/**
 * Credential implementation for the auth seam declared in protocol.ts:
 * token storage/verification, server middleware layer, handler-side
 * authorization helpers, and the client-side header middleware.
 *
 * Tokens travel as `Authorization: Bearer <token>` and are stored only as
 * SHA-256 hex digests. Admin digests get a constant-time comparison; sandbox
 * lookup keys the map by the 256-bit digest of the (never-stored) token.
 */
import { Context, Effect, Layer } from "effect"
import { Headers } from "effect/unstable/http"
import { RpcClient, RpcMiddleware } from "effect/unstable/rpc"
import { Buffer } from "node:buffer"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { Auth, Forbidden, SandboxContext, Unauthenticated } from "./protocol.js"
import type { Credential } from "./protocol.js"

/** SHA-256 hex digest of a token — the storage key everywhere. */
const sha256Hex = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex")

const bearerOf = (headers: Headers.Headers): string | undefined => {
  const raw = Headers.get(headers, "authorization")
  if (raw._tag === "None") return undefined
  const value = raw.value
  if (!value.startsWith("Bearer ")) return undefined
  const token = value.slice("Bearer ".length).trim()
  return token.length === 0 ? undefined : token
}

// ---------------------------------------------------------------------------
// Credential store
// ---------------------------------------------------------------------------

export class CredentialStore extends Context.Service<CredentialStore, {
  /** Verifies a bearer token; `undefined` when unknown. */
  readonly verify: (token: string) => Credential | undefined
  /** Mints a fresh sandbox token and registers its digest for the VM. */
  readonly mintSandbox: (vmId: string) => string
  /** Drops all credentials bound to a VM (on destroy). */
  readonly forgetVm: (vmId: string) => void
}>()("microvm/auth/CredentialStore") {
  static readonly layer = (adminTokens: ReadonlyArray<string>): Layer.Layer<CredentialStore> =>
    Layer.effect(CredentialStore)(Effect.sync(() => {
      const admin = new Set(Array.from(new Set(adminTokens), (token) => Buffer.from(sha256Hex(token), "utf8")))
      const sandbox = new Map<string, string>()
      const verify = (token: string): Credential | undefined => {
        const digest = sha256Hex(token)
        const provided = Buffer.from(digest, "utf8")
        for (const known of admin) {
          if (timingSafeEqual(provided, known)) {
            return { kind: "admin" }
          }
        }
        const vmId = sandbox.get(digest)
        return vmId === undefined ? undefined : { kind: "sandbox", vmId }
      }
      const mintSandbox = (vmId: string): string => {
        const token = `mvs_${randomBytes(24).toString("hex")}`
        sandbox.set(sha256Hex(token), vmId)
        return token
      }
      return CredentialStore.of({
        verify,
        mintSandbox,
        forgetVm: (vmId) => {
          for (const [digest, bound] of sandbox) {
            if (bound === vmId) sandbox.delete(digest)
          }
        }
      })
    }))
}

// ---------------------------------------------------------------------------
// Server-side auth middleware layer
// ---------------------------------------------------------------------------

export const authLayer: Layer.Layer<Auth, never, CredentialStore> = Layer.effect(Auth)(
  Effect.gen(function*() {
    const store = yield* CredentialStore
    return (effect, options) => {
      const token = bearerOf(options.headers)
      const credential = token === undefined ? undefined : store.verify(token)
      if (credential === undefined) {
        return Effect.fail(new Unauthenticated({ message: "missing or invalid bearer token" }))
      }
      return Effect.provideService(
        effect,
        SandboxContext,
        SandboxContext.of({ credential })
      )
    }
  })
)

// ---------------------------------------------------------------------------
// Handler-side authorization helpers
// ---------------------------------------------------------------------------

/** Fails `Forbidden` unless the caller holds an admin credential. */
export const requireAdmin = Effect.gen(function*() {
  const { credential } = yield* SandboxContext
  if (credential.kind !== "admin") {
    return yield* Effect.fail(
      new Forbidden({ message: "admin credential required for this operation" })
    )
  }
})

/** Fails `Forbidden` unless the caller is admin or the VM's own sandbox. */
export const authorizeVm = (vmId: string) =>
  Effect.gen(function*() {
    const { credential } = yield* SandboxContext
    if (credential.kind === "admin") return
    if (credential.kind !== "sandbox" || credential.vmId !== vmId) {
      return yield* Effect.fail(
        new Forbidden({ message: `credential does not authorize access to ${vmId}` })
      )
    }
  })

// ---------------------------------------------------------------------------
// Client-side auth middleware
// ---------------------------------------------------------------------------

/**
 * Client layer stamping `Authorization: Bearer <token>` directly onto each
 * outgoing request envelope. Set on the request itself (not via a fiber
 * reference) so the header is captured deterministically at request-encode
 * time regardless of middleware scheduling.
 */
export const clientAuthLayer = (token: string) =>
  RpcMiddleware.layerClient(Auth, ({ request, next }) =>
    next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) }))
