import { NodeHttpServer } from "@effect/platform-node"
import { Cause, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Result, Schema, Scope, Semaphore } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { randomBytes } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rmdir, writeFile } from "node:fs/promises"
import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { join } from "node:path"
import { authLayer, authorizeVm, CredentialStore, requireAdmin } from "./auth.js"
import { isLoopbackHost, secureOrigin } from "./endpoint.js"
import {
  clampLimits,
  defaultLimits,
  Firecracker,
  FirecrackerLive,
  GuestExecChannel,
  GuestExecChannelLive,
  GuestTransportFault,
  VmTeardownFault,
  type VmHandle
} from "./firecracker.js"
import {
  CidAllocator,
  destroyVmDir,
  HostPrereqs,
  ImageAllowlist,
  JailerUidAllocator,
  saveVmState,
  vmLayout,
  type VmLayout
} from "./host.js"
import {
  BootFailed,
  CapacityExceeded,
  CleanupResult,
  CreateResult,
  DestroyUncertain,
  DestroyResult,
  ExecResult,
  Forbidden,
  GuestExecError,
  HostPrereqFailed,
  ImageNotAllowed,
  ListResult,
  MicrovmRpc,
  SandboxContext,
  VmInfo,
  VmNotFound,
  VmPoisoned,
  execRejection,
  type Credential,
  type VmId,
  type CreateRequest,
  type ExecuteRequest,
} from "./protocol.js"

const positiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const port = nonNegativeInt.check(Schema.isLessThanOrEqualTo(65_535))
const positiveRange = Schema.Tuple([positiveInt, positiveInt])

export class DaemonConfig extends Schema.Class<DaemonConfig>("DaemonConfig")({
  listen: Schema.Struct({ host: Schema.String, port }),
  advertisedUrl: Schema.String,
  tls: Schema.optional(Schema.Struct({ cert: Schema.String, key: Schema.String, ca: Schema.String })),
  auth: Schema.Struct({ adminTokens: Schema.Array(Schema.String) }),
  firecracker: Schema.Struct({
    firecrackerBinary: Schema.String,
    flockBinary: Schema.optional(Schema.String),
    jailerBinary: Schema.String,
    kernelImage: Schema.String,
    imagesDir: Schema.String,
    runStateDir: Schema.String,
    jailerUidRange: positiveRange,
    jailerGidRange: positiveRange,
    jailerParentCgroup: Schema.optional(Schema.String),
    guestCidRange: positiveRange,
    kernelArgs: Schema.String,
    bootTimeoutMs: positiveInt,
    guestReadinessTimeoutMs: positiveInt,
    vmmOverheadMib: positiveInt,
    maxPidsPerVm: positiveInt,
    jailerFsizeBytes: positiveInt,
    jailerNoFileLimit: positiveInt
  }),
  limits: Schema.Struct({
    maxVms: positiveInt,
    defaultCpus: positiveInt,
    maxCpus: positiveInt,
    defaultMemMib: positiveInt,
    maxMemMib: positiveInt,
    maxTtlSeconds: positiveInt
  })
}) {}

export class DaemonConfigError extends Schema.TaggedError<DaemonConfigError>()("DaemonConfigError", {
  reason: Schema.String
}) {}

export class DaemonRuntimeError extends Schema.TaggedError<DaemonRuntimeError>()("DaemonRuntimeError", {
  reason: Schema.String
}) {}


const expandEnvironment = (value: unknown): unknown => {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = process.env[name]
      if (replacement === undefined) throw new Error(`environment variable ${name} is not set`)
      return replacement
    })
  }
  if (Array.isArray(value)) return value.map(expandEnvironment)
  if (value !== null && typeof value === "object") {
    const expanded: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) expanded[key] = expandEnvironment(item)
    return expanded
  }
  return value
}

const validateConfig = (config: DaemonConfig): DaemonConfig => {
  if (!isLoopbackHost(config.listen.host) && config.tls === undefined) {
    throw new Error("TLS is required when listening on a non-loopback address")
  }
  secureOrigin(config.advertisedUrl)
  if (config.auth.adminTokens.length === 0 || config.auth.adminTokens.some((token) => token.length < 16)) {
    throw new Error("auth.adminTokens must contain at least one token of 16 or more characters")
  }
  if (config.tls !== undefined &&
    (config.tls.cert.length === 0 || config.tls.key.length === 0 || config.tls.ca.length === 0)) {
    throw new Error("tls.cert, tls.key, and tls.ca must all be non-empty")
  }
  if (config.limits.defaultCpus > config.limits.maxCpus) {
    throw new Error("limits.defaultCpus cannot exceed limits.maxCpus")
  }
  if (config.limits.defaultMemMib > config.limits.maxMemMib) {
    throw new Error("limits.defaultMemMib cannot exceed limits.maxMemMib")
  }
  const ranges = [
    ["firecracker.jailerUidRange", config.firecracker.jailerUidRange],
    ["firecracker.jailerGidRange", config.firecracker.jailerGidRange],
    ["firecracker.guestCidRange", config.firecracker.guestCidRange]
  ] as const
  for (const [name, range] of ranges) {
    if (range[1] < range[0]) throw new Error(`${name} must have min <= max`)
    if (range[1] - range[0] + 1 < config.limits.maxVms) {
      throw new Error(`${name} must contain at least limits.maxVms values`)
    }
  }
  return config
}

export const loadDaemonConfig = (path: string): Effect.Effect<DaemonConfig, DaemonConfigError> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await readFile(path, "utf8")
      const parsed: unknown = JSON.parse(raw)
      return validateConfig(Schema.decodeUnknownSync(DaemonConfig)(expandEnvironment(parsed)))
    },
    catch: () => new DaemonConfigError({ reason: `daemon configuration is unreadable or invalid: ${path}` })
  })

interface Allocation {
  readonly uid: number
  readonly gid: number
  readonly cid: number
}

interface VmRecord extends Allocation {
  info: VmInfo
  readonly handle: VmHandle
  readonly layout: VmLayout
  poisoned: boolean
  destroyGate: Deferred.Deferred<DestroyResult, DaemonRuntimeError | VmTeardownFault> | undefined
  readonly execSemaphore: Semaphore.Semaphore
}

interface Quarantine {
  readonly vmId: VmId
  readonly layout: VmLayout
  readonly allocation: Allocation | undefined
  readonly handle: VmHandle | undefined
}

interface KernelLock {
  readonly lost: Effect.Effect<never, DaemonRuntimeError>
}


export class VmRegistry extends Context.Service<VmRegistry, {
  readonly create: (
    request: CreateRequest,
    credential: Credential
  ) => Effect.Effect<CreateResult, Forbidden | ImageNotAllowed | CapacityExceeded | HostPrereqFailed | BootFailed>
  readonly execute: (
    request: ExecuteRequest,
    credential: Credential
  ) => Effect.Effect<ExecResult, Forbidden | VmNotFound | VmPoisoned | GuestExecError>
  readonly inspect: (vmId: VmId, credential: Credential) => Effect.Effect<VmInfo, Forbidden | VmNotFound>
  readonly destroy: (
    vmId: VmId,
    credential: Credential
  ) => Effect.Effect<DestroyResult, Forbidden | VmNotFound | DestroyUncertain>
  readonly list: (credential: Credential) => Effect.Effect<ListResult>
  readonly cleanup: (credential: Credential) => Effect.Effect<CleanupResult, Forbidden | DestroyUncertain>
  readonly lockLost: Effect.Effect<never, DaemonRuntimeError>
}>()("microvm/daemon/VmRegistry") {
  static readonly layer = (
    config: DaemonConfig,
    unsafeSkipKernelLockForTests = false
  ): Layer.Layer<
    VmRegistry,
    DaemonRuntimeError | HostPrereqFailed,
    HostPrereqs | ImageAllowlist | CidAllocator | JailerUidAllocator | Firecracker | GuestExecChannel | CredentialStore
  > => Layer.effect(VmRegistry)(makeVmRegistry(config, unsafeSkipKernelLockForTests))
}


const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"

interface KernelLockResource extends KernelLock {
  readonly child: ChildProcessWithoutNullStreams
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
  readonly beginRelease: () => void
}

const LOCK_HELPER_SCRIPT =
  "process.stdout.write('READY\\n'); process.stdin.resume(); process.stdin.once('end', () => process.exit(0))"

const MAX_RPC_BODY_BYTES = 1_048_576
const MAX_HTTP_HEADER_BYTES = 16_384
const HTTP_HEADERS_TIMEOUT_MS = 5_000
const HTTP_REQUEST_TIMEOUT_MS = 30_000

const killLockProcessGroup = (child: ChildProcessWithoutNullStreams): void => {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

const startKernelLock = (
  flockBinary: string,
  lockPath: string
): Effect.Effect<KernelLockResource, DaemonRuntimeError> =>
  Effect.callback((resume, signal) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(
        flockBinary,
        ["--exclusive", "--nonblock", lockPath, process.execPath, "-e", LOCK_HELPER_SCRIPT],
        { detached: true, stdio: ["pipe", "pipe", "pipe"] }
      )
    } catch (cause) {
      resume(Effect.fail(new DaemonRuntimeError({ reason: `cannot start kernel lock helper: ${String(cause)}` })))
      return
    }
    type LockExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null }
    let resolveExit: (exit: LockExit) => void = () => undefined
    const exit = new Promise<LockExit>((resolve) => {
      resolveExit = resolve
    })
    let releasing = false
    let settled = false
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killLockProcessGroup(child)
      resume(Effect.fail(new DaemonRuntimeError({ reason: `kernel lock acquisition timed out: ${lockPath}` })))
    }, 5_000)
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString("utf8", 0, 4_096 - stderr.length)
    })
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return
      stdout += chunk.toString("utf8")
      if (stdout.length > 64 || (!"READY\n".startsWith(stdout) && !stdout.startsWith("READY\n"))) {
        settled = true
        clearTimeout(timer)
        killLockProcessGroup(child)
        resume(Effect.fail(new DaemonRuntimeError({ reason: "kernel lock helper returned an invalid readiness message" })))
        return
      }
      if (!stdout.includes("\n")) return
      if (stdout !== "READY\n") {
        settled = true
        clearTimeout(timer)
        killLockProcessGroup(child)
        resume(Effect.fail(new DaemonRuntimeError({ reason: "kernel lock helper returned an invalid readiness message" })))
        return
      }
      settled = true
      clearTimeout(timer)
      const lost = Effect.promise(() => exit).pipe(
        Effect.flatMap(({ code, signal: childSignal }) => releasing
          ? Effect.never
          : Effect.fail(new DaemonRuntimeError({
            reason: `kernel lock helper exited unexpectedly (code ${String(code)}, signal ${String(childSignal)})`
          })))
      )
      resume(Effect.succeed({
        child,
        exit,
        lost,
        beginRelease: () => {
          releasing = true
        }
      }))
    })
    child.once("error", (cause) => {
      if (settled) return
      settled = true
      resume(Effect.fail(new DaemonRuntimeError({ reason: `kernel lock helper failed: ${cause.message}` })))
    })
    child.once("exit", (code, childSignal) => {
      resolveExit({ code, signal: childSignal })
      if (settled) return
      settled = true
      clearTimeout(timer)
      const detail = stderr.trim().length === 0 ? "" : `: ${stderr.trim()}`
      resume(Effect.fail(new DaemonRuntimeError({
        reason: `another daemon holds ${lockPath} or flock failed (code ${String(code)})${detail}`
      })))
    })
    signal.addEventListener("abort", () => {
      if (!settled) killLockProcessGroup(child)
    }, { once: true })
    return Effect.sync(() => {
      clearTimeout(timer)
      if (!settled) killLockProcessGroup(child)
    })
  })

const releaseKernelLock = (resource: KernelLockResource): Effect.Effect<void> =>
  Effect.callback((resume) => {
    resource.beginRelease()
    const forced = setTimeout(() => killLockProcessGroup(resource.child), 2_000)
    const bounded = setTimeout(() => resume(Effect.void), 3_000)
    resource.exit.then(() => {
      clearTimeout(forced)
      clearTimeout(bounded)
      resume(Effect.void)
    })
    try {
      resource.child.stdin.end()
    } catch {
      killLockProcessGroup(resource.child)
    }
    return Effect.sync(() => {
      clearTimeout(forced)
      clearTimeout(bounded)
    })
  })

const acquireDaemonLock = (
  config: DaemonConfig,
  unsafeSkipKernelLockForTests: boolean
): Effect.Effect<KernelLock, DaemonRuntimeError, Scope.Scope> =>
  unsafeSkipKernelLockForTests
    ? process.env["NODE_ENV"] === "test"
      ? Effect.succeed({ lost: Effect.never })
      : Effect.fail(new DaemonRuntimeError({ reason: "kernel lock may be skipped only under the test runtime" }))
    : Effect.gen(function*() {
      yield* Effect.tryPromise({
        try: () => mkdir(config.firecracker.runStateDir, { recursive: true, mode: 0o700 }),
        catch: (cause) => new DaemonRuntimeError({ reason: `cannot prepare run-state directory: ${String(cause)}` })
      })
      const lockPath = join(config.firecracker.runStateDir, "daemon.lock")
      const resource = yield* Effect.acquireRelease(
        startKernelLock(config.firecracker.flockBinary ?? "/usr/bin/flock", lockPath),
        releaseKernelLock
      )
      yield* Effect.tryPromise({
        try: () => writeFile(
          join(config.firecracker.runStateDir, "daemon.owner.json"),
          JSON.stringify({
            pid: process.pid,
            lockHelperPid: resource.child.pid,
            startedAt: new Date().toISOString()
          }),
          { encoding: "utf8", mode: 0o600 }
        ),
        catch: (cause) => new DaemonRuntimeError({ reason: `cannot write daemon owner diagnostics: ${String(cause)}` })
      })
      return resource
    })

const cleanupCgroup = (layout: VmLayout): Effect.Effect<void, DaemonRuntimeError> =>
  Effect.gen(function*() {
    if (!existsSync(layout.cgroupDir)) return
    yield* Effect.tryPromise({
      try: async () => {
        try {
          await writeFile(join(layout.cgroupDir, "cgroup.kill"), "1")
        } catch (cause) {
          if (!isMissing(cause)) throw cause
        }
      },
      catch: (cause) => new DaemonRuntimeError({ reason: `cannot kill cgroup ${layout.cgroupDir}: ${String(cause)}` })
    })
    const deadline = Date.now() + 5_000
    while (true) {
      const procs = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await readFile(join(layout.cgroupDir, "cgroup.procs"), "utf8")
          } catch (cause) {
            if (isMissing(cause)) return ""
            throw cause
          }
        },
        catch: (cause) => new DaemonRuntimeError({ reason: `cannot inspect cgroup ${layout.cgroupDir}: ${String(cause)}` })
      })
      if (procs.trim().length === 0) break
      if (Date.now() >= deadline) {
        return yield* Effect.fail(new DaemonRuntimeError({
          reason: `cgroup ${layout.cgroupDir} still contains processes after 5 seconds`
        }))
      }
      yield* Effect.sleep(50)
    }
    yield* Effect.tryPromise({
      try: async () => {
        try {
          await rmdir(layout.cgroupDir)
        } catch (cause) {
          if (!isMissing(cause)) throw cause
        }
      },
      catch: (cause) => new DaemonRuntimeError({ reason: `cannot remove cgroup ${layout.cgroupDir}: ${String(cause)}` })
    })
  })

const recoverStaleVms = (config: DaemonConfig): Effect.Effect<void, DaemonRuntimeError> =>
  Effect.gen(function*() {
    const root = join(config.firecracker.runStateDir, "vms")
    const entries = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await readdir(root, { withFileTypes: true })
        } catch (cause) {
          if (isMissing(cause)) return []
          throw cause
        }
      },
      catch: (cause) => new DaemonRuntimeError({ reason: `cannot scan ${root}: ${String(cause)}` })
    })
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^mvm-[0-9a-z]{8,24}$/.test(entry.name)) {
        return yield* Effect.fail(new DaemonRuntimeError({ reason: `unexpected VM state entry: ${entry.name}` }))
      }
      const layout = vmLayout(config.firecracker, entry.name)
      yield* cleanupCgroup(layout)
      yield* destroyVmDir(config.firecracker.runStateDir, entry.name).pipe(
        Effect.mapError((cause) => new DaemonRuntimeError({ reason: cause.reason }))
      )
    }
  })

const makeVmRegistry = (config: DaemonConfig, unsafeSkipKernelLockForTests: boolean) =>
  Effect.gen(function*() {
    const prereqs = yield* HostPrereqs
    const images = yield* ImageAllowlist
    const cids = yield* CidAllocator
    const jailerUids = yield* JailerUidAllocator
    const firecracker = yield* Firecracker
    const guest = yield* GuestExecChannel
    const credentials = yield* CredentialStore
    const daemonScope = yield* Scope.Scope
    const capabilities = yield* prereqs.verifyAll()
    const kernelLock = yield* acquireDaemonLock(config, unsafeSkipKernelLockForTests)
    yield* recoverStaleVms(config)

    const records = new Map<string, VmRecord>()
    const quarantines = new Map<string, Quarantine>()
    const reservations = new Set<string>()
    const bootCancels = new Set<() => Effect.Effect<void>>()
    const mutex = yield* Semaphore.make(1)
    const capacity = yield* Semaphore.make(config.limits.maxVms)

    const withCredential = <A, E>(credential: Credential, effect: Effect.Effect<A, E, SandboxContext>) =>
      Effect.provideService(effect, SandboxContext, SandboxContext.of({ credential }))

    const allocateVmId = mutex.withPermit(Effect.sync((): VmId => {
      for (let attempt = 0; attempt < 128; attempt++) {
        const suffix = BigInt(`0x${randomBytes(10).toString("hex")}`).toString(36)
        const vmId = `mvm-${suffix}` as VmId
        if (!records.has(vmId) && !reservations.has(vmId)) {
          reservations.add(vmId)
          return vmId
        }
      }
      throw new Error("unable to allocate a collision-free VM id")
    }))

    const cleanupPartial = (
      quarantine: Quarantine
    ): Effect.Effect<void, DaemonRuntimeError | VmTeardownFault> =>
      (quarantine.handle === undefined ? Effect.void : quarantine.handle.stop()).pipe(
        Effect.andThen(cleanupCgroup(quarantine.layout)),
        Effect.andThen(destroyVmDir(config.firecracker.runStateDir, quarantine.vmId)),
        Effect.mapError((cause) => cause instanceof VmTeardownFault
          ? cause
          : new DaemonRuntimeError({ reason: "reason" in cause ? String(cause.reason) : String(cause) }))
      )

    const teardown = (
      record: VmRecord
    ): Effect.Effect<void, DaemonRuntimeError | VmTeardownFault> =>
      cleanupPartial({ vmId: record.info.vmId, layout: record.layout, allocation: record, handle: record.handle })

    const releaseAllocation = (allocation: Allocation | undefined): void => {
      if (allocation === undefined) return
      cids.release(allocation.cid)
      jailerUids.release(allocation.uid, allocation.gid)
    }

    const forgetRecord = (record: VmRecord): Effect.Effect<boolean> =>
      mutex.withPermit(Effect.sync(() => {
        if (records.get(record.info.vmId) !== record) return false
        records.delete(record.info.vmId)
        credentials.forgetVm(record.info.vmId)
        releaseAllocation(record)
        return true
      })).pipe(
        Effect.flatMap((removed) => removed ? capacity.release(1).pipe(Effect.as(true)) : Effect.succeed(false))
      )

    const markPoisoned = (record: VmRecord): Effect.Effect<void> =>
      mutex.withPermit(Effect.sync(() => {
        if (records.get(record.info.vmId) !== record) return
        record.poisoned = true
        record.info = new VmInfo({ ...record.info, state: "poisoned" })
      }))

    const destroyRecord = (
      record: VmRecord
    ): Effect.Effect<DestroyResult, DaemonRuntimeError | VmTeardownFault> =>
      Effect.gen(function*() {
        const candidate = yield* Deferred.make<DestroyResult, DaemonRuntimeError | VmTeardownFault>()
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function*() {
            const claim = yield* mutex.withPermit(Effect.sync(() => {
              if (records.get(record.info.vmId) !== record) return undefined
              if (record.destroyGate !== undefined) return { gate: record.destroyGate, owner: false } as const
              record.destroyGate = candidate
              record.poisoned = true
              record.info = new VmInfo({ ...record.info, state: "poisoned" })
              return { gate: candidate, owner: true } as const
            }))
            if (claim === undefined) return new DestroyResult({ vmId: record.info.vmId, destroyed: false })
            if (!claim.owner) return yield* restore(Deferred.await(claim.gate))

            const ownerOutcome = yield* Effect.exit(Effect.gen(function*() {
              yield* teardown(record)
              const removed = yield* forgetRecord(record)
              return new DestroyResult({ vmId: record.info.vmId, destroyed: removed })
            }))
            if (Exit.isSuccess(ownerOutcome)) {
              yield* Deferred.succeed(candidate, ownerOutcome.value)
              return ownerOutcome.value
            }

            const typed = Cause.findError(ownerOutcome.cause)
            const gateFailure = Result.isSuccess(typed)
              ? typed.success
              : new DaemonRuntimeError({ reason: "VM teardown failed unexpectedly" })
            yield* Deferred.fail(candidate, gateFailure)
            yield* mutex.withPermit(Effect.sync(() => {
              if (records.get(record.info.vmId) === record && record.destroyGate === candidate) {
                record.destroyGate = undefined
              }
            }))
            return yield* Effect.failCause(ownerOutcome.cause)
          })
        )
      })

    const destroyAfterInterrupt = (record: VmRecord): Effect.Effect<void> =>
      destroyRecord(record).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.logError("interrupted VM teardown failed", cause))
      )

    const cleanupQuarantine = (
      quarantine: Quarantine
    ): Effect.Effect<boolean, DaemonRuntimeError | VmTeardownFault> =>
      Effect.gen(function*() {
        yield* cleanupPartial(quarantine)
        const removed = yield* mutex.withPermit(Effect.sync(() => {
          if (quarantines.get(quarantine.vmId) !== quarantine) return false
          quarantines.delete(quarantine.vmId)
          reservations.delete(quarantine.vmId)
          releaseAllocation(quarantine.allocation)
          return true
        }))
        if (removed) yield* capacity.release(1)
        return removed
      })

    const createAuthorized = (request: CreateRequest) =>
      Effect.gen(function*() {
        const hasCapacity = yield* capacity.takeIfAvailable(1)
        if (!hasCapacity) {
          return yield* Effect.fail(new CapacityExceeded({ message: "maximum running VM capacity reached" }))
        }
        let vmId: VmId | undefined
        let allocation: Allocation | undefined
        let handle: VmHandle | undefined
        let tokenMinted = false
        let committed = false

        const cleanupFailedCreate = Effect.gen(function*() {
          if (tokenMinted && vmId !== undefined) credentials.forgetVm(vmId)
          if (vmId === undefined) {
            yield* capacity.release(1)
            return
          }
          const quarantine: Quarantine = {
            vmId,
            layout: vmLayout(config.firecracker, vmId),
            allocation,
            handle
          }
          const cleanup = yield* Effect.result(cleanupPartial(quarantine))
          if (Result.isFailure(cleanup)) {
            yield* mutex.withPermit(Effect.sync(() => quarantines.set(vmId!, quarantine)))
            return yield* Effect.fail(new BootFailed({
              vmId,
              reason: `failed create was quarantined because cleanup was uncertain: ${cleanup.failure.reason}`
            }))
          }
          releaseAllocation(allocation)
          yield* mutex.withPermit(Effect.sync(() => reservations.delete(vmId!)))
          yield* capacity.release(1)
        })

        return yield* Effect.gen(function*() {
          const image = yield* images.resolve(request.image)
          if (image.manifest.arch !== capabilities.arch) {
            return yield* Effect.fail(new ImageNotAllowed({ image: request.image }))
          }
          vmId = yield* allocateVmId
          allocation = yield* Effect.try({
            try: () => {
              const { uid, gid } = jailerUids.allocate()
              try {
                return { uid, gid, cid: cids.allocate() }
              } catch (cause) {
                jailerUids.release(uid, gid)
                throw cause
              }
            },
            catch: (cause) => new CapacityExceeded({ message: `host identifier space exhausted: ${String(cause)}` })
          })
          const cpus = Math.min(request.cpus ?? config.limits.defaultCpus, config.limits.maxCpus)
          const memMib = Math.min(request.memMib ?? config.limits.defaultMemMib, config.limits.maxMemMib)
          const ttlSeconds = Math.min(request.ttlSeconds ?? config.limits.maxTtlSeconds, config.limits.maxTtlSeconds)
          const createdAtEpochMs = Date.now()
          const expiresAtEpochMs = createdAtEpochMs + ttlSeconds * 1_000
          const layout = vmLayout(config.firecracker, vmId)
          const bootFiber = yield* firecracker.boot({
            vmId,
            guestCid: allocation.cid,
            cpus,
            memMib,
            kernelArgs: config.firecracker.kernelArgs,
            layout,
            uid: allocation.uid,
            gid: allocation.gid
          }, image).pipe(
            Effect.mapError((cause) => new BootFailed({ vmId: vmId!, reason: String(cause) })),
            Effect.forkIn(daemonScope)
          )
          const cancelBoot = (): Effect.Effect<void> => Fiber.interrupt(bootFiber).pipe(Effect.asVoid)
          bootCancels.add(cancelBoot)
          handle = yield* Fiber.join(bootFiber).pipe(
            Effect.onInterrupt(cancelBoot),
            Effect.ensuring(Effect.sync(() => bootCancels.delete(cancelBoot)))
          )
          const sandboxToken = credentials.mintSandbox(vmId)
          tokenMinted = true
          yield* saveVmState(layout.statePath, {
            vmId,
            image: request.image,
            cpus,
            memMib,
            guestCid: allocation.cid,
            createdAtEpochMs,
            expiresAtEpochMs,
            poisoned: false
          }).pipe(Effect.mapError((cause) => new BootFailed({ vmId: vmId!, reason: cause.reason })))
          const info = new VmInfo({
            vmId,
            owningHost: secureOrigin(config.advertisedUrl).origin,
            state: "running",
            image: request.image,
            cpus,
            memMib,
            createdAtEpochMs,
            expiresAtEpochMs
          })
          const record: VmRecord = {
            info,
            handle,
            uid: allocation.uid,
            gid: allocation.gid,
            cid: allocation.cid,
            layout,
            poisoned: false,
            destroyGate: undefined,
            execSemaphore: Semaphore.makeUnsafe(1)
          }
          yield* mutex.withPermit(Effect.sync(() => {
            reservations.delete(vmId!)
            records.set(vmId!, record)
          }))
          committed = true
          yield* handle.exited.pipe(
            Effect.andThen(markPoisoned(record)),
            Effect.forkIn(daemonScope)
          )
          return new CreateResult({ vm: info, sandboxToken })
        }).pipe(Effect.onExit((exit) => Exit.isSuccess(exit) && committed ? Effect.void : cleanupFailedCreate))
      })

    const create = (request: CreateRequest, credential: Credential) =>
      withCredential(credential, requireAdmin).pipe(Effect.andThen(createAuthorized(request)))

    const getRecord = (vmId: VmId): Effect.Effect<VmRecord, VmNotFound> =>
      mutex.withPermit(Effect.sync(() => records.get(vmId))).pipe(
        Effect.flatMap((record) => record === undefined
          ? Effect.fail(new VmNotFound({ vmId }))
          : Effect.succeed(record))
      )

    const executeAuthorized = (request: ExecuteRequest) =>
      Effect.gen(function*() {
        const record = yield* getRecord(request.vmId)
        const rejection = execRejection(request.argv, request.cwd, request.env)
        if (rejection !== undefined) {
          return yield* Effect.fail(new GuestExecError({ vmId: request.vmId, code: "INVALID_REQUEST", message: rejection }))
        }
        const defaults = defaultLimits()
        const limits = clampLimits({
          timeoutMs: request.timeoutMs ?? defaults.timeoutMs,
          maxOutputBytesPerStream: request.maxOutputBytes ?? defaults.maxOutputBytesPerStream
        })
        return yield* record.execSemaphore.withPermit(Effect.gen(function*() {
          const live = yield* mutex.withPermit(Effect.sync(() => records.get(request.vmId) === record))
          if (!live) return yield* Effect.fail(new VmNotFound({ vmId: request.vmId }))
          if (record.poisoned || record.destroyGate !== undefined) {
            return yield* Effect.fail(new VmPoisoned({ vmId: request.vmId, message: "VM is being destroyed" }))
          }
          if (record.info.expiresAtEpochMs !== undefined && record.info.expiresAtEpochMs <= Date.now()) {
            yield* Effect.result(destroyRecord(record))
            return yield* Effect.fail(new VmPoisoned({ vmId: request.vmId, message: "VM lifetime expired" }))
          }
          const execId = randomBytes(16).toString("hex")
          return yield* guest.exec({
            vmId: request.vmId,
            vsockSocket: record.layout.vsockSocket,
            execId,
            argv: request.argv,
            cwd: request.cwd,
            env: request.env,
            limits
          }).pipe(
            Effect.flatMap((result) => result._tag === "GuestError"
              ? Effect.fail(new GuestExecError({ vmId: request.vmId, code: result.code, message: result.message }))
              : Effect.succeed(new ExecResult({
                execId,
                exitCode: result.frame.code,
                signal: result.frame.signal ?? undefined,
                timedOut: result.frame.timedOut,
                outputTruncated: result.frame.outputTruncated,
                stdoutB64: result.frame.stdout.toString("base64"),
                stderrB64: result.frame.stderr.toString("base64")
              }))),
            Effect.catchTag("GuestTransportFault", (fault: GuestTransportFault) =>
              markPoisoned(record).pipe(
                Effect.andThen(Effect.fail(new VmPoisoned({ vmId: request.vmId, message: fault.reason })))
              )),
            Effect.catchTag("FirecrackerError", (fault) =>
              markPoisoned(record).pipe(
                Effect.andThen(Effect.fail(new VmPoisoned({ vmId: request.vmId, message: fault.reason })))
              )),
            Effect.onInterrupt(() => destroyAfterInterrupt(record))
          )
        }))
      })

    const execute = (request: ExecuteRequest, credential: Credential) =>
      withCredential(credential, authorizeVm(request.vmId)).pipe(Effect.andThen(executeAuthorized(request)))

    const inspect = (vmId: VmId, credential: Credential) =>
      withCredential(credential, authorizeVm(vmId)).pipe(
        Effect.andThen(getRecord(vmId)),
        Effect.map((record) => record.info)
      )

    const destroy = (vmId: VmId, credential: Credential) =>
      withCredential(credential, authorizeVm(vmId)).pipe(
        Effect.andThen(getRecord(vmId)),
        Effect.flatMap((record) => destroyRecord(record)),
        Effect.mapError((cause) => cause instanceof Forbidden || cause instanceof VmNotFound
          ? cause
          : new DestroyUncertain({
            vmId,
            phase: cause instanceof VmTeardownFault ? cause.phase : "cgroup",
            reason: cause.reason
          }))
      )

    const list = (credential: Credential) =>
      mutex.withPermit(Effect.sync(() => {
        const all = Array.from(records.values(), (record) => record.info)
        return new ListResult({
          vms: credential.kind === "admin"
            ? all.sort((left, right) => left.vmId.localeCompare(right.vmId))
            : all.filter((vm) => vm.vmId === credential.vmId)
        })
      }))

    const cleanupRecords = (): Effect.Effect<CleanupResult> =>
      Effect.gen(function*() {
        const now = Date.now()
        const candidates = yield* mutex.withPermit(Effect.sync(() =>
          Array.from(records.values()).filter((record) =>
            record.poisoned || (record.info.expiresAtEpochMs !== undefined && record.info.expiresAtEpochMs <= now)
          )
        ))
        const quarantined = yield* mutex.withPermit(Effect.sync(() => Array.from(quarantines.values())))
        const destroyed: Array<VmId> = []
        const failed: Array<{ readonly vmId: VmId; readonly reason: string }> = []
        for (const record of candidates) {
          const outcome = yield* Effect.result(destroyRecord(record))
          if (Result.isSuccess(outcome)) {
            if (outcome.success.destroyed) destroyed.push(record.info.vmId)
          } else failed.push({ vmId: record.info.vmId, reason: outcome.failure.reason })
        }
        for (const quarantine of quarantined) {
          const outcome = yield* Effect.result(cleanupQuarantine(quarantine))
          if (Result.isSuccess(outcome)) {
            if (outcome.success) destroyed.push(quarantine.vmId)
          } else failed.push({ vmId: quarantine.vmId, reason: outcome.failure.reason })
        }
        return new CleanupResult({ destroyed, failed })
      })

    const cleanup = (credential: Credential) =>
      withCredential(credential, requireAdmin).pipe(Effect.andThen(cleanupRecords()))

    const shutdown = Effect.gen(function*() {
      for (const cancel of Array.from(bootCancels)) yield* cancel()
      const live = yield* mutex.withPermit(Effect.sync(() => Array.from(records.values())))
      for (const record of live) {
        const outcome = yield* Effect.result(teardown(record))
        if (Result.isSuccess(outcome)) yield* forgetRecord(record)
        else yield* Effect.logError(`failed to stop ${record.info.vmId} during daemon shutdown`, outcome.failure)
      }
      const held = yield* mutex.withPermit(Effect.sync(() => Array.from(quarantines.values())))
      for (const quarantine of held) {
        yield* cleanupQuarantine(quarantine).pipe(
          Effect.catchCause((cause) => Effect.logError(`failed to clean ${quarantine.vmId} during shutdown`, cause))
        )
      }
    })
    yield* Scope.addFinalizer(daemonScope, shutdown)
    yield* Effect.forever(
      Effect.sleep(1_000).pipe(
        Effect.andThen(cleanupRecords()),
        Effect.catchCause((cause) => Effect.logError("VM reaper failed", cause))
      )
    ).pipe(Effect.forkIn(daemonScope))

    return VmRegistry.of({ create, execute, inspect, destroy, list, cleanup, lockLost: kernelLock.lost })
  })

export interface DaemonLayerOptions {
  readonly firecracker?: Layer.Layer<Firecracker>
  readonly guestExec?: Layer.Layer<GuestExecChannel>
  readonly prereqs?: Layer.Layer<HostPrereqs>
  readonly server?: HttpServer
  /** Test-only seam; rejected unless NODE_ENV is exactly \"test\". */
  readonly unsafeSkipKernelLockForTests?: boolean | undefined
}

export const daemonLayer = (config: DaemonConfig, options?: DaemonLayerOptions) => {
  const infrastructure = Layer.mergeAll(
    CredentialStore.layer(config.auth.adminTokens),
    options?.prereqs ?? HostPrereqs.layer(config.firecracker),
    ImageAllowlist.layer(config.firecracker.imagesDir),
    CidAllocator.layer(config.firecracker),
    JailerUidAllocator.layer(config.firecracker),
    options?.firecracker ?? FirecrackerLive(config.firecracker),
    options?.guestExec ?? GuestExecChannelLive
  )
  const registry = VmRegistry.layer(config, options?.unsafeSkipKernelLockForTests).pipe(Layer.provide(infrastructure))
  const handlers = MicrovmRpc.toLayer(Effect.gen(function*() {
    const service = yield* VmRegistry
    const authenticated = <A, E>(run: (credential: Credential) => Effect.Effect<A, E>) =>
      Effect.flatMap(SandboxContext, ({ credential }) => run(credential))
    return {
      create: (request) => authenticated((credential) => service.create(request, credential)),
      execute: (request) => authenticated((credential) => service.execute(request, credential)),
      inspect: ({ vmId }) => authenticated((credential) => service.inspect(vmId, credential)),
      destroy: ({ vmId }) => authenticated((credential) => service.destroy(vmId, credential)),
      list: () => authenticated(service.list),
      cleanup: () => authenticated(service.cleanup)
    }
  })).pipe(Layer.provide(registry))
  const authentication = authLayer.pipe(Layer.provide(infrastructure))
  const rpc = RpcServer.layerHttp({ group: MicrovmRpc, path: "/rpc", protocol: "http" }).pipe(
    Layer.provide([handlers, authentication, RpcSerialization.layerJson])
  )
  const nodeServer = options?.server ?? (config.tls === undefined
    ? createHttpServer({ maxHeaderSize: MAX_HTTP_HEADER_BYTES })
    : createHttpsServer({
      cert: config.tls.cert,
      key: config.tls.key,
      ca: config.tls.ca,
      maxHeaderSize: MAX_HTTP_HEADER_BYTES
    }))
  nodeServer.maxHeadersCount = 64
  nodeServer.headersTimeout = HTTP_HEADERS_TIMEOUT_MS
  nodeServer.requestTimeout = HTTP_REQUEST_TIMEOUT_MS
  const server = Layer.unwrap(
    Effect.map(VmRegistry, () => NodeHttpServer.layer(() => nodeServer, config.listen))
  ).pipe(Layer.provide(registry))
  const served = HttpRouter.serve(rpc, {
    disableLogger: true,
    middleware: (effect) => Effect.provideService(
      effect,
      HttpServerRequest.MaxBodySize,
      FileSystem.Size(MAX_RPC_BODY_BYTES)
    )
  }).pipe(Layer.provide(server))
  const lockGuard = Layer.effectDiscard(
    Effect.flatMap(VmRegistry, (service) => service.lockLost)
  ).pipe(Layer.provide(registry))
  return Layer.merge(served, lockGuard)
}
