#!/usr/bin/env node

import { randomBytes, createHash } from "node:crypto"
import { once } from "node:events"
import { createServer, request as httpRequest } from "node:http"
import { connect } from "node:net"
import { Effect, Result } from "effect"
import { makeMicrovmClient, makeMicrovmCluster } from "../dist/index.js"

const daemonUrl = process.env.MICROVM_URL
const adminToken = process.env.MICROVM_TOKEN
const image = process.env.MICROVM_IMAGE ?? "node"
if (!daemonUrl || !adminToken) {
  throw new Error("MICROVM_URL and MICROVM_TOKEN are required")
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const listenProxy = (proxy) => Effect.acquireRelease(
  Effect.promise(async () => {
    const server = createServer(proxy.handleRequest)
    server.on("upgrade", proxy.handleUpgrade)
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("trusted proxy has no TCP port")
    return { server, origin: `http://127.0.0.1:${address.port}`, port: address.port }
  }),
  ({ server }) => Effect.promise(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
)

const waitForResponse = async (url, predicate, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs
  let last = "no response"
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" })
      const body = await response.text()
      last = `HTTP ${response.status}`
      if (predicate(response, body)) return { response, body }
    } catch (error) {
      last = String(error)
    }
    await delay(100)
  }
  throw new Error(`timed out waiting for ${url}: ${last}`)
}

const requestStatus = (origin, method, target, headers = {}) => new Promise((resolve, reject) => {
  const url = new URL(origin)
  const request = httpRequest({
    host: url.hostname,
    port: Number(url.port),
    method,
    path: target,
    headers,
    agent: false
  }, (response) => {
    response.resume()
    response.once("end", () => resolve(response.statusCode ?? 0))
  })
  request.once("error", reject)
  request.end()
})

const requestJson = (origin, target, headers) => new Promise((resolve, reject) => {
  const url = new URL(origin)
  const request = httpRequest({
    host: url.hostname,
    port: Number(url.port),
    method: "GET",
    path: target,
    headers,
    agent: false
  }, (response) => {
    const chunks = []
    response.on("data", (chunk) => chunks.push(chunk))
    response.once("end", () => {
      if (response.statusCode !== 200) {
        reject(new Error(`header reflection returned HTTP ${response.statusCode}`))
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch (error) {
        reject(error)
      }
    })
  })
  request.once("error", reject)
  request.end()
})

const rawStatus = (port, method, target) => new Promise((resolve, reject) => {
  const socket = connect({ host: "127.0.0.1", port })
  let bytes = Buffer.alloc(0)
  socket.once("error", reject)
  socket.once("connect", () => socket.write(`${method} ${target} HTTP/1.1\r\nHost: trusted.invalid\r\nConnection: close\r\n\r\n`))
  socket.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, chunk])
    const end = bytes.indexOf("\r\n")
    if (end === -1) return
    const match = /^HTTP\/1\.1 ([0-9]{3}) /.exec(bytes.subarray(0, end).toString("ascii"))
    socket.destroy()
    if (match === null) reject(new Error("malformed trusted proxy response"))
    else resolve(Number(match[1]))
  })
})

const websocketFrame = (text) => {
  const payload = Buffer.from(text)
  assert(payload.length < 126, "acceptance websocket payload is unexpectedly large")
  const mask = randomBytes(4)
  const frame = Buffer.alloc(6 + payload.length)
  frame[0] = 0x81
  frame[1] = 0x80 | payload.length
  mask.copy(frame, 2)
  for (let index = 0; index < payload.length; index++) frame[6 + index] = payload[index] ^ mask[index % 4]
  return frame
}

const openWebSocket = (port, path = "/ws") => new Promise((resolve, reject) => {
  const socket = connect({ host: "127.0.0.1", port })
  const key = randomBytes(16).toString("base64")
  let bytes = Buffer.alloc(0)
  const fail = (error) => {
    socket.destroy()
    reject(error)
  }
  socket.once("error", fail)
  socket.once("connect", () => socket.write(
    `GET ${path} HTTP/1.1\r\nHost: trusted.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`
  ))
  socket.on("data", function handshake(chunk) {
    bytes = Buffer.concat([bytes, chunk])
    const end = bytes.indexOf("\r\n\r\n")
    if (end === -1) return
    socket.off("data", handshake)
    socket.off("error", fail)
    const head = bytes.subarray(0, end).toString("ascii")
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    if (!head.startsWith("HTTP/1.1 101 ") || !head.toLowerCase().includes(`sec-websocket-accept: ${accept}`.toLowerCase())) {
      fail(new Error(`websocket upgrade failed: ${head.split("\r\n")[0]}`))
      return
    }
    resolve(socket)
  })
})

const echoWebSocket = (socket, text) => new Promise((resolve, reject) => {
  let bytes = Buffer.alloc(0)
  const fail = (error) => {
    socket.off("data", onData)
    reject(error)
  }
  const onData = (chunk) => {
    bytes = Buffer.concat([bytes, chunk])
    if (bytes.length < 2) return
    const length = bytes[1] & 0x7f
    if (length >= 126 || bytes.length < 2 + length) return
    socket.off("data", onData)
    socket.off("error", fail)
    resolve(bytes.subarray(2, 2 + length).toString("utf8"))
  }
  socket.once("error", fail)
  socket.on("data", onData)
  socket.write(websocketFrame(text))
})

const closeWithin = async (promise, milliseconds, label) => {
  await Promise.race([
    promise,
    delay(milliseconds).then(() => { throw new Error(`${label} did not close within ${milliseconds}ms`) })
  ])
}

const guestProtocolService = String.raw`
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
    response.write("data: ready\\n\\n")
    const timer = setInterval(() => response.write("data: heartbeat\\n\\n"), 1000)
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
server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"]
  if (request.method !== "GET" || request.headers.upgrade !== "websocket" || typeof key !== "string") return socket.destroy()
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n")
  socket.on("data", (frame) => {
    if (frame.length < 6 || (frame[0] & 15) !== 1 || (frame[1] & 128) === 0) return socket.destroy()
    const length = frame[1] & 127
    if (length >= 126 || frame.length < 6 + length) return socket.destroy()
    const payload = Buffer.alloc(length)
    for (let index = 0; index < length; index++) payload[index] = frame[6 + index] ^ frame[2 + (index % 4)]
    socket.write(Buffer.concat([Buffer.from([0x81, length]), payload]))
  })
})
server.listen(Number(process.env.PORT), process.env.HOSTNAME)
`

const program = Effect.scoped(Effect.gen(function*() {
  const cluster = yield* makeMicrovmCluster({ endpoints: [{ url: daemonUrl, token: adminToken }] })
  const adminClient = yield* makeMicrovmClient({ url: daemonUrl, token: adminToken })

  const next = yield* cluster.create({ image, cpus: 1, memMib: 768, ttlSeconds: 900 })
  try {
    const initialized = yield* next.execute({ argv: ["/usr/local/bin/microvm-next-init"] })
    assert(initialized.exitCode === 0, "Next workspace initialization failed")
    const forbiddenEnvironment = yield* Effect.result(next.startWebService({
      argv: ["/usr/local/bin/pnpm", "dev"],
      cwd: "/workspace",
      env: { PORT: "3999" }
    }))
    assert(Result.isFailure(forbiddenEnvironment), "web service accepted caller-controlled PORT")

    const nextService = yield* next.startWebService({ argv: ["/usr/local/bin/pnpm", "dev"], cwd: "/workspace" })
    const nextProxy = yield* next.http()
    const nextPublic = yield* listenProxy(nextProxy)
    const initial = yield* Effect.promise(() => waitForResponse(
      `${nextPublic.origin}/`,
      (response, body) => response.status === 200 && body.includes("Ready to build.")
    ))
    const assetPath = /(?:src|href)="(\/_next\/[^"?]+(?:\?[^" ]*)?)"/.exec(initial.body)?.[1]
    assert(assetPath !== undefined, "Next page did not reference a _next asset")
    const asset = yield* Effect.promise(() => fetch(`${nextPublic.origin}${assetPath}`))
    assert(asset.status === 200, `Next asset returned HTTP ${asset.status}`)
    yield* Effect.promise(() => asset.arrayBuffer())

    const mutated = yield* next.execute({
      argv: [
        "/usr/bin/python3",
        "-c",
        "p='/workspace/app/page.tsx';s=open(p).read();open(p,'w').write(s.replace('Ready to build.','Updated through concurrent exec.'))"
      ]
    })
    assert(mutated.exitCode === 0, "concurrent exec could not mutate the running Next workspace")
    const status = yield* nextService.status()
    assert(status.state === "running", "Next service did not survive concurrent exec")
    yield* Effect.promise(() => waitForResponse(
      `${nextPublic.origin}/`,
      (response, body) => response.status === 200 && body.includes("Updated through concurrent exec.")
    ))

    const network = yield* next.execute({
      argv: ["/usr/bin/python3", "-c", "import socket;s=socket.socket();s.settimeout(.5);s.connect(('1.1.1.1',53))"]
    })
    assert(network.exitCode !== 0, "preview-enabled guest unexpectedly reached an external network")
    assert((yield* nextService.stop()).stopped === true, "Next service stop was not confirmed")
  } finally {
    yield* next.destroy().pipe(Effect.catch(() => Effect.void))
  }

  const protocol = yield* cluster.create({ image, cpus: 1, memMib: 512, ttlSeconds: 900 })
  const protocolService = yield* protocol.startWebService({ argv: ["/usr/bin/node", "-e", guestProtocolService] })
  const protocolProxy = yield* protocol.http()
  const publicServer = yield* listenProxy(protocolProxy)
  yield* Effect.promise(() => waitForResponse(
    `${publicServer.origin}/`,
    (response, body) => response.status === 200 && body === "guest-http-ok"
  ))

  const missing = yield* Effect.promise(() => requestStatus(
    daemonUrl,
    "GET",
    `/http/v1/vms/${protocol.vm.vmId}/`
  ))
  assert(missing === 401, `missing ingress capability returned HTTP ${missing}`)
  const controlCredential = yield* Effect.promise(() => requestStatus(
    daemonUrl,
    "GET",
    `/http/v1/vms/${protocol.vm.vmId}/`,
    { "proxy-authorization": `Bearer ${adminToken}` }
  ))
  assert(controlCredential === 401, `admin credential authenticated data ingress: HTTP ${controlCredential}`)
  const tokenDonor = yield* adminClient.create({ image, cpus: 1, memMib: 256, ttlSeconds: 300 })
  try {
    const crossVmCredential = yield* Effect.promise(() => requestStatus(
      daemonUrl,
      "GET",
      `/http/v1/vms/${protocol.vm.vmId}/`,
      { "proxy-authorization": `Bearer ${tokenDonor.httpIngressToken}` }
    ))
    assert(crossVmCredential === 404, `cross-VM ingress credential returned HTTP ${crossVmCredential}`)
  } finally {
    yield* adminClient.destroy({ vmId: tokenDonor.vm.vmId }).pipe(Effect.catch(() => Effect.void))
  }
  assert((yield* Effect.promise(() => rawStatus(publicServer.port, "CONNECT", "example.invalid:443"))) === 405, "CONNECT was not rejected")
  assert((yield* Effect.promise(() => rawStatus(publicServer.port, "TRACE", "/"))) === 405, "TRACE was not rejected")
  assert((yield* Effect.promise(() => rawStatus(publicServer.port, "GET", "http://example.invalid/"))) === 400, "absolute-form target was not rejected")

  const headers = yield* Effect.promise(() => requestJson(
    publicServer.origin,
    "/headers",
    { authorization: "Bearer application-data", "proxy-authorization": "Bearer attacker-data" }
  ))
  assert(headers.authorization === "Bearer application-data", "application Authorization was not preserved")
  assert(headers.proxyAuthorization === null, "Proxy-Authorization reached the guest")

  const websocket = yield* Effect.promise(() => openWebSocket(publicServer.port))
  assert((yield* Effect.promise(() => echoWebSocket(websocket, "preview-echo"))) === "preview-echo", "websocket echo failed")

  const heldSse = []
  for (let index = 0; index < 8; index++) {
    const response = yield* Effect.promise(() => fetch(`${publicServer.origin}/sse`))
    assert(response.status === 200 && response.body !== null, `SSE slot ${index} failed with HTTP ${response.status}`)
    const reader = response.body.getReader()
    const first = yield* Effect.promise(() => reader.read())
    assert(!first.done && Buffer.from(first.value).includes("data: ready"), `SSE slot ${index} did not flush immediately`)
    heldSse.push(reader)
  }
  const saturated = yield* Effect.promise(() => fetch(`${publicServer.origin}/sse`))
  assert(saturated.status === 429, `ninth SSE returned HTTP ${saturated.status}, expected 429`)
  yield* Effect.promise(() => saturated.body?.cancel())
  for (const reader of heldSse) yield* Effect.promise(() => reader.cancel())

  const slow = yield* Effect.promise(() => fetch(`${publicServer.origin}/large`))
  assert(slow.status === 200 && slow.body !== null, "large streamed response did not start")
  yield* Effect.promise(async () => {
    const reader = slow.body.getReader()
    await reader.read()
    await reader.cancel()
  })
  assert((yield* protocolService.status()).state === "running", "slow-reader cancellation killed the web service")

  const activeSse = yield* Effect.promise(() => fetch(`${publicServer.origin}/sse`))
  assert(activeSse.status === 200 && activeSse.body !== null, "active teardown SSE did not start")
  const activeReader = activeSse.body.getReader()
  yield* Effect.promise(() => activeReader.read())
  const sseClosed = (async () => {
    try {
      while (!(await activeReader.read()).done) {}
    } catch {}
  })()
  const websocketClosed = once(websocket, "close")
  const destroyed = yield* protocol.destroy()
  assert(destroyed.destroyed === true, "protocol VM destroy was not confirmed")
  yield* Effect.promise(() => closeWithin(sseClosed, 2_000, "active SSE"))
  yield* Effect.promise(() => closeWithin(websocketClosed, 2_000, "active websocket"))

  const revoked = yield* Effect.promise(() => fetch(`${publicServer.origin}/`))
  assert([401, 404, 503].includes(revoked.status), `revoked ingress returned HTTP ${revoked.status}`)
  assert(Result.isFailure(yield* Effect.result(protocolService.status())), "destroyed VM retained service-control authority")
}))

await Effect.runPromise(program)
console.log("HTTP preview acceptance passed")
