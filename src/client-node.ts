/**
 * Internal Node transport seam for the microvm clients: the shared
 * option resolution and CA-honoring Node HTTP transport used by the public
 * Node root (`src/client.ts`) and the repository-test-only raw client
 * (`src/client-raw.ts`). Deliberately not a package subpath and never
 * re-exported from a public module: the public surface exposes only the
 * scoped constructors, and `src/client-core.ts` stays runtime-neutral —
 * this is the one client module allowed to import `@effect/platform-node`.
 */
import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { ClientConfigurationError, type MicrovmClientOptions } from "./client-core.js"
import type { NodeMicrovmClientOptions } from "./client.js"

/** Default CA-honoring Node HTTP transport for the daemon connection. */
export const nodeTransport = (ca: string | undefined): Layer.Layer<HttpClient.HttpClient> =>
  NodeHttpClient.layerNodeHttpNoAgent.pipe(
    Layer.provide(NodeHttpClient.layerAgentOptions({ ca, rejectUnauthorized: true }))
  )

/**
 * Resolves public Node client options into the runtime-neutral transport
 * selection: an empty token fails closed, `ca` applies only to the default
 * transport, and a caller-supplied `httpClient` wins unchanged.
 */
export const resolveNodeOptions = (
  options: NodeMicrovmClientOptions
): Effect.Effect<MicrovmClientOptions, ClientConfigurationError> => {
  if (options.token.length === 0) {
    return Effect.fail(new ClientConfigurationError({ reason: "bearer token must not be empty" }))
  }
  return Effect.succeed({
    url: options.url,
    token: options.token,
    httpClient: options.httpClient ?? nodeTransport(options.ca)
  })
}