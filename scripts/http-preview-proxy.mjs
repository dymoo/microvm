import { createServer, request as httpRequest } from "node:http"
import { connect as openConnection } from "node:net"

const CLOSE_DEADLINE_MS = 2_000
const PROBE_DEADLINE_MS = 5_000

const timedOut = (label, milliseconds) => new Error(`${label} exceeded ${milliseconds}ms`)

/**
 * Reads one HTTP status under an absolute wall-clock deadline. The timer is
 * armed before Node creates the request, so stalled connection setup is bounded.
 */
export const requestStatus = (
  label,
  origin,
  method,
  target,
  headers = {},
  { timeoutMs = PROBE_DEADLINE_MS, request = httpRequest } = {}
) => {
  const result = Promise.withResolvers()
  const url = new URL(origin)
  let activeRequest
  let settled = false
  let deadline

  const settle = (error, status, destroy = false) => {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    if (destroy) activeRequest?.destroy()
    if (error === undefined) result.resolve(status)
    else result.reject(error)
  }

  deadline = setTimeout(
    () => settle(timedOut(label, timeoutMs), undefined, true),
    timeoutMs
  )
  try {
    activeRequest = request({
      host: url.hostname,
      port: Number(url.port),
      method,
      path: target,
      headers,
      agent: false
    }, (response) => {
      response.resume()
      response.once("error", (error) => settle(error, undefined, true))
      response.once("aborted", () => settle(new Error(`${label} response aborted`), undefined, true))
      response.once("end", () => settle(undefined, response.statusCode ?? 0))
    })
    activeRequest.once("error", (error) => settle(error))
    activeRequest.end()
  } catch (error) {
    settle(error, undefined, true)
  }
  return result.promise
}

/**
 * Sends one raw HTTP request under an absolute wall-clock deadline, including
 * connection establishment. Every terminal path shares one idempotent cleanup.
 */
export const rawStatus = (
  label,
  port,
  method,
  target,
  { timeoutMs = PROBE_DEADLINE_MS, connect = openConnection } = {}
) => {
  const result = Promise.withResolvers()
  let socket
  let bytes = Buffer.alloc(0)
  let settled = false
  let deadline

  const settle = (error, status, destroy = false) => {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    if (destroy) socket?.destroy()
    if (error === undefined) result.resolve(status)
    else result.reject(error)
  }

  deadline = setTimeout(
    () => settle(timedOut(label, timeoutMs), undefined, true),
    timeoutMs
  )
  try {
    socket = connect({ host: "127.0.0.1", port })
    socket.once("error", (error) => settle(error))
    socket.once("close", () => settle(new Error(`${label} connection closed before response`)))
    socket.once("connect", () => {
      try {
        socket.write(`${method} ${target} HTTP/1.1\r\nHost: trusted.invalid\r\nConnection: close\r\n\r\n`)
      } catch (error) {
        settle(error, undefined, true)
      }
    })
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk])
      const end = bytes.indexOf("\r\n")
      if (end === -1) return
      const match = /^HTTP\/1\.1 ([0-9]{3}) /.exec(bytes.subarray(0, end).toString("ascii"))
      if (match === null) settle(new Error(`${label} received a malformed response`), undefined, true)
      else settle(undefined, Number(match[1]), true)
    })
  } catch (error) {
    settle(error, undefined, true)
  }
  return result.promise
}

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
