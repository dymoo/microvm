/**
 * Firecracker control: jailed boot with cgroup v2 enforcement, the UDS HTTP
 * API client, and the guest exec v1 channel over the vsock UDS.
 *
 * Security-critical invariants implemented here:
 * - The jailer is mandatory; every boot runs unprivileged in a per-VM chroot
 *   with cgroup v2 CPU/memory/pid ceilings and rlimit bounds.
 * - Guest I/O is vsock-only; no network device is ever configured.
 * - Boot is not "done" until the guest runner answers a readiness probe on
 *   the vsock; `create` never returns a VM whose guest listener is unproven.
 * - Boot is transactional: any failure tears the jailer tree down and removes
 *   the cgroup; if that teardown itself is uncertain, boot fails with a typed
 *   `VmTeardownFault` instead of reporting a clean rollback.
 * - Every guest frame is schema-validated (version, id, seq, strict base64)
 *   and host buffers are capped. ANY transport violation — EOF without a
 *   terminal frame, oversize lines, cap overruns, empty data frames, unknown
 *   frame types, deadline expiry — is a `GuestTransportFault`; the daemon
 *   poisons such VMs and exec success is never reported for a VM in doubt.
 */
import { Cause, Context, Effect, Exit, Layer, Schema, Scope } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import { Buffer } from "node:buffer"
import { existsSync } from "node:fs"
import { rmdir } from "node:fs/promises"
import { request as httpRequest, type ClientRequest } from "node:http"
import type { Socket } from "node:net"
import type { HostConfig } from "./host.js"
import { provisionChroot, type ResolvedImage, type VmLayout } from "./host.js"
import {
  BootFailed,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  GuestExecError,
  MAX_JSONL_LINE_BYTES,
  MAX_OUTPUT_BYTES_PER_STREAM,
  MAX_SERVICE_CONTROL_LINE_BYTES,
  MAX_TIMEOUT_MS
} from "./protocol.js"
import {
  openGuestExecSocket,
  openGuestHttpSocket,
  openGuestServiceSocket
} from "./vsock.js"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FirecrackerError extends Schema.TaggedError<FirecrackerError>()("FirecrackerError", {
  vmId: Schema.String,
  reason: Schema.String
}) {}

export class BootProcessDied extends Schema.TaggedError<BootProcessDied>()("BootProcessDied", {
  vmId: Schema.String,
  exitCode: Schema.UndefinedOr(Schema.Number),
  signal: Schema.UndefinedOr(Schema.String),
  reason: Schema.UndefinedOr(Schema.String)
}) {}

/**
 * Teardown could not be proven complete: the process group may still be
 * alive or the cgroup could not be removed (which implies live processes).
 * Callers (the VM registry) must quarantine/destroy the VM; a "clean"
 * rollback is never claimed.
 */
export class VmTeardownFault extends Schema.TaggedError<VmTeardownFault>()("VmTeardownFault", {
  vmId: Schema.String,
  phase: Schema.Literals(["signal", "cgroup"]),
  reason: Schema.String
}) {}

/**
 * A guest/transport violation: the channel failed in a way that leaves the
 * guest state unknowable. The daemon must poison the VM (require destroy)
 * and must never report success.
 */
export class GuestTransportFault extends Schema.TaggedError<GuestTransportFault>()("GuestTransportFault", {
  vmId: Schema.String,
  reason: Schema.String
}) {}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface ExecLimits {
  readonly timeoutMs: number
  readonly maxOutputBytesPerStream: number
}

/** Clamps caller-supplied limits to daemon ceilings before they reach the guest. */
export const clampLimits = (limits: ExecLimits): ExecLimits => ({
  timeoutMs: Math.min(Math.max(1, Math.floor(limits.timeoutMs)), MAX_TIMEOUT_MS),
  maxOutputBytesPerStream: Math.min(
    Math.max(1, Math.floor(limits.maxOutputBytesPerStream)),
    MAX_OUTPUT_BYTES_PER_STREAM
  )
})

export const defaultLimits = (): ExecLimits => ({
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxOutputBytesPerStream: DEFAULT_MAX_OUTPUT_BYTES
})

/** Host-side grace beyond the guest's own timeout before we declare a fault. */
const EXEC_DEADLINE_GRACE_MS = 5_000
/** Maximum accepted Firecracker API response body. */
const API_BODY_LIMIT_BYTES = 1_048_576
const API_TIMEOUT_MS = 10_000
const SOCKET_WAIT_TIMEOUT_MS = 10_000
const STOP_GRACE_MS = 3_000
const STOP_KILL_GRACE_MS = 2_000
const READINESS_POLL_MS = 250

const timeoutCause = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  millis: number
): Effect.Effect<A, E | Cause.TimeoutError, R> => Effect.timeout(effect, { milliseconds: millis })

// ---------------------------------------------------------------------------
// Firecracker UDS API client (HTTP over the per-VM unix socket)
// ---------------------------------------------------------------------------

interface ApiResponse {
  readonly status: number
  readonly body: string
}

const apiRequest = (
  vmId: string,
  apiSocket: string,
  method: string,
  path: string,
  body?: unknown
): Effect.Effect<ApiResponse, FirecrackerError> =>
  // One callback owns the entire request lifetime: connection, headers, and
  // body consumption. The abort signal destroys the request no matter which
  // stage is in flight when the effect is interrupted or times out.
  Effect.callback<ApiResponse, FirecrackerError>((resume, signal) => {
    const requestBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body)!)
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      Accept: "application/json"
    }
    if (requestBody !== undefined) headers["Content-Length"] = requestBody.byteLength
    const req: ClientRequest = httpRequest(
      {
        socketPath: apiSocket,
        method,
        path,
        headers
      },
      (res) => {
        const chunks: Array<Buffer> = []
        let bytes = 0
        let overLimit = false
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes <= API_BODY_LIMIT_BYTES) chunks.push(chunk)
          else overLimit = true
        })
        res.on("end", () => {
          if (overLimit) {
            resume(Effect.fail(new FirecrackerError({
              vmId,
              reason: `api ${path} response exceeded ${API_BODY_LIMIT_BYTES} bytes`
            })))
            return
          }
          resume(Effect.succeed({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          }))
        })
        res.on("error", (cause: Error) =>
          resume(Effect.fail(new FirecrackerError({ vmId, reason: `api ${path}: ${String(cause)}` }))))
      }
    )
    req.on("error", (cause: Error) =>
      resume(Effect.fail(new FirecrackerError({ vmId, reason: `api ${path}: ${String(cause)}` }))))
    signal.addEventListener("abort", () => req.destroy(), { once: true })
    if (requestBody === undefined) req.end()
    else req.end(requestBody)
  }).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(response)
        : Effect.fail(new FirecrackerError({
          vmId,
          reason: `api ${path} failed ${response.status}: ${response.body.slice(0, 400)}`
        }))
    ),
    Effect.timeout({ milliseconds: API_TIMEOUT_MS }),
    Effect.catch((cause) =>
      Cause.isTimeoutError(cause)
        ? Effect.fail(new FirecrackerError({ vmId, reason: `api ${path} timed out` }))
        : Effect.fail(cause as FirecrackerError)
    )
  )

// ---------------------------------------------------------------------------
// Boot via jailer
// ---------------------------------------------------------------------------

export interface BootSpec {
  readonly vmId: string
  readonly guestCid: number
  readonly cpus: number
  readonly memMib: number
  /** Operator-controlled kernel boot arguments; never caller-supplied. */
  readonly kernelArgs: string
  /**
   * Immutable image-manifest web port. When present it is passed to the guest
   * through the operator-controlled kernel command line and all preview
   * listeners must be ready before boot succeeds.
   */
  readonly webPort?: number | undefined
  readonly layout: VmLayout
  readonly uid: number
  readonly gid: number
}

export interface VmHandle {
  readonly pid: number
  /**
   * Bounded teardown: SIGTERM, SIGKILL escalation, then cgroup removal.
   * Fails with `VmTeardownFault` when liveness cannot be disproven — callers
   * must quarantine the VM instead of assuming a clean stop.
   */
  readonly stop: () => Effect.Effect<void, VmTeardownFault>
  /** Completes when the jailer/firecracker process exits for any reason. */
  readonly exited: Effect.Effect<{ readonly exitCode: number | null; readonly signal: string | null }>
}

export class Firecracker extends Context.Service<Firecracker, {
  /**
   * Boots one microVM through the jailer, starts it, and waits until the
   * guest runner answers a readiness probe on the vsock. Any failure after
   * spawn is transactional; an uncertain rollback surfaces as
   * `VmTeardownFault`.
   */
  readonly boot: (
    spec: BootSpec,
    image: ResolvedImage
  ) => Effect.Effect<
    VmHandle,
    FirecrackerError | BootProcessDied | BootFailed | VmTeardownFault
  >
}>()("microvm/firecracker/Firecracker") {}

const killProcessGroup = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

const basenameIn = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

export const FirecrackerLive = (config: HostConfig): Layer.Layer<Firecracker> =>
  Layer.effect(Firecracker)(Effect.sync(() => {
    const boot = (
      spec: BootSpec,
      image: ResolvedImage
    ): Effect.Effect<VmHandle, FirecrackerError | BootProcessDied | BootFailed | VmTeardownFault> =>
      Effect.gen(function*() {
        const layout = spec.layout
        const vmId = spec.vmId
        if (
          spec.webPort !== undefined &&
          (!Number.isInteger(spec.webPort) || spec.webPort < 1024 || spec.webPort > 65_535)
        ) {
          return yield* Effect.fail(new FirecrackerError({
            vmId,
            reason: "web port must be an integer between 1024 and 65535"
          }))
        }

        // 1. Private root disk + kernel copy inside the chroot.
        yield* provisionChroot(vmId, layout, image, config.kernelImage, spec.uid, spec.gid).pipe(
          Effect.mapError((disk) => new FirecrackerError({ vmId, reason: disk.reason }))
        )

        // 2. Launch the jailer: chroot at
        //    <chroot-base-dir>/<exec_file_name>/<id>/root, privilege drop to
        //    the per-VM unprivileged uid/gid, cgroup v2 resource ceilings.
        //    New process group so teardown can signal the whole tree.
        const cpuQuotaUs = spec.cpus * 100_000
        // Include VMM overhead above guest RAM or the kernel OOM killer takes
        // out valid VMs.
        const memoryMaxBytes = (spec.memMib + config.vmmOverheadMib) * 1_048_576
        const child = spawn(
          config.jailerBinary,
          [
            "--id", spec.vmId,
            "--exec-file", config.firecrackerBinary,
            "--chroot-base-dir", layout.chrootBase,
            "--uid", String(spec.uid),
            "--gid", String(spec.gid),
            "--cgroup-version", "2",
            ...(config.jailerParentCgroup !== undefined
              ? ["--parent-cgroup", config.jailerParentCgroup]
              : []),
            "--cgroup", `cpu.max=${cpuQuotaUs} 100000`,
            "--cgroup", `memory.max=${memoryMaxBytes}`,
            "--cgroup", `pids.max=${config.maxPidsPerVm}`,
            "--resource-limit", `fsize=${config.jailerFsizeBytes}`,
            "--resource-limit", `no-file=${config.jailerNoFileLimit}`,
            "--",
            "--api-sock", "api.sock"
          ],
          { stdio: ["ignore", "ignore", "pipe"], detached: true }
        )
        const stderrTail: Array<string> = []
        child.stderr?.on("data", (chunk: Buffer) => {
          stderrTail.push(chunk.toString("utf8"))
          if (stderrTail.length > 20) stderrTail.shift()
        })
        // ENOENT and friends arrive as an async "error" event; without this
        // listener the daemon would crash with an unhandled error.
        let spawnError: Error | undefined
        child.once("error", (cause: Error) => {
          spawnError = cause
        })

        const childStopped = (): boolean =>
          child.exitCode !== null || child.signalCode !== null || child.pid === undefined

        const exited: Effect.Effect<{ readonly exitCode: number | null; readonly signal: string | null }> =
          Effect.callback((resume) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resume(Effect.succeed({ exitCode: child.exitCode, signal: child.signalCode }))
              return
            }
            child.once("exit", (exitCode: number | null, signal: string | null) =>
              resume(Effect.succeed({ exitCode, signal })))
          })

        /** rmdir fails while processes remain in the cgroup: genuine signal. */
        const removeCgroup: Effect.Effect<void, VmTeardownFault> = Effect.tryPromise({
          try: () => rmdir(layout.cgroupDir),
          catch: (cause) => new VmTeardownFault({
            vmId,
            phase: "cgroup",
            reason: `cgroup removal failed (processes may remain): ${String(cause)}`
          })
        })

        const stop = (): Effect.Effect<void, VmTeardownFault> =>
          Effect.gen(function*() {
            if (childStopped()) {
              yield* removeCgroup
              return
            }
            const pid = child.pid!
            killProcessGroup(pid, "SIGTERM")
            const termOutcome = yield* Effect.result(
              timeoutCause(exited, STOP_GRACE_MS)
            )
            if (termOutcome._tag === "Failure" && Cause.isTimeoutError(termOutcome.failure)) {
              killProcessGroup(pid, "SIGKILL")
              const killOutcome = yield* Effect.result(
                timeoutCause(exited, STOP_KILL_GRACE_MS)
              )
              if (killOutcome._tag === "Failure") {
                return yield* Effect.fail(new VmTeardownFault({
                  vmId,
                  phase: "signal",
                  reason: "process group survived SIGTERM and SIGKILL"
                }))
              }
            }
            yield* removeCgroup
          })

        const handle: VmHandle = { pid: child.pid ?? -1, stop, exited }

        // 3. Configure + start. Every failure path tears the process tree
        //    and cgroup down; a teardown that cannot be proven complete
        //    fails the boot with VmTeardownFault instead of a clean error.
        const configureAndStart: Effect.Effect<void, FirecrackerError | BootProcessDied> =
          Effect.gen(function*() {
            yield* waitForSocket(layout.apiSocket, child, () => spawnError).pipe(
              Effect.mapError((cause) => diedBecause(vmId, child, stderrTail, cause))
            )

            yield* apiRequest(vmId, layout.apiSocket, "PUT", "/boot-source", {
              kernel_image_path: basenameIn(layout.kernelPath),
              boot_args: spec.webPort === undefined
                ? spec.kernelArgs
                : `${spec.kernelArgs} microvm.web_port=${spec.webPort}`
            })
            yield* apiRequest(vmId, layout.apiSocket, "PUT", "/drives/rootfs", {
              drive_id: "rootfs",
              path_on_host: "rootfs.raw",
              is_root_device: true,
              is_read_only: false
            })
            yield* apiRequest(vmId, layout.apiSocket, "PUT", "/machine-config", {
              vcpu_count: spec.cpus,
              mem_size_mib: spec.memMib
            })
            // vsock only. There is no /network-interface PUT anywhere in
            // this file: the guest has no NIC and therefore no egress path.
            yield* apiRequest(vmId, layout.apiSocket, "PUT", "/vsock", {
              guest_cid: spec.guestCid,
              uds_path: "v.sock"
            })
            yield* apiRequest(vmId, layout.apiSocket, "PUT", "/actions", {
              action_type: "InstanceStart"
            })
          }).pipe(
            Effect.timeout({ milliseconds: config.bootTimeoutMs }),
            Effect.catch((cause) =>
              Cause.isTimeoutError(cause)
                ? Effect.fail(new FirecrackerError({ vmId, reason: "boot exceeded timeout" }))
                : Effect.fail(cause as FirecrackerError | BootProcessDied)
            )
          )
        const startTransaction = configureAndStart.pipe(
          Effect.andThen(
            awaitGuestReadiness(
              vmId,
              layout.vsockSocket,
              config.guestReadinessTimeoutMs,
              spec.webPort !== undefined
            ).pipe(
              Effect.mapError((reason) => new BootFailed({ vmId, reason }))
            )
          )
        )

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function*() {
            const outcome = yield* Effect.exit(restore(startTransaction))
            if (Exit.isSuccess(outcome)) return handle

            // Roll back every post-spawn failure, including guest-readiness
            // failure and external cancellation. A timeout is converted to a
            // typed failure before this point and is not mistaken for a caller
            // interruption.
            yield* stop()
            const externallyInterrupted = outcome.cause.reasons.length > 0 &&
              outcome.cause.reasons.every(Cause.isInterruptReason)
            if (externallyInterrupted) return yield* Effect.interrupt
            return yield* Effect.failCause(outcome.cause)
          })
        )
      })

    return Firecracker.of({ boot })
  }))

const diedBecause = (
  vmId: string,
  child: ChildProcess,
  stderrTail: Array<string>,
  cause: Error
): BootProcessDied => {
  const tail = stderrTail.join("").slice(-2000)
  return new BootProcessDied({
    vmId,
    exitCode: child.exitCode ?? undefined,
    signal: child.signalCode ?? undefined,
    reason: tail.length > 0 ? `${cause.message}: ${tail}` : cause.message
  })
}

const waitForSocket = (
  path: string,
  child: ChildProcess,
  spawnError: () => Error | undefined
) =>
  Effect.callback<void, Error>((resume, signal) => {
    let settled = false
    const finish = (outcome: Effect.Effect<void, Error>): void => {
      if (settled) return
      settled = true
      resume(outcome)
    }
    const started = Date.now()
    const timer = setTimeout(function tick(): void {
      if (settled) return
      const error = spawnError()
      if (error !== undefined) {
        finish(Effect.fail(new Error(`jailer failed to start: ${error.message}`)))
        return
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        finish(Effect.fail(new Error("jailer exited before API socket appeared")))
        return
      }
      if (existsSync(path)) {
        finish(Effect.void)
        return
      }
      if (Date.now() - started > SOCKET_WAIT_TIMEOUT_MS) {
        finish(Effect.fail(new Error("timed out waiting for firecracker API socket")))
        return
      }
      setTimeout(tick, 50)
    }, 50)
    signal.addEventListener("abort", () => {
      settled = true
      clearTimeout(timer)
    }, { once: true })
  })

// ---------------------------------------------------------------------------
// Guest readiness probing
// ---------------------------------------------------------------------------

/** A single fixed-purpose readiness probe; the scoped socket is immediately closed. */
const probeListener = (
  name: string,
  open: Effect.Effect<Socket, string, Scope.Scope>
): Effect.Effect<void, string> =>
  Effect.scoped(
    open.pipe(
      Effect.map(() => undefined),
      Effect.mapError((reason) => `${name} listener: ${reason}`)
    )
  )

/** Probes the exec listener retained by every supported guest image. */
export const probeGuestReadiness = (vsockSocket: string): Effect.Effect<void, string> =>
  probeListener("exec", openGuestExecSocket(vsockSocket))

const probeRequiredListeners = (
  vsockSocket: string,
  requireWebListeners: boolean
): Effect.Effect<void, string> =>
  Effect.gen(function*() {
    yield* probeGuestReadiness(vsockSocket)
    if (!requireWebListeners) return
    yield* probeListener("http", openGuestHttpSocket(vsockSocket))
    yield* probeListener("service", openGuestServiceSocket(vsockSocket))
  })

/** Polls all required listeners until the deadline; used before `create` returns. */
export const awaitGuestReadiness = (
  vmId: string,
  vsockSocket: string,
  timeoutMs: number,
  requireWebListeners = false
): Effect.Effect<void, string> =>
 Effect.gen(function*() {
   const deadline = Date.now() + timeoutMs
   let lastReason = "guest did not become ready"
   while (Date.now() < deadline) {
     const attempt = yield* Effect.result(
       timeoutCause(
         probeRequiredListeners(vsockSocket, requireWebListeners),
         READINESS_POLL_MS * 2
       )
     )
     if (attempt._tag === "Success") return
     if (attempt._tag === "Failure" && !Cause.isTimeoutError(attempt.failure)) {
       lastReason = String(attempt.failure)
     }
     yield* Effect.sleep({ milliseconds: READINESS_POLL_MS })
   }
   return yield* Effect.fail(
     `readiness timeout after ${timeoutMs}ms for ${vmId}: ${lastReason}`
   )
 })

// ---------------------------------------------------------------------------
// Guest exec v1 frames (parsed from the guest side, so validated with Schema)
// ---------------------------------------------------------------------------

const dataFrameSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  seq: Schema.Number,
  type: Schema.Literals(["stdout", "stderr"]),
  data: Schema.String
})

const exitFrameSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  type: Schema.Literal("exit"),
  code: Schema.Number,
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  outputTruncated: Schema.Boolean
})

const errorFrameSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  type: Schema.Literal("error"),
  code: Schema.Literals(["INVALID_REQUEST", "EXEC_FAILED", "INTERNAL"]),
  message: Schema.String
})

const decodeData = Schema.decodeUnknownResult(dataFrameSchema)
const decodeExit = Schema.decodeUnknownResult(exitFrameSchema)
const decodeError = Schema.decodeUnknownResult(errorFrameSchema)

const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** Strict base64: alphabet, padding shape, and lossless round-trip. */
const decodeStrictBase64 = (value: string): Buffer | undefined => {
  if (!STRICT_BASE64.test(value) || value.length % 4 !== 0) return undefined
  const decoded = Buffer.from(value, "base64")
  const expected = Math.floor((value.length * 3) / 4) -
    (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0)
  return decoded.length === expected ? decoded : undefined
}

export interface ExitFrame {
  readonly code: number
  readonly signal: string | null
  readonly timedOut: boolean
  readonly outputTruncated: boolean
  readonly stdout: Buffer
  readonly stderr: Buffer
}

export type GuestExecSuccess =
  | { readonly _tag: "Exit"; readonly frame: ExitFrame }
  | { readonly _tag: "GuestError"; readonly code: "INVALID_REQUEST" | "EXEC_FAILED"; readonly message: string }

export class GuestExecChannel extends Context.Service<GuestExecChannel, {
  /**
   * Connects to the vsock UDS, performs the `CONNECT <port>` handshake on the
   * same connection (per Firecracker vsock docs: no reconnect), sends exactly
   * one exec v1 request, and collects framed output up to the terminal frame.
   *
   * The WHOLE lifetime — connect, handshake, frames — runs under one
   * deadline; the socket is finalized on every exit path including
   * cancellation. Fails with `GuestExecError` for pre-exec guest rejections,
   * or `GuestTransportFault` for ANY transport violation (the caller must
   * poison the VM).
   */
  readonly exec: (options: {
    readonly vmId: string
    readonly vsockSocket: string
    readonly execId: string
    readonly argv: ReadonlyArray<string>
    readonly cwd?: string | undefined
    readonly env?: Readonly<Record<string, string>> | undefined
    readonly limits: ExecLimits
  }) => Effect.Effect<GuestExecSuccess, GuestExecError | GuestTransportFault | FirecrackerError>
}>()("microvm/firecracker/GuestExecChannel") {}

export const GuestExecChannelLive: Layer.Layer<GuestExecChannel> = Layer.effect(GuestExecChannel)(
  Effect.sync(() => {
    const exec: GuestExecChannel["Service"]["exec"] = (options) => {
      const request: Record<string, unknown> = {
        version: 1,
        id: options.execId,
        argv: [...options.argv],
        timeoutMs: options.limits.timeoutMs,
        maxOutputBytes: options.limits.maxOutputBytesPerStream
      }
      if (options.cwd !== undefined) request["cwd"] = options.cwd
      if (options.env !== undefined) request["env"] = { ...options.env }

      const fault = (reason: string): GuestTransportFault =>
        new GuestTransportFault({ vmId: options.vmId, reason })

      return Effect.scoped(
        openGuestExecSocket(options.vsockSocket).pipe(
          Effect.mapError((reason) => fault(`vsock connect failed: ${reason}`)),
          Effect.flatMap((socket) =>
            Effect.sync(() => {
              socket.write(`${JSON.stringify(request)}\n`, "utf8")
            }).pipe(Effect.andThen(readGuestFrames(socket, options)))
          ),
          // Whole-channel deadline covers connect + handshake + frames.
          Effect.timeout({ milliseconds: options.limits.timeoutMs + EXEC_DEADLINE_GRACE_MS }),
          Effect.catch((cause) =>
            Cause.isTimeoutError(cause)
              ? Effect.fail(fault("guest channel exceeded deadline without terminal frame"))
              : Effect.fail(cause)
          )
        )
      )
    }

    return GuestExecChannel.of({ exec })
  }))

// ---------------------------------------------------------------------------
// Guest HTTP and persistent service channels
// ---------------------------------------------------------------------------

export class GuestServiceError extends Schema.TaggedError<GuestServiceError>()("GuestServiceError", {
  vmId: Schema.String,
  code: Schema.Literals(["INVALID_REQUEST", "START_FAILED", "INTERNAL"]),
  message: Schema.String
}) {}

export type WebServiceState =
  | {
      readonly state: "not_started"
      readonly startedAtEpochMs?: undefined
      readonly exitCode?: undefined
      readonly signal?: undefined
    }
  | {
      readonly state: "running"
      readonly startedAtEpochMs: number
      readonly exitCode?: undefined
      readonly signal?: undefined
    }
  | {
      readonly state: "exited"
      readonly startedAtEpochMs: number
      readonly exitCode: number
      readonly signal: string | null
    }

export class GuestHttpChannel extends Context.Service<GuestHttpChannel, {
  /**
   * Opens one raw HTTP exchange to the fixed guest HTTP proxy. The returned
   * socket is paused and scoped; cancellation or scope close destroys it.
   */
  readonly open: (options: {
    readonly vmId: string
    readonly vsockSocket: string
  }) => Effect.Effect<Socket, GuestTransportFault, Scope.Scope>
}>()("microvm/firecracker/GuestHttpChannel") {}

export const GuestHttpChannelLive: Layer.Layer<GuestHttpChannel> = Layer.effect(
  GuestHttpChannel,
  Effect.sync(() => GuestHttpChannel.of({
    open: (options) =>
      openGuestHttpSocket(options.vsockSocket).pipe(
        Effect.mapError((reason) => new GuestTransportFault({
          vmId: options.vmId,
          reason: `http vsock connect failed: ${reason}`
        }))
      )
  }))
)

interface GuestServiceCommonOptions {
  readonly vmId: string
  readonly vsockSocket: string
  readonly requestId: string
  /** Bound on the guest's reply for this exchange. */
  readonly deadlineMs?: number | undefined
}

export class GuestServiceChannel extends Context.Service<GuestServiceChannel, {
  readonly start: (options: GuestServiceCommonOptions & {
    /** Exact validated JSON request plus its terminal newline. */
    readonly requestLine: Buffer
  }) => Effect.Effect<WebServiceState, GuestServiceError | GuestTransportFault>
  readonly status: (
    options: GuestServiceCommonOptions
  ) => Effect.Effect<WebServiceState, GuestServiceError | GuestTransportFault>
  readonly stop: (
    options: GuestServiceCommonOptions
  ) => Effect.Effect<{ readonly stopped: boolean }, GuestServiceError | GuestTransportFault>
}>()("microvm/firecracker/GuestServiceChannel") {}

/**
 * Default bound on one guest service-control reply. Generous against the guest's
 * own frozen-cgroup kill wait (5s) so a real stop still answers, but finite so a
 * wedged controller faults (and poisons through the caller) instead of hanging.
 */
const SERVICE_EXCHANGE_DEADLINE_MS = 15_000

const serviceStartedSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  type: Schema.Literal("started"),
  startedAtEpochMs: Schema.Number
})
const serviceStatusSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  type: Schema.Literal("status"),
  state: Schema.Literals(["not_started", "running", "exited"]),
  startedAtEpochMs: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  signal: Schema.optional(Schema.NullOr(Schema.String))
})
const serviceStoppedSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  type: Schema.Literal("stopped"),
  stopped: Schema.Boolean
})
const serviceErrorSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  type: Schema.Literal("error"),
  code: Schema.Literals(["INVALID_REQUEST", "START_FAILED", "INTERNAL"]),
  message: Schema.String
})

const decodeServiceStarted = Schema.decodeUnknownResult(serviceStartedSchema)
const decodeServiceStatus = Schema.decodeUnknownResult(serviceStatusSchema)
const decodeServiceStopped = Schema.decodeUnknownResult(serviceStoppedSchema)
const decodeServiceError = Schema.decodeUnknownResult(serviceErrorSchema)

const encodeServiceRequest = Effect.fn("encodeServiceRequest")(
  function*(
    request: Readonly<Record<string, unknown>>,
    vmId: string
  ): Effect.fn.Return<Buffer, GuestServiceError> {
    const json = yield* Effect.try({
      try: () => JSON.stringify(request),
      catch: () => new GuestServiceError({
        vmId,
        code: "INVALID_REQUEST",
        message: "guest service request could not be encoded as JSON"
      })
    })
    if (json === undefined) {
      return yield* new GuestServiceError({
        vmId,
        code: "INVALID_REQUEST",
        message: "guest service request could not be encoded as JSON"
      })
    }
    if (Buffer.byteLength(json, "utf8") > MAX_SERVICE_CONTROL_LINE_BYTES) {
      return yield* new GuestServiceError({
        vmId,
        code: "INVALID_REQUEST",
        message: `guest service request exceeds ${MAX_SERVICE_CONTROL_LINE_BYTES} byte line limit`
      })
    }
    return Buffer.from(`${json}\n`, "utf8")
  }
)

export const encodeGuestServiceStartRequest = Effect.fn("encodeGuestServiceStartRequest")(
  function*(options: {
    readonly vmId: string
    readonly requestId: string
    readonly argv: ReadonlyArray<string>
    readonly cwd?: string | undefined
    readonly env?: Readonly<Record<string, string>> | undefined
    readonly webPort: number
  }): Effect.fn.Return<Buffer, GuestServiceError> {
    const request: Record<string, unknown> = {
      version: 1,
      id: options.requestId,
      op: "start",
      argv: options.argv,
      port: options.webPort
    }
    if (options.cwd !== undefined) request["cwd"] = options.cwd
    if (options.env !== undefined) request["env"] = options.env
    return yield* encodeServiceRequest(request, options.vmId)
  }
)

const serviceExchange = (
  socket: Socket,
  requestLine: Buffer,
  vmId: string,
  deadlineMs: number
): Effect.Effect<unknown, GuestTransportFault> =>
  Effect.callback<unknown, GuestTransportFault>((resume, signal) => {
    let chunks: Array<Buffer> = []
    let bytes = 0
    let finished = false
    let deadline: NodeJS.Timeout | undefined

    const detach = (): void => {
      clearTimeout(deadline)
      socket.off("data", onData)
      socket.off("error", onError)
      socket.off("close", onClose)
    }
    const fault = (reason: string): void => {
      if (finished) return
      finished = true
      detach()
      resume(Effect.fail(new GuestTransportFault({ vmId, reason })))
    }
    const onData = (chunk: Buffer): void => {
      const newline = chunk.indexOf(0x0a)
      if (newline === -1) {
        if (bytes + chunk.length > MAX_SERVICE_CONTROL_LINE_BYTES) {
          fault("guest service response exceeded maximum line size")
          return
        }
        chunks.push(chunk)
        bytes += chunk.length
        return
      }
      if (bytes + newline > MAX_SERVICE_CONTROL_LINE_BYTES || newline + 1 !== chunk.length) {
        fault(
          bytes + newline > MAX_SERVICE_CONTROL_LINE_BYTES
            ? "guest service response exceeded maximum line size"
            : "guest service sent bytes after its terminal response"
        )
        return
      }
      chunks.push(chunk.subarray(0, newline))
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.concat(chunks, bytes + newline).toString("utf8"))
      } catch {
        fault("guest service sent a non-JSON response")
        return
      }
      finished = true
      detach()
      resume(Effect.succeed(parsed))
    }
    const onError = (cause: Error): void => fault(`guest service socket error: ${String(cause)}`)
    const onClose = (): void => fault("guest service closed before its terminal response")

    socket.on("data", onData)
    socket.once("error", onError)
    socket.once("close", onClose)
    deadline = setTimeout(
      () => fault("guest service response deadline exceeded"),
      deadlineMs
    )
    deadline.unref()
    signal.addEventListener("abort", () => {
      if (finished) return
      finished = true
      detach()
      socket.destroy()
      resume(Effect.interrupt)
    }, { once: true })
    socket.write(requestLine)
    socket.resume()
  })

const serviceFailure = (
  parsed: unknown,
  vmId: string,
  requestId: string
): Effect.Effect<never, GuestServiceError | GuestTransportFault> => {
  const error = decodeServiceError(parsed)
  if (error._tag === "Failure" || error.success.id !== requestId) {
    return Effect.fail(new GuestTransportFault({
      vmId,
      reason: error._tag === "Success"
        ? "guest service response id mismatch"
        : "guest service sent an unknown or invalid response"
    }))
  }
  return Effect.fail(new GuestServiceError({
    vmId,
    code: error.success.code,
    message: error.success.message.slice(0, 500)
  }))
}

export const GuestServiceChannelLive: Layer.Layer<GuestServiceChannel> = Layer.effect(
  GuestServiceChannel,
  Effect.sync(() => {
    const exchangeLine = Effect.fn("GuestServiceChannel.exchangeLine")(
      function*(
        options: GuestServiceCommonOptions,
        requestLine: Buffer
      ): Effect.fn.Return<unknown, GuestTransportFault> {
        return yield* Effect.scoped(
          openGuestServiceSocket(options.vsockSocket).pipe(
            Effect.mapError((reason) => new GuestTransportFault({
              vmId: options.vmId,
              reason: `service vsock connect failed: ${reason}`
            })),
            Effect.flatMap((socket) =>
              serviceExchange(socket, requestLine, options.vmId, options.deadlineMs ?? SERVICE_EXCHANGE_DEADLINE_MS)
            )
          )
        )
      }
    )
    const exchange = Effect.fn("GuestServiceChannel.exchange")(
      function*(
        options: GuestServiceCommonOptions,
        request: Readonly<Record<string, unknown>>
      ): Effect.fn.Return<unknown, GuestServiceError | GuestTransportFault> {
        const requestLine = yield* encodeServiceRequest(request, options.vmId)
        return yield* exchangeLine(options, requestLine)
      }
    )

    const start: GuestServiceChannel["Service"]["start"] = (options) => {
      return exchangeLine(options, options.requestLine).pipe(
        Effect.flatMap((parsed) => {
          const started = decodeServiceStarted(parsed)
          if (started._tag === "Success") {
            if (started.success.id !== options.requestId) {
              return Effect.fail(new GuestTransportFault({
                vmId: options.vmId,
                reason: "guest service response id mismatch"
              }))
            }
            return Effect.succeed<WebServiceState>({
              state: "running",
              startedAtEpochMs: started.success.startedAtEpochMs
            })
          }
          return serviceFailure(parsed, options.vmId, options.requestId)
        })
      )
    }

    const status: GuestServiceChannel["Service"]["status"] = (options) =>
      exchange(options, { version: 1, id: options.requestId, op: "status" }).pipe(
        Effect.flatMap((parsed) => {
          const status = decodeServiceStatus(parsed)
          if (status._tag === "Failure") return serviceFailure(parsed, options.vmId, options.requestId)
          const response = status.success
          if (response.id !== options.requestId) {
            return Effect.fail(new GuestTransportFault({
              vmId: options.vmId,
              reason: "guest service response id mismatch"
            }))
          }
          if (response.state === "not_started") {
            return Effect.succeed<WebServiceState>({ state: "not_started" })
          }
          if (response.startedAtEpochMs === undefined) {
            return Effect.fail(new GuestTransportFault({
              vmId: options.vmId,
              reason: `guest service ${response.state} status omitted startedAtEpochMs`
            }))
          }
          if (response.state === "running") {
            return Effect.succeed<WebServiceState>({
              state: "running",
              startedAtEpochMs: response.startedAtEpochMs
            })
          }
          if (response.exitCode === undefined) {
            return Effect.fail(new GuestTransportFault({
              vmId: options.vmId,
              reason: "guest service exited status omitted exit code"
            }))
          }
          return Effect.succeed<WebServiceState>({
            state: "exited",
            startedAtEpochMs: response.startedAtEpochMs,
            exitCode: response.exitCode,
            signal: response.signal ?? null
          })
        })
      )

    const stop: GuestServiceChannel["Service"]["stop"] = (options) =>
      exchange(options, { version: 1, id: options.requestId, op: "stop" }).pipe(
        Effect.flatMap((parsed) => {
          const stopped = decodeServiceStopped(parsed)
          if (stopped._tag === "Failure") return serviceFailure(parsed, options.vmId, options.requestId)
          if (stopped.success.id !== options.requestId) {
            return Effect.fail(new GuestTransportFault({
              vmId: options.vmId,
              reason: "guest service response id mismatch"
            }))
          }
          return Effect.succeed({ stopped: stopped.success.stopped })
        })
      )

    return GuestServiceChannel.of({ start, status, stop })
  })
)

interface StreamState {
  readonly chunks: Array<Buffer>
  bytes: number
  expectedSeq: number
}

/**
 * Consumes framed output with a bounded, amortized-linear line accumulator:
 * fragments are collected as chunk slices and only complete lines are
 * concatenated once, so a fragmented 8 MiB line cannot trigger quadratic
 * copying.
 */
const readGuestFrames = (
  socket: Socket,
  options: {
    readonly vmId: string
    readonly execId: string
    readonly limits: ExecLimits
  }
) =>
  Effect.callback<GuestExecSuccess, GuestExecError | GuestTransportFault>((resume) => {
    const { vmId, execId, limits } = options
    let finished = false
    const stdout: StreamState = { chunks: [], bytes: 0, expectedSeq: 0 }
    const stderr: StreamState = { chunks: [], bytes: 0, expectedSeq: 0 }
    let truncated = false
    let lineChunks: Array<Buffer> = []
    let lineBytes = 0

    const detach = (): void => {
      socket.off("data", onData)
      socket.off("error", onError)
      socket.off("close", onClose)
    }
    const fault = (reason: string): void => {
      if (finished) return
      finished = true
      detach()
      resume(Effect.fail(new GuestTransportFault({ vmId, reason })))
    }

    /**
     * Absorbs decoded output bytes. A compliant guest kills the workload at
     * the cap, so receiving MORE bytes than negotiated is a compromised-guest
     * protocol violation, never a truncation. Empty payloads are likewise a
     * violation: the guest never emits zero-byte data frames.
     */
    const absorb = (state: StreamState, data: Buffer): boolean => {
      if (data.length === 0) return false
      if (state.bytes + data.length > limits.maxOutputBytesPerStream) return false
      state.bytes += data.length
      state.chunks.push(data)
      return true
    }

    const handleLine = (line: Buffer): void => {
      if (line.length > MAX_JSONL_LINE_BYTES) {
        fault("guest frame exceeded maximum line size")
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(line.toString("utf8"))
      } catch {
        fault("guest sent a non-JSON frame")
        return
      }

      const data = decodeData(parsed)
      if (data._tag === "Success") {
        const frame = data.success
        if (frame.id !== execId) {
          fault("guest frame id mismatch")
          return
        }
        const state = frame.type === "stdout" ? stdout : stderr
        if (!Number.isInteger(frame.seq) || frame.seq !== state.expectedSeq) {
          fault(`guest ${frame.type} seq ${String(frame.seq)} out of order`)
          return
        }
        state.expectedSeq += 1
        const bytes = decodeStrictBase64(frame.data)
        if (bytes === undefined) {
          fault("guest frame payload is not strict base64")
          return
        }
        if (!absorb(state, bytes)) {
          fault(
            bytes.length === 0
              ? "guest sent an empty data frame"
              : `guest sent more than ${limits.maxOutputBytesPerStream} bytes on ${frame.type}`
          )
        }
        return
      }

      const exit = decodeExit(parsed)
      if (exit._tag === "Success") {
        const frame = exit.success
        if (frame.id !== execId) {
          fault("guest frame id mismatch")
          return
        }
        finished = true
        detach()
        resume(Effect.succeed({
          _tag: "Exit",
          frame: {
            code: frame.code,
            signal: frame.signal,
            timedOut: frame.timedOut,
            outputTruncated: truncated || frame.outputTruncated,
            stdout: Buffer.concat(stdout.chunks),
            stderr: Buffer.concat(stderr.chunks)
          }
        }))
        return
      }

      const error = decodeError(parsed)
      if (error._tag === "Success") {
        const frame = error.success
        if (frame.id !== execId) {
          fault("guest frame id mismatch")
          return
        }
        finished = true
        detach()
        if (frame.code === "INTERNAL") {
          // Guest-internal failures leave workload state unknowable: fault so
          // the daemon poisons the VM instead of trusting it.
          resume(Effect.fail(new GuestTransportFault({
            vmId,
            reason: `guest INTERNAL: ${frame.message.slice(0, 300)}`
          })))
          return
        }
        resume(Effect.succeed({
          _tag: "GuestError",
          code: frame.code,
          message: frame.message.slice(0, 500)
        }))
        return
      }

      // Fail closed: no unknown or malformed frame types are tolerated.
      fault("guest sent an unknown or invalid frame")
    }

    const onData = (chunk: Buffer): void => {
      let start = 0
      while (true) {
        const index = chunk.indexOf(0x0a, start)
        if (index === -1) break
        if (lineChunks.length > 0) {
          lineChunks.push(chunk.subarray(start, index))
          handleLine(Buffer.concat(lineChunks))
          lineChunks = []
          lineBytes = 0
        } else {
          handleLine(chunk.subarray(start, index))
        }
        if (finished) return
        start = index + 1
      }
      const rest = chunk.subarray(start)
      if (rest.length > 0) {
        lineChunks.push(rest)
        lineBytes += rest.length
        if (lineBytes > MAX_JSONL_LINE_BYTES) {
          fault("unfinished guest line exceeded maximum line size")
        }
      }
    }
    const onError = (cause: Error): void => fault(`vsock error: ${String(cause)}`)
    const onClose = (): void => fault("guest closed the connection before a terminal frame")

    socket.on("data", onData)
    socket.on("error", onError)
    socket.on("close", onClose)
    socket.resume()
  })
