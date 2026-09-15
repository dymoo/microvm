/**
 * Internal raw full-surface Node RPC seam used by the CLI for operations that
 * intentionally accept either an admin or sandbox bearer, and by repository
 * tests that must drive the wire directly. This module is deliberately NOT a
 * package subpath: public consumers receive only the request-scoped views.
 */
import { Effect, Layer, Scope } from "effect"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { clientAuthLayer } from "./auth.js"
import { MicrovmRpc } from "./protocol.js"
import {
  ClientConfigurationError,
  clientEndpoint,
  type MicrovmClient
} from "./client-core.js"
import { resolveNodeOptions } from "./client-node.js"
import type { NodeMicrovmClientOptions } from "./client.js"

/**
 * Raw full-surface RPC client with the caller's bearer stamped on every
 * request by the client auth middleware. Repository-test seam only.
 */
export const makeMicrovmClient = Effect.fn("makeMicrovmClient")(function*(
  options: NodeMicrovmClientOptions
): Effect.fn.Return<MicrovmClient, ClientConfigurationError, Scope.Scope> {
  const resolved = yield* resolveNodeOptions(options)
  const endpoint = yield* clientEndpoint(resolved.url)
  const protocol = RpcClient.layerProtocolHttp({ url: endpoint }).pipe(
    Layer.provide([RpcSerialization.layerJson, resolved.httpClient])
  )
  return yield* RpcClient.make(MicrovmRpc).pipe(
    Effect.provide([protocol, clientAuthLayer(resolved.token)])
  )
})
