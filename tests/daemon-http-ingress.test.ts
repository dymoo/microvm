import { createHash } from "node:crypto"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http"
import { connect, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeMicrovmClient } from "../src/client.js"
import { DaemonConfig, daemonLayer } from "../src/daemon.js"
import { DAEMON_HTTP_LIMITS, ingressIdleGuard } from "../src/daemon-http-proxy.js"
import {
  Firecracker,
  GuestExecChannel,
  GuestHttpChannel,
  GuestServiceChannel,
  GuestTransportFault
} from "../src/firecracker.js"
import { HostPrereqs } from "../src/host.js"

const adminToken = "daemon-http-ingress-admin-token"
const roots: Array<string> = []

const configFor = (root: string) => new DaemonConfig({
  listen: { host: "127.0.0.1", port: 0 },
  advertisedUrl: "http://127.0.0.1:1",
  tls: undefined,
  auth: { adminTokens: [adminToken] },
  firecracker: {
    firecrackerBinary: "/usr/bin/false",
    flockBinary: undefined,
    jailerBinary: "/usr/bin/false",
    kernelImage: join(root, "vmlinux"),
    imagesDir: join(root, "images"),
    runStateDir: join(root, "run"),
    jailerUidRange: [28_000, 28_099],
    jailerGidRange: [28_000, 28_099],
    jailerParentCgroup: undefined,
    guestCidRange: [12_000, 12_099],
    kernelArgs: "console=ttyS0 reboot=k panic=1 pci=off",
    bootTimeoutMs: 1_000,
    guestReadinessTimeoutMs: 1_000,
    vmmOverheadMib: 16,
    maxPidsPerVm: 64,
    jailerFsizeBytes: 1_048_576,
    jailerNoFileLimit: 128
  },
  limits: {
    maxVms: 3,
    defaultCpus: 1,
    maxCpus: 2,
    defaultMemMib: 128,
    maxMemMib: 256,
    maxTtlSeconds: 60
  }
})

const prepareFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "microvm-http-ingress-"))
  roots.push(root)
  await mkdir(join(root, "images"), { recursive: true })
  await mkdir(join(root, "run"), { recursive: true })
  await writeFile(join(root, "vmlinux"), "test")
  await writeFile(join(root, "images", "node.raw"), "test")
  await writeFile(join(root, "images", "node.json"), JSON.stringify({
    name: "node",
    file: "node.raw",
    arch: process.arch === "arm64" ? "aarch64" : "x86_64",
    httpEndpoints: { web: { port: 3000 } }
  }))
  return root
}

const prereqs = Layer.succeed(HostPrereqs, HostPrereqs.of({
  verifyAll: () => Effect.succeed({
    kvmDeviceAccess: true,
    cgroupV2: true,
    arch: process.arch === "arm64" ? "aarch64" : "x86_64"
  })
}))

const listeningPort = async (server: Server): Promise<number> => {
  if (!server.listening) {
    const listening = Promise.withResolvers<void>()
    server.once("listening", listening.resolve)
    await listening.promise
  }
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("listener has no TCP port")
  return address.port
}

const listen = async (server: Server): Promise<number> => {
  const listening = Promise.withResolvers<void>()
  server.listen(0, "127.0.0.1", listening.resolve)
  await listening.promise
  return listeningPort(server)
}

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return
  server.closeAllConnections()
  const closed = Promise.withResolvers<void>()
  server.close(closed.resolve)
  await closed.promise
}

const responseBody = async (response: IncomingMessage): Promise<Buffer> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of response) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

const requestDaemon = async (options: {
  readonly port: number
  readonly method?: string
  readonly path: string
  readonly headers?: Readonly<Record<string, string | ReadonlyArray<string>>>
  readonly body?: string
}): Promise<{ readonly status: number; readonly headers: IncomingMessage["headers"]; readonly body: Buffer }> =>
  new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: options.port,
      method: options.method ?? "GET",
      path: options.path,
      headers: options.headers
    }, (response) => {
      void responseBody(response).then((body) => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body
      }), reject)
    })
    request.once("error", reject)
    request.end(options.body)
  })

const rawExchange = async (port: number, request: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port })
    const chunks: Array<Buffer> = []
    socket.once("connect", () => socket.end(request, "latin1"))
    socket.on("data", (chunk) => chunks.push(chunk))
    socket.once("end", () => resolve(Buffer.concat(chunks)))
    socket.once("error", reject)
  })

interface StartedDaemon {
  readonly port: number
  readonly stopCalls: () => number
}

const startDaemon = (
  root: string,
  daemonServer: Server,
  originPort: number,
  overrides: { readonly guestHttp?: Layer.Layer<GuestHttpChannel> } = {}
): Effect.Effect<StartedDaemon, unknown> =>
  Effect.gen(function*() {
    let stops = 0
    const firecracker = Layer.succeed(Firecracker, Firecracker.of({
      boot: (spec) => Effect.promise(async () => {
        await mkdir(spec.layout.vmDir, { recursive: true })
        return {
          pid: 91,
          stop: () => Effect.sync(() => {
            stops++
          }),
          exited: Effect.never
        }
      })
    }))
    const guestExec = Layer.succeed(GuestExecChannel, GuestExecChannel.of({
      exec: () => Effect.die("exec not used")
    }))
    const guestHttp = Layer.succeed(GuestHttpChannel, GuestHttpChannel.of({
      open: ({ vmId }) => Effect.acquireRelease(
        Effect.callback<Socket, GuestTransportFault>((resume, signal) => {
          const socket = connect({ host: "127.0.0.1", port: originPort })
          const onError = (cause: Error): void => {
            socket.destroy()
            resume(Effect.fail(new GuestTransportFault({ vmId, reason: String(cause) })))
          }
          socket.once("connect", () => {
            socket.off("error", onError)
            socket.pause()
            resume(Effect.succeed(socket))
          })
          socket.once("error", onError)
          signal.addEventListener("abort", () => socket.destroy(), { once: true })
        }),
        (socket) => Effect.sync(() => socket.destroy())
      )
    }))
    const guestService = Layer.succeed(GuestServiceChannel, GuestServiceChannel.of({
      start: () => Effect.succeed({ state: "running", startedAtEpochMs: Date.now() }),
      status: () => Effect.succeed({ state: "not_started" }),
      stop: () => Effect.succeed({ stopped: false })
    }))
    yield* daemonLayer(configFor(root), {
      firecracker,
      guestExec,
      guestHttp: overrides.guestHttp ?? guestHttp,
      guestService,
      prereqs,
      server: daemonServer,
      unsafeSkipKernelLockForTests: true
    }).pipe(Layer.launch, Effect.forkScoped)
    return { port: yield* Effect.promise(() => listeningPort(daemonServer)), stopCalls: () => stops }
  })

const createVm = (port: number) =>
  Effect.gen(function*() {
    const admin = yield* makeMicrovmClient({
      url: `http://127.0.0.1:${port}`,
      token: adminToken
    })
    const created = yield* admin.create({
      image: "node",
      cpus: undefined,
      memMib: undefined,
      ttlSeconds: undefined
    })
    if (created.httpIngressToken === undefined) throw new Error("fixture did not mint an ingress token")
    return { admin, created }
  })

const proxyHeaders = (token: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> => ({
  host: "preview.example.test:8443",
  "proxy-authorization": `Bearer ${token}`,
  ...extra
})

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

describe("daemon HTTP ingress", () => {
  it("streams a semantic POST, preserves the raw suffix, and sanitizes authority headers", async () => {
    const root = await prepareFixture()
    let observedUrl = ""
    let observedHeaders: IncomingMessage["headers"] = {}
    const origin = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        observedUrl = request.url ?? ""
        observedHeaders = request.headers
        if (observedUrl === "/too-many") {
          for (let index = 0; index < 65; index++) response.setHeader(`x-field-${index}`, "value")
          response.end("unreachable")
          return
        }
        const body = await responseBody(request)
        response.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"])
        response.end(Buffer.concat([Buffer.from("echo:"), body]))
      })()
    })
    const originPort = await listen(origin)
    const daemonServer = createServer()
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const daemon = yield* startDaemon(root, daemonServer, originPort)
        const { created } = yield* createVm(daemon.port)
        const response = yield* Effect.promise(() => requestDaemon({
          port: daemon.port,
          method: "POST",
          path: `/http/v1/vms/${created.vm.vmId}/echo%2Fraw?next=%2Fkept`,
          headers: proxyHeaders(created.httpIngressToken, {
            authorization: "Bearer application-secret",
            connection: "keep-alive, x-remove-me",
            forwarded: "for=attacker;host=evil.example",
            "x-forwarded-for": "203.0.113.5",
            "x-remove-me": "secret",
            "content-type": "text/plain"
          }),
          body: "streamed-body"
        }))
        expect(response.status).toBe(200)
        expect(response.body.toString()).toBe("echo:streamed-body")
        expect(response.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"])
        expect(observedUrl).toBe("/echo%2Fraw?next=%2Fkept")
        expect(observedHeaders.host).toBe("web.internal")
        expect(observedHeaders.authorization).toBe("Bearer application-secret")
        expect(observedHeaders["proxy-authorization"]).toBeUndefined()
        expect(observedHeaders.forwarded).not.toContain("attacker")
        expect(observedHeaders["x-forwarded-for"]).toBe("127.0.0.1")
        expect(observedHeaders["x-forwarded-host"]).toBe("preview.example.test:8443")
        expect(observedHeaders["x-remove-me"]).toBeUndefined()
        const tooMany = yield* Effect.promise(() => requestDaemon({
          port: daemon.port,
          path: `/http/v1/vms/${created.vm.vmId}/too-many`,
          headers: proxyHeaders(created.httpIngressToken)
        }))
        expect(tooMany.status).toBe(502)
      })))
    } finally {
      await closeServer(origin)
    }
  })

  it("rejects invalid authority before guest I/O and never accepts CONNECT", async () => {
    const root = await prepareFixture()
    let originRequests = 0
    const origin = createServer((_request, response) => {
      originRequests++
      response.end("unexpected")
    })
    const originPort = await listen(origin)
    const daemonServer = createServer()
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const daemon = yield* startDaemon(root, daemonServer, originPort)
        const { created } = yield* createVm(daemon.port)
        const path = `/http/v1/vms/${created.vm.vmId}/`
        const missing = yield* Effect.promise(() => requestDaemon({ port: daemon.port, path, headers: { host: "preview.test" } }))
        const controlToken = yield* Effect.promise(() => requestDaemon({
          port: daemon.port,
          path,
          headers: proxyHeaders(created.sandboxToken)
        }))
        const oversized = yield* Effect.promise(() => requestDaemon({
          port: daemon.port,
          method: "POST",
          path,
          headers: proxyHeaders(created.httpIngressToken, { "content-length": String(16 * 1024 * 1024 + 1) })
        }))
        const duplicate = yield* Effect.promise(() => rawExchange(daemon.port,
          `GET ${path} HTTP/1.1\r\nHost: preview.test\r\n` +
          `Proxy-Authorization: Bearer ${created.httpIngressToken}\r\n` +
          `Proxy-Authorization: Bearer ${created.httpIngressToken}\r\nConnection: close\r\n\r\n`))
        const connectResponse = yield* Effect.promise(() => rawExchange(daemon.port,
          `CONNECT ${path} HTTP/1.1\r\nHost: preview.test\r\n` +
          `Proxy-Authorization: Bearer ${created.httpIngressToken}\r\n\r\n`))
        expect(missing.status).toBe(401)
        expect(controlToken.status).toBe(401)
        expect(oversized.status).toBe(413)
        expect(duplicate.toString("latin1")).toContain(" 401 ")
        expect(connectResponse.toString("latin1")).toContain(" 405 ")
        expect(originRequests).toBe(0)
      })))
    } finally {
      await closeServer(origin)
    }
  })

  it("does not expose a WebSocket 101 until the guest handshake is valid", async () => {
    const root = await prepareFixture()
    const origin = createServer()
    origin.on("upgrade", (request, socket) => {
      const key = request.headers["sec-websocket-key"]
      if (typeof key !== "string") return socket.destroy()
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
        .digest("base64")
      const responseHead = Buffer.from(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade, x-drop\r\n" +
        "Upgrade: websocket\r\n" +
        "X-Drop: must-not-escape\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        "latin1"
      )
      const frame = request.url === "/non-minimal"
        ? Buffer.from([0x81, 126, 0, 1, 0x78])
        : Buffer.from([0x81, 0x05, ...Buffer.from("hello")])
      socket.end(Buffer.concat([responseHead, frame]))
    })
    const originPort = await listen(origin)
    const daemonServer = createServer()
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const daemon = yield* startDaemon(root, daemonServer, originPort)
        const { created } = yield* createVm(daemon.port)
        const key = Buffer.from("0123456789abcdef").toString("base64")
        const response = yield* Effect.promise(() => rawExchange(daemon.port,
          `GET /http/v1/vms/${created.vm.vmId}/socket HTTP/1.1\r\n` +
          "Host: preview.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Proxy-Authorization: Bearer ${created.httpIngressToken}\r\n\r\n`))
        const split = response.indexOf("\r\n\r\n")
        const publicHead = response.subarray(0, split).toString("latin1")
        expect(publicHead).toContain(" 101 ")
        expect(publicHead.match(/^Connection:/gim)).toHaveLength(1)
        expect(publicHead).toMatch(/\r\nConnection: Upgrade\r\n/)
        expect(publicHead).not.toContain("X-Drop")
        expect(response.subarray(split + 4)).toEqual(Buffer.from([0x81, 0x05, ...Buffer.from("hello")]))
        const nonMinimal = yield* Effect.promise(() => rawExchange(daemon.port,
          `GET /http/v1/vms/${created.vm.vmId}/non-minimal HTTP/1.1\r\n` +
          "Host: preview.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Proxy-Authorization: Bearer ${created.httpIngressToken}\r\n\r\n`))
        const invalidSplit = nonMinimal.indexOf("\r\n\r\n")
        expect(nonMinimal.subarray(0, invalidSplit).toString("latin1")).toContain(" 101 ")
        expect(nonMinimal.subarray(invalidSplit + 4)).toHaveLength(0)
      })))
    } finally {
      await closeServer(origin)
    }
  })
})

describe("daemon HTTP registry lifecycle", () => {
  it("closes an active SSE lease before destroy tears down and revokes ingress", async () => {
    const root = await prepareFixture()
    const origin = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.flushHeaders()
      response.write("data: ready\n\n")
    })
    const originPort = await listen(origin)
    const daemonServer = createServer()
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const daemon = yield* startDaemon(root, daemonServer, originPort)
        const { admin, created } = yield* createVm(daemon.port)
        const firstChunk = Promise.withResolvers<IncomingMessage>()
        const request = httpRequest({
          host: "127.0.0.1",
          port: daemon.port,
          path: `/http/v1/vms/${created.vm.vmId}/events`,
          headers: proxyHeaders(created.httpIngressToken, { accept: "text/event-stream" })
        }, (response) => {
          response.once("data", () => firstChunk.resolve(response))
        })
        request.end()
        const stream = yield* Effect.promise(() => firstChunk.promise)
        const closed = Promise.withResolvers<void>()
        stream.once("close", () => closed.resolve())
        const destroyed = yield* admin.destroy({ vmId: created.vm.vmId })
        yield* Effect.promise(() => closed.promise)
        expect(destroyed.destroyed).toBe(true)
        expect(daemon.stopCalls()).toBe(1)
        const revoked = yield* Effect.promise(() => requestDaemon({
          port: daemon.port,
          path: `/http/v1/vms/${created.vm.vmId}/`,
          headers: proxyHeaders(created.httpIngressToken)
        }))
        expect(revoked.status).toBe(401)
      })))
    } finally {
      await closeServer(origin)
    }
  })

  it("rejects the ninth SSE admission without opening a guest connection", async () => {
    const root = await prepareFixture()
    let originRequests = 0
    const origin = createServer((_request, response) => {
      originRequests++
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.flushHeaders()
      response.write("data: ready\n\n")
    })
    const originPort = await listen(origin)
    const daemonServer = createServer()
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const daemon = yield* startDaemon(root, daemonServer, originPort)
        const { created } = yield* createVm(daemon.port)
        const path = `/http/v1/vms/${created.vm.vmId}/events`
        const open = (): Promise<{ readonly request: ClientRequest; readonly response: IncomingMessage }> => {
          const ready = Promise.withResolvers<{
            readonly request: ClientRequest
            readonly response: IncomingMessage
          }>()
          const request = httpRequest({
            host: "127.0.0.1",
            port: daemon.port,
            path,
            headers: proxyHeaders(created.httpIngressToken, { accept: "text/event-stream" })
          }, (response) => {
            response.once("data", () => ready.resolve({ request, response }))
          })
          request.once("error", ready.reject)
          request.end()
          return ready.promise
        }
        const active = yield* Effect.promise(() => Promise.all(Array.from({ length: 8 }, () => open())))
        const rejected = yield* Effect.promise(() => requestDaemon({
          port: daemon.port,
          path,
          headers: proxyHeaders(created.httpIngressToken, { accept: "text/event-stream" })
        }))
        expect(rejected.status).toBe(429)
        expect(originRequests).toBe(8)
        for (const exchange of active) {
          exchange.response.destroy()
          exchange.request.destroy()
        }
      })))
    } finally {
      await closeServer(origin)
    }
  })
})

/**
 * A stalled guest upgrade used to keep a detached public socket half-open in the
 * server's connection set forever, which gated the Node HTTP server's unbounded
 * close finalizer ahead of VmRegistry shutdown: SIGTERM wedged and a stalled
 * `openGuest` lost the destroy abort because no listener was installed yet.
 */
describe("daemon HTTP ingress lifecycle bounds", () => {
  const wsKey = Buffer.from("0123456789abcdef").toString("base64")
  const upgradeRequest = (vmId: string, token: string, target = "/socket"): string =>
    `GET /http/v1/vms/${vmId}${target} HTTP/1.1\r\n` +
    "Host: preview.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
    "Sec-WebSocket-Version: 13\r\n" +
    `Sec-WebSocket-Key: ${wsKey}\r\n` +
    `Proxy-Authorization: Bearer ${token}\r\n\r\n`
  const vmDirectory = (root: string, vmId: string): string => join(root, "run", "vms", vmId)

  it("treats a public half-close before commitment as terminal", async () => {
    const root = await prepareFixture()
    const guestReached = Promise.withResolvers<void>()
    const origin = createServer()
    origin.on("connection", () => guestReached.resolve())
    const originPort = await listen(origin)
    const daemonServer = createServer()
    let stopCalls: () => number = () => 0
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const daemon = yield* startDaemon(root, daemonServer, originPort)
        const { created } = yield* createVm(daemon.port)
        stopCalls = daemon.stopCalls
        const socket = connect({ host: "127.0.0.1", port: daemon.port })
        yield* Effect.promise(() => once(socket, "connect"))
        socket.write(upgradeRequest(created.vm.vmId, created.httpIngressToken))
        yield* Effect.promise(() => guestReached.promise)
        const closed = once(socket, "close")
        socket.end()
        // Pre-fix the daemon never ended this exchange, so nothing closed it
        // until the 120s guest response-head deadline.
        yield* Effect.promise(() => closed)
        expect(socket.destroyed).toBe(true)
      })))
      expect(stopCalls()).toBe(1)
    } finally {
      await closeServer(origin)
    }
  })

  it("shuts down with a live stalled upgrade and releases the VM exactly once", async () => {
    const root = await prepareFixture()
    const guestReached = Promise.withResolvers<void>()
    const origin = createServer()
    origin.on("connection", () => guestReached.resolve())
    const originPort = await listen(origin)
    const daemonServer = createServer()
    let stopCalls: () => number = () => 0
    let vmId = ""
    try {
      const started = Date.now()
      const socketClosed = Promise.withResolvers<void>()
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const daemon = yield* startDaemon(root, daemonServer, originPort)
        const { created } = yield* createVm(daemon.port)
        stopCalls = daemon.stopCalls
        vmId = created.vm.vmId
        const socket = connect({ host: "127.0.0.1", port: daemon.port })
        yield* Effect.promise(() => once(socket, "connect"))
        socket.once("close", () => socketClosed.resolve())
        socket.write(upgradeRequest(created.vm.vmId, created.httpIngressToken))
        yield* Effect.promise(() => guestReached.promise)
        expect(existsSync(vmDirectory(root, created.vm.vmId))).toBe(true)
        // Leaving the scope is the SIGTERM-equivalent: Layer.launch finalizers
        // run, then VmRegistry shutdown destroys the VM.
      })))
      // Pre-fix the daemon server's drain blocked on this detached socket for
      // the whole 120s guest deadline, so shutdown never reached the registry.
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(stopCalls()).toBe(1)
      expect(existsSync(vmDirectory(root, vmId))).toBe(false)
      await socketClosed.promise
    } finally {
      await closeServer(origin)
    }
  }, 30_000)

  it("completes destroy while the guest channel open is still pending", async () => {
    const root = await prepareFixture()
    const openStarted = Promise.withResolvers<void>()
    const pendingGuest = Layer.succeed(GuestHttpChannel, GuestHttpChannel.of({
      open: () => Effect.sync(() => openStarted.resolve()).pipe(Effect.andThen(Effect.never))
    }))
    const origin = createServer()
    const originPort = await listen(origin)
    const daemonServer = createServer()
    let stopCalls: () => number = () => 0
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const daemon = yield* startDaemon(root, daemonServer, originPort, { guestHttp: pendingGuest })
        const { admin, created } = yield* createVm(daemon.port)
        stopCalls = daemon.stopCalls
        const socket = connect({ host: "127.0.0.1", port: daemon.port })
        yield* Effect.promise(() => once(socket, "connect"))
        socket.write(upgradeRequest(created.vm.vmId, created.httpIngressToken))
        yield* Effect.promise(() => openStarted.promise)
        const destroyStarted = Date.now()
        const destroyed = yield* admin.destroy({ vmId: created.vm.vmId })
        // Pre-fix the abort landed inside the openGuest await with no listener
        // installed, so the lease was never released and destroy failed with
        // "HTTP connection scopes remained active after VM teardown" after ~10s.
        expect(Date.now() - destroyStarted).toBeLessThan(7_000)
        expect(destroyed.destroyed).toBe(true)
        expect(existsSync(vmDirectory(root, created.vm.vmId))).toBe(false)
      })))
      expect(stopCalls()).toBe(1)
    } finally {
      await closeServer(origin)
    }
  }, 30_000)

  it("closes an active upgraded tunnel when the VM is destroyed", async () => {
    const root = await prepareFixture()
    const originSockets = new Set<Socket>()
    const origin = createServer()
    origin.on("upgrade", (request, socket) => {
      // Upgraded sockets leave the server's accounting, so this test reclaims
      // them itself; closeAllConnections() alone would never close the origin.
      originSockets.add(socket)
      socket.once("close", () => originSockets.delete(socket))
      const key = request.headers["sec-websocket-key"]
      if (typeof key !== "string") return socket.destroy()
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
        .digest("base64")
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      )
    })
    const originPort = await listen(origin)
    const daemonServer = createServer()
    let stopCalls: () => number = () => 0
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const daemon = yield* startDaemon(root, daemonServer, originPort)
        const { admin, created } = yield* createVm(daemon.port)
        stopCalls = daemon.stopCalls
        const socket = connect({ host: "127.0.0.1", port: daemon.port })
        yield* Effect.promise(() => once(socket, "connect"))
        socket.write(upgradeRequest(created.vm.vmId, created.httpIngressToken))
        const upgraded = yield* Effect.promise(() => once(socket, "data"))
        expect(upgraded[0].toString("latin1")).toContain(" 101 ")
        const closed = once(socket, "close")
        const destroyed = yield* admin.destroy({ vmId: created.vm.vmId })
        expect(destroyed.destroyed).toBe(true)
        yield* Effect.promise(() => closed)
        expect(socket.destroyed).toBe(true)
      })))
      expect(stopCalls()).toBe(1)
    } finally {
      for (const socket of originSockets) socket.destroy()
      await closeServer(origin)
    }
  })
})

describe("ingress idle policy", () => {
  it("arms one fixed window, resets on traffic, and stops after clear", () => {
    vi.useFakeTimers()
    try {
      let closures = 0
      const guard = ingressIdleGuard(DAEMON_HTTP_LIMITS.idleMs, () => {
        closures++
      })
      vi.advanceTimersByTime(DAEMON_HTTP_LIMITS.idleMs - 1_000)
      expect(closures).toBe(0)
      guard.touch()
      vi.advanceTimersByTime(DAEMON_HTTP_LIMITS.idleMs - 1_000)
      expect(closures).toBe(0)
      vi.advanceTimersByTime(2_000)
      expect(closures).toBe(1)
      guard.clear()
      vi.advanceTimersByTime(DAEMON_HTTP_LIMITS.idleMs * 2)
      expect(closures).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("documents the five-minute response and tunnel idle contract", () => {
    expect(DAEMON_HTTP_LIMITS.idleMs).toBe(300_000)
  })
})

describe("daemon ingress destroy during a pending guest open", () => {
  it.each([
    { kind: "ordinary", headers: {} as Record<string, string> },
    { kind: "SSE", headers: { accept: "text/event-stream" } }
  ])("completes destroy while a pending $kind guest open is still pending", async ({ headers }) => {
    const root = await prepareFixture()
    const openStarted = Promise.withResolvers<void>()
    const pendingGuest = Layer.succeed(GuestHttpChannel, GuestHttpChannel.of({
      open: () => Effect.sync(() => openStarted.resolve()).pipe(Effect.andThen(Effect.never))
    }))
    const origin = createServer()
    const originPort = await listen(origin)
    const daemonServer = createServer()
    let stopCalls: () => number = () => 0
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const daemon = yield* startDaemon(root, daemonServer, originPort, { guestHttp: pendingGuest })
        const { admin, created } = yield* createVm(daemon.port)
        stopCalls = daemon.stopCalls
        // Settle handlers are attached immediately: the daemon rejecting this
        // response is expected, and an unhandled rejection would fail the suite.
        const pending = requestDaemon({
          port: daemon.port,
          path: `/http/v1/vms/${created.vm.vmId}/`,
          headers: proxyHeaders(created.httpIngressToken, headers)
        }).then(() => "resolved" as const, () => "rejected" as const)
        yield* Effect.promise(() => openStarted.promise)
        const destroyStarted = Date.now()
        const destroyed = yield* admin.destroy({ vmId: created.vm.vmId })
        // The abort must be observed even though it lands inside the open.
        expect(Date.now() - destroyStarted).toBeLessThan(7_000)
        expect(destroyed.destroyed).toBe(true)
        const settled = yield* Effect.promise(() => pending)
        expect(settled).toBe("rejected")
        expect(existsSync(join(root, "run", "vms", created.vm.vmId))).toBe(false)
      })))
      expect(stopCalls()).toBe(1)
    } finally {
      await closeServer(origin)
    }
  }, 30_000)
})

describe("daemon ingress upgrade protocol version", () => {
  const wsKey = Buffer.from("0123456789abcdef").toString("base64")

  it("refuses a direct-daemon upgrade that is not HTTP/1.1", async () => {
    const root = await prepareFixture()
    let guestUpgrades = 0
    const origin = createServer()
    origin.on("upgrade", (_request, socket) => {
      guestUpgrades++
      socket.destroy()
    })
    const originPort = await listen(origin)
    const daemonServer = createServer()
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const daemon = yield* startDaemon(root, daemonServer, originPort)
        const { created } = yield* createVm(daemon.port)
        const socket = connect({ host: "127.0.0.1", port: daemon.port })
        const chunks: Array<Buffer> = []
        const read = Promise.withResolvers<string>()
        const deadline = setTimeout(() => read.reject(new Error("no refusal within 2000ms")), 2_000)
        deadline.unref()
        socket.on("data", (chunk) => {
          chunks.push(chunk)
          const text = Buffer.concat(chunks).toString("latin1")
          if (text.includes("\r\n\r\n")) read.resolve(text)
        })
        socket.once("error", read.reject)
        socket.once("close", () => clearTimeout(deadline))
        yield* Effect.promise(() => once(socket, "connect"))
        socket.write(
          `GET /http/v1/vms/${created.vm.vmId}/socket HTTP/1.0\r\n` +
          "Host: preview.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          `Sec-WebSocket-Key: ${wsKey}\r\n` +
          `Proxy-Authorization: Bearer ${created.httpIngressToken}\r\n\r\n`
        )
        const refusal = yield* Effect.promise(() => read.promise)
        clearTimeout(deadline)
        socket.destroy()
        expect(refusal).toContain(" 426 ")
        expect(guestUpgrades).toBe(0)
      })))
    } finally {
      await closeServer(origin)
    }
  }, 20_000)
})
