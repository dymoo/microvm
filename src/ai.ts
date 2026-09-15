import { tool, type Tool, type ToolSet } from "ai"
import { Effect } from "effect"
import { posix } from "node:path"
import { z } from "zod"
import { decodeExecResult, type DecodedExecResult, type SandboxScopedClient } from "./client.js"
import { STANDARD_NODE_GUEST_WEB_PORT } from "./protocol.js"

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
  /** The one VM-bound sandbox client these tools drive; never an admin client. */
  readonly client: SandboxScopedClient
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

export const SANDBOX_SYSTEM_PROMPT = `You have tools for exactly one isolated microVM sandbox rooted at /workspace. Commands are argv arrays whose first entry is an absolute guest executable path; never compose a shell command string. The private guest root is ephemeral and has no NIC, outbound network, package downloads, or Git credentials. read_file and write_file accept relative paths beneath /workspace only and enforce byte bounds. For an empty workspace, use /usr/local/bin/microvm-next-init when it exists; its pinned Next.js dependencies are prewarmed and stay offline. A web service binds guest 127.0.0.1:${STANDARD_NODE_GUEST_WEB_PORT} and is exposed only by a trusted HTTP-only preview bridge with a fixed loopback target, never by arbitrary TCP/UDP forwarding, caller-selected destinations, or direct daemon access. Before requesting export, use /usr/bin/git when the supported image provides it to make one coherent local commit, require clean status, and record its SHA. That guest-local commit is not durable and the guest cannot push: the trusted webserver must export or materialize and verify the exact commit before teardown, then owns any external push. Keep the sandbox alive while an unexported checkpoint is pending. Preview and export are orchestrator prerequisites, not capabilities implemented by these tools. A timeout, cancellation, or failed tool call is not evidence that a command did not start: report the uncertainty and do not blindly retry. Cancellation stops the RPC and may cause the daemon to destroy a sandbox whose execution state is uncertain.`

export const TOOL_GUIDANCE = `Inspect files before editing them and prefer one bounded command at a time. Use absolute guest executables such as /usr/bin/node, /usr/bin/python3, /usr/local/bin/microvm-next-init, and /usr/local/bin/pnpm. Check exitCode, timedOut, outputTruncated, stdout, and stderr from run_command; narrow a truncated read or command instead of assuming missing output. File tools are already bound to one sandbox and accept no VM id or credential. Use the prewarmed initializer only for an empty workspace, and keep any preview service on guest 127.0.0.1:${STANDARD_NODE_GUEST_WEB_PORT}. After final changes, use /usr/bin/git when the supported image provides it to produce one clean commit and record its SHA, then request trusted export and verification; never attempt guest push or destroy while export is pending. If Git, trusted HTTP preview, or verified export is unavailable, report the missing orchestrator prerequisite rather than claiming success.`

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
      description: `Run one absolute guest executable with argv directly in the offline, ephemeral sandbox; no shell, NIC, package download, preview/export bridge, or guest push is available. Use /usr/local/bin/microvm-next-init for an empty prewarmed workspace when present; services bind guest 127.0.0.1:${STANDARD_NODE_GUEST_WEB_PORT} for a trusted HTTP-only orchestrator.`,
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
      description: "Read a bounded UTF-8 file beneath /workspace in the one configured ephemeral sandbox.",
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
      description: "Write one bounded UTF-8 file beneath /workspace, creating parent directories. The private root is ephemeral: a local commit is not durable until the trusted orchestrator exports and verifies its SHA.",
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
