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
  it("verifies admin tokens only on the control plane", async () => {
    const result = await inStore("op-secret", Effect.gen(function*() {
      const store = yield* CredentialStore
      return {
        admin: store.verifyControl("op-secret"),
        ingress: store.verifyHttpIngress("op-secret"),
        unknown: store.verifyControl("nope"),
        empty: store.verifyControl("")
      }
    }))
    expect(result.admin).toEqual({ kind: "admin" })
    expect(result.ingress).toBeUndefined()
    expect(result.unknown).toBeUndefined()
    expect(result.empty).toBeUndefined()
  })

  it("mints sandbox tokens that authenticate only the control plane", async () => {
    const result = await inStore("op-secret", Effect.gen(function*() {
      const store = yield* CredentialStore
      const token = store.mintSandbox("mvm-abc12345")
      return {
        token,
        own: store.verifyControl(token),
        ingress: store.verifyHttpIngress(token),
        fresh: store.verifyControl(`mvs_${"0".repeat(48)}`)
      }
    }))
    expect(result.token).toMatch(/^mvs_[0-9a-f]{48}$/)
    expect(result.own).toEqual({ kind: "sandbox", vmId: "mvm-abc12345" })
    expect(result.ingress).toBeUndefined()
    expect(result.fresh).toBeUndefined()
  })

  it("mints HTTP ingress tokens bound to one VM and never accepts them as RPC control credentials", async () => {
    const expiresAtEpochMs = Date.now() + 60_000
    const result = await inStore("op-secret", Effect.gen(function*() {
      const store = yield* CredentialStore
      const token = store.mintHttpIngress("mvm-abc12345", expiresAtEpochMs)
      return {
        token,
        ingress: store.verifyHttpIngress(token),
        control: store.verifyControl(token)
      }
    }))
    expect(result.token).toMatch(/^mvi_[0-9a-f]{48}$/)
    expect(result.ingress).toEqual({
      vmId: "mvm-abc12345",
      endpoint: "web",
      expiresAtEpochMs
    })
    expect(result.control).toBeUndefined()
  })

  it("keeps HTTP ingress VM bindings distinct", async () => {
    const result = await inStore("op-secret", Effect.gen(function*() {
      const store = yield* CredentialStore
      const first = store.mintHttpIngress("mvm-abc12345", undefined)
      const second = store.mintHttpIngress("mvm-def67890", undefined)
      return {
        first: store.verifyHttpIngress(first),
        second: store.verifyHttpIngress(second)
      }
    }))
    expect(result.first?.vmId).toBe("mvm-abc12345")
    expect(result.second?.vmId).toBe("mvm-def67890")
  })

  it("revokes both credential classes for only the forgotten VM", async () => {
    const result = await inStore("op-secret", Effect.gen(function*() {
      const store = yield* CredentialStore
      const controlA = store.mintSandbox("mvm-abc12345")
      const ingressA = store.mintHttpIngress("mvm-abc12345", undefined)
      const controlB = store.mintSandbox("mvm-def67890")
      const ingressB = store.mintHttpIngress("mvm-def67890", undefined)
      store.forgetVm("mvm-abc12345")
      return {
        controlA: store.verifyControl(controlA),
        ingressA: store.verifyHttpIngress(ingressA),
        controlB: store.verifyControl(controlB),
        ingressB: store.verifyHttpIngress(ingressB)
      }
    }))
    expect(result.controlA).toBeUndefined()
    expect(result.ingressA).toBeUndefined()
    expect(result.controlB).toEqual({ kind: "sandbox", vmId: "mvm-def67890" })
    expect(result.ingressB?.vmId).toBe("mvm-def67890")
  })

  it("rejects expired HTTP ingress tokens", async () => {
    const result = await inStore("op-secret", Effect.gen(function*() {
      const store = yield* CredentialStore
      const token = store.mintHttpIngress("mvm-abc12345", Date.now() - 1)
      return store.verifyHttpIngress(token)
    }))
    expect(result).toBeUndefined()
  })

  it("admin tokens keep working after credential churn", async () => {
    const result = await inStore("op-secret", Effect.gen(function*() {
      const store = yield* CredentialStore
      for (let i = 0; i < 50; i++) {
        const vmId = `mvm-abc${String(i).padStart(5, "0")}`
        store.mintSandbox(vmId)
        store.mintHttpIngress(vmId, undefined)
        store.forgetVm(vmId)
      }
      return store.verifyControl("op-secret")
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
