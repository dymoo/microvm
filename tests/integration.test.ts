import { createServer } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Layer, Result } from "effect"
import { describe, expect, it } from "vitest"
import { makeMicrovmClient } from "../src/client.js"
import { DaemonConfig, daemonLayer } from "../src/daemon.js"
import { Firecracker, GuestExecChannel, VmTeardownFault } from "../src/firecracker.js"
import { HostPrereqs } from "../src/host.js"

const adminToken = "admin-token-for-integration-tests"
const createPayload = {
  image: "node",
  cpus: undefined,
  memMib: undefined,
  ttlSeconds: undefined
} as const

const configFor = (root: string, maxVms = 3) => new DaemonConfig({
  listen: { host: "127.0.0.1", port: 0 },
  advertisedUrl: "http://127.0.0.1:1",
  tls: undefined,
  auth: { adminTokens: [adminToken] },
  firecracker: {
    firecrackerBinary: "/usr/bin/false",
    flockBinary: undefined,
    jailerBinary: "/usr/bin/false",
    kernelImage: join(root, "vmlinux"),
    imagesDir: join(root, "images"),
    runStateDir: join(root, "run"),
    jailerUidRange: [20_000, 20_099],
    jailerGidRange: [20_000, 20_099],
    jailerParentCgroup: undefined,
    guestCidRange: [5_000, 5_099],
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

const prepareFixture = async (root: string): Promise<void> => {
  await mkdir(join(root, "images"), { recursive: true })
  await mkdir(join(root, "run"), { recursive: true })
  await writeFile(join(root, "vmlinux"), "test")
  await writeFile(join(root, "images", "node.raw"), "test")
  await writeFile(join(root, "images", "node.json"), JSON.stringify({
    name: "node",
    file: "node.raw",
    arch: process.arch === "arm64" ? "aarch64" : "x86_64",
    sizeBytes: 4,
    rootDevice: "/dev/vda"
  }))
}

const prereqs = Layer.succeed(HostPrereqs, HostPrereqs.of({
  verifyAll: () => Effect.succeed({
    kvmDeviceAccess: true,
    cgroupV2: true,
    arch: process.arch === "arm64" ? "aarch64" : "x86_64"
  })
}))

const waitForListener = (server: ReturnType<typeof createServer>) =>
  Effect.gen(function*() {
    while (!server.listening) yield* Effect.sleep(5)
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("test listener has no TCP address")
    return address.port
  })

describe("daemon RPC integration", () => {
  it("authenticates real HTTP RPCs, isolates sandboxes, and invalidates a queued exec on prompt destroy", async () => {
    const root = await mkdtemp(join(tmpdir(), "microvm-rpc-"))
    await prepareFixture(root)
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const blockingStarted = yield* Deferred.make<void>()
        const stopBlocking = yield* Deferred.make<void>()
        const teardownStarted = yield* Deferred.make<void>()
        const allowTeardown = yield* Deferred.make<void>()
        let blockingCalls = 0
        let bootCalls = 0
        let stopCalls = 0
        const firecracker = Layer.succeed(Firecracker, Firecracker.of({
          boot: (spec) => Effect.promise(async () => {
            bootCalls++
            await mkdir(spec.layout.vmDir, { recursive: true })
            return {
              pid: 42,
              stop: () => Effect.gen(function*() {
                stopCalls++
                yield* Deferred.succeed(stopBlocking, undefined)
                yield* Deferred.succeed(teardownStarted, undefined)
                yield* Deferred.await(allowTeardown)
              }),
              exited: Effect.never
            }
          })
        }))
        const guest = Layer.succeed(GuestExecChannel, GuestExecChannel.of({
          exec: (request) => Effect.gen(function*() {
            if (request.argv[0] === "/block") {
              blockingCalls++
              if (blockingCalls === 1) {
                yield* Deferred.succeed(blockingStarted, undefined)
                yield* Deferred.await(stopBlocking)
              }
            }
            return {
              _tag: "Exit" as const,
              frame: {
                code: 0,
                signal: null,
                timedOut: false,
                outputTruncated: false,
                stdout: Buffer.from("ready\n"),
                stderr: Buffer.alloc(0)
              }
            }
          })
        }))
        const server = createServer()
        yield* daemonLayer(configFor(root), {
          firecracker, guestExec: guest, prereqs, server, unsafeSkipKernelLockForTests: true
        }).pipe(
          Layer.launch,
          Effect.forkScoped
        )
        const listenerPort = yield* waitForListener(server)
        const url = `http://127.0.0.1:${listenerPort}`
        const oversizedStatus = yield* Effect.promise(async () => {
          const response = await fetch(`${url}/rpc`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ blob: "x".repeat(1_048_577) })
          })
          await response.arrayBuffer()
          return response.status
        })
        expect(oversizedStatus).toBeGreaterThanOrEqual(400)
        expect(bootCalls).toBe(0)
        expect(blockingCalls).toBe(0)
        const invalid = yield* makeMicrovmClient({ url, token: "invalid-token" })
        const invalidResult = yield* Effect.result(invalid.list({}))
        expect(Result.isFailure(invalidResult) && invalidResult.failure._tag).toBe("Unauthenticated")

        const admin = yield* makeMicrovmClient({ url, token: adminToken })
        const first = yield* admin.create(createPayload)
        const second = yield* admin.create(createPayload)
        expect(first.vm.owningHost).toBe("http://127.0.0.1:1")

        const sandbox = yield* makeMicrovmClient({ url, token: first.sandboxToken })
        expect((yield* sandbox.inspect({ vmId: first.vm.vmId })).vmId).toBe(first.vm.vmId)
        const crossVm = yield* Effect.result(sandbox.inspect({ vmId: second.vm.vmId }))
        expect(Result.isFailure(crossVm) && crossVm.failure._tag).toBe("Forbidden")
        const ready = yield* sandbox.execute({
          vmId: first.vm.vmId,
          argv: ["/ready"],
          cwd: undefined,
          env: undefined,
          timeoutMs: undefined,
          maxOutputBytes: undefined
        })
        expect(Buffer.from(ready.stdoutB64, "base64").toString("utf8")).toBe("ready\n")

        const firstExec = yield* sandbox.execute({
          vmId: first.vm.vmId,
          argv: ["/block"],
          cwd: undefined,
          env: undefined,
          timeoutMs: undefined,
          maxOutputBytes: undefined
        }).pipe(Effect.forkScoped)
        yield* Deferred.await(blockingStarted)
        const queuedExec = yield* sandbox.execute({
          vmId: first.vm.vmId,
          argv: ["/block"],
          cwd: undefined,
          env: undefined,
          timeoutMs: undefined,
          maxOutputBytes: undefined
        }).pipe(Effect.forkScoped)
        yield* Effect.sleep(20)
        const firstDestroy = yield* admin.destroy({ vmId: first.vm.vmId }).pipe(Effect.forkScoped)
        yield* Deferred.await(teardownStarted).pipe(
          Effect.timeoutOrElse({
            duration: { milliseconds: 500 },
            orElse: () => Effect.die("destroy waited for the exec permit")
          })
        )
        const ownerCancellation = yield* Fiber.interrupt(firstDestroy).pipe(Effect.forkScoped)
        const concurrentDestroy = yield* admin.destroy({ vmId: first.vm.vmId }).pipe(Effect.forkScoped)
        yield* Effect.sleep(20)
        yield* Deferred.succeed(allowTeardown, undefined)
        const coalesced = yield* Fiber.join(concurrentDestroy)
        yield* Fiber.join(ownerCancellation)
        expect(coalesced.destroyed).toBe(true)
        yield* Fiber.join(firstExec)
        const queuedResult = yield* Effect.result(Fiber.join(queuedExec))
        expect(Result.isFailure(queuedResult) && ["VmNotFound", "VmPoisoned"].includes(queuedResult.failure._tag)).toBe(true)
        expect(blockingCalls).toBe(1)
        expect(stopCalls).toBe(1)

        const revoked = yield* Effect.result(sandbox.inspect({ vmId: first.vm.vmId }))
        expect(Result.isFailure(revoked) && revoked.failure._tag).toBe("Unauthenticated")
        expect((yield* admin.inspect({ vmId: second.vm.vmId })).vmId).toBe(second.vm.vmId)
      })))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("quarantines uncertain failed-create cleanup without releasing capacity or identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "microvm-quarantine-"))
    await prepareFixture(root)
    try {
      const config = configFor(root, 1)
      let boots = 0
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const firecracker = Layer.succeed(Firecracker, Firecracker.of({
          boot: (spec) => Effect.promise(async () => {
            boots++
            await mkdir(spec.layout.vmDir, { recursive: true })
            await mkdir(spec.layout.statePath)
            return {
              pid: 43,
              stop: () => Effect.fail(new VmTeardownFault({
                vmId: spec.vmId,
                phase: "signal",
                reason: "deterministic test teardown uncertainty"
              })),
              exited: Effect.never
            }
          })
        }))
        const guest = Layer.succeed(GuestExecChannel, GuestExecChannel.of({
          exec: () => Effect.die("guest must not be called")
        }))
        const server = createServer()
        yield* daemonLayer(config, {
          firecracker, guestExec: guest, prereqs, server, unsafeSkipKernelLockForTests: true
        }).pipe(
          Layer.launch,
          Effect.forkScoped
        )
        const listenerPort = yield* waitForListener(server)
        const admin = yield* makeMicrovmClient({ url: `http://127.0.0.1:${listenerPort}`, token: adminToken })
        const failed = yield* Effect.result(admin.create(createPayload))
        expect(Result.isFailure(failed) && failed.failure._tag).toBe("BootFailed")
        const exhausted = yield* Effect.result(admin.create(createPayload))
        expect(Result.isFailure(exhausted) && exhausted.failure._tag).toBe("CapacityExceeded")
        expect(boots).toBe(1)
      })))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
