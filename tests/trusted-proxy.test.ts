import { createHash } from "node:crypto"
import { once } from "node:events"
import { connect } from "node:net"
import { describe, expect, it } from "vitest"
import { listenTrustedProxy } from "../scripts/http-preview-proxy.mjs"

const WEBSOCKET_KEY = "MDEyMzQ1Njc4OWFiY2RlZg=="
const RELEASE_LIMIT_MS = 500

// A real deadline is the behavior under test: fake time cannot expose a native
// `server.close()` callback that never arrives after an HTTP Upgrade.
const settleWithin = async (work: Promise<unknown>, label: string): Promise<void> => {
  const timedOut = Promise.withResolvers<never>()
  const deadline: NodeJS.Timeout = setTimeout(
    () => timedOut.reject(new Error(`${label} did not settle within ${RELEASE_LIMIT_MS}ms`)),
    RELEASE_LIMIT_MS
  )
  deadline.unref()
  try {
    await Promise.race([work, timedOut.promise])
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
