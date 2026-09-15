/**
 * Credential implementation for the auth seam declared in protocol.ts:
 * token storage/verification, server middleware layer, and handler-side
 * authorization helpers.
 *
 * Tokens travel as bearer credentials inside each RPC request envelope and
 * are stored only as SHA-256 hex digests. Admin digests get a constant-time
 * comparison; sandbox lookup keys the map by the 256-bit digest of the
 * (never-stored) token.
 */
import { Context, Effect, Layer } from "effect"
import { Headers } from "effect/unstable/http"
import { RpcMiddleware } from "effect/unstable/rpc"
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

export interface HttpIngressCredential {
  readonly vmId: string
  readonly endpoint: "web"
  /** Undefined follows a VM with no TTL; destroy still revokes the token. */
  readonly expiresAtEpochMs: number | undefined
}

// ---------------------------------------------------------------------------
// Credential store
// ---------------------------------------------------------------------------

export class CredentialStore extends Context.Service<CredentialStore, {
  /** Verifies only admin and sandbox control-plane credentials. */
  readonly verifyControl: (token: string) => Credential | undefined
  /** Mints a fresh sandbox control token and registers only its digest. */
  readonly mintSandbox: (vmId: string) => string
  /** Mints a data-plane token bound to the VM's immutable web endpoint. */
  readonly mintHttpIngress: (vmId: string, expiresAtEpochMs: number | undefined) => string
  /** Verifies only HTTP ingress credentials and prunes expired bindings. */
  readonly verifyHttpIngress: (token: string) => HttpIngressCredential | undefined
  /** Drops every control- and data-plane credential bound to a VM. */
  readonly forgetVm: (vmId: string) => void
}>()("microvm/auth/CredentialStore") {
  /**
   * Builds the digest-only store. Admin tokens are hashed eagerly, before
   * any closure captures them, so plaintext never outlives this call.
   */
  static readonly layer = (adminTokens: ReadonlyArray<string>): Layer.Layer<CredentialStore> => {
    const admin = new Set(
      Array.from(new Set(adminTokens), (token) => Buffer.from(sha256Hex(token), "utf8"))
    )
    return Layer.effect(CredentialStore)(Effect.sync(() => {
      const sandbox = new Map<string, string>()
      const httpIngress = new Map<string, HttpIngressCredential>()

      const verifyControl = (token: string): Credential | undefined => {
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

      const mintHttpIngress = (vmId: string, expiresAtEpochMs: number | undefined): string => {
        const token = `mvi_${randomBytes(24).toString("hex")}`
        httpIngress.set(sha256Hex(token), { vmId, endpoint: "web", expiresAtEpochMs })
        return token
      }

      const verifyHttpIngress = (token: string): HttpIngressCredential | undefined => {
        const digest = sha256Hex(token)
        const binding = httpIngress.get(digest)
        if (
          binding !== undefined &&
          binding.expiresAtEpochMs !== undefined &&
          binding.expiresAtEpochMs <= Date.now()
        ) {
          httpIngress.delete(digest)
          return undefined
        }
        return binding
      }

      return CredentialStore.of({
        verifyControl,
        mintSandbox,
        mintHttpIngress,
        verifyHttpIngress,
        forgetVm: (vmId) => {
          for (const [digest, boundVmId] of sandbox) {
            if (boundVmId === vmId) sandbox.delete(digest)
          }
          for (const [digest, binding] of httpIngress) {
            if (binding.vmId === vmId) httpIngress.delete(digest)
          }
        }
      })
    }))
  }
}

// ---------------------------------------------------------------------------
// Server-side auth middleware layer
// ---------------------------------------------------------------------------

export const authLayer: Layer.Layer<Auth, never, CredentialStore> = Layer.effect(Auth)(
  Effect.gen(function*() {
    const store = yield* CredentialStore
    return (effect, options) => {
      const token = bearerOf(options.headers)
      const credential = token === undefined ? undefined : store.verifyControl(token)
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
// Raw client-side auth middleware
// ---------------------------------------------------------------------------

/**
 * Client middleware stamping the bearer credential onto each outgoing RPC
 * envelope. Used by the internal raw seam (`src/client-raw.ts`, repository
 * tests only); the request-scoped admin/sandbox views present per-call
 * headers instead.
 */
export const clientAuthLayer = (token: string) =>
  RpcMiddleware.layerClient(Auth, ({ request, next }) =>
    next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) }))
