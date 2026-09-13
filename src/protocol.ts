/**
 * Wire protocol shared by daemon and client: RPC contracts, the auth seam,
 * credential-scope errors, guest exec v1 constants, and the request-bounding
 * rules the daemon enforces before anything reaches the vsock transport.
 *
 * Callers can only ever reference images by allowlist name; there is no field
 * anywhere in this protocol for host paths, kernel paths, or boot arguments.
 *
 * Dependency direction is one-way: auth/host/firecracker/daemon -> protocol.
 */
import { Context, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/unstable/rpc"

// ---------------------------------------------------------------------------
// Guest fixed-purpose vsock ports. These are mirrored by the Go guest and are
// never selected by callers.
// ---------------------------------------------------------------------------

/** Finite command execution channel. */
export const GUEST_EXEC_VSOCK_PORT = 1024
/** HTTP preview channel. */
export const GUEST_HTTP_VSOCK_PORT = 1025
/** Durable web-service control channel. */
export const GUEST_SERVICE_VSOCK_PORT = 1026

/** Standard loopback web port in the Node guest image and its manifest. */
export const STANDARD_NODE_GUEST_WEB_PORT = 3000

/** Default per-exec wall-clock limit. */
export const DEFAULT_TIMEOUT_MS = 30_000
/** Hard maximum per-exec wall-clock limit. */
export const MAX_TIMEOUT_MS = 600_000
/** Default per-stream captured output limit. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
/** Hard maximum per-stream captured output limit. */
export const MAX_OUTPUT_BYTES_PER_STREAM = 8_388_608
/** Hard maximum size of one JSONL line in either direction. */
export const MAX_JSONL_LINE_BYTES = 8_388_608
/** Hard maximum UTF-8 JSON payload size for one service-control line, excluding newline. */
export const MAX_SERVICE_CONTROL_LINE_BYTES = 256 * 1024

// Request bounds the daemon enforces before opening a vsock connection.
export const MAX_ARGV_ENTRIES = 64
export const MAX_ARG_BYTES = 4096
export const MAX_ARGV_TOTAL_BYTES = 65_536
export const MAX_ENV_KEYS = 64
export const MAX_ENV_KEY_BYTES = 128
export const MAX_ENV_VALUE_BYTES = 8192
export const MAX_ENV_TOTAL_BYTES = 65_536
export const MAX_CWD_BYTES = 4096

// ---------------------------------------------------------------------------
// HTTP preview ingress bounds.
//
// These numbers are policy, not validation: the public Node adapter
// (`src/http-proxy.ts`) and the daemon data plane (`src/daemon-http-proxy.ts`)
// each enforce them with their own independent parsing, so a mistake in one hop
// is caught by the other rather than shared. Only the numbers live here, so the
// two hops cannot drift apart silently.
// ---------------------------------------------------------------------------

export const HTTP_PREVIEW_LIMITS = {
  /** Longest accepted origin-form request target, in bytes. */
  maxTargetBytes: 8 * 1024,
  /** Largest accepted request header block, in bytes. */
  maxHeaderBytes: 16 * 1024,
  /** Largest accepted number of request header fields. */
  maxHeaderFields: 64,
  /** Largest accepted request body, in bytes. */
  maxRequestBodyBytes: 16 * 1024 * 1024,
  /** Quiet period, in ms, after the last upload byte before an upload is abandoned. */
  uploadIdleMs: 30_000,
  /** Deadline, in ms, for the guest application's response head. */
  responseHeadMs: 120_000,
  /** Bound, in ms, on one refused detached socket flushing before it is destroyed. */
  refusalDeadlineMs: 2_000,
  /** Largest aggregate WebSocket message, in bytes. */
  maxWebSocketMessageBytes: 1024 * 1024,
  /** Read/write high-water mark for one framed WebSocket direction, in bytes. */
  frameBufferBytes: 64 * 1024
} as const

// ---------------------------------------------------------------------------
// Shared primitive schemas
// ---------------------------------------------------------------------------

/** VM identifiers: `mvm-` followed by lowercase base36. */
export const VmId = Schema.String.check(Schema.isPattern(/^mvm-[0-9a-z]{8,24}$/))
export type VmId = typeof VmId.Type

/** Exec ids handed to the guest: 1..128 safe chars. */
export const ExecId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/))

/** Operator image names as they appear in the daemon's allowlist directory. */
export const ImageName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/))

const positiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const boundedArg = Schema.String.check(Schema.isMaxLength(MAX_ARG_BYTES))
const boundedArgv = Schema.Array(boundedArg).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_ARGV_ENTRIES)
)
const boundedCwd = Schema.String.check(Schema.isMaxLength(MAX_CWD_BYTES))
const boundedEnvKey = Schema.String.check(Schema.isMaxLength(MAX_ENV_KEY_BYTES))
const boundedEnvValue = Schema.String.check(Schema.isMaxLength(MAX_ENV_VALUE_BYTES))


// ---------------------------------------------------------------------------
// Domain results
// ---------------------------------------------------------------------------

export class VmInfo extends Schema.Class<VmInfo>("VmInfo")({
  vmId: VmId,
  /** The cluster endpoint (host) currently owning this VM. */
  owningHost: Schema.String,
  state: Schema.Literals(["running", "poisoned", "terminated"]),
  image: ImageName,
  cpus: positiveInt,
  memMib: positiveInt,
  createdAtEpochMs: Schema.Number,
  expiresAtEpochMs: Schema.UndefinedOr(Schema.Number)
}) {}

export class ExecResult extends Schema.Class<ExecResult>("ExecResult")({
  execId: ExecId,
  exitCode: Schema.Number,
  /** POSIX signal name when the workload died from a signal, else undefined. */
  signal: Schema.UndefinedOr(Schema.String),
  timedOut: Schema.Boolean,
  outputTruncated: Schema.Boolean,
  /** Raw stdout bytes, base64 (standard alphabet). Bounded per stream. */
  stdoutB64: Schema.String,
  /** Raw stderr bytes, base64 (standard alphabet). Bounded per stream. */
  stderrB64: Schema.String
}) {}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {
  message: Schema.String
}) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String
}) {}

export class VmNotFound extends Schema.TaggedError<VmNotFound>()("VmNotFound", {
  vmId: VmId
}) {}

/** Quota exhausted, capacity full, or conflicting concurrent operation. */
export class CapacityExceeded extends Schema.TaggedError<CapacityExceeded>()("CapacityExceeded", {
  message: Schema.String
}) {}

/** The VM's guest is in an unknown/dirty state and must be destroyed. */
export class VmPoisoned extends Schema.TaggedError<VmPoisoned>()("VmPoisoned", {
  vmId: VmId,
  message: Schema.String
}) {}

/** Host-side prerequisites missing (KVM device access, cgroup v2, jailer, kernel, image). */
export class HostPrereqFailed extends Schema.TaggedError<HostPrereqFailed>()("HostPrereqFailed", {
  reason: Schema.String
}) {}

/** A VM failed to boot or died unexpectedly. */
export class BootFailed extends Schema.TaggedError<BootFailed>()("BootFailed", {
  vmId: VmId,
  reason: Schema.String
}) {}

/** The guest rejected or failed an exec request (guest exec v1 error codes). */
export class GuestExecError extends Schema.TaggedError<GuestExecError>()("GuestExecError", {
  vmId: VmId,
  code: Schema.Literals(["INVALID_REQUEST", "EXEC_FAILED", "INTERNAL"]),
  message: Schema.String
}) {}

/** Caller tried to use an image that is not on the operator allowlist. */
export class ImageNotAllowed extends Schema.TaggedError<ImageNotAllowed>()("ImageNotAllowed", {
  image: ImageName
}) {}

/**
 * Teardown could not be proven complete during destroy/cleanup: the VM may
 * still have live processes or residue. Callers must retry destroy and must
 * not treat the VM as released.
 */
export class DestroyUncertain extends Schema.TaggedError<DestroyUncertain>()("DestroyUncertain", {
  vmId: VmId,
  phase: Schema.Literals(["signal", "cgroup", "http"]),
  reason: Schema.String
}) {}
/** The image has no immutable `web` HTTP endpoint. */
export class HttpNotConfigured extends Schema.TaggedError<HttpNotConfigured>()("HttpNotConfigured", {
  vmId: VmId
}) {}

/**
 * Semantic failure of the single durable web-service lifecycle. Transport,
 * authentication, VM lookup and poison errors remain distinct.
 */
export class ClusterServiceError extends Schema.TaggedError<ClusterServiceError>()("ClusterServiceError", {
  vmId: VmId,
  code: Schema.Literals([
    "INVALID_REQUEST",
    "ALREADY_RUNNING",
    "NOT_RUNNING",
    "START_FAILED",
    "INTERNAL"
  ]),
  message: Schema.String
}) {}

// ---------------------------------------------------------------------------
// Auth contract (implementation lives in auth.ts)
// ---------------------------------------------------------------------------

export type Credential =
  | { readonly kind: "admin" }
  | { readonly kind: "sandbox"; readonly vmId: string }

/** Service carrying the authenticated credential into RPC handlers. */
export class SandboxContext extends Context.Service<SandboxContext, {
  readonly credential: Credential
}>()("microvm/auth/SandboxContext") {}

/**
 * RPC middleware authenticating every request, providing the verified
 * credential to handlers via {@link SandboxContext}. Unauthenticated requests
 * fail with `Unauthenticated`.
 */
export class Auth extends RpcMiddleware.Service<Auth, {
  provides: SandboxContext
}>()("microvm/auth/Auth", { error: Unauthenticated, requiredForClient: true }) {}


// ---------------------------------------------------------------------------
// Request bounding (daemon-side, before any guest I/O)
// ---------------------------------------------------------------------------

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8")

/**
 * Validates exec request bounds that the RPC schema cannot express. Returns a
 * rejection message, or undefined when the request is within every ceiling.
 * Enforced before any vsock connection is opened; the guest re-checks its own
 * caps purely as defense in depth.
 */
export const execRejection = (
  argv: ReadonlyArray<string>,
  cwd: string | undefined,
  env: Record<string, string> | undefined
): string | undefined => {
  if (argv.length < 1 || argv.length > MAX_ARGV_ENTRIES) {
    return `argv must contain 1..${MAX_ARGV_ENTRIES} entries`
  }
  const program = argv[0]
  if (program === undefined || !program.startsWith("/")) {
    return "argv[0] must be an absolute guest path"
  }
  let total = 0
  for (const arg of argv) {
    const bytes = byteLength(arg)
    total += bytes
    if (bytes > MAX_ARG_BYTES) return `argv entries limited to ${MAX_ARG_BYTES} bytes`
    if (total > MAX_ARGV_TOTAL_BYTES) return `argv limited to ${MAX_ARGV_TOTAL_BYTES} bytes`
  }
  if (cwd !== undefined) {
    if (!cwd.startsWith("/")) return "cwd must be an absolute guest path"
    if (byteLength(cwd) > MAX_CWD_BYTES) return `cwd limited to ${MAX_CWD_BYTES} bytes`
  }
  if (env !== undefined) {
    const keys = Object.keys(env)
    if (keys.length > MAX_ENV_KEYS) return `env limited to ${MAX_ENV_KEYS} keys`
    let envTotal = 0
    for (const key of keys) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return `env key ${JSON.stringify(key.slice(0, 32))} is not a valid name`
      }
      const keyBytes = byteLength(key)
      const valueBytes = byteLength(env[key] ?? "")
      if (keyBytes > MAX_ENV_KEY_BYTES) return `env keys limited to ${MAX_ENV_KEY_BYTES} bytes`
      if (valueBytes > MAX_ENV_VALUE_BYTES) return `env values limited to ${MAX_ENV_VALUE_BYTES} bytes`
      envTotal += keyBytes + valueBytes
      if (envTotal > MAX_ENV_TOTAL_BYTES) return `env limited to ${MAX_ENV_TOTAL_BYTES} bytes`
    }
  }
  return undefined
}

/**
 * Validates the exact byte ceilings and reserved environment owned by the
 * durable web-service supervisor. The RPC schema supplies structural/count
 * bounds; this check runs before service-control guest I/O.
 */
export const webServiceStartRejection = (
  argv: ReadonlyArray<string>,
  cwd: string | undefined,
  env: Readonly<Record<string, string>> | undefined
): string | undefined => {
  try {
    const rejected = execRejection(argv, cwd, env)
    if (rejected !== undefined) return rejected
    if (env !== undefined && ("HOSTNAME" in env || "PORT" in env)) {
      return "HOSTNAME and PORT are controlled by the image manifest"
    }
    return undefined
  } catch {
    return "web service request could not be validated"
  }
}

/**
 * Public request accepted by a VM-bound SandboxHandle. The low-level RPC adds
 * the already-bound VM id; callers cannot select an HTTP target or port.
 */
export class StartWebServiceRequest extends Schema.Class<StartWebServiceRequest>("StartWebServiceRequest")({
  argv: boundedArgv,
  cwd: Schema.optional(boundedCwd),
  env: Schema.optional(Schema.Record(boundedEnvKey, boundedEnvValue))
}) {}

export class WebServiceStatus extends Schema.Class<WebServiceStatus>("WebServiceStatus")({
  state: Schema.Literals(["running", "exited"]),
  startedAtEpochMs: Schema.Number,
  exitCode: Schema.optional(Schema.Number),
  signal: Schema.optional(Schema.String)
}) {}

export class StopWebServiceResult extends Schema.Class<StopWebServiceResult>("StopWebServiceResult")({
  stopped: Schema.Boolean
}) {}

// ---------------------------------------------------------------------------
// RPC contracts
// ---------------------------------------------------------------------------

export class CreateResult extends Schema.Class<CreateResult>("CreateResult")({
  vm: VmInfo,
  /**
   * Sandbox-scoped credential authorizing exec/inspect/destroy/list for this
   * VM only. This is the only credential sandboxed consumers (AI tools) need.
   */
  sandboxToken: Schema.String,
  /**
   * Dedicated HTTP data-plane capability for the immutable `web` endpoint.
   * Returned once and absent when the image has no endpoint.
   */
  httpIngressToken: Schema.UndefinedOr(Schema.String)
}) {}

export class DestroyResult extends Schema.Class<DestroyResult>("DestroyResult")({
  vmId: VmId,
  /** True when this call performed the teardown, false when already gone. */
  destroyed: Schema.Boolean
}) {}

export class CleanupResult extends Schema.Class<CleanupResult>("CleanupResult")({
  destroyed: Schema.Array(VmId),
  failed: Schema.Array(Schema.Struct({ vmId: VmId, reason: Schema.String }))
}) {}

export class ListResult extends Schema.Class<ListResult>("ListResult")({
  vms: Schema.Array(VmInfo)
}) {}

/**
 * Microvm cluster RPC surface. One deep seam for every consumer. Every RPC
 * carries the auth middleware: the server rejects unauthenticated calls
 * before handlers run, and handlers additionally enforce admin/sandbox
 * authorization via {@link SandboxContext}.
 */
export class MicrovmRpc extends RpcGroup.make(
  // Admin-only.
  Rpc.make("create", {
    payload: Schema.Struct({
      image: ImageName,
      cpus: Schema.UndefinedOr(positiveInt),
      memMib: Schema.UndefinedOr(positiveInt),
      /** Seconds of idle lifetime; destroyed by the reaper when elapsed. */
      ttlSeconds: Schema.UndefinedOr(positiveInt)
    }),
    success: CreateResult,
    error: Schema.Union([
      ImageNotAllowed,
      CapacityExceeded,
      HostPrereqFailed,
      BootFailed,
      Unauthenticated,
      Forbidden
    ])
  }).middleware(Auth),
  // Admin or the VM's own sandbox credential.
  Rpc.make("execute", {
    payload: Schema.Struct({
      vmId: VmId,
      argv: Schema.Array(Schema.String),
      cwd: Schema.UndefinedOr(Schema.String),
      env: Schema.UndefinedOr(Schema.Record(Schema.String, Schema.String)),
      timeoutMs: Schema.UndefinedOr(positiveInt),
      maxOutputBytes: Schema.UndefinedOr(positiveInt)
    }),
    success: ExecResult,
    error: Schema.Union([
      VmNotFound,
      VmPoisoned,
      GuestExecError,
      CapacityExceeded,
      Unauthenticated,
      Forbidden
    ])
  }).middleware(Auth),
  Rpc.make("inspect", {
    payload: Schema.Struct({ vmId: VmId }),
    success: VmInfo,
    error: Schema.Union([VmNotFound, Unauthenticated, Forbidden])
  }).middleware(Auth),
  Rpc.make("destroy", {
    payload: Schema.Struct({ vmId: VmId }),
    success: DestroyResult,
    error: Schema.Union([VmNotFound, DestroyUncertain, Unauthenticated, Forbidden])
  }).middleware(Auth),
  // Admin sees all VMs; sandbox credentials see only their own.
  Rpc.make("list", {
    payload: Schema.Struct({}),
    success: ListResult,
    error: Schema.Union([Unauthenticated, Forbidden])
  }).middleware(Auth),
  Rpc.make("startWebService", {
    payload: Schema.Struct({
      vmId: VmId,
      ...StartWebServiceRequest.fields
    }),
    success: WebServiceStatus,
    error: Schema.Union([
      VmNotFound,
      VmPoisoned,
      ClusterServiceError,
      Unauthenticated,
      Forbidden
    ])
  }).middleware(Auth),
  Rpc.make("webServiceStatus", {
    payload: Schema.Struct({ vmId: VmId }),
    success: WebServiceStatus,
    error: Schema.Union([
      VmNotFound,
      VmPoisoned,
      ClusterServiceError,
      Unauthenticated,
      Forbidden
    ])
  }).middleware(Auth),
  Rpc.make("stopWebService", {
    payload: Schema.Struct({ vmId: VmId }),
    success: StopWebServiceResult,
    error: Schema.Union([
      VmNotFound,
      VmPoisoned,
      ClusterServiceError,
      Unauthenticated,
      Forbidden
    ])
  }).middleware(Auth),
  // Admin-only: reap expired/poisoned VMs and orphans.
  Rpc.make("cleanup", {
    payload: Schema.Struct({}),
    success: CleanupResult,
    error: Schema.Union([DestroyUncertain, Unauthenticated, Forbidden])
  }).middleware(Auth)
) {}

type MicrovmRequest = RpcGroup.Rpcs<typeof MicrovmRpc>

/** Public request payloads derived directly from the wire contract. */
export type CreateRequest = Rpc.Payload<Extract<MicrovmRequest, { readonly _tag: "create" }>>
export type ExecuteRequest = Rpc.Payload<Extract<MicrovmRequest, { readonly _tag: "execute" }>>
export type InspectRequest = Rpc.Payload<Extract<MicrovmRequest, { readonly _tag: "inspect" }>>
export type DestroyRequest = Rpc.Payload<Extract<MicrovmRequest, { readonly _tag: "destroy" }>>
export type ListRequest = Rpc.Payload<Extract<MicrovmRequest, { readonly _tag: "list" }>>
export type CleanupRequest = Rpc.Payload<Extract<MicrovmRequest, { readonly _tag: "cleanup" }>>
export type StartWebServiceRpcRequest = Rpc.Payload<
  Extract<MicrovmRequest, { readonly _tag: "startWebService" }>
>
export type WebServiceStatusRequest = Rpc.Payload<
  Extract<MicrovmRequest, { readonly _tag: "webServiceStatus" }>
>
export type StopWebServiceRequest = Rpc.Payload<
  Extract<MicrovmRequest, { readonly _tag: "stopWebService" }>
>
