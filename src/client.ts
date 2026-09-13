import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Layer, Schema, Scope } from "effect"
import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc"
import { secureOrigin } from "./endpoint.js"
import { clientAuthLayer } from "./auth.js"
import type { SandboxHttpProxy } from "./http-proxy.js"
import {
  MicrovmRpc,
  type BootFailed,
  type CapacityExceeded,
  type ClusterServiceError,
  type DestroyUncertain,
  type DestroyResult,
  type ExecResult,
  type Forbidden,
  type GuestExecError,
  type HostPrereqFailed,
  type HttpNotConfigured,
  type ImageNotAllowed,
  type StopWebServiceResult,
  type Unauthenticated,
  type VmInfo,
  type VmNotFound,
  type VmPoisoned,
  type WebServiceStatus
} from "./protocol.js"
import { bindSandboxHandle, createWireRequest, SandboxBindingError } from "./sandbox-binding.js"

export { SandboxBindingError }

export interface MicrovmClientOptions {
  readonly url: string
  readonly token: string
  /** PEM-encoded CA bundle for a privately issued daemon certificate. */
  readonly ca?: string | undefined
}

export class ClientConfigurationError extends Schema.TaggedError<ClientConfigurationError>()(
  "ClientConfigurationError",
  { reason: Schema.String }
) {}

export type MicrovmClient = RpcClient.FromGroup<typeof MicrovmRpc, RpcClientError.RpcClientError>

/**
 * Public request inputs for the convenience API. These are the shapes a
 * plain-JavaScript consumer builds, so every property beyond the required core
 * is optional: the client normalizes the keys the RPC payload declares as
 * required-with-`undefined` before the wire schema sees them.
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
  | BootFailed | CapacityExceeded | Forbidden | HostPrereqFailed | ImageNotAllowed
  | Unauthenticated | RpcClientError.RpcClientError | SandboxBindingError
export type SandboxInspectError =
  Forbidden | Unauthenticated | VmNotFound | RpcClientError.RpcClientError
export type SandboxExecuteError =
  Forbidden | GuestExecError | Unauthenticated | VmNotFound | VmPoisoned | CapacityExceeded
  | RpcClientError.RpcClientError
export type SandboxDestroyError =
  DestroyUncertain | Forbidden | Unauthenticated | VmNotFound
  | RpcClientError.RpcClientError
export type SandboxServiceOperationError =
  | ClusterServiceError | Forbidden | Unauthenticated | VmNotFound | VmPoisoned
  | RpcClientError.RpcClientError

export interface WebServiceHandle {
  readonly status: () => Effect.Effect<WebServiceStatus, SandboxServiceOperationError>
  readonly stop: () => Effect.Effect<StopWebServiceResult, SandboxServiceOperationError>
}

export interface SandboxHandle {
  readonly vm: VmInfo
  /** Sandbox-scoped client closed over the selected configured daemon. */
  readonly client: MicrovmClient
  /** Binds the image's immutable `web` endpoint; callers cannot select a target. */
  readonly http: () => Effect.Effect<SandboxHttpProxy, HttpNotConfigured>
  /** Starts the single durable `web` service while ordinary execute remains available. */
  readonly startWebService: (
    request: SandboxStartWebServiceInput
  ) => Effect.Effect<WebServiceHandle, SandboxServiceOperationError>
  readonly execute: (request: SandboxExecuteInput) => Effect.Effect<ExecResult, SandboxExecuteError>
  readonly inspect: () => Effect.Effect<VmInfo, SandboxInspectError>
  readonly destroy: () => Effect.Effect<DestroyResult, SandboxDestroyError>
}

export interface Microvm {
  readonly create: (request: SandboxCreateInput) => Effect.Effect<SandboxHandle, SandboxCreateError>
}

const clientEndpoint = (input: string): Effect.Effect<string, ClientConfigurationError> =>
  Effect.try({
    try: () => {
      const base = secureOrigin(input)
      return `${base.origin}/rpc`
    },
    catch: (cause) => new ClientConfigurationError({ reason: `invalid microVM RPC URL: ${String(cause)}` })
  })

/**
 * Acquires a typed Effect RPC client. The returned client is scoped because its
 * HTTP agents and RPC protocol are closed with the surrounding Scope.
 */
export const makeMicrovmClient = (
  options: MicrovmClientOptions
): Effect.Effect<MicrovmClient, ClientConfigurationError, Scope.Scope> =>
  Effect.gen(function*() {
    if (options.token.length === 0) {
      return yield* Effect.fail(new ClientConfigurationError({ reason: "bearer token must not be empty" }))
    }
    const endpoint = yield* clientEndpoint(options.url)
    const agent = NodeHttpClient.layerAgentOptions({
      ca: options.ca,
      rejectUnauthorized: true
    })
    const http = NodeHttpClient.layerNodeHttpNoAgent.pipe(Layer.provide(agent))
    const protocol = RpcClient.layerProtocolHttp({ url: endpoint }).pipe(
      Layer.provide([RpcSerialization.layerJson, http])
    )
    return yield* RpcClient.make(MicrovmRpc).pipe(
      Effect.provide([protocol, clientAuthLayer(options.token)])
    )
  })

/**
 * Acquires a single-daemon convenience client. Create is one RPC to the
 * configured origin: no health, list, placement, failover, or retry.
 * Scope closure ends RPC transports; it does not destroy the remote VM or
 * revoke independently request-owned HTTP ingress.
 */
export const makeMicrovm = Effect.fn("makeMicrovm")(
  function*(options: MicrovmClientOptions): Effect.fn.Return<Microvm, ClientConfigurationError, Scope.Scope> {
    const scope = yield* Scope.Scope
    const adminClient = yield* makeMicrovmClient(options)
    const origin = secureOrigin(options.url).origin
    const create = (
      request: SandboxCreateInput
    ): Effect.Effect<SandboxHandle, SandboxCreateError> =>
      Effect.uninterruptibleMask((restore) =>
        restore(adminClient.create(createWireRequest(request))).pipe(
          Effect.flatMap((created) =>
            bindSandboxHandle({
              adminClient,
              makeSandboxClient: (token) =>
                makeMicrovmClient({
                  url: origin,
                  token,
                  ca: options.ca
                }).pipe(Effect.provideService(Scope.Scope, scope)),
              created,
              origin,
              ca: options.ca
            })
          )
        )
      )
    return { create }
  }
)

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
export const decodeExecResult = (result: ExecResult): DecodedExecResult => ({
  execId: result.execId,
  exitCode: result.exitCode,
  signal: result.signal,
  timedOut: result.timedOut,
  outputTruncated: result.outputTruncated,
  stdout: Buffer.from(result.stdoutB64, "base64").toString("utf8"),
  stderr: Buffer.from(result.stderrB64, "base64").toString("utf8")
})
