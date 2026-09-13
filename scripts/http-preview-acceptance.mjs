#!/usr/bin/env node

import { randomBytes, createHash } from "node:crypto"
import { once } from "node:events"
import { writeSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { connect } from "node:net"
import { Effect, Exit, Result } from "effect"
import { makeMicrovmClient, makeMicrovmCluster } from "../dist/index.js"
import { assertRevokedIngress, listenTrustedProxy, rawStatus, requestStatus } from "./http-preview-proxy.mjs"
import { guestProtocolService } from "./http-preview-fixture.mjs"

let currentOperation = "initialization"
let exiting = false

const writeLine = (fileDescriptor, line) => {
  try {
    writeSync(fileDescriptor, `${line}\n`)
  } catch {}
}

const step = (label) => {
  writeLine(process.stdout.fd, `[http-preview] ${label}`)
}

const operationStarted = (label) => {
  currentOperation = label
  step(`${label} started`)
}

const operationSucceeded = () => {
  const completed = currentOperation
  currentOperation = "between acceptance operations"
  step(`${completed} succeeded`)
}

const operationFailed = () => {
  const failed = currentOperation
  currentOperation = "between acceptance operations"
  step(`${failed} failed`)
}

const genericErrorMessage = (value) => {
  if (!(value instanceof Error)) return "Error: non-Error rejection"
  if (/tim(?:e|ed) ?out|exceeded/i.test(value.message)) return "Error: operation timed out"
  if (/abort|interrupt/i.test(value.message)) return "Error: operation aborted"
  if (/refused|ECONNREFUSED/i.test(value.message)) return "Error: connection refused"
  if (/closed|reset|socket hang up/i.test(value.message)) return "Error: connection closed"
  return "Error: operation failed"
}

const exitWithPendingOperation = (reason, exitCode, error) => {
  if (exiting) return
  exiting = true
  const detail = error === undefined ? "" : `; error: ${genericErrorMessage(error)}`
  writeLine(process.stderr.fd, `[http-preview] ${reason}; pending operation: ${currentOperation}${detail}`)
  process.exit(exitCode)
}

process.once("SIGTERM", () => exitWithPendingOperation("received SIGTERM", 143))
process.once("uncaughtException", (error) => exitWithPendingOperation("uncaught exception", 1, error))
process.once("unhandledRejection", (error) => exitWithPendingOperation("unhandled rejection", 1, error))

const daemonUrl = process.env.MICROVM_URL
const adminToken = process.env.MICROVM_TOKEN
const image = process.env.MICROVM_IMAGE ?? "node"
const imageDigest = process.env.MICROVM_IMAGE_DIGEST ?? ""
if (!daemonUrl || !adminToken) {
  throw new Error("MICROVM_URL and MICROVM_TOKEN are required")
}
if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
  throw new Error("MICROVM_IMAGE_DIGEST must be sha256:<64 lowercase hex> from the image manifest")
}
const createInput = (cpus, memMib, ttlSeconds) => ({ image, imageDigest, cpus, memMib, ttlSeconds })

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

/**
 * Every wait in this script is bounded and labelled: the hosted phase must fail
 * with the operation that stalled, never hang until the CI job deadline.
 */
const DEADLINES = {
  readyMs: 120_000,
  rpcMs: 60_000,
  rpcCreateMs: 300_000,
  cleanupMs: 30_000,
  requestMs: 30_000,
  websocketMs: 30_000,
  streamMs: 60_000
}

const expired = (label, milliseconds) => new Error(`${label} exceeded ${milliseconds}ms`)

/** Resolves `work` or rejects with a labelled error once `milliseconds` elapse. */
const bounded = (label, milliseconds, work) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(expired(label, milliseconds)), milliseconds)
  timer.unref()
  Promise.resolve(work).then(
    (value) => { clearTimeout(timer); resolve(value) },
    (error) => { clearTimeout(timer); reject(error) }
  )
})

const fetchBounded = (label, url, init = {}, milliseconds = DEADLINES.requestMs) =>
  fetch(url, { redirect: "manual", ...init, signal: AbortSignal.timeout(milliseconds) }).catch((error) => {
    throw new Error(`${label} failed: ${String(error)}`)
  })

/**
 * Bounds one RPC. Typed failures reach the caller unchanged; only a stall dies,
 * loudly and with its label.
 */
const boundedRpc = (label, effect, milliseconds = DEADLINES.rpcMs) =>
  Effect.raceFirst(effect, Effect.delay(Effect.die(expired(label, milliseconds)), milliseconds))

const armVmCleanup = (label, destroy) => Effect.acquireRelease(
  Effect.sync(() => ({ armed: true })),
  (cleanup) => {
    if (!cleanup.armed) return Effect.void
    const interruptedOperation = currentOperation
    currentOperation = `${label} cleanup`
    return Effect.exit(Effect.suspend(() =>
      boundedRpc(currentOperation, destroy(), DEADLINES.cleanupMs)
    )).pipe(
      Effect.andThen((outcome) => Effect.sync(() => {
        currentOperation = interruptedOperation
        if (Exit.isFailure(outcome) || outcome.value.destroyed !== true) {
          step(`${label} cleanup failed`)
        }
      }))
    )
  }
)

const listenProxy = (proxy) => Effect.acquireRelease(
  Effect.promise(() => listenTrustedProxy(proxy)),
  (handle) => Effect.promise(handle.close)
)

const waitForResponse = async (url, predicate, timeoutMs = DEADLINES.readyMs) => {
  const deadline = Date.now() + timeoutMs
  let last = "no response"
  while (Date.now() < deadline) {
    try {
      const response = await fetchBounded(`readiness request ${url}`, url)
      const body = await bounded(`readiness body ${url}`, DEADLINES.requestMs, response.text())
      last = `HTTP ${response.status}`
      if (predicate(response, body)) return { response, body }
    } catch (error) {
      last = String(error)
    }
    await delay(100)
  }
  throw new Error(`timed out waiting for ${url}: ${last}`)
}


const requestJson = (origin, target, headers) => new Promise((resolve, reject) => {
  const label = `header reflection ${target}`
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
  request.setTimeout(DEADLINES.requestMs, () => request.destroy(expired(label, DEADLINES.requestMs)))
  request.once("error", reject)
  request.end()
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
  socket.setTimeout(DEADLINES.websocketMs, () => fail(expired(`websocket handshake ${path}`, DEADLINES.websocketMs)))
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
    socket.setTimeout(0)
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
    socket.setTimeout(0)
    resolve(bytes.subarray(2, 2 + length).toString("utf8"))
  }
  socket.setTimeout(DEADLINES.websocketMs, () => {
    fail(expired("websocket echo", DEADLINES.websocketMs))
    socket.destroy()
  })
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

const program = Effect.scoped(Effect.gen(function*() {
  step("program started")
  const cluster = yield* makeMicrovmCluster({ endpoints: [{ url: daemonUrl, token: adminToken }] })
  const adminClient = yield* makeMicrovmClient({ url: daemonUrl, token: adminToken })
  step("clients initialized")

  const next = yield* boundedRpc(
    "cluster create (next preview)",
    cluster.create(createInput(2, 2048, 900)),
    DEADLINES.rpcCreateMs
  )
  const nextCleanup = yield* armVmCleanup("Next VM", () => next.destroy())
  step("Next preview VM created")
  try {
    const initialized = yield* boundedRpc("exec microvm-next-init", next.execute({
      argv: ["/usr/local/bin/microvm-next-init"]
    }))
    assert(initialized.exitCode === 0, "Next workspace initialization failed")
    step("Next workspace initialized")
    const forbiddenEnvironment = yield* Effect.result(boundedRpc(
      "startWebService with reserved PORT",
      next.startWebService({
        argv: ["/usr/local/bin/pnpm", "dev"],
        cwd: "/workspace",
        env: { PORT: "3999" }
      })
    ))
    assert(Result.isFailure(forbiddenEnvironment), "web service accepted caller-controlled PORT")

    step("caller-controlled PORT rejected")
    const nextService = yield* boundedRpc("startWebService pnpm dev", next.startWebService({
      argv: ["/usr/local/bin/pnpm", "dev"],
      cwd: "/workspace"
    }))
    const nextProxy = yield* next.http()
    const nextPublic = yield* listenProxy(nextProxy)
    step("Next service and trusted proxy started")
    const initial = yield* Effect.promise(() => waitForResponse(
      `${nextPublic.origin}/`,
      (response, body) => response.status === 200 && body.includes("Ready to build.")
    ))
    step("Next page served through the trusted proxy")
    const assetPath = /(?:src|href)="(\/_next\/[^"?]+(?:\?[^" ]*)?)"/.exec(initial.body)?.[1]
    assert(assetPath !== undefined, "Next page did not reference a _next asset")
    const asset = yield* Effect.promise(() => fetchBounded("Next asset", `${nextPublic.origin}${assetPath}`))
    assert(asset.status === 200, `Next asset returned HTTP ${asset.status}`)
    yield* Effect.promise(() => bounded("Next asset body", DEADLINES.requestMs, asset.arrayBuffer()))

    step("Next asset served")
    const mutated = yield* boundedRpc("exec workspace mutation", next.execute({
      argv: [
        "/usr/bin/python3",
        "-c",
        "p='/workspace/app/page.tsx';s=open(p).read();open(p,'w').write(s.replace('Ready to build.','Updated through concurrent exec.'))"
      ]
    }))
    assert(mutated.exitCode === 0, "concurrent exec could not mutate the running Next workspace")
    step("concurrent exec mutated the running workspace")
    const status = yield* boundedRpc("next service status", nextService.status())
    assert(status.state === "running", "Next service did not survive concurrent exec")
    yield* Effect.promise(() => waitForResponse(
      `${nextPublic.origin}/`,
      (response, body) => response.status === 200 && body.includes("Updated through concurrent exec.")
    ))

    step("Next service survived concurrent exec")
    const network = yield* boundedRpc("exec external-network probe", next.execute({
      argv: ["/usr/bin/python3", "-c", "import socket;s=socket.socket();s.settimeout(.5);s.connect(('1.1.1.1',53))"]
    }))
    assert(network.exitCode !== 0, "preview-enabled guest unexpectedly reached an external network")
    assert(
      (yield* boundedRpc("next service stop", nextService.stop())).stopped === true,
      "Next service stop was not confirmed"
    )
    step("network isolation and Next service stop verified")
  } finally {
    const nextDestroy = yield* Effect.exit(boundedRpc("destroy next preview VM", next.destroy()))
    if (Exit.isSuccess(nextDestroy) && nextDestroy.value.destroyed === true) {
      nextCleanup.armed = false
    } else {
      step("Next VM cleanup failed")
    }
  }

  step("Next preview phase completed")
  const protocol = yield* boundedRpc(
    "cluster create (protocol service)",
    cluster.create(createInput(1, 512, 900)),
    DEADLINES.rpcCreateMs
  )
  const protocolCleanup = yield* armVmCleanup("protocol VM", () => protocol.destroy())
  const protocolService = yield* boundedRpc("startWebService guest protocol service", protocol.startWebService({
    argv: ["/usr/bin/node", "-e", guestProtocolService]
  }))
  const protocolProxy = yield* protocol.http()
  const publicServer = yield* listenProxy(protocolProxy)
  yield* Effect.promise(() => waitForResponse(
    `${publicServer.origin}/`,
    (response, body) => response.status === 200 && body === "guest-http-ok"
  ))

  step("protocol service and trusted proxy ready")
  operationStarted("missing capability request")
  const missing = yield* Effect.promise(() => requestStatus(
    currentOperation,
    daemonUrl,
    "GET",
    `/http/v1/vms/${protocol.vm.vmId}/`
  ))
  assert(missing === 401, `missing ingress capability returned HTTP ${missing}`)
  operationSucceeded()

  operationStarted("administrative credential request")
  const controlCredential = yield* Effect.promise(() => requestStatus(
    currentOperation,
    daemonUrl,
    "GET",
    `/http/v1/vms/${protocol.vm.vmId}/`,
    { "proxy-authorization": `Bearer ${adminToken}` }
  ))
  assert(controlCredential === 401, `admin credential authenticated data ingress: HTTP ${controlCredential}`)
  operationSucceeded()

  operationStarted("token donor creation")
  const tokenDonor = yield* boundedRpc(
    currentOperation,
    adminClient.create(createInput(1, 256, 300)),
    DEADLINES.rpcCreateMs
  )
  const donorCleanup = yield* armVmCleanup("token donor VM", () =>
    adminClient.destroy({ vmId: tokenDonor.vm.vmId })
  )
  operationSucceeded()
  try {
    operationStarted("cross-VM credential request")
    const crossVmCredential = yield* Effect.promise(() => requestStatus(
      currentOperation,
      daemonUrl,
      "GET",
      `/http/v1/vms/${protocol.vm.vmId}/`,
      { "proxy-authorization": `Bearer ${tokenDonor.httpIngressToken}` }
    ))
    assert(crossVmCredential === 404, `cross-VM ingress credential returned HTTP ${crossVmCredential}`)
    operationSucceeded()
  } finally {
    const interruptedOperation = currentOperation
    operationStarted("token donor destruction")
    const donorDestroy = yield* Effect.exit(boundedRpc(
      currentOperation,
      adminClient.destroy({ vmId: tokenDonor.vm.vmId })
    ))
    if (Exit.isSuccess(donorDestroy) && donorDestroy.value.destroyed === true) {
      donorCleanup.armed = false
      operationSucceeded()
    } else {
      operationFailed()
    }
    currentOperation = interruptedOperation
  }

  operationStarted("CONNECT method probe")
  assert(
    (yield* Effect.promise(() => rawStatus(currentOperation, publicServer.port, "CONNECT", "example.invalid:443"))) === 405,
    "CONNECT was not rejected"
  )
  operationSucceeded()

  operationStarted("TRACE method probe")
  assert(
    (yield* Effect.promise(() => rawStatus(currentOperation, publicServer.port, "TRACE", "/"))) === 405,
    "TRACE was not rejected"
  )
  operationSucceeded()

  operationStarted("absolute-form target probe")
  assert(
    (yield* Effect.promise(() => rawStatus(currentOperation, publicServer.port, "GET", "http://example.invalid/"))) === 400,
    "absolute-form target was not rejected"
  )
  operationSucceeded()

  // `Expect: 100-continue` is delivered to the server's `checkContinue` event.
  // The probe reads the first status line, so an interim `100 Continue` would
  // fail here exactly as a wrongly continued body would in a browser.
  operationStarted("Expect 100-continue probe")
  assert(
    (yield* Effect.promise(() => rawStatus(currentOperation, publicServer.port, "POST", "/", {
      headers: { expect: "100-continue", "content-length": "5" }
    }))) === 400,
    "Expect: 100-continue was not refused without an interim 100"
  )
  operationSucceeded()

  step("capability separation and method/target rejection verified")
  const headers = yield* Effect.promise(() => requestJson(
    publicServer.origin,
    "/headers",
    { authorization: "Bearer application-data", "proxy-authorization": "Bearer attacker-data" }
  ))
  assert(headers.authorization === "Bearer application-data", "application Authorization was not preserved")
  assert(headers.proxyAuthorization === null, "Proxy-Authorization reached the guest")

  step("authorization separation verified")
  operationStarted("WebSocket open")
  const websocket = yield* Effect.promise(() => openWebSocket(publicServer.port))
  operationSucceeded()
  operationStarted("WebSocket echo")
  assert((yield* Effect.promise(() => echoWebSocket(websocket, "preview-echo"))) === "preview-echo", "websocket echo failed")
  operationSucceeded()

  step("websocket echo verified")
  const heldSse = []
  for (let index = 0; index < 8; index++) {
    const response = yield* Effect.promise(() => fetchBounded(`SSE slot ${index}`, `${publicServer.origin}/sse`))
    assert(response.status === 200 && response.body !== null, `SSE slot ${index} failed with HTTP ${response.status}`)
    const reader = response.body.getReader()
    const first = yield* Effect.promise(() => bounded(`SSE slot ${index} first event`, DEADLINES.streamMs, reader.read()))
    assert(!first.done && Buffer.from(first.value).includes("data: ready"), `SSE slot ${index} did not flush immediately`)
    heldSse.push(reader)
  }
  const saturated = yield* Effect.promise(() => fetchBounded("ninth SSE", `${publicServer.origin}/sse`))
  assert(saturated.status === 429, `ninth SSE returned HTTP ${saturated.status}, expected 429`)
  yield* Effect.promise(() => bounded("saturated SSE cancel", DEADLINES.streamMs, saturated.body?.cancel()))
  for (const reader of heldSse) {
    yield* Effect.promise(() => bounded("held SSE cancel", DEADLINES.streamMs, reader.cancel()))
  }

  step("SSE pressure window verified")
  const slow = yield* Effect.promise(() => fetchBounded("large streamed response", `${publicServer.origin}/large`))
  assert(slow.status === 200 && slow.body !== null, "large streamed response did not start")
  yield* Effect.promise(async () => {
    const reader = slow.body.getReader()
    await bounded("large response first chunk", DEADLINES.streamMs, reader.read())
    await bounded("large response cancel", DEADLINES.streamMs, reader.cancel())
  })
  assert(
    (yield* boundedRpc("protocol service status after slow reader", protocolService.status())).state === "running",
    "slow-reader cancellation killed the web service"
  )

  step("slow-reader cancellation survived")
  const activeSse = yield* Effect.promise(() => fetchBounded("active teardown SSE", `${publicServer.origin}/sse`))
  assert(activeSse.status === 200 && activeSse.body !== null, "active teardown SSE did not start")
  const activeReader = activeSse.body.getReader()
  yield* Effect.promise(() => bounded("active SSE first event", DEADLINES.streamMs, activeReader.read()))
  const sseClosed = (async () => {
    try {
      while (!(await activeReader.read()).done) {}
    } catch {}
  })()
  const websocketClosed = once(websocket, "close")
  const destroyed = yield* boundedRpc("destroy protocol VM", protocol.destroy())
  assert(destroyed.destroyed === true, "protocol VM destroy was not confirmed")
  protocolCleanup.armed = false
  yield* Effect.promise(() => closeWithin(sseClosed, 2_000, "active SSE"))
  yield* Effect.promise(() => closeWithin(websocketClosed, 2_000, "active websocket"))
  assert(websocket.destroyed, "active websocket client socket remained open after VM destroy")

  step("destroy closed active SSE and websocket streams")
  const revoked = yield* Effect.promise(() => fetchBounded("revoked ingress", `${publicServer.origin}/`))
  assertRevokedIngress(revoked.status)
  step("revoked ingress refused")
  assert(
    Result.isFailure(yield* Effect.result(boundedRpc("service status after destroy", protocolService.status()))),
    "destroyed VM retained service-control authority"
  )
  step("protocol VM service control revoked")
}))

await Effect.runPromise(program)
step("all scoped trusted proxies released")
console.log("HTTP preview acceptance passed")
