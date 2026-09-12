import { createServer } from "node:http"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { Firecracker, FirecrackerLive } from "../src/firecracker.js"
import { ImageManifest, type HostConfig, type ResolvedImage, type VmLayout } from "../src/host.js"

const roots: Array<string> = []

const fixture = async (respondToApi: boolean) => {
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
  await writeFile(jailer, `#!/usr/bin/python3
import os
import time
with open(${JSON.stringify(pidPath)}, "w", encoding="utf-8") as pid_file:
    pid_file.write(str(os.getpid()))
while True:
    time.sleep(1)
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
    bootTimeoutMs: 500,
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

const bootResult = async (respondToApi: boolean) => {
  let apiRequests = 0
  const { config, image, layout, pidPath, vmId } = await fixture(respondToApi)
  const api = createServer((request, response) => {
    apiRequests++
    request.resume()
    if (respondToApi) {
      response.writeHead(204, { "content-length": "0" })
      response.end()
    }
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
    const pid = Number(await readFile(pidPath, "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
    return { result, apiRequests }
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
    const { result } = await bootResult(false)
    expect(Result.isFailure(result) && result.failure._tag).toBe("FirecrackerError")
    if (Result.isFailure(result)) expect(result.failure.reason).toContain("boot exceeded timeout")
  })

  it("rolls back a configured VM whose guest runner never becomes ready", async () => {
    const { result, apiRequests } = await bootResult(true)
    expect(apiRequests).toBe(5)
    expect(Result.isFailure(result) ? result.failure : result).toMatchObject({ _tag: "BootFailed" })
  })
})
