/**
 * Admission contracts: every process start is admission-closed (the config
 * marker accepts the literal `false` only), the admin gate and the create
 * reservation are linearized through the registry mutex, a closed gate wins
 * before image resolution, `info.liveVms` counts admitted in-flight
 * reservations and quarantines so a drain cannot report zero during an active
 * boot, authorization precedes the gate (a closed gate refuses a sandbox
 * create with `Forbidden`, never `AdmissionClosed`), and a real two-launch
 * restart proves an opened first daemon comes back closed and adopts no VM.
 *
 * Concurrent RPC flows use separate request-scoped client instances (as
 * real Workers/CLI invocations do): one Effect RPC client/protocol
 * serializes its own requests, so a held create must never share a client
 * with the admission/control traffic it must not block.
 */
import { createServer } from "node:http"
import { readFileSync as readPackageJson } from "node:fs"
import { Context, Effect, Fiber, Layer, Result } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CredentialStore } from "../src/auth.js"
import { DaemonConfig, daemonLayer, DaemonConfigError, loadDaemonConfig, VmRegistry } from "../src/daemon.js"
import { Firecracker, GuestExecChannel, GuestExecChannelLive, GuestHttpChannelLive, GuestServiceChannelLive } from "../src/firecracker.js"
import { CidAllocator, HostPrereqs, ImageAllowlist, JailerUidAllocator } from "../src/host.js"
import { MICROVM_VERSION } from "../src/protocol.js"
import { makeAdminClient } from "../src/client.js"
import { makeMicrovmClient } from "../src/client-raw.js"

const adminToken = "admin-token-for-admission-tests"
const fixtureImageBytes = "test"
const fixtureImageDigest = `sha256:${"cd".repeat(32)}`
const createPayload = {
  image: "node",
  imageDigest: fixtureImageDigest,
  cpus: undefined,
  memMib: undefined,
  ttlSeconds: undefined
} as const

const configFor = (root: string) => new DaemonConfig({
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
    maxVms: 3,
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
  await writeFile(join(root, "images", "node.raw"), fixtureImageBytes)
  await writeFile(join(root, "images", "node.json"), JSON.stringify({
    name: "node",
    file: "node.raw",
    arch: process.arch === "arm64" ? "aarch64" : "x86_64",
    sizeBytes: 4,
    rootDevice: "/dev/vda",
    imageDigest: fixtureImageDigest
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

const staticBoot = Layer.succeed(Firecracker, Firecracker.of({
  boot: (spec) => Effect.promise(async () => {
    await mkdir(spec.layout.vmDir, { recursive: true })
    return { pid: 71, imageDigest: fixtureImageDigest, stop: () => Effect.void, exited: Effect.never }
  })
}))

const guestOk = Layer.succeed(GuestExecChannel, GuestExecChannel.of({
  exec: () => Effect.succeed({
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
}))

/**
 * Launches a daemon that starts admission-closed (as every real start must)
 * and opens the gate when `open` is set, so tests drive creates as before.
 */
const startHarness = (root: string, open: boolean, boot: Layer.Layer<Firecracker> = staticBoot) =>
  Effect.gen(function*() {
    const server = createServer()
    yield* daemonLayer(configFor(root), {
      firecracker: boot,
      guestExec: guestOk,
      prereqs,
      credentials: CredentialStore.layer([adminToken]),
      server,
      unsafeSkipKernelLockForTests: true
    }).pipe(
      Layer.launch,
      Effect.forkScoped
    )
    const port = yield* waitForListener(server)
    const url = `http://127.0.0.1:${port}`
    const admin = yield* makeMicrovmClient({ url, token: adminToken })
    if (open) yield* admin.setAdmission({ accepting: true })
    return { url, admin }
  })

describe("daemon startup admission configuration", () => {
  it("refuses to load a config file without acceptingAtStartup", async () => {
    const root = await mkdtemp(join(tmpdir(), "microvm-admission-"))
    try {
      const missing = join(root, "missing-gate.json")
      await writeFile(missing, JSON.stringify({
        listen: { host: "127.0.0.1", port: 0 },
        advertisedUrl: "http://127.0.0.1:1",
        auth: { adminTokens: [adminToken] }
      }))
      const absent = await Effect.runPromise(loadDaemonConfig(missing).pipe(Effect.result))
      expect(absent._tag).toBe("Failure")
      if (absent._tag === "Failure") {
        expect(absent.failure).toBeInstanceOf(DaemonConfigError)
        expect(absent.failure.reason).toContain("acceptingAtStartup")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses configs that try to boot admission-open", async () => {
    const root = await mkdtemp(join(tmpdir(), "microvm-admission-"))
    try {
      const path = join(root, "open-gate.json")
      await writeFile(path, JSON.stringify({
        listen: { host: "127.0.0.1", port: 0 },
        advertisedUrl: "http://127.0.0.1:1",
        acceptingAtStartup: true,
        auth: { adminTokens: [adminToken] }
      }))
      const result = await Effect.runPromise(loadDaemonConfig(path).pipe(Effect.result))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.reason).toContain("literally false")
      }
      // The schema itself rejects `true` at construction time too.
      expect(() => new DaemonConfig({
        listen: { host: "127.0.0.1", port: 0 },
        advertisedUrl: "http://127.0.0.1:1",
        tls: undefined,
        acceptingAtStartup: true as never,
        firecracker: {},
        limits: {}
      } as never)).toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses configs whose acceptingAtStartup is not the boolean false", async () => {
    const root = await mkdtemp(join(tmpdir(), "microvm-admission-"))
    try {
      const path = join(root, "invalid-gate.json")
      await writeFile(path, JSON.stringify({
        listen: { host: "127.0.0.1", port: 0 },
        advertisedUrl: "http://127.0.0.1:1",
        acceptingAtStartup: "false",
        auth: { adminTokens: [adminToken] }
      }))
      const result = await Effect.runPromise(loadDaemonConfig(path).pipe(Effect.result))
      expect(result._tag).toBe("Failure")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses configs whose admin tokens are missing or too short", async () => {
    const root = await mkdtemp(join(tmpdir(), "microvm-admission-"))
    try {
      const path = join(root, "invalid-tokens.json")
      await writeFile(path, JSON.stringify({
        listen: { host: "127.0.0.1", port: 0 },
        advertisedUrl: "http://127.0.0.1:1",
        acceptingAtStartup: false,
        auth: { adminTokens: ["short"] }
      }))
      const result = await Effect.runPromise(loadDaemonConfig(path).pipe(Effect.result))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.reason).toContain("adminTokens")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("admission gate lifecycle", () => {
  it("reports exact build/version, admission state, and live VM count to admins only", async () => {
    const root = await mkdtemp(join(tmpdir(), "microvm-admission-"))
    await prepareFixture(root)
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const harness = yield* startHarness(root, true)
        const admin = yield* makeAdminClient({ url: harness.url, token: adminToken })

        const initial = yield* admin.info()
        expect(initial).toEqual({ version: MICROVM_VERSION, accepting: true, liveVms: 0 })

        const created = yield* admin.create({ image: "node", imageDigest: fixtureImageDigest })
        const afterCreate = yield* admin.info()
        expect(afterCreate).toEqual({ version: MICROVM_VERSION, accepting: true, liveVms: 1 })
        expect(created.vm.vmId).toMatch(/^mvm-/)

        // A sandbox credential is authenticated but never admin: both admin
        // RPCs refuse with Forbidden, not Unauthenticated or AdmissionClosed.
        const sandbox = yield* makeMicrovmClient({ url: harness.url, token: created.sandboxToken })
        const sandboxInfo = yield* Effect.result(sandbox.info({}))
        expect(Result.isFailure(sandboxInfo) && sandboxInfo.failure._tag).toBe("Forbidden")
        const sandboxAdmission = yield* Effect.result(sandbox.setAdmission({ accepting: false }))
        expect(Result.isFailure(sandboxAdmission) && sandboxAdmission.failure._tag).toBe("Forbidden")
        const sandboxCreate = yield* Effect.result(sandbox.create({
          image: "node", imageDigest: fixtureImageDigest, cpus: undefined, memMib: undefined, ttlSeconds: undefined
        }))
        expect(Result.isFailure(sandboxCreate) && sandboxCreate.failure._tag).toBe("Forbidden")
      })))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("starts admission-closed and fails creates with AdmissionClosed until opened", async () => {
    const root = await mkdtemp(join(tmpdir(), "microvm-admission-"))
    await prepareFixture(root)
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const harness = yield* startHarness(root, false)
        const admin = yield* makeAdminClient({ url: harness.url, token: adminToken })
        const initial = yield* admin.info()
        expect(initial).toEqual({ version: MICROVM_VERSION, accepting: false, liveVms: 0 })
        const blocked = yield* Effect.result(admin.create({ image: "node", imageDigest: fixtureImageDigest }))
        expect(Result.isFailure(blocked) && blocked.failure._tag).toBe("AdmissionClosed")
        expect(Result.isFailure(blocked) && blocked.failure.message.length).toBeGreaterThan(0)

        // Admission is the first authorized create decision. Even an invalid
        // image cannot trigger allowlist I/O or reveal image policy while the
        // daemon is drained.
        const invalidBlocked = yield* Effect.result(admin.create({
          image: "not-allowlisted",
          imageDigest: fixtureImageDigest
        }))
        expect(Result.isFailure(invalidBlocked) && invalidBlocked.failure._tag).toBe("AdmissionClosed")
        expect((yield* admin.info()).liveVms).toBe(0)

        const opened = yield* admin.setAdmission(true)
        expect(opened.accepting).toBe(true)
        const rejectedImage = yield* Effect.result(admin.create({
          image: "not-allowlisted",
          imageDigest: fixtureImageDigest
        }))
        expect(Result.isFailure(rejectedImage) && rejectedImage.failure._tag).toBe("ImageNotAllowed")
        expect((yield* admin.info()).liveVms).toBe(0)
        const created = yield* admin.create({ image: "node", imageDigest: fixtureImageDigest })
        expect(created.vm.vmId).toMatch(/^mvm-/)
      })))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("authorizes before gating: a sandbox create on a closed gate is Forbidden, not AdmissionClosed", async () => {
    const root = await mkdtemp(join(tmpdir(), "microvm-admission-"))
    await prepareFixture(root)
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const harness = yield* startHarness(root, true)
        const created = yield* harness.admin.create(createPayload)
        const closed = yield* harness.admin.setAdmission({ accepting: false })
        expect(closed.accepting).toBe(false)

        // The sandbox credential is refused for the admin-only create before
        // the closed gate is consulted, so it must not see AdmissionClosed.
        const sandbox = yield* makeMicrovmClient({ url: harness.url, token: created.sandboxToken })
        const blocked = yield* Effect.result(sandbox.create(createPayload))
        expect(Result.isFailure(blocked) && blocked.failure._tag).toBe("Forbidden")
      })))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("drains: close during an admitted boot keeps accounting nonzero and refuses later creates", async () => {
    const root = await mkdtemp(join(tmpdir(), "microvm-admission-"))
    await prepareFixture(root)
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        // Deterministic latches: the fake boot signals bootStarted and then
        // blocks on bootReleased until the test resolves it.
        let signalBootStarted!: () => void
        const bootStarted = new Promise<void>((resolve) => { signalBootStarted = resolve })
        let releaseBoot!: () => void
        const bootReleased = new Promise<void>((resolve) => { releaseBoot = resolve })
        const blockingBoot = Layer.succeed(Firecracker, Firecracker.of({
          boot: (spec) => Effect.promise(async () => {
            signalBootStarted()
            await bootReleased
            await mkdir(spec.layout.vmDir, { recursive: true })
            return { pid: 72, imageDigest: fixtureImageDigest, stop: () => Effect.void, exited: Effect.never }
          })
        }))
        const harness = yield* startHarness(root, true, blockingBoot)
        // Separate request-scoped clients: the forked create serializes on
        // its own client and must never share it with the control traffic.
        const creator = yield* makeAdminClient({ url: harness.url, token: adminToken })
        const control = yield* makeAdminClient({ url: harness.url, token: adminToken })

        const inFlight = yield* creator.create({ image: "node", imageDigest: fixtureImageDigest }).pipe(Effect.forkScoped)
        yield* Effect.promise(() => bootStarted)

        // While the boot is blocked, close admission and probe accounting.
        const gate = yield* control.setAdmission(false)
        expect(gate.accepting).toBe(false)
        expect((yield* control.info()).liveVms).toBe(1)
        const refused = yield* Effect.result(control.create({ image: "node", imageDigest: fixtureImageDigest }))
        expect(Result.isFailure(refused) && refused.failure._tag).toBe("AdmissionClosed")

        // The admitted create still completes; accounting stays exact.
        releaseBoot()
        const created = yield* Fiber.join(inFlight)
        const finalInfo = yield* control.info()
        expect(finalInfo).toEqual({ version: MICROVM_VERSION, accepting: false, liveVms: 1 })
        expect((yield* control.list()).vms.map((vm) => vm.vmId)).toEqual([created.vm.vmId])
      })))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("restarts closed and adopts no VM: an opened first daemon comes back shut", async () => {
    const root = await mkdtemp(join(tmpdir(), "microvm-admission-"))
    await prepareFixture(root)
    try {
      // First launch: explicitly opened, one VM created, then the process
      // exits (its scope closes, taking the daemon's runtime with it).
      const first = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const harness = yield* startHarness(root, true)
        const created = yield* harness.admin.create(createPayload)
        expect((yield* harness.admin.info({})).liveVms).toBe(1)
        return created.vm.vmId
      })))
      expect(first).toMatch(/^mvm-/)

      // Second launch on the same state directory: the fresh process starts
      // admission-closed regardless of the first process's opened gate and
      // adopts no VM.
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const harness = yield* startHarness(root, false)
        const initial = yield* harness.admin.info({})
        expect(initial).toEqual({ version: MICROVM_VERSION, accepting: false, liveVms: 0 })
        const listed = yield* harness.admin.list({})
        expect(listed.vms).toEqual([])
        const blocked = yield* Effect.result(harness.admin.create(createPayload))
        expect(Result.isFailure(blocked) && blocked.failure._tag).toBe("AdmissionClosed")
      })))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// The package version and the wire constant must move together: a drift is a
// hard client rejection, so the lock is asserted observably.
describe("version lock", () => {
  it("package.json version equals MICROVM_VERSION", () => {
    const pkg = JSON.parse(readPackageJson(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
    expect(pkg.version).toBe(MICROVM_VERSION)
  })
})
