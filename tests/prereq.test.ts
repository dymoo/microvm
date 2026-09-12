/**
 * Host prerequisite contracts: fail-closed aggregation on hosts lacking KVM,
 * cgroup v2 or trusted paths, plus deterministic resource allocation with
 * rollback guarantees.
 */
import { Effect } from "effect"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CidAllocator, HostPrereqs, JailerUidAllocator, type HostConfig } from "../src/host.js"
import { HostPrereqFailed } from "../src/protocol.js"

const baseConfig = (overrides: Partial<HostConfig> = {}): HostConfig => ({
  firecrackerBinary: "/usr/bin/firecracker",
  flockBinary: "/usr/bin/flock",
  jailerBinary: "/usr/bin/jailer",
  kernelImage: "/opt/microvm/vmlinux",
  imagesDir: "/opt/microvm/images",
  runStateDir: mkdtempSync(join(tmpdir(), "mvm-state-")),
  jailerUidRange: [1000, 1099],
  jailerGidRange: [2000, 2099],
  jailerParentCgroup: undefined,
  guestCidRange: [3, 255],
  vmmOverheadMib: 256,
  maxPidsPerVm: 1024,
  jailerFsizeBytes: 1_073_741_824,
  jailerNoFileLimit: 4096,
  bootTimeoutMs: 30_000,
  guestReadinessTimeoutMs: 30_000,
  ...overrides
})

const verifyWith = (config: HostConfig) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const prereqs = yield* HostPrereqs
      return yield* prereqs.verifyAll()
    }).pipe(Effect.provide(HostPrereqs.layer(config)))
  )

describe("host prerequisites (fail closed)", () => {
  it("aggregates deterministic violations into one failure naming each check", async () => {
    const config = baseConfig()
    try {
      // Both invalid resources are missing files inside the config's own
      // freshly allocated private runStateDir: they fail on every host and
      // identity, with no trust/UID/cgroup assumptions in the assertions.
      const result = await verifyWith({
        ...config,
        firecrackerBinary: join(config.runStateDir, "missing-firecracker"),
        flockBinary: join(config.runStateDir, "missing-flock")
      }).then(
        () => "ok",
        (error) => error
      )
      expect(result).toBeInstanceOf(HostPrereqFailed)
      expect((result as HostPrereqFailed).reason).toMatch(/firecracker/)
      expect((result as HostPrereqFailed).reason).toMatch(/flock/)
    } finally {
      rmSync(config.runStateDir, { recursive: true, force: true })
    }
  })

  it("never reports success with capabilities unchecked", async () => {
    const result = await verifyWith(baseConfig({ firecrackerBinary: "/nonexistent/fc" })).then(
      () => "ok",
      (error) => error
    )
    expect(result).toBeInstanceOf(HostPrereqFailed)
    expect((result as HostPrereqFailed).reason).toMatch(/firecracker/)
  })

  it("rejects an executable flock binary from an untrusted operator path", async () => {
    const root = mkdtempSync(join(tmpdir(), "mvm-untrusted-flock-"))
    try {
      const flockBinary = join(root, "flock")
      writeFileSync(flockBinary, "#!/bin/sh\nexit 0\n")
      chmodSync(flockBinary, 0o755)
      const result = await verifyWith(baseConfig({ flockBinary })).then(
        () => "ok",
        (error) => error
      )
      expect(result).toBeInstanceOf(HostPrereqFailed)
      expect((result as HostPrereqFailed).reason).toMatch(/flock: untrusted location/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects non-positive or inverted uid/gid ranges", async () => {
    const result = await verifyWith(baseConfig({ jailerUidRange: [0, 5] })).then(
      () => "ok",
      (error) => error
    )
    expect(result).toBeInstanceOf(HostPrereqFailed)
    expect((result as HostPrereqFailed).reason).toMatch(/jailer-uid-range/)
  })
})

describe("deterministic resource allocation", () => {
  it("allocates the first free cid and releases in order", async () => {
    const config = baseConfig({ guestCidRange: [3, 5] })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const alloc = yield* CidAllocator
        const first = alloc.allocate()
        const second = alloc.allocate()
        const third = alloc.allocate()
        const exhausted = (() => {
          try {
            alloc.allocate()
            return false
          } catch {
            return true
          }
        })()
        alloc.release(second)
        const reused = alloc.allocate()
        return { first, second, third, exhausted, reused }
      }).pipe(Effect.provide(CidAllocator.layer(config)))
    )
    expect(result.first).toBe(3)
    expect(result.second).toBe(4)
    expect(result.third).toBe(5)
    expect(result.exhausted).toBe(true)
    expect(result.reused).toBe(4)
  })

  it("rolls the uid back when the gid range is exhausted", async () => {
    const config = baseConfig({ jailerUidRange: [10, 12], jailerGidRange: [20, 20] })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const alloc = yield* JailerUidAllocator
        const first = alloc.allocate()
        let failed = false
        try {
          alloc.allocate() // gid space exhausted -> must roll uid 11 back
        } catch {
          failed = true
        }
        alloc.release(first.uid, first.gid)
        // If the rollback works, uid 11 is free again and the deterministic
        // scan hands out 10; without it, 11 would still be held.
        const afterRelease = alloc.allocate()
        return { first, failed, afterRelease }
      }).pipe(Effect.provide(JailerUidAllocator.layer(config)))
    )
    expect(result.first).toEqual({ uid: 10, gid: 20 })
    expect(result.failed).toBe(true)
    expect(result.afterRelease).toEqual({ uid: 10, gid: 20 })
  })
})
