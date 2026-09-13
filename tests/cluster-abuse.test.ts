/**
 * Hostile cluster-routing contracts. These drive the real `makeMicrovmCluster`
 * against real daemons (Firecracker/guest replaced at the Context seam) plus
 * raw request-counting listeners:
 *
 * - response-supplied `owningHost` metadata is never used as a route, so a
 *   daemon cannot redirect credentials or work to another origin,
 * - duplicate origins are rejected before any credential is sent,
 * - a sandbox handle returned by `create` carries only sandbox scope: it
 *   cannot create, clean up, list other VMs, or touch another sandbox.
 */
import { createServer, type Server } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeMicrovmCluster } from "../src/cluster.js"
import { DaemonConfig, daemonLayer } from "../src/daemon.js"
import { Firecracker, GuestExecChannel } from "../src/firecracker.js"
import { HostPrereqs } from "../src/host.js"

const adminToken = "admin-token-for-cluster-abuse-tests"
const createPayload = {
  image: "node",
  cpus: undefined,
  memMib: undefined,
  ttlSeconds: undefined
} as const
const execPayload = {
  argv: ["/marker"],
  cwd: undefined,
  env: undefined,
  timeoutMs: undefined,
  maxOutputBytes: undefined
} as const

const roots: Array<string> = []
const servers: Array<Server> = []

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "microvm-cluster-abuse-"))
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
    rootDevice: "/dev/vda"
  }))
  return root
}

const configFor = (root: string, advertisedUrl: string) => new DaemonConfig({
  listen: { host: "127.0.0.1", port: 0 },
  advertisedUrl,
  tls: undefined,
  auth: { adminTokens: [adminToken] },
  firecracker: {
    firecrackerBinary: "/usr/bin/false",
    flockBinary: undefined,
    jailerBinary: "/usr/bin/false",
    kernelImage: join(root, "vmlinux"),
    imagesDir: join(root, "images"),
    runStateDir: join(root, "run"),
    jailerUidRange: [25_000, 25_099],
    jailerGidRange: [25_000, 25_099],
    jailerParentCgroup: undefined,
    guestCidRange: [10_000, 10_099],
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

const prereqs = Layer.succeed(HostPrereqs, HostPrereqs.of({
  verifyAll: () => Effect.succeed({
    kvmDeviceAccess: true,
    cgroupV2: true,
    arch: process.arch === "arm64" ? "aarch64" : "x86_64"
  })
}))

/** Resolves once the daemon layer itself has the server listening. */
const listenAddress = (server: Server) => Effect.gen(function*() {
  while (!server.listening) yield* Effect.sleep(5)
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("listener has no TCP port")
  return `http://127.0.0.1:${address.port}`
})

/** Records every request it ever receives. */
const startCounter = () => {
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    request.resume()
    response.end("{}")
  })
  servers.push(server)
  return {
    server,
    start: async (): Promise<string> => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("counter listener has no TCP port")
      return `http://127.0.0.1:${address.port}`
    },
    requests: () => requests
  }
}

const startDaemon = (root: string, advertisedUrl: string) =>
  Effect.gen(function*() {
    const server = createServer()
    yield* daemonLayer(configFor(root, advertisedUrl), {
      firecracker: Layer.succeed(Firecracker, Firecracker.of({
        boot: (spec) => Effect.promise(async () => {
          await mkdir(spec.layout.vmDir, { recursive: true })
          return { pid: 53_000, stop: () => Effect.void, exited: Effect.never }
        })
      })),
      guestExec: Layer.succeed(GuestExecChannel, GuestExecChannel.of({
        exec: () => Effect.succeed({
          _tag: "Exit" as const,
          frame: {
            code: 0,
            signal: null,
            timedOut: false,
            outputTruncated: false,
            stdout: Buffer.from("marker"),
            stderr: Buffer.alloc(0)
          }
        })
      })),
      prereqs,
      server,
      unsafeSkipKernelLockForTests: true
    }).pipe(
      Layer.launch,
      Effect.forkScoped
    )
    return yield* listenAddress(server)
  })

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
  while (servers.length > 0) {
    const server = servers.pop()!
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe("cluster routing abuse", () => {
  it("never follows a response-supplied owningHost to another origin", async () => {
    const root = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const attacker = startCounter()
      const attackerUrl = yield* Effect.promise(() => attacker.start())
      const daemonUrl = yield* startDaemon(root, attackerUrl)

      const cluster = yield* makeMicrovmCluster({
        endpoints: [{ url: daemonUrl, token: adminToken }]
      })
      const sandbox = yield* cluster.create(createPayload)
      // The daemon's metadata points at the other origin; the cluster must
      // ignore it for routing.
      expect(sandbox.vm.owningHost).toBe(attackerUrl)
      const executed = yield* sandbox.execute(execPayload)
      expect(Buffer.from(executed.stdoutB64, "base64").toString("utf8")).toBe("marker")
      expect((yield* cluster.inspect(sandbox.vm.vmId)).vmId).toBe(sandbox.vm.vmId)

      expect(attacker.requests()).toBe(0)
    })))
  })

  it("rejects duplicate origins before any credential is sent", async () => {
    const counter = startCounter()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const url = yield* Effect.promise(() => counter.start())
      const duplicate = yield* Effect.result(makeMicrovmCluster({
        endpoints: [
          { url, token: "first-endpoint-token" },
          { url, token: "second-endpoint-token" }
        ]
      }))
      expect(Result.isFailure(duplicate) && duplicate.failure._tag).toBe("ClusterRoutingError")
    })))
    expect(counter.requests()).toBe(0)
  })

  it("hands out sandbox-scoped handles that cannot escalate or touch other sandboxes", async () => {
    const root = await fixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const daemonUrl = yield* startDaemon(root, "http://127.0.0.1:1")
      const cluster = yield* makeMicrovmCluster({
        endpoints: [{ url: daemonUrl, token: adminToken }]
      })
      const first = yield* cluster.create(createPayload)
      const second = yield* cluster.create(createPayload)

      const escalatedCreate = yield* Effect.result(second.client.create(createPayload))
      const escalatedCleanup = yield* Effect.result(second.client.cleanup({}))
      const crossInspect = yield* Effect.result(second.client.inspect({ vmId: first.vm.vmId }))
      const crossExecute = yield* Effect.result(second.client.execute({
        vmId: first.vm.vmId,
        ...execPayload
      }))
      expect(Result.isFailure(escalatedCreate) && escalatedCreate.failure._tag).toBe("Forbidden")
      expect(Result.isFailure(escalatedCleanup) && escalatedCleanup.failure._tag).toBe("Forbidden")
      expect(Result.isFailure(crossInspect) && crossInspect.failure._tag).toBe("Forbidden")
      expect(Result.isFailure(crossExecute) && crossExecute.failure._tag).toBe("Forbidden")

      const visible = yield* second.client.list({})
      expect(visible.vms.map((vm) => vm.vmId)).toEqual([second.vm.vmId])
      expect((yield* first.inspect()).vmId).toBe(first.vm.vmId)
      expect(Buffer.from((yield* second.execute(execPayload)).stdoutB64, "base64").toString("utf8")).toBe("marker")
      expect((yield* first.destroy()).destroyed).toBe(true)
      expect((yield* second.destroy()).destroyed).toBe(true)
    })))
  })
})
