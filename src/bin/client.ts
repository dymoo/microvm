#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { constants } from "node:os"
import {
  ClientConfigurationError,
  decodeExecResult,
  makeAdminClient,
  makeSandboxScopedClient
} from "../client.js"
import { makeMicrovmClient } from "../client-raw.js"
import { GuestExecError, VmId } from "../protocol.js"

interface ParsedArguments {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly url: string
  readonly token: string
  readonly json: boolean
}

class CliUsageError extends Schema.TaggedError<CliUsageError>()("CliUsageError", {
  message: Schema.String
}) {}

const isGuestExecError = Schema.is(GuestExecError)

const usage = "usage: microvm [--url URL] [--token TOKEN] <create|exec|status|list|destroy|info|set-admission> [options] [--json]"

const parseArguments = (argv: ReadonlyArray<string>): ParsedArguments => {
  let url = process.env["MICROVM_URL"] ?? ""
  let token = process.env["MICROVM_TOKEN"] ?? ""
  let json = false
  let wantsHelp = false
  const remaining: Array<string> = []
  let index = 0
  while (index < argv.length) {
    const current = argv[index]
    if (current === undefined) break
    if (current === "--") {
      remaining.push(...argv.slice(index))
      break
    }
    if (current === "--url") {
      const value = argv[index + 1]
      if (value === undefined) throw new CliUsageError({ message: "--url requires a value" })
      url = value
      index += 2
      continue
    }
    if (current === "--token") {
      const value = argv[index + 1]
      if (value === undefined) throw new CliUsageError({ message: "--token requires a value" })
      token = value
      index += 2
      continue
    }
    if (current === "--json") {
      json = true
      index += 1
      continue
    }
    if (current === "--help" || current === "-h") {
      wantsHelp = true
      index += 1
      continue
    }
    remaining.push(current)
    index += 1
  }
  const command = remaining.shift()
  if (wantsHelp) {
    return { command: "help", args: remaining, url, token, json }
  }
  if (command === undefined) {
    throw new CliUsageError({ message: `a command is required; ${usage}` })
  }
  return { command, args: remaining, url, token, json }
}

const option = (args: ReadonlyArray<string>, name: string): string | undefined => {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) throw new CliUsageError({ message: `${name} requires a value` })
  return value
}

const requiredOption = (args: ReadonlyArray<string>, name: string): string => {
  const value = option(args, name)
  if (value === undefined) throw new CliUsageError({ message: `${name} is required` })
  return value
}

const integerOption = (args: ReadonlyArray<string>, name: string): number | undefined => {
  const raw = option(args, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CliUsageError({ message: `${name} must be a positive integer` })
  }
  return value
}

const emit = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const errorTag = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string") {
    return error._tag
  }
  return "OperationError"
}

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const message = "message" in error && typeof error.message === "string" ? error.message : undefined
    if (message !== undefined && message.trim().length > 0) return message
    const reason = "reason" in error && typeof error.reason === "string" ? error.reason : undefined
    if (reason !== undefined && reason.trim().length > 0) return reason
    if (message !== undefined) return message
    if (reason !== undefined) return reason
  }
  return String(error)
}

const exitCodeForError = (error: unknown): number => {
  switch (errorTag(error)) {
    case "Unauthenticated":
    case "Forbidden":
      return 2
    case "VmNotFound":
      return 3
    case "CapacityExceeded":
    case "AdmissionClosed":
      return 4
    case "HostPrereqFailed":
    case "BootFailed":
      return 5
    case "RpcClientError":
      return 10
    default:
      return 1
  }
}

/** One parsed command before any client exists. */
type CliCommand =
  | { readonly _tag: "create"; readonly image: string; readonly imageDigest: string; readonly options: ReadonlyArray<string> }
  | { readonly _tag: "exec"; readonly vmId: string; readonly argv: ReadonlyArray<string>; readonly options: ReadonlyArray<string> }
  | { readonly _tag: "status"; readonly vmId: string }
  | { readonly _tag: "list" }
  | { readonly _tag: "destroy"; readonly vmId: string }
  | { readonly _tag: "info" }
  | { readonly _tag: "set-admission"; readonly accepting: boolean }
  | { readonly _tag: "help" }

/**
 * Builds the typed command from its options. Throws `CliUsageError` for a
 * usage mistake; {@link parseCommand} converts exactly that error, so option
 * parsing never reaches the RPC layer as a defect.
 */
const buildCommand = (parsed: ParsedArguments): CliCommand => {
  switch (parsed.command) {
    case "create":
      return {
        _tag: "create",
        image: requiredOption(parsed.args, "--image"),
        imageDigest: requiredOption(parsed.args, "--image-digest"),
        options: parsed.args
      }
    case "exec": {
      const delimiter = parsed.args.indexOf("--")
      if (delimiter === -1 || delimiter === parsed.args.length - 1) {
        throw new CliUsageError({ message: "exec requires -- followed by an absolute argv" })
      }
      const options = parsed.args.slice(0, delimiter)
      return {
        _tag: "exec",
        vmId: requiredOption(options, "--vm"),
        argv: parsed.args.slice(delimiter + 1),
        options
      }
    }
    case "status":
      return { _tag: "status", vmId: requiredOption(parsed.args, "--vm") }
    case "list":
      return { _tag: "list" }
    case "destroy":
      return { _tag: "destroy", vmId: requiredOption(parsed.args, "--vm") }
    case "info":
      return { _tag: "info" }
    case "help":
      return { _tag: "help" }
    case "set-admission": {
      const yes = parsed.args.includes("--yes")
      const no = parsed.args.includes("--no")
      if (yes === no) {
        throw new CliUsageError({ message: "set-admission requires exactly one of --yes or --no" })
      }
      return { _tag: "set-admission", accepting: yes }
    }
    default:
      throw new CliUsageError({ message: `unknown command ${parsed.command}; ${usage}` })
  }
}

/**
 * Parses the command into a typed request before any client is constructed or
 * any scope entered. A `CliUsageError` becomes an ordinary typed failure;
 * anything else thrown by the parser is a genuine defect and is NOT relabelled
 * as a usage error.
 */
const parseCommand = (parsed: ParsedArguments): Effect.Effect<CliCommand, CliUsageError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(buildCommand(parsed))
    } catch (cause) {
      return cause instanceof CliUsageError ? Effect.fail(cause) : Effect.die(cause)
    }
  })
const executeCommand = (parsed: ParsedArguments, command: CliCommand) =>
  Effect.scoped(Effect.gen(function*() {
    if (command._tag === "help") {
      process.stdout.write(`${usage}\n`)
      return
    }
    if (command._tag === "exec" || command._tag === "status") {
      const client = yield* makeSandboxScopedClient({
        url: parsed.url,
        token: parsed.token,
        vmId: command.vmId
      })
      if (command._tag === "exec") {
        const result = yield* client.execute({
          argv: command.argv,
          cwd: option(command.options, "--cwd"),
          env: undefined,
          timeoutMs: integerOption(command.options, "--timeout-ms"),
          maxOutputBytes: integerOption(command.options, "--max-output-bytes")
        })
        const decoded = decodeExecResult(result)
        emit(decoded)
        if (decoded.signal !== undefined) {
          const signalNumber = constants.signals[decoded.signal as keyof typeof constants.signals]
          process.exitCode = signalNumber === undefined ? decoded.exitCode : 128 + signalNumber
        } else {
          process.exitCode = decoded.exitCode
        }
        return
      }
      emit(yield* client.inspect())
      return
    }
    if (command._tag === "list" || command._tag === "destroy") {
      if (command._tag === "destroy" && !Schema.is(VmId)(command.vmId)) {
        return yield* Effect.fail(new CliUsageError({
          message: `--vm does not match the wire pattern: ${command.vmId}`
        }))
      }
      // list/destroy intentionally accept either an admin token or the
      // addressed VM's sandbox token. Do not run the admin-only info probe.
      const client = yield* makeMicrovmClient({ url: parsed.url, token: parsed.token })
      if (command._tag === "list") {
        emit(yield* client.list({}))
      } else {
        emit(yield* client.destroy({ vmId: command.vmId }))
      }
      return
    }
    const client = yield* makeAdminClient({ url: parsed.url, token: parsed.token })
    switch (command._tag) {
      case "create": {
        const created = yield* client.create({
          image: command.image,
          imageDigest: command.imageDigest,
          cpus: integerOption(command.options, "--cpus"),
          memMib: integerOption(command.options, "--mem-mib"),
          ttlSeconds: integerOption(command.options, "--ttl-s")
        })
        emit({ ...created.vm, sandboxToken: created.sandboxToken, httpIngressToken: created.httpIngressToken })
        return
      }
      case "info": {
        emit(yield* client.info())
        return
      }
      case "set-admission": {
        emit(yield* client.setAdmission(command.accepting))
        return
      }
    }
  }))

const main = Effect.try({
  try: () => parseArguments(process.argv.slice(2)),
  catch: (cause) => cause
}).pipe(
  Effect.flatMap((parsed) => parseCommand(parsed).pipe(Effect.map((command) => ({ parsed, command })))),
  Effect.flatMap(({ parsed, command }) => executeCommand(parsed, command)),
  Effect.catch((error) => Effect.sync(() => {
    const payload = { error: errorTag(error), message: errorMessage(error) }
    if (isGuestExecError(error)) {
      emit({ ...payload, code: error.code, vmId: error.vmId })
    } else if (typeof error === "object" && error !== null && "vmId" in error) {
      emit({ ...payload, vmId: error.vmId })
    } else if (process.argv.includes("--json")) {
      emit(payload)
    } else {
      process.stderr.write(`${payload.error}: ${payload.message}\n`)
    }
    process.exitCode = exitCodeForError(error)
  }))
)

NodeRuntime.runMain(main)
