import { tool, type Tool, type ToolSet } from "ai"
import { Effect } from "effect"
import { posix } from "node:path"
import { z } from "zod"
import { decodeExecResult, type DecodedExecResult, type MicrovmClient } from "./client.js"

const HARD_TIMEOUT_MS = 120_000
const HARD_OUTPUT_BYTES = 256 * 1024
const DEFAULT_READ_BYTES = 64 * 1024
const HARD_WRITE_BYTES = 4 * 1024

export interface SandboxToolLimits {
  readonly timeoutMs?: number | undefined
  readonly maxOutputBytes?: number | undefined
  readonly maxReadBytes?: number | undefined
  readonly maxWriteBytes?: number | undefined
}

export interface SandboxToolsOptions {
  readonly client: MicrovmClient
  readonly vmId: string
  readonly workdir?: string | undefined
  readonly limits?: SandboxToolLimits | undefined
}

type SandboxTool<INPUT, OUTPUT> = Tool<INPUT, OUTPUT> & {
  execute: NonNullable<Tool<INPUT, OUTPUT>["execute"]>
}

type SandboxTools = {
  readonly run_command: SandboxTool<{
    argv: Array<string>
    timeoutMs?: number | undefined
    maxOutputBytes?: number | undefined
  }, {
    exitCode: number
    signal: string | null
    timedOut: boolean
    outputTruncated: boolean
    stdout: string
    stderr: string
  }>
  readonly read_file: SandboxTool<{
    path: string
    maxBytes?: number | undefined
  }, {
    path: string
    content: string
    truncated: boolean
  }>
  readonly write_file: SandboxTool<{
    path: string
    content: string
  }, {
    path: string
    bytesWritten: number
  }>
}

export const SANDBOX_SYSTEM_PROMPT = `You have tools for exactly one isolated microVM sandbox at /workspace. Commands are argv arrays whose first entry is an absolute guest executable path, normally /usr/bin/node or /usr/bin/python3; never compose a shell command string. The sandbox has no network or package-download capability. read_file and write_file accept relative paths beneath /workspace only and enforce byte bounds. A timeout, cancellation, or failed tool call is not evidence that a command did not start: report the uncertainty and do not blindly retry. Tool cancellation stops the RPC and the daemon destroys a sandbox whose execution state is uncertain.`

export const TOOL_GUIDANCE = `Inspect files before editing them. Prefer one bounded command at a time. Use /usr/bin/node for JavaScript and /usr/bin/python3 for Python. Check exitCode, timedOut, outputTruncated, stdout, and stderr from run_command. File writes are bounded and file tools never accept a VM id or credential: their server-side closure is already bound to one sandbox. If a result is truncated, request a narrower read or command rather than assuming the missing output. Never claim network access, host access, or successful package installation.`

const boundedLimit = (requested: number | undefined, fallback: number, hardMaximum: number): number => {
  const value = requested ?? fallback
  return Math.min(Math.max(1, Math.floor(value)), hardMaximum)
}

const sandboxPath = (workdir: string, input: string): { readonly root: string; readonly relative: string } => {
  if (input.includes("\0") || posix.isAbsolute(input)) {
    throw new Error("file path must be relative to the sandbox workspace")
  }
  const root = posix.resolve(workdir)
  const absolute = posix.resolve(root, input)
  if (absolute !== root && !absolute.startsWith(`${root}/`)) {
    throw new Error("file path escapes the sandbox workspace")
  }
  return { root, relative: posix.relative(root, absolute) }
}

const runInterruptibly = <A, E>(effect: Effect.Effect<A, E>, signal: AbortSignal | undefined): Promise<A> => {
  if (signal === undefined) return Effect.runPromise(effect)
  const aborted = Effect.callback<never>((resume) => {
    if (signal.aborted) {
      resume(Effect.interrupt)
      return
    }
    const onAbort = (): void => resume(Effect.interrupt)
    signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })
  return Effect.runPromise(Effect.raceFirst(effect, aborted))
}

const commandResult = (result: DecodedExecResult) => ({
  exitCode: result.exitCode,
  signal: result.signal ?? null,
  timedOut: result.timedOut,
  outputTruncated: result.outputTruncated,
  stdout: result.stdout,
  stderr: result.stderr
})

export const createSandboxTools = (options: SandboxToolsOptions): SandboxTools => {
  const workdir = posix.resolve(options.workdir ?? "/workspace")
  const timeoutMs = boundedLimit(options.limits?.timeoutMs, 30_000, HARD_TIMEOUT_MS)
  const maxOutputBytes = boundedLimit(options.limits?.maxOutputBytes, HARD_OUTPUT_BYTES, HARD_OUTPUT_BYTES)
  const maxReadBytes = boundedLimit(options.limits?.maxReadBytes, DEFAULT_READ_BYTES, HARD_OUTPUT_BYTES - 1)
  const maxWriteBytes = boundedLimit(options.limits?.maxWriteBytes, HARD_WRITE_BYTES, HARD_WRITE_BYTES)

  const executeRaw = (
    argv: ReadonlyArray<string>,
    executionOptions: { readonly timeoutMs: number; readonly maxOutputBytes: number },
    abortSignal: AbortSignal | undefined,
    env?: Readonly<Record<string, string>>
  ) => runInterruptibly(
    options.client.execute({
      vmId: options.vmId,
      argv,
      cwd: workdir,
      env,
      timeoutMs: executionOptions.timeoutMs,
      maxOutputBytes: executionOptions.maxOutputBytes
    }),
    abortSignal
  )

  return {
    run_command: tool({
      description: "Run one absolute guest executable path (for example /usr/bin/node or /usr/bin/python3) with argv directly; no shell or network is available.",
      inputSchema: z.object({
        argv: z.array(z.string().min(1).max(4096)).min(1).max(64)
          .refine((argv) => argv[0]?.startsWith("/") === true, "argv[0] must be an absolute guest path"),
        timeoutMs: z.number().int().min(1).max(timeoutMs).optional(),
        maxOutputBytes: z.number().int().min(1).max(maxOutputBytes).optional()
      }).strict(),
      execute: async (input, invocation) => {
        const result = decodeExecResult(await executeRaw(
          input.argv,
          {
            timeoutMs: input.timeoutMs ?? timeoutMs,
            maxOutputBytes: input.maxOutputBytes ?? maxOutputBytes
          },
          invocation.abortSignal
        ))
        return commandResult(result)
      }
    }),
    read_file: tool({
      description: "Read a UTF-8 file beneath the configured sandbox workspace.",
      inputSchema: z.object({
        path: z.string().min(1).max(512),
        maxBytes: z.number().int().min(1).max(maxReadBytes).optional()
      }).strict(),
      execute: async (input, invocation) => {
        const path = sandboxPath(workdir, input.path)
        const bytes = input.maxBytes ?? maxReadBytes
        const script = "from pathlib import Path; import sys; root=Path(sys.argv[1]).resolve(); p=(root/sys.argv[2]).resolve(strict=True); p.relative_to(root); f=p.open('rb'); data=f.read(int(sys.argv[3])+1); f.close(); sys.stdout.buffer.write(data)"
        const result = await executeRaw(
          ["/usr/bin/python3", "-c", script, path.root, path.relative, String(bytes)],
          { timeoutMs, maxOutputBytes: bytes + 1 },
          invocation.abortSignal
        )
        const stderr = Buffer.from(result.stderrB64, "base64").toString("utf8")
        if (result.exitCode !== 0) throw new Error(stderr || `read failed with exit code ${result.exitCode}`)
        const output = Buffer.from(result.stdoutB64, "base64")
        const truncated = output.length > bytes || result.outputTruncated
        return {
          path: input.path,
          content: output.subarray(0, bytes).toString("utf8"),
          truncated
        }
      }
    }),
    write_file: tool({
      description: "Write one UTF-8 file beneath the configured sandbox workspace, creating parent directories.",
      inputSchema: z.object({
        path: z.string().min(1).max(512),
        content: z.string().max(maxWriteBytes)
      }).strict(),
      execute: async (input, invocation) => {
        const path = sandboxPath(workdir, input.path)
        const content = Buffer.from(input.content, "utf8")
        if (content.length > maxWriteBytes) throw new Error(`file content exceeds ${maxWriteBytes} UTF-8 bytes`)
        const script = "from pathlib import Path; import base64,os,sys; root=Path(sys.argv[1]).resolve(); p=(root/sys.argv[2]).resolve(strict=False); p.relative_to(root); p.parent.mkdir(parents=True,exist_ok=True); data=base64.b64decode(os.environ['MICROVM_FILE_B64'],validate=True); p.write_bytes(data); print(len(data))"
        const result = await executeRaw(
          ["/usr/bin/python3", "-c", script, path.root, path.relative],
          { timeoutMs, maxOutputBytes: 128 },
          invocation.abortSignal,
          { MICROVM_FILE_B64: content.toString("base64") }
        )
        const stderr = Buffer.from(result.stderrB64, "base64").toString("utf8")
        if (result.exitCode !== 0) throw new Error(stderr || `write failed with exit code ${result.exitCode}`)
        return { path: input.path, bytesWritten: content.length }
      }
    })
  } satisfies ToolSet
}
