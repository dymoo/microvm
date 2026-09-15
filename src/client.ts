/**
 * Node root of the request-scoped microvm clients: the admin and sandbox
 * views over the Node HTTP transport, honoring a PEM CA bundle for privately
 * issued daemon certificates. Edge runtimes use the dedicated
 * `microvm/workerd` subpath instead; this module may import Node builtins
 * and `@effect/platform-node` freely.
 */
import { Effect, Layer, Scope } from "effect"
import type { HttpClient } from "effect/unstable/http"
import {
  ClientConfigurationError,
  adminClientView,
  isValidVmId,
  makeUnstampedClient,
  sandboxClientView,
  validateDaemonVersion,
  type AdminClient,
  type AdminConstructionError,
  type SandboxScopedClient
} from "./client-core.js"
import { resolveNodeOptions } from "./client-node.js"

/**
 * Node client options. `ca` applies to the default Node transport for
 * privately issued daemon certificates; a caller may instead supply a fully
 * custom transport layer.
 */
export interface NodeMicrovmClientOptions {
  readonly url: string
  readonly token: string
  /** PEM-encoded CA bundle for a privately issued daemon certificate. */
  readonly ca?: string | undefined
  /** Overrides the default CA-honoring Node HTTP transport. */
  readonly httpClient?: Layer.Layer<HttpClient.HttpClient> | undefined
}

/**
 * Acquires an admin client. Construction probes the daemon with `info` and
 * refuses any version mismatch with `ClientConfigurationError`; every other
 * probe failure — unauthenticated, forbidden, or transport — is propagated
 * with its own type. The client never speaks a protocol the daemon cannot
 * interpret, and auth or transport failures are never disguised as
 * configuration errors.
 */
export const makeAdminClient = Effect.fn("makeAdminClient")(function*(
  options: NodeMicrovmClientOptions
): Effect.fn.Return<AdminClient, AdminConstructionError, Scope.Scope> {
  const resolved = yield* resolveNodeOptions(options)
  const client = yield* makeUnstampedClient(resolved)
  yield* validateDaemonVersion(client, options.token)
  return adminClientView(client, options.token)
})

/**
 * Acquires a VM-bound sandbox client for an existing VM's sandbox credential
 * (an admin token also authorizes every operation server-side).
 */
export const makeSandboxScopedClient = Effect.fn("makeSandboxScopedClient")(function*(
  options: NodeMicrovmClientOptions & { readonly vmId: string }
): Effect.fn.Return<SandboxScopedClient, ClientConfigurationError, Scope.Scope> {
  if (!isValidVmId(options.vmId)) {
    return yield* Effect.fail(new ClientConfigurationError({
      reason: `vmId does not match the wire pattern: ${options.vmId}`
    }))
  }
  const resolved = yield* resolveNodeOptions(options)
  const client = yield* makeUnstampedClient(resolved)
  return sandboxClientView(client, options.vmId, options.token)
})

export { ClientConfigurationError, decodeExecResult } from "./client-core.js"
export type {
  AdminClient,
  AdminConstructionError,
  CreateOutcome,
  DecodedExecResult,
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
