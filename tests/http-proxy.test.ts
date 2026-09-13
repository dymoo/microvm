import { createHash } from "node:crypto"
import { once } from "node:events"
import {
  createServer,
  get,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http"
import { connect, type Socket } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { makeSandboxHttpProxy } from "../src/http-proxy.js"

const VM_ID = "mvm-abc12345"
const INGRESS_TOKEN = "vm-bound-http-ingress-token"
const WEBSOCKET_KEY = "dGhlIHNhbXBsZSBub25jZQ=="
const WEBSOCKET_ACCEPT = createHash("sha1")
  .update(`${WEBSOCKET_KEY}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
  .digest("base64")

const servers: Array<Server> = []
const sockets = new Set<Socket>()

const listen = async (server: Server): Promise<{ readonly origin: string; readonly port: number }> => {
  servers.push(server)
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("test server has no TCP port")
  return { origin: `http://127.0.0.1:${address.port}`, port: address.port }
}

const closeServers = async (): Promise<void> => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  while (servers.length > 0) {
    const server = servers.pop()!
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

afterEach(closeServers)

interface Harness {
  readonly daemon: Server
  readonly daemonOrigin: string
  readonly publicOrigin: string
  readonly publicPort: number
  readonly daemonConnections: () => number
  readonly daemonRequests: () => number
}

const harness = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<Harness> => {
  const daemon = createServer(handler)
  let daemonConnections = 0
  let daemonRequests = 0
  daemon.on("connection", () => { daemonConnections++ })
  daemon.on("request", () => { daemonRequests++ })
  const daemonAddress = await listen(daemon)
  const proxy = makeSandboxHttpProxy({
    daemonOrigin: new URL(daemonAddress.origin),
    vmId: VM_ID,
    httpIngressToken: INGRESS_TOKEN
  })
  const publicServer = createServer(proxy.handleRequest)
  publicServer.on("upgrade", proxy.handleUpgrade)
  // Node routes CONNECT to `connect` and `Expect: 100-continue` to
  // `checkContinue`, never to `request`, so a host must wire both refusals or
  // the socket is either answered silently or invited to send a body first.
  publicServer.on("connect", proxy.handleConnect)
  publicServer.on("checkContinue", proxy.handleCheckContinue)
  const publicAddress = await listen(publicServer)
  return {
    daemon,
    daemonOrigin: daemonAddress.origin,
    publicOrigin: publicAddress.origin,
    publicPort: publicAddress.port,
    daemonConnections: () => daemonConnections,
    daemonRequests: () => daemonRequests
  }
}

const rawRequest = async (port: number, payload: string | Buffer): Promise<string> => {
  const result = Promise.withResolvers<string>()
  const socket = connect(port, "127.0.0.1")
  let response = Buffer.alloc(0)
  socket.once("error", result.reject)
  socket.on("data", (chunk) => {
    response = Buffer.concat([response, chunk])
  })
  socket.once("close", () => result.resolve(response.toString("latin1")))
  socket.end(payload)
  return result.promise
}

const exchange = async (
  origin: string,
  path: string
): Promise<{ readonly status: number | undefined; readonly body: string; readonly location: string | undefined }> => {
  const result = Promise.withResolvers<{
    readonly status: number | undefined
    readonly body: string
    readonly location: string | undefined
  }>()
  const outgoing = get(origin + path, (response) => {
    const chunks: Array<Buffer> = []
    response.on("data", (chunk: Buffer) => chunks.push(chunk))
    response.once("end", () => result.resolve({
      status: response.statusCode,
      body: Buffer.concat(chunks).toString("utf8"),
      location: response.headers.location
    }))
  })
  outgoing.once("error", result.reject)
  return result.promise
}

const serverFrame = (text: string): Buffer => {
  const payload = Buffer.from(text)
  return Buffer.concat([Buffer.from([0x81, payload.byteLength]), payload])
}

const maskedClientFrame = (text: string): Buffer => {
  const payload = Buffer.from(text)
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const encoded = Buffer.alloc(payload.byteLength)
  for (let index = 0; index < payload.byteLength; index++) encoded[index] = payload[index]! ^ mask[index % 4]!
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.byteLength]), mask, encoded])
}

const unmaskClientFrame = (frame: Buffer): string | undefined => {
  if (frame.byteLength < 6 || (frame[1]! & 0x80) === 0) return undefined
  const length = frame[1]! & 0x7f

  if (length >= 126 || frame.byteLength < 6 + length) return undefined
  const mask = frame.subarray(2, 6)
  const decoded = Buffer.alloc(length)
  for (let index = 0; index < length; index++) decoded[index] = frame[6 + index]! ^ mask[index % 4]!
  return decoded.toString("utf8")
}
const oversizedClientFrameHeader = (): Buffer => {
  const header = Buffer.alloc(14)
  header[0] = 0x82
  header[1] = 0xff
  header.writeBigUInt64BE(BigInt(1024 * 1024 + 1), 2)
  header.set([0x12, 0x34, 0x56, 0x78], 10)
  return header
}

const parseServerFrames = (bytes: Buffer): ReadonlyArray<string> => {
  const messages: Array<string> = []
  let offset = 0
  while (offset + 2 <= bytes.byteLength) {
    const length = bytes[offset + 1]! & 0x7f
    if (length >= 126 || offset + 2 + length > bytes.byteLength) break
    messages.push(bytes.subarray(offset + 2, offset + 2 + length).toString("utf8"))
    offset += 2 + length
  }
  return messages
}

describe("SandboxHttpProxy ordinary HTTP", () => {
  it("streams request and response bodies while preserving only application headers", async () => {
    let observed:
      | { readonly url: string | undefined; readonly headers: IncomingMessage["headers"]; readonly rawHeaders: ReadonlyArray<string> }
      | undefined
    let releaseResponse!: () => void
    const responseReleased = new Promise<void>((resolve) => { releaseResponse = resolve })
    const test = await harness((incoming, response) => {
      observed = { url: incoming.url, headers: incoming.headers, rawHeaders: incoming.rawHeaders }
      let body = ""
      let opened = false
      incoming.setEncoding("utf8")
      incoming.on("data", (chunk: string) => {
        body += chunk
        if (!opened) {
          opened = true
          response.writeHead(200, {
            "content-type": "text/plain",
            "set-cookie": ["first=1", "second=2"]
          })
          response.flushHeaders()
          response.write(`first:${chunk};`)
        }
      })
      incoming.once("end", () => {
        void responseReleased.then(() => response.end(`all:${body}`))
      })
    })

    let firstChunk!: (chunk: string) => void
    const firstChunkSeen = new Promise<string>((resolve) => { firstChunk = resolve })
    const completed = new Promise<{ readonly body: string; readonly cookies: ReadonlyArray<string> }>((resolve, reject) => {
      const outgoing = request(`${test.publicOrigin}/upload?q=%2F`, {
        method: "POST",
        headers: {
          authorization: "Bearer application-token",
          connection: "x-remove",
          "proxy-authorization": "Bearer caller-controlled-token",
          "x-forwarded-host": "attacker.invalid",
          "x-remove": "must-not-cross"
        }
      }, (response) => {
        const chunks: Array<string> = []
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => {
          chunks.push(chunk)
          if (chunks.length === 1) firstChunk(chunk)
        })
        response.once("end", () => resolve({
          body: chunks.join(""),
          cookies: response.headers["set-cookie"] ?? []
        }))
      })
      outgoing.once("error", reject)
      outgoing.flushHeaders()
      outgoing.write("alpha")
      void firstChunkSeen.then(() => {
        outgoing.end("omega")
        releaseResponse()
      })
    })

    expect(await firstChunkSeen).toBe("first:alpha;")
    const result = await completed
    expect(result).toEqual({ body: "first:alpha;all:alphaomega", cookies: ["first=1", "second=2"] })
    expect(observed?.url).toBe(`/http/v1/vms/${VM_ID}/upload?q=%2F`)
    expect(observed?.headers.authorization).toBe("Bearer application-token")
    expect(observed?.headers["proxy-authorization"]).toBe(`Bearer ${INGRESS_TOKEN}`)
    expect(observed?.rawHeaders.filter((_, index) => index % 2 === 0 && observed?.rawHeaders[index]?.toLowerCase() === "proxy-authorization")).toHaveLength(1)
    expect(observed?.headers["x-forwarded-host"]).toBeUndefined()
    expect(observed?.headers["x-remove"]).toBeUndefined()
    expect(observed?.headers.host).toBe(new URL(test.daemonOrigin).host)
    expect(observed?.headers.connection?.toLowerCase()).toBe("close")
  })

  it("flushes SSE events without waiting for completion", async () => {
    let releaseSecond!: () => void
    const secondAllowed = new Promise<void>((resolve) => { releaseSecond = resolve })
    const test = await harness((_incoming, response) => {
      response.writeHead(200, {
        "cache-control": "no-cache",
        "content-type": "text/event-stream"
      })
      response.flushHeaders()
      response.write("data: first\n\n")
      void secondAllowed.then(() => response.end("data: second\n\n"))
    })

    let firstEvent!: (value: string) => void
    const firstEventSeen = new Promise<string>((resolve) => { firstEvent = resolve })
    const finished = new Promise<string>((resolve, reject) => {
      const outgoing = get(`${test.publicOrigin}/events`, (response) => {
        const chunks: Array<string> = []
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => {
          chunks.push(chunk)
          if (chunks.length === 1) firstEvent(chunk)
        })
        response.once("end", () => resolve(chunks.join("")))
      })
      outgoing.once("error", reject)
    })

    expect(await firstEventSeen).toBe("data: first\n\n")
    releaseSecond()
    expect(await finished).toBe("data: first\n\ndata: second\n\n")
  })

  it("cancels the daemon response when the public reader disconnects and never retries", async () => {
    let daemonRequests = 0
    let daemonClosed!: () => void
    const closed = new Promise<void>((resolve) => { daemonClosed = resolve })
    const test = await harness((_incoming, response) => {
      daemonRequests++
      response.writeHead(200, { "content-type": "application/octet-stream" })
      response.flushHeaders()
      response.write(Buffer.alloc(64 * 1024, 1))
      response.once("close", daemonClosed)
    })

    await new Promise<void>((resolve, reject) => {
      const outgoing = get(`${test.publicOrigin}/cancel`, (response) => {
        response.once("data", () => {
          response.destroy()
          resolve()
        })
      })
      outgoing.once("error", reject)
    })
    await closed
    expect(daemonRequests).toBe(1)
  })

  it("opens one daemon connection per exchange and never retries or follows redirects", async () => {
    let dropped = 0
    let followed = 0
    const daemonPorts = new Set<number>()
    const test = await harness((incoming, response) => {
      if (incoming.url?.endsWith("/drop") === true) {
        dropped++
        incoming.socket.destroy()
        return
      }
      if (incoming.url?.endsWith("/redirect") === true) {
        response.writeHead(302, { location: "/followed" })
        response.end("redirect")
        return
      }
      if (incoming.url?.endsWith("/followed") === true) followed++
      if (incoming.socket.remotePort !== undefined) daemonPorts.add(incoming.socket.remotePort)
      response.end("ok")
    })

    expect((await exchange(test.publicOrigin, "/drop")).status).toBe(502)
    const redirect = await exchange(test.publicOrigin, "/redirect")
    expect(redirect).toMatchObject({ status: 302, body: "redirect", location: "/followed" })
    expect((await exchange(test.publicOrigin, "/one")).body).toBe("ok")
    expect((await exchange(test.publicOrigin, "/two")).body).toBe("ok")
    expect(dropped).toBe(1)
    expect(followed).toBe(0)
    expect(daemonPorts.size).toBe(2)
  })
})

describe("SandboxHttpProxy WebSocket upgrades", () => {
  it("waits for a valid daemon 101, preserves coalesced bytes, and tunnels full duplex", async () => {
    let upgradeHeaders: IncomingMessage["headers"] | undefined
    const test = await harness((_incoming, response) => response.end("ordinary"))
    test.daemon.on("upgrade", (incoming, socket, head) => {
      upgradeHeaders = incoming.headers
      let buffered = head
      const consume = (): void => {
        const text = unmaskClientFrame(buffered)
        if (text === undefined) return
        socket.write(serverFrame(`echo:${text}`))
        buffered = Buffer.alloc(0)
      }
      socket.on("data", (chunk) => {
        buffered = Buffer.concat([buffered, chunk])
        consume()
      })
      const response = Buffer.from(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        `Sec-WebSocket-Accept: ${WEBSOCKET_ACCEPT}\r\n` +
        "Sec-WebSocket-Protocol: chat\r\n\r\n",
        "latin1"
      )
      socket.write(Buffer.concat([response, serverFrame("welcome")]))
      consume()
    })

    const handshake = Buffer.from(
      "GET /socket?q=%2F HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${test.publicPort}\r\n` +
      "Connection: keep-alive, Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      `Sec-WebSocket-Key: ${WEBSOCKET_KEY}\r\n` +
      "Sec-WebSocket-Protocol: chat\r\n" +
      "Sec-WebSocket-Extensions: permessage-deflate\r\n" +
      "Proxy-Authorization: Bearer caller-controlled-token\r\n\r\n",
      "latin1"
    )
    const response = await new Promise<Buffer>((resolve, reject) => {
      const socket = connect(test.publicPort, "127.0.0.1")
      let received = Buffer.alloc(0)
      socket.once("error", reject)
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, chunk])
        const split = received.indexOf("\r\n\r\n")
        if (split < 0) return
        const messages = parseServerFrames(received.subarray(split + 4))
        if (messages.length < 2) return
        socket.destroy()
        resolve(received)
      })
      socket.write(Buffer.concat([handshake, maskedClientFrame("ping")]))
    })

    const split = response.indexOf("\r\n\r\n")
    const responseHead = response.subarray(0, split + 4).toString("latin1")
    expect(responseHead).toContain("HTTP/1.1 101 Switching Protocols")
    expect(responseHead.toLowerCase()).not.toContain("sec-websocket-extensions")

    expect(parseServerFrames(response.subarray(split + 4))).toEqual(["welcome", "echo:ping"])
    expect(upgradeHeaders?.["proxy-authorization"]).toBe(`Bearer ${INGRESS_TOKEN}`)
    expect(upgradeHeaders?.["sec-websocket-extensions"]).toBeUndefined()
    expect(upgradeHeaders?.host).toBe(new URL(test.daemonOrigin).host)
  })
  it.each([
    { policy: "invalid masking", frame: () => serverFrame("unmasked-client-frame") },
    { policy: "oversized message", frame: oversizedClientFrameHeader }
  ])("closes the public socket without forwarding $policy frames", async ({ frame }) => {
    let daemonSocket: Socket | undefined
    let daemonPayloadBytes = 0
    const test = await harness((_incoming, response) => response.end())
    test.daemon.on("upgrade", (_incoming, socket, head) => {
      daemonSocket = socket
      daemonPayloadBytes += head.byteLength
      socket.on("data", (chunk) => {
        daemonPayloadBytes += chunk.byteLength
      })
      socket.on("error", () => undefined)
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        `Sec-WebSocket-Accept: ${WEBSOCKET_ACCEPT}\r\n\r\n`
      )
    })

    const handshake = Buffer.from(
      "GET /socket HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${test.publicPort}\r\n` +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      `Sec-WebSocket-Key: ${WEBSOCKET_KEY}\r\n\r\n`,
      "latin1"
    )
    const publicClosed = Promise.withResolvers<void>()
    const socket = connect(test.publicPort, "127.0.0.1", () => {
      socket.write(Buffer.concat([handshake, frame()]))
    })
    socket.on("error", () => undefined)
    socket.once("close", publicClosed.resolve)

    await publicClosed.promise
    expect(daemonSocket).toBeDefined()
    expect(daemonPayloadBytes).toBe(0)
  })

  it("does not expose 101 until the daemon handshake is valid", async () => {
    const test = await harness((_incoming, response) => response.end())
    test.daemon.on("upgrade", (_incoming, socket) => {
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Accept: invalid\r\n\r\n"
      )
    })
    const response = await rawRequest(test.publicPort,
      "GET /bad HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${test.publicPort}\r\n` +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      `Sec-WebSocket-Key: ${WEBSOCKET_KEY}\r\n\r\n`
    )
    expect(response).toContain("HTTP/1.1 502 Bad Gateway")
    expect(response).not.toContain("101 Switching Protocols")
  })
})

describe("SandboxHttpProxy refused semantics", () => {
  it("refuses CONNECT and Expect locally, then still serves ordinary requests", async () => {
    const test = await harness((_incoming, response) => response.end("ok"))

    // CONNECT arrives on the server's `connect` event. With no listener Node
    // closes the socket silently, so this is the one refusal a host must wire;
    // trailing bytes after the head must never become a tunnel.
    const connect = await rawRequest(
      test.publicPort,
      "CONNECT attacker.invalid:443 HTTP/1.1\r\n" +
      "Host: attacker.invalid\r\n\r\n" +
      "raw-tunnel-bytes"
    )
    expect(connect).toContain("HTTP/1.1 405 Method Not Allowed")
    expect(connect).toContain("Connection: close")
    expect(connect.toLowerCase()).not.toContain("101")
    expect(connect).not.toContain("raw-tunnel-bytes")

    // `Expect: 100-continue` arrives on `checkContinue`. Node answers an
    // unwired expectation itself by writing an interim `100 Continue` and then
    // emitting `request`, which invites a body this adapter will never forward.
    const expectContinue = await rawRequest(
      test.publicPort,
      "POST /upload HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${test.publicPort}\r\n` +
      "Expect: 100-continue\r\n" +
      "Content-Length: 5\r\n\r\n"
    )
    expect(expectContinue).toContain("HTTP/1.1 400 Bad Request")
    expect(expectContinue.toLowerCase()).not.toContain("100 continue")
    expect(expectContinue.toLowerCase()).toContain("connection: close")

    // Neither refusal may cross the daemon seam at all.
    expect(test.daemonConnections()).toBe(0)
    expect(test.daemonRequests()).toBe(0)

    expect((await exchange(test.publicOrigin, "/ordinary")).body).toBe("ok")
    expect(test.daemonRequests()).toBe(1)
  })
})

describe("SandboxHttpProxy refusal pressure", () => {
  it("refuses an over-limit body without draining it or holding the socket", async () => {
    const test = await harness((_request, response) => response.end("unexpected"))
    const socket = connect({ host: "127.0.0.1", port: test.publicPort })
    const chunks: Array<Buffer> = []
    const received = Promise.withResolvers<string>()
    const deadline = setTimeout(() => received.reject(new Error("no refusal within 2000ms")), 2_000)
    deadline.unref()
    const closed = Promise.withResolvers<void>()
    socket.on("data", (chunk) => {
      chunks.push(chunk)
      const text = Buffer.concat(chunks).toString("latin1")
      if (text.includes("\r\n\r\n")) received.resolve(text)
    })
    socket.once("error", received.reject)
    socket.once("close", () => {
      clearTimeout(deadline)
      closed.resolve()
    })
    await once(socket, "connect")
    // Declare (and never finish) a body far past the adapter's cap: the refusal
    // must be immediate, must close the connection, and must not leave the
    // trusted server draining an attacker-sized body.
    socket.write(
      "POST /submit HTTP/1.1\r\nHost: preview.test\r\n" +
      `Content-Length: ${16 * 1024 * 1024 + 1}\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n"
    )
    const refusal = await received.promise
    expect(refusal).toContain(" 413 ")
    expect(refusal.toLowerCase()).toContain("connection: close")
    await closed.promise
    expect(socket.destroyed).toBe(true)
  }, 20_000)
})

describe("SandboxHttpProxy target and header safety", () => {
  it("rejects non-origin targets, forbidden methods, malformed upgrades, and reserved fields locally", async () => {
    let daemonRequests = 0
    const test = await harness((_incoming, response) => {
      daemonRequests++
      response.end("unexpected")
    })

    const cases = [
      {
        payload: "GET http://attacker.invalid/stolen HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n",
        status: 400
      },
      {
        payload: "GET attacker.invalid:80 HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n",
        status: 400
      },
      {
        payload: "TRACE / HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n",
        status: 405
      },
      {
        // Routed to the proxy's `handleConnect` through the server's connect
        // event; without a listener Node would close with no response at all.
        payload: "CONNECT attacker.invalid:443 HTTP/1.1\r\nHost: attacker.invalid\r\n\r\n",
        status: 405
      },
      {
        payload: "GET /upgrade HTTP/1.1\r\nHost: example\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n",
        status: 426
      },
      {
        payload: "GET / HTTP/1.1\r\nHost: example\r\nMicrovm-Target: attacker\r\nConnection: close\r\n\r\n",
        status: 400
      }
    ]
    for (const entry of cases) {
      const response = await rawRequest(test.publicPort, entry.payload)
      expect(response, entry.payload).toContain(`HTTP/1.1 ${entry.status} `)
    }
    expect(daemonRequests).toBe(0)
  })
})
