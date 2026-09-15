/**
 * Hostile public-API contracts for the daemon RPC surface. Every scenario
 * drives the real HTTP listener, the real auth middleware, the real registry
 * and the real request-bounding code; only Firecracker and the guest exec
 * channel are replaced at their Context seams. Each test models a malicious
 * or buggy caller and fails for a plausible security regression:
 *
 * - privilege escalation / cross-VM credential misuse,
 * - request bounds bypassed before the guest transport,
 * - malformed wire payloads with host-side side effects,
 * - quota over-admission or leaked capacity,
 * - resource requests above the operator ceilings,
 * - success reported (or the VM reused) after an ambiguous transport failure,
 * - reservations released without a proven teardown.
 */
import { createServer, type Server } from "node:http"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Layer, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeMicrovmClient } from "../src/client-raw.js"
import type { MicrovmClient } from "../src/client-core.js"
import { CredentialStore } from "../src/auth.js"
import { DaemonConfig, daemonLayer } from "../src/daemon.js"
import {
  Firecracker,
  GuestExecChannel,
  GuestTransportFault,
  VmTeardownFault,
  type GuestExecSuccess
} from "../src/firecracker.js"
import { HostPrereqs } from "../src/host.js"
import type { CreateRequest, ExecuteRequest, VmId } from "../src/protocol.js"

const adminToken = "admin-token-for-api-abuse-tests"
const fixtureImageBytes = "test"
const fixtureImageDigest = `sha256:${createHash("sha256").update(fixtureImageBytes).digest("hex")}`
const createPayload = {
  image: "node",
  imageDigest: fixtureImageDigest,
  cpus: undefined,
  memMib: undefined,
  ttlSeconds: undefined
} as const

const roots: Array<string> = []
const servers: Array<Server> = []

const configFor = (root: string, maxVms: number) => new DaemonConfig({
  listen: { host: "127.0.0.1", port: 0 },
  advertisedUrl: "http://127.0.0.1:1",
  acceptingAtStartup: false,
  tls: undefined,
  firecracker: {
    firecrackerBinary: "/usr/bin/false",
    flockBinary: undefined,
    jailerBinary: "/usr/bin/false",
    kernelImage: join(root, "vmlinux"),
    imagesDir: join(root, "images"),
    runStateDir: join(root, "run"),
    jailerUidRange: [23_000, 23_099],
    jailerGidRange: [23_000, 23_099],
    jailerParentCgroup: undefined,
    guestCidRange: [8_000, 8_099],
    kernelArgs: "console=ttyS0 reboot=k panic=1 pci=off",
    bootTimeoutMs: 1_000,
    guestReadinessTimeoutMs: 1_000,
    vmmOverheadMib: 16,
    maxPidsPerVm: 64,
    jailerFsizeBytes: 1_048_576,
    jailerNoFileLimit: 128
  },
  limits: {
    maxVms,
    defaultCpus: 1,
    maxCpus: 2,
    defaultMemMib: 128,
    maxMemMib: 256,
    maxTtlSeconds: 60
  }
})

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "microvm-api-abuse-"))
  roots.push(root)
  await mkdir(join(root, "images"), { recursive: true })
  await mkdir(join(root, "run"), { recursive: true })
  await writeFile(join(root, "vmlinux"), "test")
  await writeFile(join(root, "images", "node.raw"), fixtureImageBytes)
  await writeFile(join(root, "images", "node.json"), JSON.stringify({
    name: "node",
    file: "node.raw",
    arch: process.arch === "arm64" ? "aarch64" : "x86_64",
    sizeBytes: 4,
    rootDevice: "/dev/vda",
    imageDigest: fixtureImageDigest
  }))
  return root
}

const prereqs = Layer.succeed(HostPrereqs, HostPrereqs.of({
  verifyAll: () => Effect.succeed({
    kvmDeviceAccess: true,
    cgroupV2: true,
    arch: process.arch === "arm64" ? "aarch64" : "x86_64"
  })
}))

const waitForListener = (server: Server) =>
  Effect.gen(function*() {
    while (!server.listening) yield* Effect.sleep(5)
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("test listener has no TCP port")
    return address.port
  })


/** Starts admission-closed; opens the gate for the harness before tests run. */
const openAdmission = (port: number) =>
  Effect.gen(function*() {
    const admin = yield* makeMicrovmClient({ url: `http://127.0.0.1:${port}`, token: adminToken })
    yield* admin.setAdmission({ accepting: true })
  })

type GuestRequest = Parameters<GuestExecChannel["Service"]["exec"]>[0]

interface HarnessOptions {
  readonly maxVms?: number
  /** Deterministic teardown behavior; `call` is the 1-based stop attempt. */
  readonly stop?: (vmId: string, call: number) => Effect.Effect<void, VmTeardownFault>
  readonly exec?: (request: GuestRequest) => Effect.Effect<GuestExecSuccess, GuestTransportFault>
}

const guestExit = () => ({
  _tag: "Exit" as const,
  frame: {
    code: 0,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0)
  }
})

const startHarness = (root: string, options: HarnessOptions = {}) =>
  Effect.gen(function*() {
    const guestCalls: Array<{ readonly vmId: string; readonly argv: ReadonlyArray<string> }> = []
    let boots = 0
    let stops = 0
    const server = createServer()
    const firecracker = Layer.succeed(Firecracker, Firecracker.of({
      boot: (spec) => Effect.promise(async () => {
        boots += 1
        await mkdir(spec.layout.vmDir, { recursive: true })
        return {
          pid: 51_000 + boots,
          imageDigest: fixtureImageDigest,
          stop: () => {
            stops += 1
            return options.stop === undefined ? Effect.void : options.stop(spec.vmId, stops)
          },
          exited: Effect.never
        }
      })
    }))
    const guest = Layer.succeed(GuestExecChannel, GuestExecChannel.of({
      exec: (request) => {
        guestCalls.push({ vmId: request.vmId, argv: request.argv })
        return options.exec === undefined ? Effect.succeed(guestExit()) : options.exec(request)
      }
    }))
    yield* daemonLayer(configFor(root, options.maxVms ?? 3), {
          credentials: CredentialStore.layer([adminToken]),
      firecracker, guestExec: guest, prereqs, server, unsafeSkipKernelLockForTests: true
    }).pipe(
      Layer.launch,
      Effect.forkScoped
    )
    const port = yield* waitForListener(server)
    yield* openAdmission(port)
    return { url: `http://127.0.0.1:${port}`, bootCount: () => boots, guestCalls }
  })

const execCall = (vmId: string, overrides: Partial<ExecuteRequest> = {}): ExecuteRequest => ({
  vmId: vmId as VmId,
  argv: ["/bin/true"],
  cwd: undefined,
  env: undefined,
  timeoutMs: undefined,
  maxOutputBytes: undefined,
  ...overrides
})

const failureTag = <A, E extends { readonly _tag: string }>(result: Result.Result<A, E>): string => {
  if (Result.isSuccess(result)) throw new Error("expected the call to fail but it succeeded")
  return result.failure._tag
}

/** Concurrent creates against a full quota: exactly `capacity` may win. */
const capacityProbe = (admin: MicrovmClient, capacity: number) =>
  Effect.forEach(
    Array.from({ length: capacity + 1 }, (_, index) => index),
    () => admin.create(createPayload).pipe(Effect.result),
    { concurrency: "unbounded" }
  ).pipe(Effect.map((results) => ({
    admitted: results.filter((result) => Result.isSuccess(result)).length,
    rejected: results.filter((result) => Result.isFailure(result) && result.failure._tag === "CapacityExceeded").length
  })))

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
  while (servers.length > 0) {
    const server = servers.pop()!
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe("daemon RPC abuse", () => {
  it("confines sandbox credentials to their own VM and never grants admin operations", async () => {
    const root = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const harness = yield* startHarness(root)
      const admin = yield* makeMicrovmClient({ url: harness.url, token: adminToken })
      const first = yield* admin.create(createPayload)
      const second = yield* admin.create(createPayload)
      const sandbox = yield* makeMicrovmClient({ url: harness.url, token: first.sandboxToken })

      const escalatedCreate = yield* Effect.result(sandbox.create(createPayload))
      expect(failureTag(escalatedCreate)).toBe("Forbidden")
      const escalatedAdmission = yield* Effect.result(sandbox.setAdmission({ accepting: false }))
      expect(failureTag(escalatedAdmission)).toBe("Forbidden")
      const escalatedInfo = yield* Effect.result(sandbox.info({}))
      expect(failureTag(escalatedInfo)).toBe("Forbidden")

      const crossInspect = yield* Effect.result(sandbox.inspect({ vmId: second.vm.vmId }))
      const crossExecute = yield* Effect.result(sandbox.execute(execCall(second.vm.vmId)))
      const crossDestroy = yield* Effect.result(sandbox.destroy({ vmId: second.vm.vmId }))
      expect(failureTag(crossInspect)).toBe("Forbidden")
      expect(failureTag(crossExecute)).toBe("Forbidden")
      expect(failureTag(crossDestroy)).toBe("Forbidden")

      // The refused calls must leave the other VM untouched and unexecuted.
      expect(harness.guestCalls.length).toBe(0)
      expect((yield* admin.inspect({ vmId: second.vm.vmId })).state).toBe("running")

      const scoped = yield* sandbox.list({})
      expect(scoped.vms.map((vm) => vm.vmId)).toEqual([first.vm.vmId])
      const everything = yield* admin.list({})
      expect(everything.vms.map((vm) => vm.vmId).sort()).toEqual([first.vm.vmId, second.vm.vmId].sort())

      const nearMiss = `${first.sandboxToken.slice(0, -1)}${first.sandboxToken.endsWith("a") ? "b" : "a"}`
      const stranger = yield* makeMicrovmClient({ url: harness.url, token: nearMiss })
      const strangerList = yield* Effect.result(stranger.list({}))
      expect(failureTag(strangerList)).toBe("Unauthenticated")
      const absent = yield* makeMicrovmClient({
        url: harness.url,
        token: "mvs_000000000000000000000000000000000000000000000000"
      })
      const absentList = yield* Effect.result(absent.list({}))
      expect(failureTag(absentList)).toBe("Unauthenticated")
    })))
  })

  it("rejects out-of-bounds exec requests before any guest transport and never poisons the VM", async () => {
    const root = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const harness = yield* startHarness(root)
      const admin = yield* makeMicrovmClient({ url: harness.url, token: adminToken })
      const created = yield* admin.create(createPayload)
      const sandbox = yield* makeMicrovmClient({ url: harness.url, token: created.sandboxToken })
      const vmId = created.vm.vmId

      const overMaxArgvEntries = Array.from({ length: 65 }, () => "/bin/true")
      const overTotalArgv = ["/bin/echo", ...Array.from({ length: 33 }, () => "/x".repeat(2_000))]
      const overEnvKeys: Record<string, string> = {}
      for (let index = 0; index < 65; index++) overEnvKeys[`K${index}`] = "v"
      const overEnvTotal: Record<string, string> = {}
      for (let index = 0; index < 16; index++) overEnvTotal[`K${index}`] = "y".repeat(8_000)

      const hostileRequests: ReadonlyArray<readonly [string, Partial<ExecuteRequest>]> = [
        ["empty argv", { argv: [] }],
        ["relative program", { argv: ["bin/true"] }],
        ["too many argv entries", { argv: overMaxArgvEntries }],
        ["oversized argument", { argv: ["/bin/echo", "x".repeat(5_000)] }],
        ["oversized argv total", { argv: overTotalArgv }],
        ["relative cwd", { cwd: "workspace" }],
        ["oversized cwd", { cwd: `/${"x".repeat(5_000)}` }],
        ["invalid env key", { env: { "bad key": "v" } }],
        ["too many env keys", { env: overEnvKeys }],
        ["oversized env value", { env: { OK: "x".repeat(9_000) } }],
        ["oversized env total", { env: overEnvTotal }]
      ]
      for (const [label, overrides] of hostileRequests) {
        const result = yield* Effect.result(sandbox.execute(execCall(vmId, overrides)))
        if (Result.isSuccess(result)) throw new Error(`expected rejection for ${label}`)
        expect(result.failure._tag, label).toBe("GuestExecError")
        expect(result.failure, label).toMatchObject({ code: "INVALID_REQUEST" })
      }
      expect(harness.guestCalls.length).toBe(0)

      // A rejected request must not consume or dirty the VM.
      const accepted = yield* sandbox.execute(execCall(vmId, { argv: ["/bin/true"] }))
      expect(accepted.exitCode).toBe(0)
      expect(harness.guestCalls.length).toBe(1)
      expect((yield* sandbox.inspect({ vmId })).state).toBe("running")
      expect((yield* admin.destroy({ vmId })).destroyed).toBe(true)
    })))
  })

  it("rejects malformed wire payloads without host-side effects", async () => {
    const root = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const harness = yield* startHarness(root, { maxVms: 1 })
      const admin = yield* makeMicrovmClient({ url: harness.url, token: adminToken })

      const invalidCreates: ReadonlyArray<readonly [string, CreateRequest]> = [
        ["unknown image", { image: "not-on-host", imageDigest: fixtureImageDigest, cpus: undefined, memMib: undefined, ttlSeconds: undefined }],
        ["traversal image", { image: "../images/node", imageDigest: fixtureImageDigest, cpus: undefined, memMib: undefined, ttlSeconds: undefined }],
        ["zero cpus", { image: "node", imageDigest: fixtureImageDigest, cpus: 0, memMib: undefined, ttlSeconds: undefined }],
        ["negative memory", { image: "node", imageDigest: fixtureImageDigest, cpus: undefined, memMib: -1, ttlSeconds: undefined }],
        ["fractional cpus", { image: "node", imageDigest: fixtureImageDigest, cpus: 1.5, memMib: undefined, ttlSeconds: undefined }],
        ["zero ttl", { image: "node", imageDigest: fixtureImageDigest, cpus: undefined, memMib: undefined, ttlSeconds: 0 }]
      ]
      for (const [label, request] of invalidCreates) {
        // Wire-schema violations may surface as typed failures or client-side
        // encode defects; either way the call must not succeed or reach a boot.
        expect(Exit.isFailure(yield* Effect.exit(admin.create(request))), label).toBe(true)
      }
      expect(harness.bootCount()).toBe(0)

      const traversalExec = yield* Effect.exit(admin.execute(execCall("mvm-abc12345/../../etc")))
      expect(Exit.isFailure(traversalExec)).toBe(true)
      const shortVmId = yield* Effect.exit(admin.execute(execCall("mvm-abc")))
      expect(Exit.isFailure(shortVmId)).toBe(true)
      const malformedArgv = yield* Effect.exit(admin.execute(
        execCall("mvm-abc12345", { argv: "not-an-array" as unknown as ReadonlyArray<string> })
      ))
      expect(Exit.isFailure(malformedArgv)).toBe(true)
      const absentVm = yield* Effect.result(admin.inspect({ vmId: "mvm-zzzzzzzz" as VmId }))
      expect(failureTag(absentVm)).toBe("VmNotFound")
      expect(harness.guestCalls.length).toBe(0)
      expect(harness.bootCount()).toBe(0)

      // After all malformed input the daemon still admits exactly the allowed
      // capacity, so no rejected request consumed or leaked a slot.
      yield* admin.create(createPayload)
      expect((yield* admin.list({})).vms.length).toBe(1)
      const overCapacity = yield* Effect.result(admin.create(createPayload))
      expect(failureTag(overCapacity)).toBe("CapacityExceeded")
      expect((yield* admin.list({})).vms.length).toBe(1)
    })))
  })

  it("bounds raw HTTP header count/size and body size before any RPC handling", async () => {
    const root = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const harness = yield* startHarness(root, { maxVms: 3 })
      const admin = yield* makeMicrovmClient({ url: harness.url, token: adminToken })

      // Capture one real, protocol-valid RPC envelope from the genuine client,
      // so the replays below are legal requests rather than garbage that any
      // transport would reject for the wrong reason.
      let captured: { body: string; authorization: string } | undefined
      const recorder = createServer((request, response) => {
        const chunks: Array<Buffer> = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => {
          captured ??= {
            body: Buffer.concat(chunks).toString("utf8"),
            authorization: String(request.headers["authorization"] ?? "")
          }
          response.writeHead(500, { "content-type": "application/json" })
          response.end("{}")
        })
      })
      servers.push(recorder)
      yield* Effect.promise(async () => {
        recorder.listen(0, "127.0.0.1")
        await new Promise<void>((resolve) => recorder.once("listening", () => resolve()))
      })
      const recorderAddress = recorder.address()
      if (recorderAddress === null || typeof recorderAddress === "string") throw new Error("recorder has no TCP port")
      yield* Effect.scoped(Effect.gen(function*() {
        const throwaway = yield* makeMicrovmClient({
          url: `http://127.0.0.1:${recorderAddress.port}`,
          token: adminToken
        })
        yield* Effect.exit(throwaway.create(createPayload))
      }))
      if (captured === undefined) throw new Error("no RPC envelope was captured")
      const authHeaders = { "content-type": "application/json", authorization: captured.authorization }
      const post = (headers: Record<string, string>, body: string) =>
        Effect.promise(async () => {
          const response = await fetch(`${harness.url}/rpc`, { method: "POST", headers, body })
          return { status: response.status, body: await response.text() }
        })

      // Control: the captured envelope is accepted and creates one VM.
      const accepted = yield* post(authHeaders, captured.body)
      expect(accepted.body).toContain("_tag")
      expect((yield* admin.list({})).vms.length).toBe(1)

      // Whitespace padding below the body cap is still a parsed request...
      const underCap = yield* post(authHeaders, captured.body + " ".repeat(900_000))
      expect(underCap.body).toContain("_tag")
      expect((yield* admin.list({})).vms.length).toBe(2)

      // ...while padding above the cap is refused before any handler runs, so
      // no third VM is created (capacity 3 would otherwise admit it).
      const overCap = yield* post(authHeaders, captured.body + " ".repeat(2_000_000))
      expect(overCap.status).toBeGreaterThanOrEqual(400)
      expect(overCap.status).toBeLessThan(500)
      expect(overCap.body).not.toContain("_tag")
      expect((yield* admin.list({})).vms.length).toBe(2)

      // Header count and header size are bounded at the same boundary: a
      // protocol-valid create must not dispatch when headers overflow.
      const control = yield* post({ "content-type": "application/json" }, "{}")
      expect(control.body).toContain("_tag")
      const floodHeaders: Record<string, string> = { ...authHeaders }
      for (let index = 0; index < 100; index++) floodHeaders[`x-flood-${index}`] = "1"
      const flooded = yield* post(floodHeaders, captured.body)
      expect(flooded.status).toBeGreaterThanOrEqual(400)
      expect(flooded.status).toBeLessThan(500)
      expect(flooded.body).not.toContain("_tag")
      expect((yield* admin.list({})).vms.length).toBe(2)
      const hugeHeader = yield* post(
        { ...authHeaders, "x-huge": "a".repeat(32_768) },
        captured.body
      )
      expect(hugeHeader.status).toBeGreaterThanOrEqual(400)
      expect(hugeHeader.status).toBeLessThan(500)
      expect(hugeHeader.body).not.toContain("_tag")
      expect((yield* admin.list({})).vms.length).toBe(2)

      // Recovery: the daemon still serves a real authenticated RPC end to end.
      const vms = yield* admin.list({})
      expect(vms.vms.length).toBe(2)
      const executed = yield* admin.execute(execCall(vms.vms[0]!.vmId))
      expect(executed.exitCode).toBe(0)
      expect(harness.guestCalls.length).toBe(1)
    })))
  })

  it("never over-admits capacity and reclaims it exactly once across concurrent churn", async () => {
    const root = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const harness = yield* startHarness(root, { maxVms: 2 })
      const admin = yield* makeMicrovmClient({ url: harness.url, token: adminToken })

      const creates = yield* Effect.forEach(
        Array.from({ length: 6 }, (_, index) => index),
        () => admin.create(createPayload).pipe(Effect.result),
        { concurrency: "unbounded" }
      )
      expect(creates.filter((result) => Result.isSuccess(result)).length).toBe(2)
      expect(creates.filter((result) => Result.isFailure(result) && result.failure._tag === "CapacityExceeded").length).toBe(4)

      const survivors = creates.flatMap((result) => Result.isSuccess(result) ? [result.success.vm.vmId] : [])
      const destroys = yield* Effect.forEach(
        [survivors[0]!, survivors[1]!, survivors[0]!, survivors[1]!],
        (vmId) => admin.destroy({ vmId }).pipe(Effect.result),
        { concurrency: "unbounded" }
      )
      expect(destroys.filter((result) => Result.isSuccess(result)).length).toBe(4)
      expect((yield* admin.list({})).vms.length).toBe(0)

      // Exact-accounting probe: with capacity 2, three concurrent creates can
      // only ever succeed twice. A double release would admit all three.
      const refill = yield* capacityProbe(admin, 2)
      expect(refill).toEqual({ admitted: 2, rejected: 1 })
    })))
  })

  it("caps abusive resource requests before Firecracker ever sees them", async () => {
    const root = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const harness = yield* startHarness(root, { maxVms: 2 })
      const admin = yield* makeMicrovmClient({ url: harness.url, token: adminToken })

      const abusive = yield* admin.create({ image: "node", imageDigest: fixtureImageDigest, cpus: 64, memMib: 999_999, ttlSeconds: 999_999 })
      const info = yield* admin.inspect({ vmId: abusive.vm.vmId })
      expect(info.cpus).toBe(2)
      expect(info.memMib).toBe(256)
      expect(info.expiresAtEpochMs).toBeDefined()
      expect(info.expiresAtEpochMs! - info.createdAtEpochMs).toBeLessThanOrEqual(60_000)
      expect(info.expiresAtEpochMs! - info.createdAtEpochMs).toBeGreaterThan(0)
    })))
  })

  it("distinguishes a guest pre-exec rejection from a poisoned transport and never reuses a dirty VM", async () => {
    const root = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const harness = yield* startHarness(root, {
        maxVms: 1,
        exec: (request) => request.argv[0] === "/fault"
          ? Effect.fail(new GuestTransportFault({ vmId: request.vmId, reason: "hostile guest: no terminal frame" }))
          : request.argv[0] === "/reject"
          ? Effect.succeed({
            _tag: "GuestError" as const,
            code: "EXEC_FAILED" as const,
            message: "synthetic pre-exec rejection"
          })
          : Effect.succeed(guestExit())
      })
      const admin = yield* makeMicrovmClient({ url: harness.url, token: adminToken })
      const created = yield* admin.create(createPayload)
      const sandbox = yield* makeMicrovmClient({ url: harness.url, token: created.sandboxToken })
      const vmId = created.vm.vmId

      const rejected = yield* Effect.result(sandbox.execute(execCall(vmId, { argv: ["/reject"] })))
      if (Result.isSuccess(rejected)) throw new Error("pre-exec rejection must not succeed")
      expect(rejected.failure._tag).toBe("GuestExecError")
      expect(rejected.failure).toMatchObject({ code: "EXEC_FAILED" })
      expect((yield* sandbox.inspect({ vmId })).state).toBe("running")
      const healthy = yield* sandbox.execute(execCall(vmId, { argv: ["/ok"] }))
      expect(healthy.exitCode).toBe(0)

      const faulted = yield* Effect.result(sandbox.execute(execCall(vmId, { argv: ["/fault"] })))
      expect(failureTag(faulted)).toBe("VmPoisoned")
      expect((yield* sandbox.inspect({ vmId })).state).toBe("poisoned")
      const afterFault = yield* Effect.result(sandbox.execute(execCall(vmId, { argv: ["/ok"] })))
      expect(failureTag(afterFault)).toBe("VmPoisoned")
      expect(harness.guestCalls.filter((call) => call.argv[0] === "/ok").length).toBe(1)

      expect((yield* admin.destroy({ vmId })).destroyed).toBe(true)
      const revoked = yield* Effect.result(sandbox.inspect({ vmId }))
      expect(failureTag(revoked)).toBe("Unauthenticated")
      expect((yield* admin.list({})).vms.length).toBe(0)
      const replacement = yield* admin.create(createPayload)
      expect(replacement.vm.vmId).not.toBe(vmId)
    })))
  })

  it("keeps a VM reserved when teardown is uncertain and releases it only after a proven retry", async () => {
    const root = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const harness = yield* startHarness(root, {
        maxVms: 1,
        stop: (vmId, call) => call === 1
          ? Effect.fail(new VmTeardownFault({ vmId, phase: "signal", reason: "synthetic uncertain teardown" }))
          : Effect.void
      })
      const admin = yield* makeMicrovmClient({ url: harness.url, token: adminToken })
      const created = yield* admin.create(createPayload)

      const uncertain = yield* Effect.result(admin.destroy({ vmId: created.vm.vmId }))
      expect(failureTag(uncertain)).toBe("DestroyUncertain")

      // Nothing was released: capacity is still held and the VM is still listed.
      const blocked = yield* Effect.result(admin.create(createPayload))
      expect(failureTag(blocked)).toBe("CapacityExceeded")
      const listed = yield* admin.list({})
      expect(listed.vms.map((vm) => vm.vmId)).toEqual([created.vm.vmId])
      expect(listed.vms[0]!.state).toBe("poisoned")

      const proven = yield* admin.destroy({ vmId: created.vm.vmId })
      expect(proven.destroyed).toBe(true)
      expect((yield* admin.list({})).vms.length).toBe(0)
      const replacement = yield* admin.create(createPayload)
      expect(replacement.vm.vmId).not.toBe(created.vm.vmId)
    })))
  })

  it("coalesces concurrent destroy callers without double-releasing capacity", async () => {
    const root = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const harness = yield* startHarness(root, { maxVms: 2 })
      const admin = yield* makeMicrovmClient({ url: harness.url, token: adminToken })
      const created = yield* admin.create(createPayload)

      const calls: Array<Result.Result<unknown, { readonly _tag: string }>> = yield* Effect.forEach(
        Array.from({ length: 4 }, () => created.vm.vmId),
        (vmId) => admin.destroy({ vmId }).pipe(Effect.result),
        { concurrency: "unbounded" }
      )
      for (const call of calls) expect(Result.isSuccess(call)).toBe(true)
      expect((yield* admin.list({})).vms.length).toBe(0)

      // One VM was destroyed; exactly one slot (of the two) may be refilled.
      const refill = yield* capacityProbe(admin, 2)
      expect(refill).toEqual({ admitted: 2, rejected: 1 })
    })))
  })

  it("reclaims a poisoned VM through the periodic reaper and never double-releases its quota", async () => {
    const root = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const harness = yield* startHarness(root, {
        maxVms: 1,
        exec: (request) => request.argv[0] === "/fault"
          ? Effect.fail(new GuestTransportFault({ vmId: request.vmId, reason: "hostile guest: no terminal frame" }))
          : Effect.succeed(guestExit())
      })
      const admin = yield* makeMicrovmClient({ url: harness.url, token: adminToken })
      const created = yield* admin.create(createPayload)
      const faulted = yield* Effect.result(admin.execute(execCall(created.vm.vmId, { argv: ["/fault"] })))
      expect(failureTag(faulted)).toBe("VmPoisoned")

      // The ~1s periodic reaper reclaims the poisoned record exactly once.
      let gone = false
      for (let attempt = 0; attempt < 300 && !gone; attempt++) {
        gone = (yield* admin.list({})).vms.length === 0
        if (!gone) yield* Effect.sleep(10)
      }
      expect(gone).toBe(true)

      // Exactly one slot was released, so one refill succeeds and one fails.
      yield* admin.create(createPayload)
      const overCapacity = yield* Effect.result(admin.create(createPayload))
      expect(failureTag(overCapacity)).toBe("CapacityExceeded")
    })))
  })
})
