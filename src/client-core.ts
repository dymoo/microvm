/**
 * Runtime-neutral core of the request-scoped microvm clients.
 *
 * This module is the shared seam for both shipped runtimes: the Node root
 * (`src/client.ts`, Node transport with CA support) and the dedicated
 * `microvm/workerd` subpath (`src/client-workerd.ts`, Effect FetchHttpClient
 * behind a caller-supplied binding fetch). It must therefore never depend on
 * `node:*` builtins, `@effect/platform-node`, or `node:buffer` — byte and
 * base64 work goes through `TextEncoder`/`effect` Encoding.
 *
 * An admin client carries the operator credential for
 * create/list/destroy/setAdmission/info; a distinct VM-bound
 * {@link SandboxScopedClient} carries a sandbox credential for
 * inspect/execute and the durable web-service operations of exactly one VM.
 * Both are views over one unstamped transport: every call presents its own
 * bearer in the request envelope, so nothing persistent — no Effect Scope, no
 * durable handle, no shared mutable client state — survives between calls,
 * and a sandbox view can never inherit an admin credential from middleware.
 *
 * Admin clients validate the daemon's reported version against
 * {@link MICROVM_VERSION} at construction and fail closed with
 * {@link ClientConfigurationError} on any mismatch; every other `info` probe
 * failure — unauthenticated, forbidden, or transport — keeps its own type
 * ({@link AdminConstructionError}).
 */
import { Effect, Encoding, Layer, Schema, Scope } from "effect"
import type { Headers, HttpClient } from "effect/unstable/http"
import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc"
import { secureOrigin } from "./endpoint.js"
import { MICROVM_VERSION, MicrovmRpc, VmId } from "./protocol.js"
import type {
  AdmissionClosed,
  AdmissionState,
  BootFailed,
  CapacityExceeded,
  CreateRequest,
  CreateResult,
  DaemonInfo,
  DestroyResult,
  DestroyUncertain,
  ExecResult,
  ExecuteRequest,
  Forbidden,
  GuestExecError,
  HostPrereqFailed,
  ImageNotAllowed,
  ListResult,
  ServiceError,
  StartWebServiceRpcRequest,
  StopWebServiceResult,
  Unauthenticated,
  VmId as VmIdType,
  VmInfo,
  VmNotFound,
  VmPoisoned,
  WebServiceStatus
} from "./protocol.js"

export class ClientConfigurationError extends Schema.TaggedError<ClientConfigurationError>()(
  "ClientConfigurationError",
  { reason: Schema.String }
) {}

/** The underlying typed RPC client shared by both request-scoped views. */
export type MicrovmClient = RpcClient.FromGroup<typeof MicrovmRpc, RpcClientError.RpcClientError>

/**
 * Runtime-neutral transport selection: every shipped runtime supplies the
 * HTTP transport layer for the daemon connection (Node: CA-honoring Node
 * transport; workerd: FetchHttpClient behind the caller's binding fetch).
 */
export interface MicrovmClientOptions {
  readonly url: string
  readonly token: string
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>
}

/**
 * Public request inputs. These are the shapes a plain-JavaScript consumer
 * builds, so every property beyond the required core is optional: the client
 * normalizes the keys the RPC payload declares as required-with-`undefined`
 * before the wire schema sees them.
 */
export interface SandboxCreateInput {
  readonly image: string
  /** Exact raw rootfs bytes before boot: `sha256:` and 64 lowercase hex digits. */
  readonly imageDigest: string
  readonly cpus?: number | undefined
  readonly memMib?: number | undefined
  readonly ttlSeconds?: number | undefined
}

export interface SandboxExecuteInput {
  /** Executed directly, with no shell; `argv[0]` is an absolute guest path. */
  readonly argv: ReadonlyArray<string>
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly timeoutMs?: number | undefined
  readonly maxOutputBytes?: number | undefined
}

export interface SandboxStartWebServiceInput {
  readonly argv: ReadonlyArray<string>
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
}

export type SandboxCreateError =
  | AdmissionClosed
  | BootFailed
  | CapacityExceeded
  | Forbidden
  | HostPrereqFailed
  | ImageNotAllowed
  | Unauthenticated
  | RpcClientError.RpcClientError
export type SandboxListError =
  Forbidden | Unauthenticated | RpcClientError.RpcClientError
export type SandboxAdmissionError =
  Forbidden | Unauthenticated | RpcClientError.RpcClientError
export type SandboxInfoError =
  Forbidden | Unauthenticated | RpcClientError.RpcClientError
export type SandboxInspectError =
  Forbidden | Unauthenticated | VmNotFound | RpcClientError.RpcClientError
export type SandboxExecuteError =
  | CapacityExceeded
  | Forbidden
  | GuestExecError
  | RpcClientError.RpcClientError
  | Unauthenticated
  | VmNotFound
  | VmPoisoned
export type SandboxDestroyError =
  | DestroyUncertain
  | Forbidden
  | RpcClientError.RpcClientError
  | Unauthenticated
  | VmNotFound
export type SandboxServiceOperationError =
  | Forbidden
  | RpcClientError.RpcClientError
  | ServiceError
  | Unauthenticated
  | VmNotFound
  | VmPoisoned

/**
 * Failures `makeAdminClient` construction can surface: a genuine daemon
 * version mismatch is a {@link ClientConfigurationError}, while everything
 * the `info` probe itself fails with — `Unauthenticated`, `Forbidden`, and
 * RPC transport failures — is propagated unchanged.
 */
export type AdminConstructionError =
  | ClientConfigurationError
  | Forbidden
  | RpcClientError.RpcClientError
  | Unauthenticated

/**
 * One VM-bound sandbox client. It can inspect and drive exactly the VM its
 * sandbox credential was minted for; it has no create, list, destroy,
 * admission, or admin surface, so AI tools can never receive more than their
 * own sandbox.
 */
export interface SandboxScopedClient {
  /** The one VM this client is bound to. */
  readonly vmId: string
  readonly execute: (request: SandboxExecuteInput) => Effect.Effect<ExecResult, SandboxExecuteError>
  readonly inspect: () => Effect.Effect<VmInfo, SandboxInspectError>
  /** Starts the single durable `web` service while ordinary execute remains available. */
  readonly startWebService: (
    request: SandboxStartWebServiceInput
  ) => Effect.Effect<WebServiceStatus, SandboxServiceOperationError>
  readonly webServiceStatus: () => Effect.Effect<WebServiceStatus, SandboxServiceOperationError>
  readonly stopWebService: () => Effect.Effect<StopWebServiceResult, SandboxServiceOperationError>
}

/** Result of one admin create: the VM, its credentials, and its scoped client. */
export interface CreateOutcome {
  readonly vm: VmInfo
  /**
   * Sandbox-scoped credential authorizing inspect/execute/web-service
   * operations for this VM only. This is the only credential sandboxed
   * consumers (AI tools) need.
   */
  readonly sandboxToken: string
  /**
   * HTTP data-plane capability token for the immutable `web` endpoint,
   * absent when the image has no endpoint. Pair it with
   * `makeSandboxHttpIngress` — constructed explicitly with the appropriate
   * Node, custom-CA, or VPC-binding fetch — to serve the preview.
   */
  readonly httpIngressToken: string | undefined
  /** Request-scoped sandbox client bound to the created VM. */
  readonly sandbox: SandboxScopedClient
}

/** Admin client: create/list/destroy/setAdmission/info and nothing else. */
export interface AdminClient {
  readonly create: (request: SandboxCreateInput) => Effect.Effect<CreateOutcome, SandboxCreateError>
  readonly list: () => Effect.Effect<ListResult, SandboxListError>
  readonly destroy: (vmId: VmIdType) => Effect.Effect<DestroyResult, SandboxDestroyError>
  /** Switches VM admission for the whole daemon; admin-only, in memory only. */
  readonly setAdmission: (accepting: boolean) => Effect.Effect<AdmissionState, SandboxAdmissionError>
  /** Exact build/version, admission state, and live VM count. */
  readonly info: () => Effect.Effect<DaemonInfo, SandboxInfoError>
}

export const clientEndpoint = (input: string): Effect.Effect<string, ClientConfigurationError> =>
  Effect.try({
    try: () => {
      const base = secureOrigin(input)
      return `${base.origin}/rpc`
    },
    catch: (cause) => new ClientConfigurationError({ reason: `invalid microvm RPC URL: ${String(cause)}` })
  })

/**
 * Builds the unstamped typed RPC client over the supplied transport. No
 * auth middleware is attached: every view presents its bearer per call, so
 * admin and sandbox views can share one transport without credential bleed.
 */
export const makeUnstampedClient = Effect.fn("makeUnstampedClient")(function*(
  options: MicrovmClientOptions
): Effect.fn.Return<MicrovmClient, ClientConfigurationError, Scope.Scope> {
  const endpoint = yield* clientEndpoint(options.url)
  const protocol = RpcClient.layerProtocolHttp({ url: endpoint }).pipe(
    Layer.provide([RpcSerialization.layerJson, options.httpClient])
  )
  return yield* RpcClient.make(MicrovmRpc).pipe(Effect.provide(protocol))
})

export const bearer = (token: string): Headers.Input => ({ authorization: `Bearer ${token}` })

export const createWireRequest = (input: SandboxCreateInput): CreateRequest => ({
  image: input.image,
  imageDigest: input.imageDigest,
  cpus: input.cpus,
  memMib: input.memMib,
  ttlSeconds: input.ttlSeconds
})

export const executeWireRequest = (input: SandboxExecuteInput, vmId: VmIdType): ExecuteRequest => ({
  vmId,
  argv: input.argv,
  cwd: input.cwd,
  env: input.env,
  timeoutMs: input.timeoutMs,
  maxOutputBytes: input.maxOutputBytes
})

export const startWebServiceWireRequest = (
  input: SandboxStartWebServiceInput,
  vmId: VmIdType
): StartWebServiceRpcRequest => ({
  vmId,
  argv: input.argv,
  cwd: input.cwd,
  env: input.env
})

export const sandboxClientView = (
  client: MicrovmClient,
  vmId: VmIdType,
  token: string
): SandboxScopedClient => {
  const auth = bearer(token)
  return {
    vmId,
    execute: (input) => client.execute(executeWireRequest(input, vmId), { headers: auth }),
    inspect: () => client.inspect({ vmId }, { headers: auth }),
    startWebService: (input) =>
      client.startWebService(startWebServiceWireRequest(input, vmId), { headers: auth }),
    webServiceStatus: () => client.webServiceStatus({ vmId }, { headers: auth }),
    stopWebService: () => client.stopWebService({ vmId }, { headers: auth })
  }
}

/**
 * Validates the daemon's reported version. A mismatch is a configuration
 * error, never retried, and leaves no further calls behind; every other
 * `info` failure — unauthenticated, forbidden, or transport — is propagated
 * unchanged with its own type.
 */
export const validateDaemonVersion = (
  client: MicrovmClient,
  token: string
): Effect.Effect<void, AdminConstructionError> =>
  client.info({}, { headers: bearer(token) }).pipe(
    Effect.flatMap((described) => described.version === MICROVM_VERSION
      ? Effect.void
      : Effect.fail(new ClientConfigurationError({
        reason: `microvm version mismatch: daemon ${described.version}, client ${MICROVM_VERSION}`
      })))
  )

export const adminClientView = (client: MicrovmClient, token: string): AdminClient => {
  const auth = bearer(token)
  return {
    create: (input) =>
      Effect.map(
        client.create(createWireRequest(input), { headers: auth }),
        (created) => ({
          vm: created.vm,
          sandboxToken: created.sandboxToken,
          httpIngressToken: created.httpIngressToken,
          sandbox: sandboxClientView(client, created.vm.vmId, created.sandboxToken)
        })
      ),
    list: () => client.list({}, { headers: auth }),
    destroy: (vmId) => client.destroy({ vmId }, { headers: auth }),
    setAdmission: (accepting) => client.setAdmission({ accepting }, { headers: auth }),
    info: () => client.info({}, { headers: auth })
  }
}

export interface DecodedExecResult {
  readonly execId: string
  readonly exitCode: number
  readonly signal: string | undefined
  readonly timedOut: boolean
  readonly outputTruncated: boolean
  readonly stdout: string
  readonly stderr: string
}

/** Decodes the protocol's bounded base64 byte fields as replacement-safe UTF-8. */
export const decodeExecResult = (result: ExecResult): DecodedExecResult => {
  const decode = (fieldB64: string): string => {
    const decoded = Encoding.decodeBase64String(fieldB64)
    if (decoded._tag === "Failure") {
      throw new TypeError("exec result carried malformed base64 bytes")
    }
    return decoded.success
  }
  return {
    execId: result.execId,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    outputTruncated: result.outputTruncated,
    stdout: decode(result.stdoutB64),
    stderr: decode(result.stderrB64)
  }
}

export const isValidVmId = Schema.is(VmId)
