/**
 * Direct single-daemon `makeMicrovm` contracts. These drive the real client
 * against a raw Node HTTP listener so they prove observable RPC/ingress
 * behavior rather than constructor wiring:
 *
 * - an unanswered create is sent once and cannot invent a vmId or destroy,
 * - CapacityExceeded is returned without list, health, failover, or retry,
 * - a known create that fails to bind or is interrupted during handoff
 *   attempts one admin destroy and keeps cleanup uncertainty,
 * - Scope closure is not remote destroy and does not revoke HTTP ingress,
 * - handle traffic stays on the configured origin, never VmInfo.owningHost.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http"
import { Cause, Deferred, Effect, Exit, Fiber, Result, Scheduler } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeMicrovm, makeMicrovmClient, SandboxBindingError, type MicrovmClient } from "../src/client.js"
import type { CreateResult, VmId } from "../src/protocol.js"
import { bindSandboxHandle } from "../src/sandbox-binding.js"

const IMAGE_DIGEST = `sha256:${"ab".repeat(32)}`
const createPayload = {
  image: "node",
  imageDigest: IMAGE_DIGEST,
  cpus: 2,
  memMib: 2048,
  ttlSeconds: 60
} as const
const VM_ID = "mvm-abc12345" as VmId
const ATTACKER_ORIGIN = "http://attacker.example.test:9443"
const ADMIN_TOKEN = "direct-admin-token"
const SANDBOX_TOKEN = "direct-sandbox-token"
const INGRESS_TOKEN = "direct-ingress-token"

const servers: Array<Server> = []

interface RpcCall {
  readonly tag: string
  readonly payload: Record<string, unknown>
}

type RpcReply =
  | { readonly kind: "success"; readonly value: unknown }
  | { readonly kind: "failure"; readonly error: unknown }
  | { readonly kind: "drop" }

interface IngressCall {
  readonly url: string | undefined
  readonly authorization: string | undefined
}

interface MockDaemon {
  readonly url: string
  readonly rpc: () => ReadonlyArray<RpcCall>
  readonly ingress: () => ReadonlyArray<IngressCall>
}

const runningVm = {
  vmId: VM_ID,
  owningHost: ATTACKER_ORIGIN,
  state: "running" as const,
  image: "node",
  imageDigest: IMAGE_DIGEST,
  cpus: 2,
  memMib: 2048,
  createdAtEpochMs: 1,
  expiresAtEpochMs: 61_000
}

const createSuccess = (sandboxToken: string, httpIngressToken: string) => ({
  vm: runningVm,
  sandboxToken,
  httpIngressToken
})

const rpcBearer = (headers: unknown): string | undefined => {
  if (!Array.isArray(headers)) return undefined
  for (const entry of headers) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") continue
    if (entry[0].toLowerCase() === "authorization") return entry[1]
  }
  return undefined
}

const rpcAuthorized = (tag: string, bearer: string | undefined): boolean => {
  if (tag === "execute") return bearer === `Bearer ${SANDBOX_TOKEN}`
  return bearer === `Bearer ${ADMIN_TOKEN}`
}

const readBody = (request: IncomingMessage): Promise<string> => {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const chunks: Array<Buffer> = []
  request.on("data", (chunk: Buffer) => chunks.push(chunk))
  request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  request.on("error", reject)
  return promise
}

const startMock = async (
  onRpc: (call: RpcCall) => Promise<RpcReply>
): Promise<MockDaemon> => {
  const rpc: Array<RpcCall> = []
  const ingress: Array<IngressCall> = []
  const server = createServer((request, response) => {
    if ((request.url ?? "").startsWith("/http/")) {
      ingress.push({
        url: request.url,
        authorization: request.headers["proxy-authorization"]
      })
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("guest")
      return
    }
    void readBody(request).then(async (body) => {
      let envelope: {
        readonly id?: string | number
        readonly tag?: string
        readonly payload?: unknown
        readonly headers?: unknown
      }
      try {
        envelope = JSON.parse(body) as typeof envelope
      } catch {
        response.writeHead(400)
        response.end()
        return
      }
      const call: RpcCall = {
        tag: String(envelope.tag ?? ""),
        payload: envelope.payload !== null && typeof envelope.payload === "object"
          ? envelope.payload as Record<string, unknown>
          : {}
      }
      rpc.push(call)
      const reply = rpcAuthorized(call.tag, rpcBearer(envelope.headers))
        ? await onRpc(call)
        : { kind: "failure", error: { _tag: "Unauthenticated", message: "missing or invalid bearer token" } }
      if (reply.kind === "drop") {
        request.socket.destroy()
        return
      }
      const exit = reply.kind === "success"
        ? { _tag: "Success", value: reply.value }
        : { _tag: "Failure", cause: [{ _tag: "Fail", error: reply.error }] }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify([{
        _tag: "Exit",
        requestId: envelope.id,
        exit
      }]))
    })
  })
  servers.push(server)
  const listening = Promise.withResolvers<void>()
  server.listen(0, "127.0.0.1", () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("direct-client mock has no TCP port")
  return { url: `http://127.0.0.1:${address.port}`, rpc: () => rpc, ingress: () => ingress }
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!
    server.closeAllConnections()
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
  }
})

describe("direct create ambiguity", () => {
  it("sends an unanswered create once and does not invent a vmId or destroy", async () => {
    const daemon = await startMock(async () => ({ kind: "drop" }))
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const microvm = yield* makeMicrovm({ url: daemon.url, token: ADMIN_TOKEN })
      const created = yield* Effect.result(microvm.create(createPayload))
      expect(Result.isFailure(created)).toBe(true)
      if (Result.isFailure(created)) {
        expect(created.failure._tag).not.toBe("SandboxBindingError")
      }
      yield* Effect.sleep(250)
      expect(daemon.rpc().map((call) => call.tag)).toEqual(["create"])
    })))
  })

  it("interrupting create before a reply does not destroy", async () => {
    const held = Promise.withResolvers<RpcReply>()
    const daemon = await startMock(async (call) => {
      if (call.tag === "create") return held.promise
      return { kind: "success", value: { destroyed: true, vmId: VM_ID } }
    })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const microvm = yield* makeMicrovm({ url: daemon.url, token: ADMIN_TOKEN })
      const fiber = yield* microvm.create(createPayload).pipe(Effect.forkScoped)
      while (daemon.rpc().length === 0) yield* Effect.sleep(10)
      yield* Fiber.interrupt(fiber)
      const interrupted = yield* Fiber.await(fiber)
      expect(Exit.isFailure(interrupted)).toBe(true)
      if (Exit.isFailure(interrupted)) {
        expect(Cause.hasInterrupts(interrupted.cause)).toBe(true)
      }
      held.resolve({ kind: "success", value: createSuccess(SANDBOX_TOKEN, INGRESS_TOKEN) })
      yield* Effect.sleep(250)
      expect(daemon.rpc().some((call) => call.tag === "destroy")).toBe(false)
    })))
  })
})

describe("direct create routing", () => {
  it("returns CapacityExceeded from one create without list or retry", async () => {
    const daemon = await startMock(async () => ({
      kind: "failure",
      error: { _tag: "CapacityExceeded", message: "full" }
    }))
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const microvm = yield* makeMicrovm({ url: daemon.url, token: ADMIN_TOKEN })
      const created = yield* Effect.result(microvm.create(createPayload))
      expect(Result.isFailure(created) && created.failure._tag).toBe("CapacityExceeded")
      yield* Effect.sleep(250)
      expect(daemon.rpc().map((call) => call.tag)).toEqual(["create"])
      expect(daemon.rpc()[0]?.payload).toMatchObject({
        image: "node",
        imageDigest: IMAGE_DIGEST,
        cpus: 2,
        memMib: 2048,
        ttlSeconds: 60
      })
    })))
  })

  it("keeps execute and HTTP ingress on the configured origin after Scope close", async () => {
    const daemon = await startMock(async (call) => {
      if (call.tag === "create") {
        return { kind: "success", value: createSuccess(SANDBOX_TOKEN, INGRESS_TOKEN) }
      }
      if (call.tag === "execute") {
        return {
          kind: "success",
          value: {
            execId: "exec-1",
            exitCode: 0,
            signal: "",
            timedOut: false,
            outputTruncated: false,
            stdoutB64: Buffer.from("ok").toString("base64"),
            stderrB64: ""
          }
        }
      }
      return { kind: "failure", error: { _tag: "VmNotFound", vmId: VM_ID } }
    })
    const proxy = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const microvm = yield* makeMicrovm({ url: daemon.url, token: ADMIN_TOKEN })
      const sandbox = yield* microvm.create(createPayload)
      expect(sandbox.vm.owningHost).toBe(ATTACKER_ORIGIN)
      expect(sandbox.vm.imageDigest).toBe(IMAGE_DIGEST)
      const executed = yield* sandbox.execute({ argv: ["/bin/true"] })
      expect(Buffer.from(executed.stdoutB64, "base64").toString("utf8")).toBe("ok")
      const executeCall = daemon.rpc().find((call) => call.tag === "execute")
      expect(executeCall?.payload).toMatchObject({ vmId: VM_ID, argv: ["/bin/true"] })
      return yield* sandbox.http()
    })))
    expect(daemon.rpc().some((call) => call.tag === "destroy")).toBe(false)
    expect(daemon.rpc().some((call) => call.tag === "list")).toBe(false)

    const publicServer = createServer(proxy.handleRequest)
    servers.push(publicServer)
    const publicListening = Promise.withResolvers<void>()
    publicServer.listen(0, "127.0.0.1", () => publicListening.resolve())
    await publicListening.promise
    const address = publicServer.address()
    if (address === null || typeof address === "string") throw new Error("ingress public listener has no TCP port")
    const incoming = Promise.withResolvers<string>()
    const outgoing = httpRequest(`http://127.0.0.1:${address.port}/`, (response) => {
      const chunks: Array<Buffer> = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.once("end", () => incoming.resolve(Buffer.concat(chunks).toString("utf8")))
    })
    outgoing.once("error", incoming.reject)
    outgoing.end()
    const body = await incoming.promise
    expect(body).toBe("guest")
    expect(daemon.ingress()).toEqual([{
      url: `/http/v1/vms/${VM_ID}/`,
      authorization: `Bearer ${INGRESS_TOKEN}`
    }])
  })
})

describe("direct bind rollback", () => {
  it("destroys once when a known create cannot bind, preserving vmId", async () => {
    const daemon = await startMock(async (call) => {
      if (call.tag === "create") {
        return { kind: "success", value: createSuccess("", INGRESS_TOKEN) }
      }
      if (call.tag === "destroy") {
        return { kind: "success", value: { vmId: VM_ID, destroyed: true } }
      }
      return { kind: "drop" }
    })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const microvm = yield* makeMicrovm({ url: daemon.url, token: ADMIN_TOKEN })
      const created = yield* Effect.result(microvm.create(createPayload))
      expect(Result.isFailure(created) && created.failure instanceof SandboxBindingError).toBe(true)
      if (Result.isFailure(created) && created.failure instanceof SandboxBindingError) {
        expect(created.failure.vmId).toBe(VM_ID)
        expect(created.failure.cleanup).toBeUndefined()
      }
      expect(daemon.rpc().map((call) => call.tag)).toEqual(["create", "destroy"])
      expect(daemon.rpc()[1]?.payload).toEqual({ vmId: VM_ID })
    })))
  })

  it("preserves cleanup Cause when the one rollback destroy is uncertain", async () => {
    const daemon = await startMock(async (call) => {
      if (call.tag === "create") {
        return { kind: "success", value: createSuccess("", "") }
      }
      return {
        kind: "failure",
        error: { _tag: "DestroyUncertain", vmId: VM_ID, phase: "http", reason: "ingress still draining" }
      }
    })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const microvm = yield* makeMicrovm({ url: daemon.url, token: ADMIN_TOKEN })
      const created = yield* Effect.result(microvm.create(createPayload))
      expect(Result.isFailure(created) && created.failure instanceof SandboxBindingError).toBe(true)
      if (Result.isFailure(created) && created.failure instanceof SandboxBindingError) {
        expect(created.failure.vmId).toBe(VM_ID)
        const cleanup = created.failure.cleanup
        expect(cleanup).not.toBeUndefined()
        if (cleanup !== undefined) expect(Cause.hasFails(cleanup)).toBe(true)
      }
      expect(daemon.rpc().map((call) => call.tag)).toEqual(["create", "destroy"])
    })))
  })

  it("rolls back a known create when binding is interrupted before delivery", async () => {
    const daemon = await startMock(async (call) => {
      if (call.tag === "destroy") {
        return { kind: "success", value: { vmId: VM_ID, destroyed: true } }
      }
      return { kind: "drop" }
    })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const adminClient = yield* makeMicrovmClient({ url: daemon.url, token: ADMIN_TOKEN })
      const started = yield* Deferred.make<void>()
      const hold = yield* Deferred.make<MicrovmClient>()
      const fiber = yield* bindSandboxHandle({
        adminClient,
        makeSandboxClient: () =>
          Effect.gen(function*() {
            yield* Deferred.succeed(started, undefined)
            return yield* Deferred.await(hold)
          }),
        created: createSuccess(SANDBOX_TOKEN, INGRESS_TOKEN) as CreateResult,
        origin: daemon.url,
        ca: undefined
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const interrupted = yield* Fiber.await(fiber)
      expect(Exit.isFailure(interrupted)).toBe(true)
      if (Exit.isFailure(interrupted)) {
        const error = Cause.findError(interrupted.cause)
        expect(Result.isSuccess(error) && error.success instanceof SandboxBindingError).toBe(true)
        if (Result.isSuccess(error) && error.success instanceof SandboxBindingError) {
          expect(error.success.vmId).toBe(VM_ID)
          expect(error.success.cleanup).toBeUndefined()
          expect(Cause.hasInterrupts(error.success.failure)).toBe(true)
        }
      }
      expect(daemon.rpc().map((call) => call.tag)).toEqual(["destroy"])
      expect(daemon.rpc()[0]?.payload).toEqual({ vmId: VM_ID })
    })))
  })

  it("bounds the one rollback when destroy never replies under cancellation", async () => {
    const held = Promise.withResolvers<RpcReply>()
    const daemon = await startMock(async (call) => {
      if (call.tag === "destroy") return held.promise
      return { kind: "drop" }
    })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const adminClient = yield* makeMicrovmClient({ url: daemon.url, token: ADMIN_TOKEN })
      const started = yield* Deferred.make<void>()
      const hold = yield* Deferred.make<MicrovmClient>()
      const fiber = yield* bindSandboxHandle({
        adminClient,
        makeSandboxClient: () =>
          Effect.gen(function*() {
            yield* Deferred.succeed(started, undefined)
            return yield* Deferred.await(hold)
          }),
        created: createSuccess(SANDBOX_TOKEN, INGRESS_TOKEN) as CreateResult,
        origin: daemon.url,
        ca: undefined
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const interrupted = yield* Fiber.await(fiber)
      expect(Exit.isFailure(interrupted)).toBe(true)
      if (Exit.isFailure(interrupted)) {
        const error = Cause.findError(interrupted.cause)
        expect(Result.isSuccess(error) && error.success instanceof SandboxBindingError).toBe(true)
        if (Result.isSuccess(error) && error.success instanceof SandboxBindingError) {
          expect(error.success.vmId).toBe(VM_ID)
          expect(Cause.hasInterrupts(error.success.failure)).toBe(true)
          const cleanup = error.success.cleanup
          expect(cleanup).not.toBeUndefined()
          if (cleanup !== undefined) {
            const timedOut = Cause.findError(cleanup)
            expect(Result.isSuccess(timedOut) && Cause.isTimeoutError(timedOut.success)).toBe(true)
          }
        }
      }
      expect(daemon.rpc().map((call) => call.tag)).toEqual(["destroy"])
      expect(daemon.rpc()[0]?.payload).toEqual({ vmId: VM_ID })
    })))
  }, 15_000)

  it("delivers or rolls back at every budget-4 yield under a direct-equivalent outer mask", () => {
    // Limitation: private binder + outer uninterruptibleMask, not the public HTTP factory.
    class SteppingScheduler implements Scheduler.Scheduler {
      readonly executionMode = "async" as const
      readonly tasks: Array<() => void> = []
      readonly dispatcher: Scheduler.SchedulerDispatcher
      constructor() {
        const tasks = this.tasks
        this.dispatcher = {
          scheduleTask: (task) => {
            tasks.push(task)
          },
          flush: () => {
            while (tasks.length > 0) {
              const task = tasks.shift()
              if (task !== undefined) task()
            }
          }
        }
      }
      shouldYield(fiber: Fiber.Fiber<unknown, unknown>): boolean {
        return fiber.currentOpCount >= fiber.maxOpsBeforeYield
      }
      makeDispatcher(): Scheduler.SchedulerDispatcher {
        return this.dispatcher
      }
      step(): boolean {
        const task = this.tasks.shift()
        if (task === undefined) return false
        task()
        return true
      }
    }
    const fakeClient = {} as MicrovmClient
    const created = createSuccess(SANDBOX_TOKEN, INGRESS_TOKEN) as CreateResult
    const drain = (scheduler: SteppingScheduler, fiber: Fiber.Fiber<unknown, unknown>, maxSteps: number): number => {
      let steps = 0
      while (fiber.pollUnsafe() === undefined && steps < maxSteps) {
        if (!scheduler.step()) break
        steps += 1
      }
      return steps
    }
    const run = (interruptAt: number | "none"): {
      readonly caller: boolean
      readonly destroy: number
      readonly live: number
      readonly client: boolean
      readonly vmId: string | undefined
      readonly steps: number
    } => {
      const scheduler = new SteppingScheduler()
      const live = new Set<string>()
      let destroy = 0
      let client = false
      const program = Effect.uninterruptibleMask((restore) =>
        restore(Effect.sync(() => {
          live.add(VM_ID)
          return created
        })).pipe(
          Effect.flatMap((known) =>
            bindSandboxHandle({
              adminClient: {
                destroy: (request: { readonly vmId: string }) =>
                  Effect.sync(() => {
                    destroy += 1
                    live.delete(request.vmId)
                    return { vmId: request.vmId, destroyed: true }
                  })
              } as MicrovmClient,
              makeSandboxClient: () =>
                Effect.sync(() => {
                  client = true
                  return fakeClient
                }),
              created: known,
              origin: "http://127.0.0.1:1",
              ca: undefined
            })
          )
        )
      ).pipe(
        Effect.provideService(Scheduler.Scheduler, scheduler),
        Effect.provideService(Scheduler.MaxOpsBeforeYield, 4)
      )
      const fiber = Effect.runFork(program, { scheduler })
      let steps = 0
      if (interruptAt === "none") {
        steps = drain(scheduler, fiber, 64)
      } else {
        while (steps < interruptAt && fiber.pollUnsafe() === undefined) {
          if (!scheduler.step()) break
          steps += 1
        }
        if (fiber.pollUnsafe() === undefined) fiber.interruptUnsafe()
        steps += drain(scheduler, fiber, 64)
      }
      if (fiber.pollUnsafe() === undefined) {
        fiber.interruptUnsafe()
        drain(scheduler, fiber, 64)
      }
      const settled = fiber.pollUnsafe()
      const found = settled !== undefined && Exit.isFailure(settled) ? Cause.findError(settled.cause) : undefined
      const binding = found !== undefined && Result.isSuccess(found) && found.success instanceof SandboxBindingError
        ? found.success
        : undefined
      return {
        caller: settled !== undefined && Exit.isSuccess(settled),
        destroy,
        live: live.size,
        client,
        vmId: binding?.vmId,
        steps
      }
    }
    const happy = run("none")
    expect(happy.caller).toBe(true)
    expect(happy.destroy).toBe(0)
    expect(happy.live).toBe(1)
    expect(happy.client).toBe(true)
    expect(happy.steps).toBeGreaterThanOrEqual(0)
    for (let cut = 0; cut <= happy.steps; cut++) {
      const observed = run(cut)
      expect(observed.destroy).toBeLessThanOrEqual(1)
      if (observed.caller) {
        expect(observed.destroy).toBe(0)
        expect(observed.live).toBe(1)
      } else if (observed.destroy === 1) {
        expect(observed.vmId).toBe(VM_ID)
        expect(observed.live).toBe(0)
      } else {
        expect(observed.client).toBe(false)
        expect(observed.live).toBeLessThanOrEqual(1)
      }
    }
  })
})
