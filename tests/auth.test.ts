/**
 * Auth behavioral contracts: token mint/verify/revoke lifecycle, cross-VM
 * rejection, and the handler-side authorization helpers.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { CredentialStore, authorizeVm, clientAuthLayer, requireAdmin } from "../src/auth.js"
import { Forbidden, SandboxContext } from "../src/protocol.js"

const withStore = (adminTokens: string[]) => CredentialStore.layer(adminTokens)

const inStore = <A, E>(token: string, effect: Effect.Effect<A, E, CredentialStore>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, withStore([token])))

describe("credential store", () => {
  it("verifies admin tokens and rejects unknown ones", async () => {
    const result = await inStore("op-secret", Effect.gen(function*() {
      const store = yield* CredentialStore
      return {
        admin: store.verify("op-secret"),
        unknown: store.verify("nope"),
        empty: store.verify("")
      }
    }))
    expect(result.admin).toEqual({ kind: "admin" })
    expect(result.unknown).toBeUndefined()
    expect(result.empty).toBeUndefined()
  })

  it("mints sandbox tokens that verify only for their own VM", async () => {
    const result = await inStore("op-secret", Effect.gen(function*() {
      const store = yield* CredentialStore
      const token = store.mintSandbox("mvm-abc12345")
      return {
        token,
        own: store.verify(token),
        fresh: store.verify(`mvs_${"0".repeat(48)}`)
      }
    }))
    expect(result.token).toMatch(/^mvs_[0-9a-f]{48}$/)
    expect(result.own).toEqual({ kind: "sandbox", vmId: "mvm-abc12345" })
    expect(result.fresh).toBeUndefined()
  })

  it("revokes all sandbox credentials when the VM is forgotten", async () => {
    const result = await inStore("op-secret", Effect.gen(function*() {
      const store = yield* CredentialStore
      const token = store.mintSandbox("mvm-abc12345")
      const before = store.verify(token)
      store.forgetVm("mvm-abc12345")
      return { before, after: store.verify(token) }
    }))
    expect(result.before).toEqual({ kind: "sandbox", vmId: "mvm-abc12345" })
    expect(result.after).toBeUndefined()
  })


  it("admin tokens keep working after sandbox churn", async () => {
    const result = await inStore("op-secret", Effect.gen(function*() {
      const store = yield* CredentialStore
      for (let i = 0; i < 50; i++) {
        const token = store.mintSandbox(`mvm-abc${String(i).padStart(5, "0")}`)
        store.forgetVm(`mvm-abc${String(i).padStart(5, "0")}`)
        void token
      }
      return store.verify("op-secret")
    }))
    expect(result).toEqual({ kind: "admin" })
  })
})

// ---------------------------------------------------------------------------
// Handler-side authorization
// ---------------------------------------------------------------------------

const runAs = <A, E>(credential: { readonly kind: "admin" } | { readonly kind: "sandbox"; readonly vmId: string }, effect: Effect.Effect<A, E, SandboxContext>): Promise<A> =>
  Effect.runPromise(Effect.provideService(effect, SandboxContext, SandboxContext.of({ credential })))

describe("handler authorization", () => {
  it("requireAdmin passes for admin and fails for sandbox credentials", async () => {
    await expect(runAs({ kind: "admin" }, requireAdmin)).resolves.toBeUndefined()
    const sandboxFailure = runAs({ kind: "sandbox", vmId: "mvm-abc12345" }, requireAdmin)
    await expect(sandboxFailure).rejects.toBeInstanceOf(Forbidden)
  })

  it("authorizeVm allows admin for any VM", async () => {
    await expect(runAs({ kind: "admin" }, authorizeVm("mvm-abc12345"))).resolves.toBeUndefined()
    await expect(runAs({ kind: "admin" }, authorizeVm("mvm-zzz99999"))).resolves.toBeUndefined()
  })

  it("authorizeVm allows a sandbox token only for its own VM", async () => {
    await expect(runAs({ kind: "sandbox", vmId: "mvm-abc12345" }, authorizeVm("mvm-abc12345"))).resolves.toBeUndefined()
    await expect(runAs({ kind: "sandbox", vmId: "mvm-abc12345" }, authorizeVm("mvm-zzz99999"))).rejects.toBeInstanceOf(Forbidden)
  })
})

// ---------------------------------------------------------------------------
// Client auth middleware attaches bearer headers (wiring sanity)
// ---------------------------------------------------------------------------

describe("client auth layer", () => {
  it("builds a layer without throwing and is reusable per token", () => {
    expect(() => clientAuthLayer("mvs_secret")).not.toThrow()
    expect(() => clientAuthLayer("other")).not.toThrow()
  })
})
