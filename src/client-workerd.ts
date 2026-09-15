/**
 * workerd (Cloudflare Workers / edge runtime) entrypoint of the
 * request-scoped microvm clients, backed by Effect `FetchHttpClient`.
 *
 * The daemon connection is never routed through `globalThis.fetch` silently:
 * `fetch` is a REQUIRED option and every daemon call — the version probe and
 * every subsequent request — goes through exactly the caller-supplied
 * binding (e.g. a VPC Service binding such as
 * `env.MICROVM_NODE2.fetch.bind(env.MICROVM_NODE2)`). TLS trust is the
 * supplied fetch's business; private CAs are handled by the binding.
 *
 * This module is the portability contract: its import graph must contain no
 * `node:*` builtin and no `@effect/platform-node` module (verified during
 * release/check; the tests drive observable behavior instead of source
 * text).
 */
import { Effect, Layer, Scope } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { FetchHttpClient } from "effect/unstable/http"
import {
  ClientConfigurationError,
  adminClientView,
  makeUnstampedClient,
  sandboxClientView,
  validateDaemonVersion,
  isValidVmId,
  type AdminClient,
  type AdminConstructionError,
  type SandboxScopedClient
} from "./client-core.js"
import {
  makeSandboxHttpIngress as makeSharedHttpIngress,
  type SandboxHttpIngress,
  type SandboxHttpIngressOptions
} from "./http-ingress.js"

/**
 * workerd client options. The binding fetch is REQUIRED: the client never
 * silently routes daemon calls through `globalThis.fetch`, so a missing or
 * mis-bound VPC binding cannot become an accidental public-network call.
 */
export interface WorkerdMicrovmClientOptions {
  readonly url: string
  readonly token: string
  /**
   * The caller's binding fetch (e.g. `env.MICROVM_NODE2.fetch.bind(...)` for
   * a VPC service binding). Every daemon request is sent through it.
   */
  readonly fetch: typeof globalThis.fetch
}

const bindingTransport = (fetch: typeof globalThis.fetch): Layer.Layer<HttpClient.HttpClient> =>
  FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
  )

/**
 * Acquires an admin client over the caller's binding fetch. Construction
 * probes the daemon with `info` and refuses any version mismatch with
 * `ClientConfigurationError`; every other probe failure — unauthenticated,
 * forbidden, or transport — is propagated with its own type. The client
 * never speaks a protocol the daemon cannot interpret, and auth or
 * transport failures are never disguised as configuration errors.
 */
export const makeAdminClient = Effect.fn("makeAdminClient")(function*(
  options: WorkerdMicrovmClientOptions
): Effect.fn.Return<AdminClient, AdminConstructionError, Scope.Scope> {
  if (typeof options.fetch !== "function") {
    return yield* Effect.fail(new ClientConfigurationError({
      reason: "a binding fetch is required; the workerd client never falls back to globalThis.fetch"
    }))
  }
  if (options.token.length === 0) {
    return yield* Effect.fail(new ClientConfigurationError({ reason: "bearer token must not be empty" }))
  }
  const client = yield* makeUnstampedClient({
    url: options.url,
    token: options.token,
    httpClient: bindingTransport(options.fetch)
  })
  yield* validateDaemonVersion(client, options.token)
  return adminClientView(client, options.token)
})

/**
 * Acquires a VM-bound sandbox client over the caller's binding fetch.
 */
export const makeSandboxScopedClient = Effect.fn("makeSandboxScopedClient")(function*(
  options: WorkerdMicrovmClientOptions & { readonly vmId: string }
): Effect.fn.Return<SandboxScopedClient, ClientConfigurationError, Scope.Scope> {
  if (typeof options.fetch !== "function") {
    return yield* Effect.fail(new ClientConfigurationError({
      reason: "a binding fetch is required; the workerd client never falls back to globalThis.fetch"
    }))
  }
  if (options.token.length === 0) {
    return yield* Effect.fail(new ClientConfigurationError({ reason: "bearer token must not be empty" }))
  }
  if (!isValidVmId(options.vmId)) {
    return yield* Effect.fail(new ClientConfigurationError({
      reason: `vmId does not match the wire pattern: ${options.vmId}`
    }))
  }
  const client = yield* makeUnstampedClient({
    url: options.url,
    token: options.token,
    httpClient: bindingTransport(options.fetch)
  })
  return sandboxClientView(client, options.vmId, options.token)
})

/**
 * workerd-safe HTTP ingress for one created microVM's `web` endpoint. The
 * daemon-hop fetch is REQUIRED: edge callers must pass their binding fetch
 * explicitly, so the adapter can never silently route through
 * `globalThis.fetch`.
 */
export interface WorkerdHttpIngressOptions extends Omit<SandboxHttpIngressOptions, "fetch"> {
  /** The caller's binding fetch; used for the final daemon hop. */
  readonly fetch: typeof globalThis.fetch
}

export const makeSandboxHttpIngress = (options: WorkerdHttpIngressOptions): SandboxHttpIngress => {
  // Destructure once: a validation read must not be followed by another
  // accessor read that can substitute a different route.
  const { fetch, ...sharedOptions } = options
  if (typeof fetch !== "function") {
    throw new ClientConfigurationError({
      reason: "a binding fetch is required; the workerd ingress never falls back to globalThis.fetch"
    })
  }
  return makeSharedHttpIngress({ ...sharedOptions, fetch })
}

export { ClientConfigurationError, decodeExecResult } from "./client-core.js"
export type {
  AdminClient,
  AdminConstructionError,
  CreateOutcome,
  SandboxScopedClient
} from "./client-core.js"
export type {
  SandboxAdmissionError,
  SandboxCreateError,
  SandboxCreateInput,
  SandboxDestroyError,
  SandboxExecuteError,
  SandboxExecuteInput,
  SandboxInfoError,
  SandboxInspectError,
  SandboxServiceOperationError,
  SandboxStartWebServiceInput
} from "./client-core.js"
