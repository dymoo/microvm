import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Layer, Schema, type Scope } from "effect"
import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc"
import { secureOrigin } from "./endpoint.js"
import { clientAuthLayer } from "./auth.js"
import { MicrovmRpc, type ExecResult } from "./protocol.js"

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
