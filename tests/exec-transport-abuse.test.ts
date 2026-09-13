/**
 * Hostile-guest contracts for the real exec transport. Each VM runs the real
 * GuestExecChannelLive against an in-test AF_UNIX peer speaking the guest side
 * of docs/protocol.md; only the Firecracker boot is replaced. The daemon under
 * test is the real one, so these prove the public outcome a caller observes:
 *
 * - a compromised guest can never fake exec success,
 * - any transport violation poisons the VM stickily (no reuse, no retry),
 * - a silent guest is bounded by the whole-channel deadline,
 * - a pre-exec `error` frame is a protocol outcome (bounded message, VM stays
 *   usable) and is never confused with transport uncertainty,
 * - a poisoned VM holds its quota until destroy proves teardown.
 *
 * Paths live under /tmp so the derived vsock socket path stays inside the
 * AF_UNIX sun_path limit on every platform, including macOS.
 */
import { createServer, type Server } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer as createUnixServer, type Server as UnixServer, type Socket } from "node:net"
import { dirname, join } from "node:path"
import { Effect, Layer, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeMicrovmClient } from "../src/client.js"
import { DaemonConfig, daemonLayer } from "../src/daemon.js"
import { Firecracker, GuestExecChannelLive } from "../src/firecracker.js"
import { HostPrereqs, vmLayout } from "../src/host.js"
import type { ExecuteRequest, VmId } from "../src/protocol.js"

const adminToken = "admin-token-for-transport-abuse-tests"
const createPayload = {
  image: "node",
  cpus: undefined,
  memMib: undefined,
  ttlSeconds: undefined
} as const

const roots: Array<string> = []

/**
 * Deliberately short run-state root: the guest socket path is derived from it
 * and must fit the platform AF_UNIX limit (104 bytes on macOS).
 */
const fixture = async (): Promise<string> => {
  const root = await mkdtemp("/tmp/microvm-uds-")
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
    jailerUidRange: [24_000, 24_099],
    jailerGidRange: [24_000, 24_099],
    jailerParentCgroup: undefined,
    guestCidRange: [9_000, 9_099],
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

const waitForListener = (server: Server) =>
  Effect.gen(function*() {
    while (!server.listening) yield* Effect.sleep(5)
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("test listener has no TCP port")
    return address.port
  })

interface GuestRequest {
  readonly id: string
  readonly argv: ReadonlyArray<string>
}

interface HostileGuest {
  readonly connections: () => number
  readonly close: () => Promise<void>
}

const startHostileGuest = async (
  socketPath: string,
  behavior: (socket: Socket, request: GuestRequest) => void
): Promise<HostileGuest> => {
  await mkdir(dirname(socketPath), { recursive: true })
  let connections = 0
  const live = new Set<Socket>()
  const server: UnixServer = createUnixServer((socket) => {
    connections += 1
    live.add(socket)
    socket.on("close", () => live.delete(socket))
    let buffer = ""
    let acked = false
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      if (!acked) {
        const index = buffer.indexOf("\n")
        if (index === -1) return
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line !== "CONNECT 1024") {
          socket.destroy()
          return
        }
        socket.write("OK 1073741824\n")
        acked = true
      }
      const index = buffer.indexOf("\n")
      if (index === -1) return
      const request = JSON.parse(buffer.slice(0, index)) as GuestRequest
      buffer = ""
      behavior(socket, request)
    })
    socket.on("error", () => undefined)
  })
  server.listen(socketPath)
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  return {
    connections: () => connections,
    close: async () => {
      for (const socket of live) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

const frame = (execId: string, payload: Record<string, unknown>): string =>
  `${JSON.stringify({ version: 1, id: execId, ...payload })}\n`

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64")

const execCall = (vmId: string, argv: ReadonlyArray<string>, overrides: Partial<ExecuteRequest> = {}): ExecuteRequest => ({
  vmId: vmId as VmId,
  argv,
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

const startDaemon = (root: string) =>
  Effect.gen(function*() {
    const server = createServer()
    const config = configFor(root, 1)
    yield* daemonLayer(config, {
      firecracker: Layer.succeed(Firecracker, Firecracker.of({
        boot: (spec) => Effect.promise(async () => {
          await mkdir(spec.layout.vmDir, { recursive: true })
          return { pid: 52_000, stop: () => Effect.void, exited: Effect.never }
        })
      })),
      guestExec: GuestExecChannelLive,
      prereqs,
      server,
      unsafeSkipKernelLockForTests: true
    }).pipe(
      Layer.launch,
      Effect.forkScoped
    )
    const port = yield* waitForListener(server)
    return { url: `http://127.0.0.1:${port}`, config }
  })

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

describe("hostile guest cannot fake success", () => {
  const hostileBehaviors: ReadonlyArray<readonly [string, (socket: Socket, request: GuestRequest) => void]> = [
    ["an unknown frame type", (socket, request) => {
      socket.write(frame(request.id, { seq: 0, type: "stdout", data: b64("fabricated") }))
      socket.write(frame(request.id, { seq: 0, type: "privileged", data: b64("x") }))
    }],
    ["a mismatched exec id", (socket) => {
      socket.write(frame("some-other-exec", {
        seq: 0,
        type: "stdout",
        data: b64("fabricated")
      }))
    }],
    ["an out-of-order sequence", (socket, request) => {
      socket.write(frame(request.id, { seq: 1, type: "stdout", data: b64("fabricated") }))
    }],
    ["EOF before a terminal frame", (socket, request) => {
      socket.write(frame(request.id, { seq: 0, type: "stdout", data: b64("fabricated") }))
      socket.end()
    }]
  ]

  for (const [label, behavior] of hostileBehaviors) {
    it(`poisons the VM on ${label} and never reports an exec result`, async () => {
      const root = await fixture()
      try {
        await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
          const daemon = yield* startDaemon(root)
          const admin = yield* makeMicrovmClient({ url: daemon.url, token: adminToken })
          const created = yield* admin.create(createPayload)
          const sandbox = yield* makeMicrovmClient({ url: daemon.url, token: created.sandboxToken })
          const vmId = created.vm.vmId
          const guest = yield* Effect.promise(() =>
            startHostileGuest(vmLayout(daemon.config.firecracker, vmId).vsockSocket, behavior)
          )
          try {
            const exec = yield* Effect.result(sandbox.execute(execCall(vmId, ["/bin/true"])))
            if (Result.isSuccess(exec)) throw new Error(`guest ${label} produced a false success`)
            expect(failureTag(exec), label).toBe("VmPoisoned")

            // Sticky poison: the VM is never asked to run anything again.
            expect((yield* sandbox.inspect({ vmId })).state).toBe("poisoned")
            const reused = yield* Effect.result(sandbox.execute(execCall(vmId, ["/bin/true"])))
            expect(failureTag(reused)).toBe("VmPoisoned")
            expect(guest.connections()).toBe(1)

            // The poisoned VM still holds its quota until destroy returns.
            const overCapacity = yield* Effect.result(admin.create(createPayload))
            expect(failureTag(overCapacity)).toBe("CapacityExceeded")
            expect((yield* admin.destroy({ vmId })).destroyed).toBe(true)
            yield* admin.create(createPayload)
          } finally {
            yield* Effect.promise(() => guest.close())
          }
        })))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  it("bounds a silent guest by the whole-channel deadline instead of hanging", async () => {
    const root = await fixture()
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const daemon = yield* startDaemon(root)
        const admin = yield* makeMicrovmClient({ url: daemon.url, token: adminToken })
        const created = yield* admin.create(createPayload)
        const sandbox = yield* makeMicrovmClient({ url: daemon.url, token: created.sandboxToken })
        const vmId = created.vm.vmId
        const guest = yield* Effect.promise(() =>
          startHostileGuest(vmLayout(daemon.config.firecracker, vmId).vsockSocket, () => undefined)
        )
        try {
          const started = Date.now()
          const exec = yield* Effect.result(sandbox.execute(execCall(vmId, ["/bin/true"], { timeoutMs: 200 })))
          const elapsed = Date.now() - started
          expect(Result.isFailure(exec)).toBe(true)
          if (Result.isSuccess(exec)) throw new Error("a silent guest must never produce an exec result")
          expect(exec.failure._tag).toBe("VmPoisoned")
          expect(elapsed).toBeGreaterThanOrEqual(5_000)
          expect(elapsed).toBeLessThan(30_000)
          expect((yield* sandbox.inspect({ vmId })).state).toBe("poisoned")
          expect((yield* admin.destroy({ vmId })).destroyed).toBe(true)
        } finally {
          yield* Effect.promise(() => guest.close())
        }
      })))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("treats a guest error frame as a bounded protocol outcome, not transport uncertainty", async () => {
    const root = await fixture()
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const daemon = yield* startDaemon(root)
        const admin = yield* makeMicrovmClient({ url: daemon.url, token: adminToken })
        const created = yield* admin.create(createPayload)
        const sandbox = yield* makeMicrovmClient({ url: daemon.url, token: created.sandboxToken })
        const vmId = created.vm.vmId
        const guest = yield* Effect.promise(() => startHostileGuest(
          vmLayout(daemon.config.firecracker, vmId).vsockSocket,
          (socket, request) => {
            if (request.argv[0] === "/bin/echo") {
              socket.write(frame(request.id, {
                type: "error",
                code: "EXEC_FAILED",
                message: "A".repeat(100_000)
              }))
              socket.end()
              return
            }
            socket.write(frame(request.id, {
              seq: 0,
              type: "stdout",
              data: b64("ok")
            }))
            socket.end(frame(request.id, {
              type: "exit",
              code: 0,
              signal: null,
              timedOut: false,
              outputTruncated: false
            }))
          }
        ))
        try {
          const rejected = yield* Effect.result(sandbox.execute(execCall(vmId, ["/bin/echo", "x"])))
          if (Result.isSuccess(rejected)) throw new Error("a guest error frame must not be an exec success")
          expect(rejected.failure._tag).toBe("GuestExecError")
          expect(rejected.failure).toMatchObject({ code: "EXEC_FAILED" })
          if (rejected.failure._tag !== "GuestExecError") throw new Error("unreachable")
          expect(rejected.failure.message.length).toBeGreaterThan(0)
          expect(rejected.failure.message.length).toBeLessThanOrEqual(500)

          // A rejected exec is not transport uncertainty: the VM still works.
          expect((yield* sandbox.inspect({ vmId })).state).toBe("running")
          const healthy = yield* sandbox.execute(execCall(vmId, ["/bin/true"]))
          expect(healthy.exitCode).toBe(0)
          expect(Buffer.from(healthy.stdoutB64, "base64").toString("utf8")).toBe("ok")
        } finally {
          yield* Effect.promise(() => guest.close())
        }
      })))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
