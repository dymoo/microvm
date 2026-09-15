/**
 * Observable behavior of the workerd entrypoint, driven against a fake
 * binding fetch so the tests observe exactly what the client sends:
 *
 * - the REQUIRED binding fetch carries the version probe and every
 *   subsequent call, with the credential in the RPC envelope, while a
 *   booby-trapped `globalThis.fetch` is never consulted,
 * - a non-function `fetch` fails with `ClientConfigurationError` before any
 *   I/O,
 * - probe failures keep their own types: a version mismatch is
 *   `ClientConfigurationError`, while `Unauthenticated`, `Forbidden`, and
 *   binding-fetch transport failures are never rewritten,
 * - the workerd HTTP ingress requires the binding fetch and forwards the
 *   injected request through it.
 */
import { Effect, Result } from "effect"
import { RpcClientError } from "effect/unstable/rpc"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  makeAdminClient,
  makeSandboxHttpIngress,
  makeSandboxScopedClient,
  ClientConfigurationError
} from "../src/client-workerd.js"
import { Forbidden, MICROVM_VERSION, Unauthenticated } from "../src/protocol.js"

const TOKEN = "admin-token-for-workerd-tests"
const VM_ID = "mvm-workerd1"

interface SeenRequest {
  readonly url: string
  readonly envelopeAuthorization: string | undefined
}

/**
 * Decodes the body the transport hands to fetch: a string, a byte array, or
 * a web ReadableStream (cross-realm safe: duck-typed, no instanceof).
 */
const decodeBody = async (body: unknown): Promise<string> => {
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body !== null && typeof body === "object" && typeof (body as ReadableStream).getReader === "function") {
    return await new Response(body as ReadableStream).text()
  }
  return ""
}

type RpcReply = { readonly value: unknown } | { readonly failure: unknown }

/** One fake binding fetch: answers the plain-JSON RPC envelope per tag. */
const bindingFetch = (respond: (tag: string) => RpcReply) => {
  const seen: Array<SeenRequest> = []
  const impl = (async (input: unknown, init?: { headers?: unknown; body?: unknown }) => {
    const url = typeof input === "string" ? input : String(input)
    const bodyText = await decodeBody(init?.body)
    const envelope: unknown = bodyText.length === 0 ? [] : JSON.parse(bodyText)
    const message = (Array.isArray(envelope) ? envelope : [envelope])[0] as
      | { id?: number; tag?: string; headers?: ReadonlyArray<readonly [string, string]> }
      | undefined
    const authorization = message?.headers?.find(([name]) => name.toLowerCase() === "authorization")?.[1]
    seen.push({ url, envelopeAuthorization: authorization })
    const reply = respond(message?.tag ?? "")
    return new Response(JSON.stringify([
      {
        _tag: "Exit",
        requestId: message?.id ?? 0,
        exit: "failure" in reply
          ? { _tag: "Failure", cause: [{ _tag: "Fail", error: reply.failure }] }
          : { _tag: "Success", value: reply.value }
      }
    ]), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof globalThis.fetch
  return { impl, seen }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("workerd binding-fetch client", () => {
  it("routes the version probe and a subsequent call through the supplied fetch only", async () => {
    const binding = bindingFetch((tag) => {
      if (tag === "info") return { value: { version: MICROVM_VERSION, accepting: true, liveVms: 0 } }
      if (tag === "setAdmission") return { value: { accepting: true } }
      throw new Error(`unexpected tag ${tag}`)
    })
    const globalFetch = vi.fn(() => {
      throw new Error("globalThis.fetch must never be consulted")
    })
    vi.stubGlobal("fetch", globalFetch)

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const admin = yield* makeAdminClient({ url: "http://127.0.0.1:39601", token: TOKEN, fetch: binding.impl })
      const gate = yield* admin.setAdmission(true)
      expect(gate.accepting).toBe(true)
    })))

    expect(binding.seen.length).toBe(2)
    expect(binding.seen.every((call) => call.envelopeAuthorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("refuses a non-function fetch with ClientConfigurationError before any I/O", async () => {
    const binding = bindingFetch(() => {
      throw new Error("no request may be sent")
    })

    const badAdmin = await Effect.runPromise(Effect.scoped(
      makeAdminClient({
        url: "http://127.0.0.1:39601",
        token: TOKEN,
        fetch: undefined as unknown as typeof globalThis.fetch
      }).pipe(Effect.result)
    ))
    expect(Result.isFailure(badAdmin) && badAdmin.failure instanceof ClientConfigurationError).toBe(true)

    const badSandbox = await Effect.runPromise(Effect.scoped(
      makeSandboxScopedClient({
        url: "http://127.0.0.1:39601",
        token: TOKEN,
        vmId: VM_ID,
        fetch: 42 as unknown as typeof globalThis.fetch
      }).pipe(Effect.result)
    ))
    expect(Result.isFailure(badSandbox) && badSandbox.failure instanceof ClientConfigurationError).toBe(true)
    expect(binding.seen).toEqual([])
  })

  it("refuses a version mismatch with ClientConfigurationError after exactly one probe", async () => {
    const binding = bindingFetch((tag) => {
      if (tag === "info") return { value: { version: "9.9.9", accepting: true, liveVms: 0 } }
      throw new Error(`unexpected tag ${tag}`)
    })
    const built = await Effect.runPromise(Effect.scoped(
      makeAdminClient({ url: "http://127.0.0.1:39601", token: TOKEN, fetch: binding.impl }).pipe(Effect.result)
    ))
    expect(Result.isFailure(built)).toBe(true)
    if (Result.isFailure(built)) {
      expect(built.failure instanceof ClientConfigurationError).toBe(true)
      if (built.failure instanceof ClientConfigurationError) {
        expect(built.failure.reason).toContain("version mismatch")
        expect(built.failure.reason).toContain("9.9.9")
        expect(built.failure.reason).toContain(MICROVM_VERSION)
      }
    }
    expect(binding.seen.length).toBe(1)
  })

  it("propagates an unauthenticated probe with its own type instead of a configuration error", async () => {
    const binding = bindingFetch(() => ({
      failure: { _tag: "Unauthenticated", message: "credential rejected" }
    }))
    const built = await Effect.runPromise(Effect.scoped(
      makeAdminClient({ url: "http://127.0.0.1:39601", token: TOKEN, fetch: binding.impl }).pipe(Effect.result)
    ))
    expect(Result.isFailure(built)).toBe(true)
    if (Result.isFailure(built)) {
      expect(built.failure).toBeInstanceOf(Unauthenticated)
      expect(built.failure).not.toBeInstanceOf(ClientConfigurationError)
    }
    expect(binding.seen.length).toBe(1)
  })

  it("propagates a forbidden probe with its own type instead of a configuration error", async () => {
    const binding = bindingFetch(() => ({
      failure: { _tag: "Forbidden", message: "sandbox credentials may not query the daemon" }
    }))
    const built = await Effect.runPromise(Effect.scoped(
      makeAdminClient({ url: "http://127.0.0.1:39601", token: TOKEN, fetch: binding.impl }).pipe(Effect.result)
    ))
    expect(Result.isFailure(built)).toBe(true)
    if (Result.isFailure(built)) {
      expect(built.failure).toBeInstanceOf(Forbidden)
      expect(built.failure).not.toBeInstanceOf(ClientConfigurationError)
    }
    expect(binding.seen.length).toBe(1)
  })

  it("propagates a failing binding fetch as a transport failure, not a configuration error", async () => {
    const binding = bindingFetch(() => {
      throw new Error("binding fetch rejected")
    })
    const built = await Effect.runPromise(Effect.scoped(
      makeAdminClient({ url: "http://127.0.0.1:39601", token: TOKEN, fetch: binding.impl }).pipe(Effect.result)
    ))
    expect(Result.isFailure(built)).toBe(true)
    if (Result.isFailure(built)) {
      expect(built.failure).toBeInstanceOf(RpcClientError.RpcClientError)
      expect(built.failure).not.toBeInstanceOf(ClientConfigurationError)
    }
  })
})

describe("workerd HTTP ingress", () => {
  it("requires the binding fetch and forwards the injected request through it", async () => {
    const globalFetch = vi.fn(() => {
      throw new Error("globalThis.fetch must never be consulted")
    })
    vi.stubGlobal("fetch", globalFetch)
    let seenUrl = ""
    let seenAuthorization = ""
    const upstream = (async (input: unknown, init?: { headers?: Headers }) => {
      seenUrl = typeof input === "string" ? input : String(input)
      seenAuthorization = init?.headers?.get("proxy-authorization") ?? ""
      return new Response("guest-reply", { status: 200, headers: { "content-type": "text/plain" } })
    }) as typeof globalThis.fetch

    const ingress = makeSandboxHttpIngress({
      url: "http://127.0.0.1:39601",
      vmId: VM_ID,
      httpIngressToken: "mvi_workerd_token",
      fetch: upstream
    })
    const response = await ingress.handle(new Request("http://internal.test/health", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hop-body",
      duplex: "half"
    } as RequestInit))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("guest-reply")
    expect(seenUrl.startsWith(`http://127.0.0.1:39601/http/v1/vms/${VM_ID}/health`)).toBe(true)
    expect(seenAuthorization).toBe("Bearer mvi_workerd_token")
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("captures an accessor-backed binding fetch exactly once", async () => {
    const globalFetch = vi.fn(() => {
      throw new Error("globalThis.fetch must never be consulted")
    })
    vi.stubGlobal("fetch", globalFetch)
    const upstream = (async () => new Response("guest-reply")) as typeof globalThis.fetch
    let fetchReads = 0
    const options = {
      url: "http://127.0.0.1:39601",
      vmId: VM_ID,
      httpIngressToken: "mvi_workerd_token",
      get fetch(): typeof globalThis.fetch {
        fetchReads += 1
        return fetchReads === 1
          ? upstream
          : undefined as unknown as typeof globalThis.fetch
      }
    }
    const ingress = makeSandboxHttpIngress(options)
    const response = await ingress.handle(new Request("http://internal.test/health"))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("guest-reply")
    expect(fetchReads).toBe(1)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("preserves a binding fetch's encoded response body and content coding", async () => {
    const compressed = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00])
    const upstream = (async () =>
      new Response(compressed, {
        headers: {
          "content-encoding": "gzip",
          "content-length": String(compressed.byteLength)
        }
      })) as typeof globalThis.fetch
    const ingress = makeSandboxHttpIngress({
      url: "http://127.0.0.1:39601",
      vmId: VM_ID,
      httpIngressToken: "mvi_workerd_token",
      fetch: upstream
    })

    const response = await ingress.handle(new Request("http://internal.test/"))

    expect(response.headers.get("content-encoding")).toBe("gzip")
    expect(response.headers.get("content-length")).toBeNull()
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(compressed)
  })

  it("throws ClientConfigurationError when the binding fetch is absent", () => {
    expect(() =>
      makeSandboxHttpIngress({
        url: "http://127.0.0.1:39601",
        vmId: VM_ID,
        httpIngressToken: "mvi_workerd_token",
        fetch: undefined as unknown as typeof globalThis.fetch
      })
    ).toThrow(ClientConfigurationError)
  })
})
