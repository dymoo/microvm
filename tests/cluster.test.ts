import { createServer, type Server } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Layer, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeMicrovmClient } from "../src/client.js"
import {
  makeMicrovmCluster,
  type SandboxCreateInput,
  type SandboxExecuteInput,
  type SandboxStartWebServiceInput
} from "../src/cluster.js"
import { DaemonConfig, daemonLayer } from "../src/daemon.js"
import {
  Firecracker,
  GuestExecChannel,
  GuestServiceChannel,
  GuestTransportFault,
  type WebServiceState
} from "../src/firecracker.js"
import { HostPrereqs } from "../src/host.js"

const adminToken = "admin-token-for-cluster-integration"
const roots: Array<string> = []
const createPayload = { image: "node", cpus: undefined, memMib: undefined, ttlSeconds: undefined } as const

const fixture = async (webPort?: number): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "microvm-cluster-"))
  roots.push(root)
  await mkdir(join(root, "images"), { recursive: true })
  await mkdir(join(root, "run"), { recursive: true })
  await writeFile(join(root, "vmlinux"), "test")
  await writeFile(join(root, "images", "node.raw"), "test")
  await writeFile(join(root, "images", "node.json"), JSON.stringify({
    name: "node",
    file: "node.raw",
    arch: process.arch === "arm64" ? "aarch64" : "x86_64",
    sizeBytes: 4,
    rootDevice: "/dev/vda",
    ...(webPort === undefined ? {} : { httpEndpoints: { web: { port: webPort } } })
  }))
  return root
}

const configFor = (root: string, maxVms: number) => new DaemonConfig({
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
    jailerUidRange: [21_000, 21_099],
    jailerGidRange: [21_000, 21_099],
    jailerParentCgroup: undefined,
    guestCidRange: [6_000, 6_099],
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

const prereqs = Layer.succeed(HostPrereqs, HostPrereqs.of({
  verifyAll: () => Effect.succeed({
    kvmDeviceAccess: true,
    cgroupV2: true,
    arch: process.arch === "arm64" ? "aarch64" : "x86_64"
  })
}))

const listeningPort = (server: Server) => Effect.gen(function*() {
  while (!server.listening) yield* Effect.sleep(5)
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("listener did not expose a TCP port")
  return address.port
})

const firecrackerLayer = (onBoot?: (server: Server) => void) => (server: Server) =>
  Layer.succeed(Firecracker, Firecracker.of({
    boot: (spec) => Effect.promise(async () => {
      await mkdir(spec.layout.vmDir, { recursive: true })
      onBoot?.(server)
      return { pid: 44, stop: () => Effect.void, exited: Effect.never }
    })
  }))

const guestLayer = (marker: string, onBlock?: () => Effect.Effect<never>) =>
  Layer.succeed(GuestExecChannel, GuestExecChannel.of({
    exec: (request) => request.argv[0] === "/block" && onBlock !== undefined
      ? onBlock()
      : Effect.succeed({
        _tag: "Exit" as const,
        frame: {
          code: 0,
          signal: null,
          timedOut: false,
          outputTruncated: false,
          stdout: Buffer.from(marker),
          stderr: Buffer.alloc(0)
        }
      })
  }))

const start = (
  root: string,
  maxVms: number,
  server: Server,
  firecracker: Layer.Layer<Firecracker>,
  guest: Layer.Layer<GuestExecChannel>,
  guestService?: Layer.Layer<GuestServiceChannel>
) =>
  daemonLayer(configFor(root, maxVms), {
    server,
    firecracker,
    guestExec: guest,
    prereqs,
    unsafeSkipKernelLockForTests: true,
    ...(guestService === undefined ? {} : { guestService })
  }).pipe(
    Layer.launch,
    Effect.forkScoped
  )

const execPayload = { argv: ["/marker"], cwd: undefined, env: undefined, timeoutMs: undefined, maxOutputBytes: undefined } as const

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

describe("static microVM cluster", () => {
  it("fails over only after explicit capacity and keeps the sandbox bound to the configured owner", async () => {
    const firstRoot = await fixture()
    const secondRoot = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const firstServer = createServer()
      const secondServer = createServer()
      yield* start(firstRoot, 1, firstServer, firecrackerLayer()(firstServer), guestLayer("first"))
      yield* start(secondRoot, 3, secondServer, firecrackerLayer()(secondServer), guestLayer("second"))
      const firstUrl = `http://127.0.0.1:${yield* listeningPort(firstServer)}`
      const secondUrl = `http://127.0.0.1:${yield* listeningPort(secondServer)}`
      const firstAdmin = yield* makeMicrovmClient({ url: firstUrl, token: adminToken })
      const secondAdmin = yield* makeMicrovmClient({ url: secondUrl, token: adminToken })
      yield* firstAdmin.create(createPayload)
      yield* secondAdmin.create(createPayload)

      const cluster = yield* makeMicrovmCluster({
        endpoints: [
          { url: firstUrl, token: adminToken },
          { url: secondUrl, token: adminToken }
        ]
      })
      const sandbox = yield* cluster.create(createPayload)
      expect(Buffer.from((yield* sandbox.execute(execPayload)).stdoutB64, "base64").toString()).toBe("second")
      const absentOnFirst = yield* Effect.result(firstAdmin.inspect({ vmId: sandbox.vm.vmId }))
      expect(Result.isFailure(absentOnFirst) && absentOnFirst.failure._tag).toBe("VmNotFound")
      expect((yield* secondAdmin.inspect({ vmId: sandbox.vm.vmId })).vmId).toBe(sandbox.vm.vmId)
      expect((yield* cluster.inspect(sandbox.vm.vmId)).vmId).toBe(sandbox.vm.vmId)
      expect((yield* cluster.destroy(sandbox.vm.vmId)).destroyed).toBe(true)
    })))
  })

  it("exposes only a semantic HTTP adapter when the image declares web", async () => {
    const plainRoot = await fixture()
    const webRoot = await fixture(3_000)
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const plainServer = createServer()
      const webServer = createServer()
      yield* start(plainRoot, 1, plainServer, firecrackerLayer()(plainServer), guestLayer("plain"))
      yield* start(webRoot, 1, webServer, firecrackerLayer()(webServer), guestLayer("web"))
      const plainUrl = `http://127.0.0.1:${yield* listeningPort(plainServer)}`
      const webUrl = `http://127.0.0.1:${yield* listeningPort(webServer)}`

      const plainCluster = yield* makeMicrovmCluster({ endpoints: [{ url: plainUrl, token: adminToken }] })
      const plain = yield* plainCluster.create(createPayload)
      const absent = yield* Effect.result(plain.http())
      expect(Result.isFailure(absent) && absent.failure._tag).toBe("HttpNotConfigured")
      expect(Result.isFailure(absent) && absent.failure.vmId).toBe(plain.vm.vmId)

      const webCluster = yield* makeMicrovmCluster({ endpoints: [{ url: webUrl, token: adminToken }] })
      const web = yield* webCluster.create(createPayload)
      const proxy = yield* web.http()
      expect(Object.keys(proxy).sort()).toEqual([
        "handleCheckContinue",
        "handleConnect",
        "handleRequest",
        "handleUpgrade"
      ])
      expect(typeof proxy.handleRequest).toBe("function")
      expect(typeof proxy.handleUpgrade).toBe("function")
      // Node routes these to their own server events; a host that omits either
      // wiring gets a silent close or an interim `100 Continue` instead.
      expect(typeof proxy.handleConnect).toBe("function")
      expect(typeof proxy.handleCheckContinue).toBe("function")
      expect("httpIngressToken" in web).toBe(false)
    })))
  })

  it("owns the durable web service lifecycle without blocking execute", async () => {
    const root = await fixture(3_000)
    let state: WebServiceState = { state: "not_started" }
    let startOptions: Parameters<GuestServiceChannel["Service"]["start"]>[0] | undefined
    const serviceLayer = Layer.succeed(GuestServiceChannel, GuestServiceChannel.of({
      start: (options) => Effect.sync(() => {
        startOptions = options
        state = { state: "running", startedAtEpochMs: 1_700_000_000_000 }
        return state
      }),
      status: () => Effect.sync(() => state),
      stop: () => Effect.sync(() => {
        state = {
          state: "exited",
          startedAtEpochMs: 1_700_000_000_000,
          exitCode: 143,
          signal: "SIGTERM"
        }
        return { stopped: true }
      })
    }))

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const server = createServer()
      yield* start(
        root,
        1,
        server,
        firecrackerLayer()(server),
        guestLayer("execute-remains-available"),
        serviceLayer
      )
      const url = `http://127.0.0.1:${yield* listeningPort(server)}`
      const cluster = yield* makeMicrovmCluster({ endpoints: [{ url, token: adminToken }] })
      const sandbox = yield* cluster.create(createPayload)

      const service = yield* sandbox.startWebService({
        argv: ["/usr/bin/node", "server.js"],
        cwd: "/workspace",
        env: { NODE_ENV: "development" }
      })
      expect(Object.keys(service).sort()).toEqual(["status", "stop"])
      expect(yield* service.status()).toMatchObject({
        state: "running",
        startedAtEpochMs: 1_700_000_000_000
      })
      expect(Buffer.from((yield* sandbox.execute(execPayload)).stdoutB64, "base64").toString()).toBe(
        "execute-remains-available"
      )
      expect(startOptions).toMatchObject({
        vmId: sandbox.vm.vmId,
        argv: ["/usr/bin/node", "server.js"],
        cwd: "/workspace",
        env: { NODE_ENV: "development" },
        webPort: 3_000
      })
      expect(yield* service.stop()).toEqual({ stopped: true })
      expect(yield* service.status()).toMatchObject({
        state: "exited",
        startedAtEpochMs: 1_700_000_000_000,
        exitCode: 143,
        signal: "SIGTERM"
      })

      const reserved = yield* Effect.result(sandbox.startWebService({
        argv: ["/usr/bin/node", "server.js"],
        env: { PORT: "9999" }
      }))
      expect(Result.isFailure(reserved) && reserved.failure._tag).toBe("ClusterServiceError")
      expect(Result.isFailure(reserved) && reserved.failure.code).toBe("INVALID_REQUEST")
    })))
  })

  it("accepts argv-only request objects from a plain JavaScript caller", async () => {
    const root = await fixture(3_000)
    let state: WebServiceState = { state: "not_started" }
    let serviceStart: Parameters<GuestServiceChannel["Service"]["start"]>[0] | undefined
    const serviceLayer = Layer.succeed(GuestServiceChannel, GuestServiceChannel.of({
      start: (options) => Effect.sync(() => {
        serviceStart = options
        state = { state: "running", startedAtEpochMs: 1_700_000_000_000 }
        return state
      }),
      status: () => Effect.sync(() => state),
      stop: () => Effect.sync(() => {
        state = {
          state: "exited",
          startedAtEpochMs: 1_700_000_000_000,
          exitCode: 143,
          signal: "SIGTERM"
        }
        return { stopped: true }
      })
    }))

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const server = createServer()
      yield* start(root, 1, server, firecrackerLayer()(server), guestLayer("argv-only"), serviceLayer)
      const url = `http://127.0.0.1:${yield* listeningPort(server)}`
      const cluster = yield* makeMicrovmCluster({ endpoints: [{ url, token: adminToken }] })

      // The public contract allows omitting every optional key, so these
      // argv-only literals must type-check (enforced by tsconfig.tests.json).
      // Before the cluster normalized omitted keys, the execute RPC payload
      // rejected the object client-side with MissingKey for `cwd`.
      const createInput: SandboxCreateInput = { image: "node" }
      const executeInput: SandboxExecuteInput = { argv: ["/marker"] }
      const serviceInput: SandboxStartWebServiceInput = { argv: ["/usr/bin/node", "server.js"] }

      const sandbox = yield* cluster.create(createInput)
      const executed = yield* sandbox.execute(executeInput)
      expect(Buffer.from(executed.stdoutB64, "base64").toString()).toBe("argv-only")

      const addressed = yield* cluster.execute({ vmId: sandbox.vm.vmId, argv: ["/marker"] })
      expect(Buffer.from(addressed.stdoutB64, "base64").toString()).toBe("argv-only")

      yield* sandbox.startWebService(serviceInput)
      expect(serviceStart?.argv).toEqual(["/usr/bin/node", "server.js"])
      expect(serviceStart?.cwd).toBeUndefined()
      expect(serviceStart?.env).toBeUndefined()
      expect(serviceStart?.webPort).toBe(3_000)
    })))
  })

  it("poisons the VM when a service-control exchange faults", async () => {
    const root = await fixture(3_000)
    const faultingService = Layer.succeed(GuestServiceChannel, GuestServiceChannel.of({
      start: (options) => Effect.fail(new GuestTransportFault({
        vmId: options.vmId,
        reason: "guest service response deadline exceeded"
      })),
      status: (options) => Effect.fail(new GuestTransportFault({
        vmId: options.vmId,
        reason: "guest service response deadline exceeded"
      })),
      stop: (options) => Effect.fail(new GuestTransportFault({
        vmId: options.vmId,
        reason: "guest service response deadline exceeded"
      }))
    }))

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const server = createServer()
      yield* start(root, 1, server, firecrackerLayer()(server), guestLayer("unused"), faultingService)
      const url = `http://127.0.0.1:${yield* listeningPort(server)}`
      const cluster = yield* makeMicrovmCluster({ endpoints: [{ url, token: adminToken }] })
      const sandbox = yield* cluster.create({ image: "node" })

      const failed = yield* Effect.result(sandbox.startWebService({ argv: ["/usr/bin/node", "server.js"] }))
      expect(Result.isFailure(failed)).toBe(true)

      // A bounded deadline is a transport fault, not an application outcome:
      // the VM must be unusable until it is destroyed, never half-controlled.
      const poisoned = yield* Effect.result(sandbox.execute({ argv: ["/marker"] }))
      expect(Result.isFailure(poisoned) && poisoned.failure._tag).toBe("VmPoisoned")
    })))
  })

  it("skips an unavailable host during read-only placement but never retries an ambiguous create", async () => {
    const availableRoot = await fixture()
    const availableServer = createServer()
    const silentServer = createServer((_request, _response) => {})
    await new Promise<void>((resolve, reject) => {
      silentServer.once("error", reject)
      silentServer.listen(0, "127.0.0.1", () => resolve())
    })
    const silentAddress = silentServer.address()
    if (silentAddress === null || typeof silentAddress === "string") {
      throw new Error("silent listener did not expose a TCP port")
    }
    const silentUrl = `http://127.0.0.1:${silentAddress.port}`
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        let availableBoots = 0
        const countedFirecracker = Layer.succeed(Firecracker, Firecracker.of({
          boot: (spec) => Effect.promise(async () => {
            availableBoots++
            await mkdir(spec.layout.vmDir, { recursive: true })
            return { pid: 45, stop: () => Effect.void, exited: Effect.never }
          })
        }))
        yield* start(availableRoot, 2, availableServer, countedFirecracker, guestLayer("available"))
        const availableUrl = `http://127.0.0.1:${yield* listeningPort(availableServer)}`
        const cluster = yield* makeMicrovmCluster({
          endpoints: [
            { url: "http://127.0.0.1:1", token: adminToken },
            { url: silentUrl, token: adminToken },
            { url: availableUrl, token: adminToken }
          ],
          healthTimeoutMs: 50
        })
        const sandbox = yield* cluster.create(createPayload)
        expect(availableBoots).toBe(1)
        expect(Buffer.from((yield* sandbox.execute(execPayload)).stdoutB64, "base64").toString()).toBe("available")
      })))
    } finally {
      silentServer.closeAllConnections()
      await new Promise<void>((resolve) => silentServer.close(() => resolve()))
    }

    const ambiguousRoot = await fixture()
    const fallbackRoot = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const ambiguousServer = createServer()
      const fallbackServer = createServer()
      let ambiguousBoots = 0
      let fallbackBoots = 0
      const ambiguousFirecracker = Layer.succeed(Firecracker, Firecracker.of({
        boot: (spec) => Effect.promise(async () => {
          ambiguousBoots++
          await mkdir(spec.layout.vmDir, { recursive: true })
          ambiguousServer.closeAllConnections()
          return { pid: 46, stop: () => Effect.void, exited: Effect.never }
        })
      }))
      const fallbackFirecracker = Layer.succeed(Firecracker, Firecracker.of({
        boot: (spec) => Effect.promise(async () => {
          fallbackBoots++
          await mkdir(spec.layout.vmDir, { recursive: true })
          return { pid: 47, stop: () => Effect.void, exited: Effect.never }
        })
      }))
      yield* start(ambiguousRoot, 2, ambiguousServer, ambiguousFirecracker, guestLayer("ambiguous"))
      yield* start(fallbackRoot, 2, fallbackServer, fallbackFirecracker, guestLayer("fallback"))
      const ambiguousUrl = `http://127.0.0.1:${yield* listeningPort(ambiguousServer)}`
      const fallbackUrl = `http://127.0.0.1:${yield* listeningPort(fallbackServer)}`
      const cluster = yield* makeMicrovmCluster({
        endpoints: [
          { url: ambiguousUrl, token: adminToken },
          { url: fallbackUrl, token: adminToken }
        ]
      })
      const result = yield* Effect.result(cluster.create(createPayload))
      expect(Result.isFailure(result)).toBe(true)
      expect(ambiguousBoots).toBe(1)
      expect(fallbackBoots).toBe(0)
    })))
  })

  it("propagates cancellation to destroy uncertain execution and enforces expiry", async () => {
    const root = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const server = createServer()
      const blockStarted = yield* Deferred.make<void>()
      let stops = 0
      const firecracker = Layer.succeed(Firecracker, Firecracker.of({
        boot: (spec) => Effect.promise(async () => {
          await mkdir(spec.layout.vmDir, { recursive: true })
          return {
            pid: 48,
            stop: () => Effect.sync(() => { stops++ }),
            exited: Effect.never
          }
        })
      }))
      const guest = guestLayer("ready", () => Deferred.succeed(blockStarted, undefined).pipe(Effect.andThen(Effect.never)))
      yield* start(root, 3, server, firecracker, guest)
      const url = `http://127.0.0.1:${yield* listeningPort(server)}`
      const cluster = yield* makeMicrovmCluster({ endpoints: [{ url, token: adminToken }] })
      const cancelled = yield* cluster.create(createPayload)
      const running = yield* cancelled.execute({
        argv: ["/block"], cwd: undefined, env: undefined, timeoutMs: undefined, maxOutputBytes: undefined
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(blockStarted)
      yield* Fiber.interrupt(running)
      let cancelledGone = false
      for (let attempt = 0; attempt < 100 && !cancelledGone; attempt++) {
        const inspected = yield* Effect.result(cluster.inspect(cancelled.vm.vmId))
        cancelledGone = Result.isFailure(inspected) && inspected.failure._tag === "VmNotFound"
        if (!cancelledGone) yield* Effect.sleep(10)
      }
      expect(cancelledGone).toBe(true)
      expect(stops).toBeGreaterThanOrEqual(1)

      const expiring = yield* cluster.create({ ...createPayload, ttlSeconds: 1 })
      yield* Effect.sleep(1_100)
      const expiredExec = yield* Effect.result(expiring.execute(execPayload))
      expect(Result.isFailure(expiredExec)).toBe(true)
      let expiredGone = false
      for (let attempt = 0; attempt < 100 && !expiredGone; attempt++) {
        const inspected = yield* Effect.result(cluster.inspect(expiring.vm.vmId))
        expiredGone = Result.isFailure(inspected) && inspected.failure._tag === "VmNotFound"
        if (!expiredGone) yield* Effect.sleep(10)
      }
      expect(expiredGone).toBe(true)
    })))
  })
})
