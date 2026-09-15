#!/usr/bin/env node

import { writeSync } from "node:fs"
import { createServer } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { Effect, Exit, Result } from "effect"
import { makeAdminClient, makeSandboxHttpIngress } from "../dist/index.js"
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

const requestJson = async (origin, target, headers) => {
  const response = await fetchBounded(`header reflection ${target}`, `${origin}${target}`, { headers })
  if (response.status !== 200) {
    await response.body?.cancel()
    throw new Error(`header reflection returned HTTP ${response.status}`)
  }
  return bounded(`header reflection body ${target}`, DEADLINES.requestMs, response.json())
}

const requestStatus = async (label, origin, method, target, headers = {}) => {
  const response = await fetchBounded(label, new URL(target, origin), { method, headers })
  const status = response.status
  await response.body?.cancel()
  return status
}


const closeWithin = async (promise, milliseconds, label) => {
  await Promise.race([
    promise,
    delay(milliseconds).then(() => { throw new Error(`${label} did not close within ${milliseconds}ms`) })
  ])
}

/**
 * Test-local Node bridge for the Fetch-native ingress API. It only translates
 * Node HTTP streams to Request/Response; routing, credentials, and admission
 * remain entirely inside makeSandboxHttpIngress and the daemon.
 */
const listenIngressBridge = async (ingress) => {
  const sockets = new Set()
  let origin = ""
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    incoming.once("aborted", abort)
    outgoing.once("close", () => {
      if (!outgoing.writableEnded) abort()
    })
    try {
      const method = incoming.method ?? "GET"
      const headers = new Headers()
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1])
      }
      const body = method === "GET" || method === "HEAD"
        ? undefined
        : Readable.toWeb(incoming)
      const response = await ingress.handle(new Request(new URL(incoming.url ?? "/", origin), {
        method,
        headers,
        signal: controller.signal,
        ...(body === undefined ? {} : { body, duplex: "half" })
      }))
      outgoing.writeHead(
        response.status,
        response.statusText,
        Object.fromEntries(response.headers.entries())
      )
      if (response.body === null) {
        outgoing.end()
      } else {
        await pipeline(Readable.fromWeb(response.body), outgoing)
      }
    } catch {
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
        outgoing.end("500 Bridge Failure\n")
      } else {
        outgoing.destroy()
      }
    }
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    const failed = (error) => {
      server.off("listening", listening)
      reject(error)
    }
    const listening = () => {
      server.off("error", failed)
      resolve()
    }
    server.once("error", failed)
    server.listen(0, "127.0.0.1", listening)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("ingress bridge has no TCP port")
  }
  origin = `http://127.0.0.1:${address.port}`
  return {
    port: address.port,
    origin,
    close: async () => {
      const closed = new Promise((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
      })
      for (const socket of sockets) socket.destroy()
      await closeWithin(closed, 2_000, "ingress bridge")
    }
  }
}

const listenIngress = (ingress) => Effect.acquireRelease(
  Effect.promise(() => listenIngressBridge(ingress)),
  (bridge) => Effect.promise(bridge.close)
)

const program = Effect.scoped(Effect.gen(function*() {
  step("program started")
  const adminClient = yield* makeAdminClient({ url: daemonUrl, token: adminToken })
  step("clients initialized")

  const next = yield* boundedRpc(
    "daemon create (next preview)",
    adminClient.create(createInput(2, 2048, 900)),
    DEADLINES.rpcCreateMs
  )
  const nextCleanup = yield* armVmCleanup(
    "Next VM",
    () => adminClient.destroy(next.vm.vmId)
  )
  step("Next preview VM created")
  try {
    const initialized = yield* boundedRpc("exec microvm-next-init", next.sandbox.execute({
      argv: ["/usr/local/bin/microvm-next-init"]
    }))
    assert(initialized.exitCode === 0, "Next workspace initialization failed")
    step("Next workspace initialized")
    const forbiddenEnvironment = yield* Effect.result(boundedRpc(
      "startWebService with reserved PORT",
      next.sandbox.startWebService({
        argv: ["/usr/local/bin/pnpm", "dev"],
        cwd: "/workspace",
        env: { PORT: "3999" }
      })
    ))
    assert(Result.isFailure(forbiddenEnvironment), "web service accepted caller-controlled PORT")

    step("caller-controlled PORT rejected")
    yield* boundedRpc("startWebService pnpm dev", next.sandbox.startWebService({
      argv: ["/usr/local/bin/pnpm", "dev"],
      cwd: "/workspace"
    }))
    assert(next.httpIngressToken !== undefined, "Next image did not mint an HTTP ingress capability")
    const nextIngress = makeSandboxHttpIngress({
      url: daemonUrl,
      vmId: next.vm.vmId,
      httpIngressToken: next.httpIngressToken
    })
    const nextPublic = yield* listenIngress(nextIngress)
    step("Next service and Fetch ingress started")
    const initial = yield* Effect.promise(() => waitForResponse(
      `${nextPublic.origin}/`,
      (response, body) => response.status === 200 && body.includes("Ready to build.")
    ))
    step("Next page served through Fetch ingress")
    const assetPath = /(?:src|href)="(\/_next\/[^"?]+(?:\?[^" ]*)?)"/.exec(initial.body)?.[1]
    assert(assetPath !== undefined, "Next page did not reference a _next asset")
    const asset = yield* Effect.promise(() => fetchBounded("Next asset", `${nextPublic.origin}${assetPath}`))
    assert(asset.status === 200, `Next asset returned HTTP ${asset.status}`)
    yield* Effect.promise(() => bounded("Next asset body", DEADLINES.requestMs, asset.arrayBuffer()))

    step("Next asset served")
    const mutated = yield* boundedRpc("exec workspace mutation", next.sandbox.execute({
      argv: [
        "/usr/bin/python3",
        "-c",
        "p='/workspace/app/page.tsx';s=open(p).read();open(p,'w').write(s.replace('Ready to build.','Updated through concurrent exec.'))"
      ]
    }))
    assert(mutated.exitCode === 0, "concurrent exec could not mutate the running Next workspace")
    step("concurrent exec mutated the running workspace")
    const status = yield* boundedRpc("next service status", next.sandbox.webServiceStatus())
    assert(status.state === "running", "Next service did not survive concurrent exec")
    yield* Effect.promise(() => waitForResponse(
      `${nextPublic.origin}/`,
      (response, body) => response.status === 200 && body.includes("Updated through concurrent exec.")
    ))

    step("Next service survived concurrent exec")
    const network = yield* boundedRpc("exec external-network probe", next.sandbox.execute({
      argv: ["/usr/bin/python3", "-c", "import socket;s=socket.socket();s.settimeout(.5);s.connect(('1.1.1.1',53))"]
    }))
    assert(network.exitCode !== 0, "preview-enabled guest unexpectedly reached an external network")
    assert(
      (yield* boundedRpc("next service stop", next.sandbox.stopWebService())).stopped === true,
      "Next service stop was not confirmed"
    )
    step("network isolation and Next service stop verified")
  } finally {
    const nextDestroy = yield* Effect.exit(boundedRpc(
      "destroy next preview VM",
      adminClient.destroy(next.vm.vmId)
    ))
    if (Exit.isSuccess(nextDestroy) && nextDestroy.value.destroyed === true) {
      nextCleanup.armed = false
    } else {
      step("Next VM cleanup failed")
    }
  }

  step("Next preview phase completed")
  const protocol = yield* boundedRpc(
    "daemon create (protocol service)",
    adminClient.create(createInput(1, 512, 900)),
    DEADLINES.rpcCreateMs
  )
  const protocolCleanup = yield* armVmCleanup(
    "protocol VM",
    () => adminClient.destroy(protocol.vm.vmId)
  )
  yield* boundedRpc("startWebService guest protocol service", protocol.sandbox.startWebService({
    argv: ["/usr/bin/node", "-e", guestProtocolService]
  }))
  assert(protocol.httpIngressToken !== undefined, "protocol image did not mint an HTTP ingress capability")
  const protocolIngress = makeSandboxHttpIngress({
    url: daemonUrl,
    vmId: protocol.vm.vmId,
    httpIngressToken: protocol.httpIngressToken
  })
  const publicServer = yield* listenIngress(protocolIngress)
  yield* Effect.promise(() => waitForResponse(
    `${publicServer.origin}/`,
    (response, body) => response.status === 200 && body === "guest-http-ok"
  ))

  step("protocol service and Fetch ingress ready")
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
  assert(tokenDonor.httpIngressToken !== undefined, "token donor did not mint an HTTP ingress capability")
  const donorCleanup = yield* armVmCleanup(
    "token donor VM",
    () => adminClient.destroy(tokenDonor.vm.vmId)
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
      adminClient.destroy(tokenDonor.vm.vmId)
    ))
    if (Exit.isSuccess(donorDestroy) && donorDestroy.value.destroyed === true) {
      donorCleanup.armed = false
      operationSucceeded()
    } else {
      operationFailed()
    }
    currentOperation = interruptedOperation
  }


  step("capability separation verified")
  const headers = yield* Effect.promise(() => requestJson(
    publicServer.origin,
    "/headers",
    { authorization: "Bearer application-data", "proxy-authorization": "Bearer attacker-data" }
  ))
  assert(headers.authorization === "Bearer application-data", "application Authorization was not preserved")
  assert(headers.proxyAuthorization === null, "Proxy-Authorization reached the guest")

  step("authorization separation verified")
  operationStarted("WebSocket refusal")
  const websocketRefusal = yield* Effect.promise(() => protocolIngress.handle(new Request(
    `${publicServer.origin}/ws`,
    { headers: { connection: "Upgrade", upgrade: "websocket" } }
  )))
  assert(websocketRefusal.status === 426, `WebSocket ingress returned HTTP ${websocketRefusal.status}`)
  yield* Effect.promise(() => websocketRefusal.body?.cancel())
  operationSucceeded()

  step("Fetch ingress WebSocket refusal verified")
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
    (yield* boundedRpc("protocol service status after slow reader", protocol.sandbox.webServiceStatus())).state === "running",
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
  const destroyed = yield* boundedRpc("destroy protocol VM", adminClient.destroy(protocol.vm.vmId))
  assert(destroyed.destroyed === true, "protocol VM destroy was not confirmed")
  protocolCleanup.armed = false
  yield* Effect.promise(() => closeWithin(sseClosed, 2_000, "active SSE"))

  step("destroy closed the active SSE stream")
  const revoked = yield* Effect.promise(() => fetchBounded("revoked ingress", `${publicServer.origin}/`))
  assert(revoked.status === 401, `revoked ingress returned HTTP ${revoked.status}`)
  step("revoked ingress refused")
  assert(
    Result.isFailure(yield* Effect.result(boundedRpc("service status after destroy", protocol.sandbox.webServiceStatus()))),
    "destroyed VM retained service-control authority"
  )
  step("protocol VM service control revoked")
}))

await Effect.runPromise(program)
step("all scoped HTTP ingress bridges released")
console.log("HTTP preview acceptance passed")
