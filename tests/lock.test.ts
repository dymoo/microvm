import { createServer, type Server } from "node:http"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { DaemonConfig, daemonLayer } from "../src/daemon.js"
import { Firecracker, GuestExecChannel } from "../src/firecracker.js"
import { HostPrereqs } from "../src/host.js"

const canExerciseFlock = process.platform === "linux" && existsSync("/usr/bin/flock")

const configFor = (root: string) => new DaemonConfig({
  listen: { host: "127.0.0.1", port: 0 },
  advertisedUrl: "http://127.0.0.1:1",
  tls: undefined,
  auth: { adminTokens: ["lock-test-admin-token"] },
  firecracker: {
    firecrackerBinary: "/usr/bin/false",
    flockBinary: "/usr/bin/flock",
    jailerBinary: "/usr/bin/false",
    kernelImage: join(root, "vmlinux"),
    imagesDir: join(root, "images"),
    runStateDir: join(root, "run"),
    jailerUidRange: [31_000, 31_099],
    jailerGidRange: [31_000, 31_099],
    jailerParentCgroup: undefined,
    guestCidRange: [7_000, 7_099],
    kernelArgs: "console=ttyS0 reboot=k panic=1 pci=off",
    bootTimeoutMs: 1_000,
    guestReadinessTimeoutMs: 1_000,
    vmmOverheadMib: 16,
    maxPidsPerVm: 64,
    jailerFsizeBytes: 1_048_576,
    jailerNoFileLimit: 128
  },
  limits: {
    maxVms: 1,
    defaultCpus: 1,
    maxCpus: 1,
    defaultMemMib: 128,
    maxMemMib: 128,
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
const firecracker = Layer.succeed(Firecracker, Firecracker.of({
  boot: () => Effect.die("lock test must not boot a VM")
}))
const guest = Layer.succeed(GuestExecChannel, GuestExecChannel.of({
  exec: () => Effect.die("lock test must not execute in a VM")
}))

const start = (config: DaemonConfig, server: Server) =>
  daemonLayer(config, { server, prereqs, firecracker, guestExec: guest }).pipe(
    Layer.launch,
    Effect.forkScoped
  )

const waitUntil = (predicate: () => boolean, label: string) => Effect.gen(function*() {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    yield* Effect.sleep(10)
  }
  return yield* Effect.die(`timed out waiting for ${label}`)
})

describe("daemon kernel lock", () => {
  it.skipIf(!canExerciseFlock)("has one winner, ignores stale metadata, and shuts down if its lock helper dies", async () => {
    const root = await mkdtemp(join(tmpdir(), "microvm-lock-"))
    try {
      await mkdir(join(root, "images"), { recursive: true })
      await mkdir(join(root, "run"), { recursive: true })
      await writeFile(join(root, "vmlinux"), "test")
      const lockPath = join(root, "run", "daemon.lock")
      const ownerPath = join(root, "run", "daemon.owner.json")
      await writeFile(lockPath, "lock-file-must-not-be-replaced")
      await writeFile(ownerPath, JSON.stringify({ pid: 999_999, lockHelperPid: 999_998 }))
      const lockInode = (await stat(lockPath)).ino

      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const first = createServer()
        const second = createServer()
        yield* start(configFor(root), first)
        yield* start(configFor(root), second)
        yield* waitUntil(() => Number(first.listening) + Number(second.listening) === 1, "exactly one listener")
        expect(Number(first.listening) + Number(second.listening)).toBe(1)
        expect((yield* Effect.promise(() => readFile(lockPath, "utf8")))).toBe("lock-file-must-not-be-replaced")
        expect((yield* Effect.promise(() => stat(lockPath))).ino).toBe(lockInode)

        const winner = first.listening ? first : second
        const owner = JSON.parse(yield* Effect.promise(() => readFile(ownerPath, "utf8"))) as { lockHelperPid: number }
        process.kill(owner.lockHelperPid, "SIGKILL")
        yield* waitUntil(() => !winner.listening, "lock holder shutdown")

        const replacement = createServer()
        yield* start(configFor(root), replacement)
        yield* waitUntil(() => replacement.listening, "replacement listener")
        expect(replacement.listening).toBe(true)
      })))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
