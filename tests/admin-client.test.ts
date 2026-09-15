/**
 * Request-scoped client and ingress seams, driven against raw HTTP listeners
 * so the tests observe exactly what crosses the wire:
 *
 * - `makeAdminClient` probes the daemon's `info` at construction and refuses
 *   a version mismatch with `ClientConfigurationError` — one probe, no
 *   retries, no calls after the refusal,
 * - every other probe failure keeps its own type: `Unauthenticated`,
 *   `Forbidden`, and RPC transport failures are never rewritten into
 *   `ClientConfigurationError`,
 * - the Fetch-native ingress adapter injects `Proxy-Authorization` exactly
 *   once on its final hop and strips untrusted caller headers and malformed
 *   targets.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { Effect, Result } from "effect"
import { RpcClientError } from "effect/unstable/rpc"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ClientConfigurationError,
  makeAdminClient,
  makeSandboxScopedClient
} from "../src/client.js"
import { makeSandboxHttpIngress } from "../src/http-ingress.js"
import {
  Forbidden,
  HTTP_PREVIEW_LIMITS,
  MICROVM_VERSION,
  Unauthenticated
} from "../src/protocol.js"

const ADMIN_TOKEN = "admin-token-for-client-seam-tests"
const SANDBOX_TOKEN = `mvs_${"ab".repeat(24)}`
const INGRESS_TOKEN = "mvi_ingress_token"
const VM_ID = "mvm-scoped01"

const servers: Array<Server> = []

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
const listen = async (server: Server): Promise<string> => {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("listener has no TCP port")
  return `http://127.0.0.1:${address.port}`
}

interface RpcCall {
  readonly tag: string
  readonly payload: Record<string, unknown>
  readonly envelopeHeaders: ReadonlyArray<readonly [string, string]>
  readonly httpAuthorization: string | undefined
}

type RpcReply = { readonly value: unknown } | { readonly failure: unknown }

/**
 * A raw RPC listener: decodes the plain-JSON RPC envelope, dispatches on the
 * RPC tag, and answers with the terminal-exit shape the client decodes.
 */
const startRpcMock = async (respond: (call: RpcCall) => RpcReply) => {
  const calls: Array<RpcCall> = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const messages = Array.isArray(envelope) ? envelope : [envelope]
      for (const message of messages) {
        const record = message as {
          id?: number
          tag?: string
          payload?: Record<string, unknown>
          headers?: ReadonlyArray<readonly [string, string]>
        }
        const call: RpcCall = {
          tag: record.tag ?? "",
          payload: record.payload ?? {},
          envelopeHeaders: record.headers ?? [],
          httpAuthorization: typeof request.headers["authorization"] === "string"
            ? String(request.headers["authorization"])
            : undefined
        }
        calls.push(call)
        response.writeHead(200, { "content-type": "application/json" })
        const reply = respond(call)
        response.end(JSON.stringify([{
          _tag: "Exit",
          requestId: record.id ?? 0,
          exit: "failure" in reply
            ? { _tag: "Failure", cause: [{ _tag: "Fail", error: reply.failure }] }
            : { _tag: "Success", value: reply.value }
        }]))
      }
    })
  })
  const url = await listen(server)
  return { url, calls }
}

const infoReply = (): RpcReply => ({ value: { version: MICROVM_VERSION, accepting: true, liveVms: 0 } })

describe("admin client version validation", () => {
  it("refuses a daemon whose info version mismatches the client constant", async () => {
    const { url, calls } = await startRpcMock(() => ({
      value: { version: "9.9.9", accepting: true, liveVms: 0 }
    }))
    const built = await Effect.runPromise(Effect.scoped(
      makeAdminClient({ url, token: ADMIN_TOKEN }).pipe(Effect.result)
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
    // Exactly one probe was sent and nothing else ever left the client.
    expect(calls.map((call) => call.tag)).toEqual(["info"])
  })

  it("accepts a daemon that reports the exact client version", async () => {
    const { url, calls } = await startRpcMock(infoReply)
    const built = await Effect.runPromise(Effect.scoped(
      makeAdminClient({ url, token: ADMIN_TOKEN }).pipe(Effect.result)
    ))
    expect(Result.isSuccess(built)).toBe(true)
    expect(calls.map((call) => call.tag)).toEqual(["info"])
  })

  it("propagates an unauthenticated probe with its own type instead of a configuration error", async () => {
    const { url, calls } = await startRpcMock(() => ({
      failure: { _tag: "Unauthenticated", message: "credential rejected" }
    }))
    const built = await Effect.runPromise(Effect.scoped(
      makeAdminClient({ url, token: ADMIN_TOKEN }).pipe(Effect.result)
    ))
    expect(Result.isFailure(built)).toBe(true)
    if (Result.isFailure(built)) {
      expect(built.failure).toBeInstanceOf(Unauthenticated)
      expect(built.failure.message).toContain("credential rejected")
      expect(built.failure).not.toBeInstanceOf(ClientConfigurationError)
    }
    // An auth failure is terminal: exactly one probe, nothing else ever sent.
    expect(calls.map((call) => call.tag)).toEqual(["info"])
  })

  it("propagates a forbidden probe with its own type instead of a configuration error", async () => {
    const { url, calls } = await startRpcMock(() => ({
      failure: { _tag: "Forbidden", message: "sandbox credentials may not query the daemon" }
    }))
    const built = await Effect.runPromise(Effect.scoped(
      makeAdminClient({ url, token: SANDBOX_TOKEN }).pipe(Effect.result)
    ))
    expect(Result.isFailure(built)).toBe(true)
    if (Result.isFailure(built)) {
      expect(built.failure).toBeInstanceOf(Forbidden)
      expect(built.failure.message).toContain("sandbox credentials")
      expect(built.failure).not.toBeInstanceOf(ClientConfigurationError)
    }
    expect(calls.map((call) => call.tag)).toEqual(["info"])
  })

  it("propagates a dead daemon hop as a transport failure, not a configuration error", async () => {
    const server = createServer((_request, response) => {
      response.destroy()
    })
    const url = await listen(server)
    const built = await Effect.runPromise(Effect.scoped(
      makeAdminClient({ url, token: ADMIN_TOKEN }).pipe(Effect.result)
    ))
    expect(Result.isFailure(built)).toBe(true)
    if (Result.isFailure(built)) {
      expect(built.failure).toBeInstanceOf(RpcClientError.RpcClientError)
      expect(built.failure).not.toBeInstanceOf(ClientConfigurationError)
    }
  })
})

describe("sandbox scoped client auth", () => {
  const execReply = (): RpcReply => ({
    value: {
      execId: "exec-1",
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputTruncated: false,
      stdoutB64: Buffer.from("ok").toString("base64"),
      stderrB64: Buffer.from("").toString("base64")
    }
  })

  it("presents exactly the sandbox bearer on each call and binds the request to its VM", async () => {
    const { url, calls } = await startRpcMock((call) => {
      if (call.tag === "execute") return execReply()
      if (call.tag === "inspect") {
        return {
          value: {
            vmId: VM_ID,
            state: "running",
            image: "node",
            imageDigest: `sha256:${"ab".repeat(32)}`,
            cpus: 1,
            memMib: 64,
            createdAtEpochMs: 1,
            expiresAtEpochMs: null
          }
        }
      }
      return execReply()
    })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeSandboxScopedClient({ url, token: SANDBOX_TOKEN, vmId: VM_ID })
      const executed = yield* client.execute({ argv: ["/bin/true"] })
      expect(executed.exitCode).toBe(0)
      const inspected = yield* client.inspect()
      expect(inspected.vmId).toBe(VM_ID)
    })))

    // The wire: every call carries exactly the sandbox bearer inside the
    // authenticated RPC envelope, never an admin credential, and never an
    // HTTP authorization header (credentials never ride the URL or transport
    // headers).
    expect(calls.length).toBe(2)
    for (const call of calls) {
      const bearer = call.envelopeHeaders.filter(([name]) => name === "authorization").map(([, value]) => value)
      expect(bearer).toEqual([`Bearer ${SANDBOX_TOKEN}`])
      expect(call.httpAuthorization).toBeUndefined()
      expect(JSON.stringify(call.envelopeHeaders)).not.toContain(ADMIN_TOKEN)
    }
    expect(calls[0]?.payload).toEqual(expect.objectContaining({ vmId: VM_ID, argv: ["/bin/true"] }))
    expect(calls[1]?.payload).toEqual({ vmId: VM_ID })
  })

  it("refuses to build a scoped client for a malformed vm id before any call", async () => {
    const { url, calls } = await startRpcMock(infoReply)
    const built = await Effect.runPromise(Effect.scoped(
      makeSandboxScopedClient({ url, token: SANDBOX_TOKEN, vmId: "not-a-vm-id" }).pipe(Effect.result)
    ))
    expect(Result.isFailure(built) && built.failure instanceof ClientConfigurationError).toBe(true)
    expect(calls).toEqual([])
  })
})

describe("fetch-native ingress adapter", () => {
  it("injects the ingress bearer once, strips untrusted caller headers, and forwards the response", async () => {
    let seen: { method: string | undefined; url: string | undefined; headers: Record<string, string | string[] | undefined> } | undefined
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        seen = { method: request.method, url: request.url, headers: request.headers }
        response.writeHead(200, { "content-type": "text/plain" })
        response.end("guest-reply")
      })
    })
    const url = await listen(server)
    const ingress = makeSandboxHttpIngress({
      url,
      vmId: "mvm-ingress1",
      httpIngressToken: INGRESS_TOKEN,
      fetch: globalThis.fetch
    })

    // The caller smuggles an untrusted proxy credential and forwarding
    // headers; neither may reach the daemon, and the adapter injects exactly
    // one Proxy-Authorization: Bearer <httpIngressToken> on its final hop.
    const response = await ingress.handle(new Request("http://internal.test/health?probe=1", {
      method: "POST",
      headers: {
        "proxy-authorization": "Bearer attacker-token",
        "x-forwarded-for": "10.0.0.1",
        forwarded: "for=10.0.0.1",
        "content-type": "text/plain"
      },
      body: "payload",
      duplex: "half"
    } as RequestInit))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("guest-reply")
    expect(seen?.method).toBe("POST")
    expect(seen?.url).toBe("/http/v1/vms/mvm-ingress1/health?probe=1")
    expect(seen?.headers["proxy-authorization"]).toBe("Bearer mvi_ingress_token")
    expect(seen?.headers["x-forwarded-for"]).toBeUndefined()
    expect(seen?.headers["forwarded"]).toBeUndefined()
  })

  it("refuses reserved, non-origin-form, and unusable methods before any credential is sent", async () => {
    const server = createServer((_request, response) => {
      response.destroy()
    })
    const url = await listen(server)
    const ingress = makeSandboxHttpIngress({
      url,
      vmId: "mvm-ingress2",
      httpIngressToken: INGRESS_TOKEN,
      fetch: globalThis.fetch
    })

    const reserved = await ingress.handle(new Request("http://internal.test/health", {
      method: "POST",
      headers: { "microvm-bypass": "1" },
      body: "x",
      duplex: "half"
    } as RequestInit))
    expect(reserved.status).toBe(400)

    // Fetch-conformant Request constructors silently drop the `upgrade`
    // header and reject CONNECT/TRACE outright at construction, so the
    // adapter's upgrade (426) and method (405) refusals remain as defense
    // for non-conforming host runtimes.

    const doubleSlash = await ingress.handle(new Request("http://internal.test//evil"))
    expect(doubleSlash.status).toBe(400)
  })

  it("answers a dead daemon hop with 502 instead of throwing", async () => {
    const server = createServer((_request, response) => {
      response.socket?.destroy()
    })
    const url = await listen(server)
    const ingress = makeSandboxHttpIngress({
      url,
      vmId: "mvm-ingress3",
      httpIngressToken: INGRESS_TOKEN,
      fetch: globalThis.fetch
    })
    const response = await ingress.handle(new Request("http://internal.test/health"))
    expect(response.status).toBe(502)
  })

  it("refuses a non-null body that contradicts content-length zero before the daemon hop", async () => {
    const upstream = vi.fn(async () => new Response("unreachable"))
    const ingress = makeSandboxHttpIngress({
      url: "http://127.0.0.1:39601",
      vmId: "mvm-ingress4",
      httpIngressToken: INGRESS_TOKEN,
      fetch: upstream as typeof globalThis.fetch
    })
    const response = await ingress.handle(new Request("http://internal.test/upload", {
      method: "POST",
      headers: { "content-length": "0" },
      body: "not-empty",
      duplex: "half"
    } as RequestInit))
    expect(response.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("strips forwarding and framing fields from a successful guest response", async () => {
    const upstream = (async () =>
      new Response("guest", {
        headers: {
          "content-length": "5",
          forwarded: "for=guest.internal",
          via: "hostile-proxy",
          "x-forwarded-for": "192.0.2.1",
          "content-type": "text/plain"
        }
      })) as typeof globalThis.fetch
    const ingress = makeSandboxHttpIngress({
      url: "http://127.0.0.1:39601",
      vmId: "mvm-ingress5",
      httpIngressToken: INGRESS_TOKEN,
      fetch: upstream
    })
    const response = await ingress.handle(new Request("http://internal.test/"))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("guest")
    expect(response.headers.get("content-length")).toBeNull()
    expect(response.headers.get("forwarded")).toBeNull()
    expect(response.headers.get("via")).toBeNull()
    expect(response.headers.get("x-forwarded-for")).toBeNull()
  })

  it("cancels the guest body before refusing a reserved response header", async () => {
    let cancelled = 0
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled += 1
      }
    })
    const upstream = (async () =>
      new Response(body, { headers: { "microvm-reserved": "1" } })) as typeof globalThis.fetch
    const ingress = makeSandboxHttpIngress({
      url: "http://127.0.0.1:39601",
      vmId: "mvm-ingress6",
      httpIngressToken: INGRESS_TOKEN,
      fetch: upstream
    })
    const response = await ingress.handle(new Request("http://internal.test/"))
    expect(response.status).toBe(502)
    await vi.waitFor(() => expect(cancelled).toBe(1))
  })

  it("refuses an undeclared body that exceeds the cap while the fake hop consumes it", async () => {
    // No declared content-length: the byte cap must trip on the fly (413).
    const megabyte = new Uint8Array(1024 * 1024).fill(7)
    let produced = 0
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced < 17) {
          produced += 1
          controller.enqueue(megabyte)
          return
        }
        controller.close()
      }
    })
    const upstream = (async (_input: unknown, init?: { body?: unknown }) => {
      await new Response(init?.body as ReadableStream).text()
      return new Response("unreachable", { status: 200 })
    }) as typeof globalThis.fetch
    const ingress = makeSandboxHttpIngress({ url: "http://127.0.0.1:39601", vmId: "mvm-ingress4", httpIngressToken: INGRESS_TOKEN, fetch: upstream })
    const response = await ingress.handle(new Request("http://internal.test/upload", {
      method: "POST",
      body: oversized,
      duplex: "half"
    } as RequestInit))
    expect(response.status).toBe(413)
  })

  it("does not abort a late response after the upload reached EOF", async () => {
    // Deterministic fake-clock proof: the body drains fully, then the fake
    // hop holds past the whole upload-idle window before answering. The
    // disarmed idle timer must not abort the completed upload's response.
    vi.useFakeTimers()
    try {
      let eof!: () => void
      const drained = new Promise<void>((resolve) => { eof = resolve })
      let release!: (response: Response) => void
      const released = new Promise<Response>((resolve) => { release = resolve })
      const upstream = (async (_input: unknown, init?: { body?: unknown }) => {
        await new Response(init?.body as ReadableStream).text()
        eof()
        return await released
      }) as typeof globalThis.fetch
      const ingress = makeSandboxHttpIngress({ url: "http://127.0.0.1:39601", vmId: "mvm-ingress5", httpIngressToken: INGRESS_TOKEN, fetch: upstream })
      const handlePromise = ingress.handle(new Request("http://internal.test/slow", {
        method: "POST",
        body: "small-upload",
        duplex: "half"
      } as RequestInit))
      await drained
      await vi.advanceTimersByTimeAsync(HTTP_PREVIEW_LIMITS.uploadIdleMs + 1_000)
      release(new Response("late-reply", { status: 200, headers: { "content-type": "text/plain" } }))
      const response = await handlePromise
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("late-reply")
    } finally {
      vi.useRealTimers()
    }
  })

  it("bounds a body stalled before its first byte with the idle refusal", async () => {
    // The idle window is armed immediately: a body that never delivers a
    // byte is abandoned with 408 instead of hanging the hop forever, and
    // the stalled source is explicitly cancelled (never left locked).
    vi.useFakeTimers()
    try {
      let sourceCancelled = 0
      const stalled = new ReadableStream<Uint8Array>({
        start() {
          // Never enqueues: the stall begins before byte 1.
        },
        cancel() {
          sourceCancelled += 1
        }
      })
      const upstream = (async (_input: unknown, init?: { body?: unknown }) => {
        await new Response(init?.body as ReadableStream).text()
        return new Response("unreachable", { status: 200 })
      }) as typeof globalThis.fetch
      const ingress = makeSandboxHttpIngress({ url: "http://127.0.0.1:39601", vmId: "mvm-ingress6", httpIngressToken: INGRESS_TOKEN, fetch: upstream })
      const handlePromise = ingress.handle(new Request("http://internal.test/stall", {
        method: "POST",
        body: stalled,
        duplex: "half"
      } as RequestInit))
      await vi.advanceTimersByTimeAsync(HTTP_PREVIEW_LIMITS.uploadIdleMs + 1_000)
      const response = await handlePromise
      expect(response.status).toBe(408)
      expect(sourceCancelled).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
