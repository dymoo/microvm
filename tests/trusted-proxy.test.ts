import { createHash } from "node:crypto"
import { once } from "node:events"
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http"
import { connect, Socket } from "node:net"
import { describe, expect, it } from "vitest"
import { listenTrustedProxy, rawStatus, requestStatus } from "../scripts/http-preview-proxy.mjs"

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
    const proxy = await listenTrustedProxy(
      (_request, response) => response.end("ok"),
      (_request, socket) => {
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
    )
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
