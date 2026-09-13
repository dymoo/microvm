import { createServer } from "node:http"
import { existsSync, watch } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { Firecracker, FirecrackerLive } from "../src/firecracker.js"
import { ImageAllowlist, ImageManifest, type HostConfig, type ResolvedImage, type VmLayout } from "../src/host.js"
import { ImageNotAllowed } from "../src/protocol.js"

const roots: Array<string> = []

/**
 * A pending wait for a path to exist. Callers MUST `close()` it (in a
 * `finally`) so the watcher never outlives the wait.
 */
interface FileWait {
  readonly found: Promise<void>
  readonly close: () => void
}

/**
 * Waits for `path` to exist. Uses the real filesystem event plus existence
 * checks on both sides of the watch registration, so there is no polling
 * timer and no window in which an already-created file is missed.
 */
const waitForFile = (path: string): FileWait => {
  const { promise, resolve } = Promise.withResolvers<void>()
  if (existsSync(path)) {
    resolve()
    return { found: promise, close: () => undefined }
  }
  let settled = false
  const watcher = watch(dirname(path), { persistent: false }, () => {
    if (settled || !existsSync(path)) return
    settled = true
    watcher.close()
    resolve()
  })
  // The file may have appeared between the check above and the watcher
  // registration; the watcher itself cannot report an event that predates it.
  if (existsSync(path)) {
    settled = true
    watcher.close()
    resolve()
  }
  return {
    found: promise,
    close: () => {
      if (settled) return
      settled = true
      watcher.close()
    }
  }
}

const fixture = async (respondToApi: boolean, bootTimeoutMs = 500) => {
  const root = await mkdtemp(join(tmpdir(), "fc-"))
  roots.push(root)
  const jailer = join(root, "jailer")
  const firecracker = join(root, "firecracker")
  const kernel = join(root, "vmlinux")
  const imagePath = join(root, "node.raw")
  const chrootBase = join(root, "j")
  const vmId = "mvm-coretest"
  const chrootRoot = join(chrootBase, "firecracker", vmId, "root")
  const cgroupDir = join(root, "cgroup")
  const pidPath = join(root, "jailer.pid")
  await mkdir(chrootRoot, { recursive: true })
  await mkdir(cgroupDir)
  await writeFile(firecracker, "fake")
  await writeFile(kernel, "kernel")
  await writeFile(imagePath, "image")
  if (respondToApi) {
    await mkdir(chrootBase, { recursive: true })
    await writeFile(join(chrootBase, "respond"), "1")
  }
  await writeFile(jailer, `#!/bin/sh
echo $$ > ${JSON.stringify(pidPath)}
while true; do sleep 1; done
`)
  await chmod(jailer, 0o755)

  const layout: VmLayout = {
    vmDir: root,
    chrootBase,
    chrootRoot,
    rootfsPath: join(chrootRoot, "rootfs.raw"),
    kernelPath: join(chrootRoot, "vmlinux"),
    apiSocket: join(chrootRoot, "api.sock"),
    vsockSocket: join(chrootRoot, "v.sock"),
    cgroupDir,
    statePath: join(root, "state.json")
  }
  const config: HostConfig = {
    firecrackerBinary: firecracker,
    flockBinary: undefined,
    jailerBinary: jailer,
    kernelImage: kernel,
    imagesDir: root,
    runStateDir: root,
    jailerUidRange: [process.getuid?.() ?? 0, process.getuid?.() ?? 0],
    jailerGidRange: [process.getgid?.() ?? 0, process.getgid?.() ?? 0],
    jailerParentCgroup: undefined,
    guestCidRange: [10, 10],
    vmmOverheadMib: 1,
    maxPidsPerVm: 16,
    jailerFsizeBytes: 1_048_576,
    jailerNoFileLimit: 64,
    bootTimeoutMs,
    guestReadinessTimeoutMs: 75
  }
  const image: ResolvedImage = {
    manifest: new ImageManifest({
      name: "node",
      file: "node.raw",
      arch: process.arch === "arm64" ? "aarch64" : "x86_64",
      sizeBytes: undefined,
      rootDevice: undefined
    }),
    absolutePath: imagePath
  }
  return { config, image, layout, pidPath, vmId }
}

const bootResult = async (respondToApi: boolean, bootTimeoutMs = 500) => {
  const { config, image, layout, pidPath, vmId } = await fixture(respondToApi, bootTimeoutMs)
  const api = createServer((request, response) => {
    if (!respondToApi) {
      request.resume()
      return
    }
    let bodyBytes = 0
    request.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.byteLength
    })
    request.on("end", async () => {
      const header = request.headers["content-length"]
      const contentLength = typeof header === "string" && /^\d+$/.test(header)
        ? Number(header)
        : undefined
      const hasFixedLengthBody =
        request.headers["transfer-encoding"] === undefined &&
        contentLength !== undefined &&
        Number.isSafeInteger(contentLength) &&
        contentLength > 0 &&
        contentLength === bodyBytes
      if (!hasFixedLengthBody) {
        response.writeHead(400, { "content-length": "17" })
        response.end("Empty PUT request")
        return
      }
      // A real jailer serves the Firecracker API only once its process (and
      // the VMM it launched) is up. The fixture jailer publishes its pid as
      // its first action, so acknowledge only after that publication: the
      // rollback assertions below then describe a process that provably
      // existed, without guessing how fast the fixture starts. The response
      // close race keeps the handler from awaiting forever if the caller
      // gives up on this request first.
      const publication = waitForFile(pidPath)
      const clientGone = Promise.withResolvers<void>()
      const onClose = (): void => clientGone.resolve()
      response.once("close", onClose)
      if (response.destroyed) clientGone.resolve()
      try {
        await Promise.race([publication.found, clientGone.promise])
      } finally {
        publication.close()
        response.off("close", onClose)
      }
      // The caller may have aborted while we waited: never write to a
      // response whose underlying connection is gone.
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(204, { "content-length": "0" })
        response.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    api.once("error", reject)
    api.listen(layout.apiSocket, () => resolve())
  })
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const firecracker = yield* Firecracker
      return yield* Effect.result(firecracker.boot({
        vmId,
        guestCid: 10,
        cpus: 1,
        memMib: 64,
        kernelArgs: "console=ttyS0",
        layout,
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0
      }, image))
    }).pipe(Effect.provide(FirecrackerLive(config))))
    // Deterministic rollback evidence: teardown removes the per-VM cgroup it
    // uses as its proven-complete marker, so a failed boot that left the
    // process tree (or the cgroup) behind cannot pass this helper.
    expect(existsSync(layout.cgroupDir)).toBe(false)
    // When the fixture jailer published its identity, it must be dead. The
    // API acknowledgement above waits for that publication, so this is the
    // normal path rather than a timing guess.
    if (existsSync(pidPath)) {
      const pid = Number(await readFile(pidPath, "utf8"))
      expect(() => process.kill(pid, 0)).toThrow()
    }
    return result
  } finally {
    api.closeAllConnections()
    await new Promise<void>((resolve) => api.close(() => resolve()))
  }
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

describe("Firecracker boot transaction", () => {
  it("returns a typed boot timeout and rolls back the spawned process", async () => {
    const result = await bootResult(false)
    expect(Result.isFailure(result) && result.failure._tag).toBe("FirecrackerError")
  })

  it("rolls back a configured VM whose guest runner never becomes ready", async () => {
    // The fake API acknowledges a request only after the fixture jailer has
    // published its pid, and the first execution of a freshly written script
    // costs a few hundred milliseconds on some hosts. The readiness failure
    // is what this test is about, so the boot budget must not race that
    // publication; the timeout test below still pins the timeout path.
    const result = await bootResult(true, 10_000)
    expect(Result.isFailure(result) ? result.failure : result).toMatchObject({ _tag: "BootFailed" })
  })
})

describe("image allowlist", () => {
  const writeImage = async (dir: string, manifest: unknown) => {
    await writeFile(join(dir, "node.json"), JSON.stringify(manifest))
    await writeFile(join(dir, "node.raw"), "raw-image-bytes")
  }

  const resolveNode = (dir: string) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const allowlist = yield* ImageAllowlist
        return yield* allowlist.resolve("node")
      }).pipe(Effect.provide(ImageAllowlist.layer(dir)))
    )

  it("resolves a builder manifest that omits optional metadata and serves readable image bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mvm-images-"))
    roots.push(dir)
    // Both informational fields omitted: the keys must simply be optional.
    await writeImage(dir, { name: "node", file: "node.raw", arch: "x86_64" })
    const image = await resolveNode(dir)
    expect(await readFile(image.absolutePath, "utf8")).toBe("raw-image-bytes")
  })

  it("rejects a builder manifest whose provided metadata fails validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mvm-images-"))
    roots.push(dir)
    await writeImage(dir, { name: "node", file: "node.raw", arch: "x86_64", sizeBytes: "4 GiB" })
    await expect(resolveNode(dir)).rejects.toBeInstanceOf(ImageNotAllowed)
  })
})
