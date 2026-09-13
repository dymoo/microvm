#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { constants } from "node:os"
import { decodeExecResult, makeMicrovmClient } from "../client.js"
import { GuestExecError } from "../protocol.js"
import type { CreateRequest, ExecuteRequest } from "../protocol.js"

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

const usage = "usage: microvm [--url URL] [--token TOKEN] <create|exec|status|list|destroy|cleanup> [options] [--json]"

const parseArguments = (argv: ReadonlyArray<string>): ParsedArguments => {
  let url = process.env["MICROVM_URL"] ?? ""
  let token = process.env["MICROVM_TOKEN"] ?? ""
  let json = false
  const remaining: Array<string> = []
  let guestArguments = false
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (argument === "--") {
      guestArguments = true
      remaining.push(argument)
      continue
    }
    if (!guestArguments && argument === "--json") {
      json = true
      continue
    }
    if (!guestArguments && (argument === "--url" || argument === "--token")) {
      const value = argv[index + 1]
      if (value === undefined) throw new CliUsageError({ message: `${argument} requires a value` })
      if (argument === "--url") url = value
      else token = value
      index++
      continue
    }
    remaining.push(argument)
  }
  const command = remaining.shift()
  if (command === undefined || url.length === 0 || token.length === 0) {
    throw new CliUsageError({ message: `${usage}; MICROVM_URL and MICROVM_TOKEN are required` })
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

/** One parsed command, with its fully typed request, before any client exists. */
type CliCommand =
  | { readonly _tag: "create"; readonly request: CreateRequest }
  | { readonly _tag: "exec"; readonly request: ExecuteRequest }
  | { readonly _tag: "status"; readonly vmId: string }
  | { readonly _tag: "list" }
  | { readonly _tag: "destroy"; readonly vmId: string }
  | { readonly _tag: "cleanup" }

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
        request: {
          image: requiredOption(parsed.args, "--image"),
          imageDigest: requiredOption(parsed.args, "--image-digest"),
          cpus: integerOption(parsed.args, "--cpus"),
          memMib: integerOption(parsed.args, "--mem-mib"),
          ttlSeconds: integerOption(parsed.args, "--ttl-s")
        }
      }
    case "exec": {
      const delimiter = parsed.args.indexOf("--")
      if (delimiter === -1 || delimiter === parsed.args.length - 1) {
        throw new CliUsageError({ message: "exec requires -- followed by an absolute argv" })
      }
      const options = parsed.args.slice(0, delimiter)
      return {
        _tag: "exec",
        request: {
          vmId: requiredOption(options, "--vm"),
          argv: parsed.args.slice(delimiter + 1),
          cwd: option(options, "--cwd"),
          env: undefined,
          timeoutMs: integerOption(options, "--timeout-ms"),
          maxOutputBytes: integerOption(options, "--max-output-bytes")
        }
      }
    }
    case "status":
      return { _tag: "status", vmId: requiredOption(parsed.args, "--vm") }
    case "list":
      return { _tag: "list" }
    case "destroy":
      return { _tag: "destroy", vmId: requiredOption(parsed.args, "--vm") }
    case "cleanup":
      return { _tag: "cleanup" }
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
    const client = yield* makeMicrovmClient({ url: parsed.url, token: parsed.token })
    switch (command._tag) {
      case "create": {
        const result = yield* client.create(command.request)
        emit({ ...result.vm, sandboxToken: result.sandboxToken })
        return
      }
      case "exec": {
        const result = yield* client.execute(command.request)
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
      case "status": {
        emit(yield* client.inspect({ vmId: command.vmId }))
        return
      }
      case "list": {
        emit(yield* client.list({}))
        return
      }
      case "destroy": {
        emit(yield* client.destroy({ vmId: command.vmId }))
        return
      }
      case "cleanup": {
        emit(yield* client.cleanup({}))
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
