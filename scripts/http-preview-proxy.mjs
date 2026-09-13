import { createServer } from "node:http"

const CLOSE_DEADLINE_MS = 2_000

/**
 * Starts the trusted loopback proxy server for the preview acceptance run.
 *
 * Node's HTTP server detaches upgraded sockets from its connection accounting,
 * so every accepted connection is tracked explicitly. Release first stops
 * admission, then destroys every connection (including upgraded Duplexes), and
 * finally waits under a labelled deadline for the listener to close.
 */
export const listenTrustedProxy = async (handleRequest, handleUpgrade) => {
  const sockets = new Set()
  let accepting = true

  const track = (socket) => {
    if (!accepting) {
      socket.destroy()
      return false
    }
    if (!sockets.has(socket)) {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
    }
    return true
  }

  const server = createServer((request, response) => {
    if (!accepting) {
      response.shouldKeepAlive = false
      response.writeHead(503)
      response.end()
      return
    }
    handleRequest(request, response)
  })
  server.on("connection", track)
  server.on("upgrade", (request, socket, head) => {
    if (!track(socket)) return
    handleUpgrade(request, socket, head)
  })
  const listening = Promise.withResolvers()
  const onError = (error) => {
    server.off("listening", onListening)
    listening.reject(error)
  }
  const onListening = () => {
    server.off("error", onError)
    listening.resolve()
  }
  server.once("error", onError)
  server.listen(0, "127.0.0.1", onListening)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("trusted proxy has no TCP port")
  }

  return {
    server,
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      accepting = false
      const closed = Promise.withResolvers()
      server.close((error) => {
        if (error === undefined) closed.resolve()
        else closed.reject(error)
      })
      for (const socket of sockets) socket.destroy()

      let deadline
      try {
        const timedOut = Promise.withResolvers()
        deadline = setTimeout(
          () => timedOut.reject(new Error(`trusted proxy close exceeded ${CLOSE_DEADLINE_MS}ms`)),
          CLOSE_DEADLINE_MS
        )
        await Promise.race([closed.promise, timedOut.promise])
      } finally {
        clearTimeout(deadline)
      }
    }
  }
}
