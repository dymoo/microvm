export const guestProtocolService = String.raw`
const http = require("node:http")
const { createHash } = require("node:crypto")
const server = http.createServer((request, response) => {
  if (request.url === "/headers") {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ authorization: request.headers.authorization || null, proxyAuthorization: request.headers["proxy-authorization"] || null }))
    return
  }
  if (request.url === "/sse") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    response.write("data: ready\n\n")
    const timer = setInterval(() => response.write("data: heartbeat\n\n"), 1000)
    request.once("close", () => clearInterval(timer))
    return
  }
  if (request.url === "/large") {
    response.writeHead(200, { "content-type": "application/octet-stream" })
    let remaining = 8 << 20
    const write = () => {
      while (remaining > 0) {
        const size = Math.min(32768, remaining)
        remaining -= size
        if (!response.write(Buffer.alloc(size, 120))) return response.once("drain", write)
      }
      response.end()
    }
    write()
    return
  }
  response.end("guest-http-ok")
})
server.on("upgrade", (request, socket, head) => {
  const key = request.headers["sec-websocket-key"]
  if (request.method !== "GET" || request.headers.upgrade !== "websocket" || typeof key !== "string") return socket.destroy()
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n")
  let pending = Buffer.alloc(0)
  const feed = (chunk) => {
    if (socket.destroyed) return
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    while (pending.length >= 2) {
      if (pending[0] !== 0x81 || (pending[1] & 128) === 0) return socket.destroy()
      const length = pending[1] & 127
      if (length >= 126) return socket.destroy()
      if (pending.length < 6 + length) return
      const payload = Buffer.alloc(length)
      for (let index = 0; index < length; index++) payload[index] = pending[6 + index] ^ pending[2 + (index % 4)]
      socket.write(Buffer.concat([Buffer.from([0x81, length]), payload]))
      pending = pending.subarray(6 + length)
    }
  }
  socket.on("data", feed)
  if (head.length > 0) feed(head)
})
server.listen(Number(process.env.PORT), process.env.HOSTNAME)
`
