/**
 * Trusted-path walk contracts behind HostPrereqs, driven through the real
 * caller (HostPrereqs.layer -> verifyAll). Fixtures are real owned temp
 * directories, canonicalized with realpathSync, and the mocked lstatSync
 * patches metadata only: the entire ancestor chain through `/` is planted
 * root-owned with group/world writability cleared, derived from each path's
 * real Stats so file type bits stay real, and negative cases override
 * individual components. Everything else delegates to the real filesystem,
 * so kernel semantics — symlink resolution, ENOTDIR, separator collapse —
 * are exercised for real. No real ancestor is ever chmod'ed or chown'ed and
 * nothing is written outside owned temp dirs, so the suite is independent
 * of the ambient HOME and tmpdir posture. A rejection is attributed to the
 * fixture because the reason must name the configured imagesDir verbatim,
 * which only the images check does.
 */
import { Effect } from "effect"
import type * as fs from "node:fs"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HostPrereqs, type HostConfig } from "../src/host.js"
import { HostPrereqFailed } from "../src/protocol.js"

type Patch = (stats: fs.Stats) => { uid: number; mode: number }

const overrides = vi.hoisted(() => new Map<string, Patch>())

/**
 * Fixture lookup key: textual dot-segment and separator collapse, used only
 * to match planted metadata against the regular fixture tree. Symlink names
 * keep their own entries, so a probe of a symlink is answered with what the
 * kernel reports for that name.
 */
const fixtureKey = vi.hoisted(() => (path: string) => {
  const parts: Array<string> = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `/${parts.join("/")}`
})

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    lstatSync: (path: fs.PathLike) => {
      const stats = actual.lstatSync(path)
      const patch = overrides.get(String(path)) ?? overrides.get(fixtureKey(String(path)))
      return patch === undefined ? stats : Object.assign(stats, patch(stats))
    }
  }
})

afterEach(() => {
  overrides.clear()
})

/** Canonical absolute prefix chain of path, from `/` through path itself. */
const ancestorsOf = (path: string): Array<string> => {
  const chain = ["/"]
  let prefix = ""
  for (const part of realpathSync(path).split("/")) {
    if (part === "") continue
    prefix += `/${part}`
    chain.push(prefix)
  }
  return chain
}

/**
 * Owned fixture chain <canonical tmpdir>/mvm-trusted-XXXX/a/b/c/d, deep
 * enough to exceed any fixed-depth walk, with its full ancestor chain.
 */
const makeChain = () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "mvm-trusted-")))
  const a = join(temp, "a")
  const b = join(a, "b")
  const c = join(b, "c")
  const d = join(c, "d")
  mkdirSync(a)
  mkdirSync(b)
  mkdirSync(c)
  mkdirSync(d)
  return { chain: [...ancestorsOf(temp), a, b, c, d], temp, a, b, c, d }
}

/** Baseline: every fixture component pretends root-owned, group/world write cleared. */
const plantBaseline = (chain: Array<string>) => {
  for (const path of chain) overrides.set(path, (stats) => ({ uid: 0, mode: stats.mode & ~0o222 }))
}

const configWith = (overridesForConfig: Partial<HostConfig> = {}): HostConfig => ({
  firecrackerBinary: "/usr/bin/firecracker",
  flockBinary: "/usr/bin/flock",
  jailerBinary: "/usr/bin/jailer",
  kernelImage: "/opt/microvm/vmlinux",
  imagesDir: "/opt/microvm/images",
  runStateDir: realpathSync(mkdtempSync(join(tmpdir(), "mvm-state-"))),
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
  ...overridesForConfig
})

/** Verifies and returns the aggregated failure reason, or null on success. */
const verifyReason = async (config: HostConfig): Promise<string | null> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const prereqs = yield* HostPrereqs
      return yield* prereqs.verifyAll()
    }).pipe(Effect.provide(HostPrereqs.layer(config)))
  ).then(
    () => null,
    (error) => {
      expect(error).toBeInstanceOf(HostPrereqFailed)
      return (error as HostPrereqFailed).reason as string
    }
  )

/** Removes a fixture chain and the config's runState dir. */
const discard = (fixtureRoot: string | null, config: HostConfig) => {
  if (fixtureRoot !== null) rmSync(fixtureRoot, { recursive: true, force: true })
  rmSync(config.runStateDir, { recursive: true, force: true })
}

describe("trusted operator path walk", () => {
  it("rejects a relative operator path outright", async () => {
    const config = configWith({ imagesDir: "state/images" })
    try {
      expect(await verifyReason(config)).toContain(config.imagesDir)
    } finally {
      discard(null, config)
    }
  })

  it("rejects a missing operator path", async () => {
    const chain = makeChain()
    plantBaseline(chain.chain)
    const config = configWith({ imagesDir: `${chain.temp}/absent/images` })
    try {
      expect(await verifyReason(config)).toContain(config.imagesDir)
    } finally {
      discard(chain.temp, config)
    }
  })

  it("rejects a path walking through a regular file", async () => {
    const chain = makeChain()
    plantBaseline(chain.chain)
    const file = join(chain.a, "f")
    writeFileSync(file, "")
    overrides.set(file, (stats) => ({ uid: 0, mode: stats.mode & ~0o222 }))
    const config = configWith({ imagesDir: `${file}/..` })
    try {
      expect(await verifyReason(config)).toContain(config.imagesDir)
    } finally {
      discard(chain.temp, config)
    }
  })

  it("rejects a group-writable operator location", async () => {
    const chain = makeChain()
    plantBaseline(chain.chain)
    overrides.set(chain.a, (stats) => ({ uid: 0, mode: stats.mode | 0o022 }))
    const config = configWith({ imagesDir: chain.a })
    try {
      expect(await verifyReason(config)).toContain(config.imagesDir)
    } finally {
      discard(chain.temp, config)
    }
  })

  it("rejects a non-root-owned operator location", async () => {
    const chain = makeChain()
    plantBaseline(chain.chain)
    overrides.set(chain.a, (stats) => ({ uid: 1000, mode: stats.mode & ~0o222 }))
    const config = configWith({ imagesDir: chain.a })
    try {
      expect(await verifyReason(config)).toContain(config.imagesDir)
    } finally {
      discard(chain.temp, config)
    }
  })

  it("accepts a fully trusted operator path of arbitrary depth", async () => {
    const chain = makeChain()
    plantBaseline(chain.chain)
    const config = configWith({ imagesDir: chain.d })
    try {
      expect(await verifyReason(config)).not.toContain(config.imagesDir)
    } finally {
      discard(chain.temp, config)
    }
  })

  it("accepts kernel-equivalent dot-segment and repeated-slash addressings of a trusted path", async () => {
    const chain = makeChain()
    plantBaseline(chain.chain)
    const dotSegments = configWith({ imagesDir: `${chain.a}/./b/c/d` })
    const repeatedSlashes = configWith({ imagesDir: `${chain.a}//b/c/d` })
    try {
      expect(await verifyReason(dotSegments)).not.toContain(dotSegments.imagesDir)
      expect(await verifyReason(repeatedSlashes)).not.toContain(repeatedSlashes.imagesDir)
    } finally {
      discard(chain.temp, dotSegments)
      rmSync(repeatedSlashes.runStateDir, { recursive: true, force: true })
    }
  })

  it("rejects a group-writable filesystem root behind a deep operator path", async () => {
    const chain = makeChain()
    plantBaseline(chain.chain)
    overrides.set("/", (stats) => ({ uid: 0, mode: stats.mode | 0o020 }))
    const config = configWith({ imagesDir: chain.d })
    try {
      expect(await verifyReason(config)).toContain(config.imagesDir)
    } finally {
      discard(chain.temp, config)
    }
  })

  it("rejects a symlink addressed with a trailing slash", async () => {
    const chain = makeChain()
    plantBaseline(chain.chain)
    symlinkSync("b", join(chain.a, "link"))
    // Root-owned resolution surface: only the bare symlink name can fail.
    overrides.set(join(chain.a, "link"), (stats) => ({ uid: 0, mode: stats.mode & ~0o222 }))
    const config = configWith({ imagesDir: `${join(chain.a, "link")}/` })
    try {
      expect(await verifyReason(config)).toContain(config.imagesDir)
    } finally {
      discard(chain.temp, config)
    }
  })

  it("rejects a symlink that a dot segment would normalize away", async () => {
    const chain = makeChain()
    plantBaseline(chain.chain)
    symlinkSync("b", join(chain.a, "sym"))
    // Root-owned resolution surface: only the bare symlink name can fail.
    overrides.set(join(chain.a, "sym"), (stats) => ({ uid: 0, mode: stats.mode & ~0o222 }))
    const config = configWith({ imagesDir: `${chain.a}/sym/../b` })
    try {
      expect(await verifyReason(config)).toContain(config.imagesDir)
    } finally {
      discard(chain.temp, config)
    }
  })
})
