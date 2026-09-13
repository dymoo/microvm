import { createHash } from "node:crypto"
import { once } from "node:events"
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type Server
} from "node:http"
import { connect, Socket } from "node:net"
import { describe, expect, it } from "vitest"
import { makeSandboxHttpProxy } from "../src/http-proxy.js"
import { assertRevokedIngress, listenTrustedProxy, rawStatus, requestStatus } from "../scripts/http-preview-proxy.mjs"

const WEBSOCKET_KEY = "MDEyMzQ1Njc4OWFiY2RlZg=="
const RELEASE_LIMIT_MS = 500

// Real deadlines are the behavior under test: fake time cannot expose native
// server-close and connection-lifecycle callbacks that never arrive.
const settleWithin = async <Value>(work: Promise<Value>, label: string): Promise<Value> => {
  const timedOut = Promise.withResolvers<never>()
  const deadline: NodeJS.Timeout = setTimeout(
    () => timedOut.reject(new Error(`${label} did not settle within ${RELEASE_LIMIT_MS}ms`)),
    RELEASE_LIMIT_MS
  )
  deadline.unref()
  try {
    return await Promise.race([work, timedOut.promise])
  } finally {
    clearTimeout(deadline)
  }
}

describe("trusted preview proxy server", () => {
  it("releases both ends of an upgraded connection", async () => {
    let upgradedSocket: { destroyed: boolean } | undefined
    const proxy = await listenTrustedProxy({
      handleRequest: (_request, response) => response.end("ok"),
      handleConnect: (_request, socket) => socket.end(),
      handleCheckContinue: (_request, response) => response.end(),
      handleUpgrade: (_request, socket) => {
        upgradedSocket = socket
        const accept = createHash("sha1")
          .update(`${WEBSOCKET_KEY}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64")
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        )
      }
    })
    const clientSocket = connect({ host: "127.0.0.1", port: proxy.port })

    try {
      await once(clientSocket, "connect")
      clientSocket.write(
        "GET /ws HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${proxy.port}\r\n` +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        `Sec-WebSocket-Key: ${WEBSOCKET_KEY}\r\n\r\n`
      )
      await once(clientSocket, "data")
      const clientClosed = once(clientSocket, "close")

      await settleWithin(proxy.close(), "trusted proxy release")
      await settleWithin(clientClosed, "upgraded client socket close")

      expect(proxy.server.listening).toBe(false)
      expect(upgradedSocket?.destroyed).toBe(true)
      expect(clientSocket.destroyed).toBe(true)
    } finally {
      clientSocket.destroy()
      if (proxy.server.listening) await settleWithin(proxy.close(), "trusted proxy cleanup")
    }
  })
})

describe("trusted preview proxy refusals", () => {
  it("refuses CONNECT and Expect through the real adapter without reaching the daemon", async () => {
    let daemonConnections = 0
    let daemonRequests = 0
    const daemon = createServer((_request, response) => {
      daemonRequests++
      response.end("daemon")
    })
    daemon.on("connection", () => { daemonConnections++ })
    const daemonPort = await listenOnLoopback(daemon)
    const proxy = await listenTrustedProxy(makeSandboxHttpProxy({
      daemonOrigin: new URL(`http://127.0.0.1:${daemonPort}`),
      vmId: "mvm-trusted1",
      httpIngressToken: "trusted-preview-ingress-token"
    }))

    try {
      // Both probes are refused by the adapter's own handlers. Before the
      // trusted listener wired `connect`/`checkContinue`, CONNECT closed with
      // no response and Expect was answered with an interim `100 Continue`.
      expect(await rawStatus("trusted CONNECT probe", proxy.port, "CONNECT", "example.invalid:443")).toBe(405)
      expect(await rawStatus("trusted Expect probe", proxy.port, "POST", "/upload", {
        headers: { expect: "100-continue", "content-length": "5" }
      })).toBe(400)
      expect(daemonConnections).toBe(0)
      expect(daemonRequests).toBe(0)

      expect(await requestStatus("trusted ordinary probe", proxy.origin, "GET", "/")).toBe(200)
      expect(daemonRequests).toBe(1)
    } finally {
      await proxy.close()
      await closeServer(daemon)
    }
  })

  it("distinguishes revoked credentials from temporary ingress unavailability", async () => {
    const server = createServer((request, response) => {
      response.writeHead(request.url === "/revoked" ? 401 : 503)
      response.end()
    })
    const port = await listenOnLoopback(server)
    try {
      const revoked = await requestStatus("revoked credential probe", `http://127.0.0.1:${port}`, "GET", "/revoked")
      expect(() => assertRevokedIngress(revoked)).not.toThrow()
      const unavailable = await requestStatus("unavailable ingress probe", `http://127.0.0.1:${port}`, "GET", "/unavailable")
      expect(() => assertRevokedIngress(unavailable)).toThrow("revoked ingress returned HTTP 503")
    } finally {
      await closeServer(server)
    }
  })

  it("refuses a proxy that is missing a refusal handler instead of accepting it", async () => {
    await expect(listenTrustedProxy({
      handleRequest: () => undefined,
      handleUpgrade: () => undefined
    })).rejects.toThrow("handleConnect")
  })
})

const listenOnLoopback = async (server: Server): Promise<number> => {
  const listening = Promise.withResolvers<void>()
  server.once("error", listening.reject)
  server.listen(0, "127.0.0.1", listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("test server has no TCP port")
  return address.port
}

const closeServer = async (server: Server): Promise<void> => {
  const closed = Promise.withResolvers<void>()
  server.close((error) => {
    if (error === undefined) closed.resolve()
    else closed.reject(error)
  })
  await settleWithin(closed.promise, "test server close")
}

describe("HTTP preview denial probes", () => {
  it("times out and closes a request when a server accepts but never responds", async () => {
    const server = createServer()
    const listening = Promise.withResolvers<void>()
    server.once("error", listening.reject)
    server.listen(0, "127.0.0.1", listening.resolve)
    await listening.promise
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("silent test server has no TCP port")

    const accepted = Promise.withResolvers<Socket>()
    server.once("connection", accepted.resolve)
    const status = requestStatus(
      "silent request probe",
      `http://127.0.0.1:${address.port}`,
      "GET",
      "/",
      {},
      {
        timeoutMs: 50,
        request: (options: RequestOptions, onResponse: (response: IncomingMessage) => void) => {
          const request = httpRequest(options, onResponse)
          request.setTimeout = () => request
          return request
        }
      }
    )
    try {
      const serverSocket = await settleWithin(accepted.promise, "silent server accept")
      const serverSocketClosed = once(serverSocket, "close")
      await expect(settleWithin(status, "silent request result"))
        .rejects.toThrow("silent request probe exceeded 50ms")
      await settleWithin(serverSocketClosed, "silent request socket close")
      expect(serverSocket.destroyed).toBe(true)
    } finally {
      server.closeAllConnections()
      if (server.listening) {
        const closed = Promise.withResolvers<void>()
        server.close((error) => {
          if (error === undefined) closed.resolve()
          else closed.reject(error)
        })
        await settleWithin(closed.promise, "silent server close")
      }
    }
  })

  it("times out and closes a socket when connection establishment never completes", async () => {
    const stalledSocket = new Socket()
    stalledSocket.setTimeout = () => stalledSocket
    const socketClosed = once(stalledSocket, "close")

    await expect(settleWithin(
      rawStatus("stalled connection probe", 1, "GET", "/", {
        timeoutMs: 50,
        connect: () => stalledSocket
      }),
      "stalled connection result"
    )).rejects.toThrow("stalled connection probe exceeded 50ms")
    await settleWithin(socketClosed, "stalled socket close")
    expect(stalledSocket.destroyed).toBe(true)
  })
})
