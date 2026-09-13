/**
 * Image identity: pin exact raw rootfs bytes before boot, reject mismatch
 * before allocation, hash the private copy, and keep that measured identity
 * on inspect/list even after guest writes or later allowlist edits.
 */
import { createHash } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Layer, Result, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeMicrovmClient } from "../src/client.js"
import { DaemonConfig, daemonLayer } from "../src/daemon.js"
import { Firecracker, FirecrackerLive } from "../src/firecracker.js"
import {
  HostPrereqs,
  ImageAllowlist,
  ImageManifest,
  provisionChroot,
  vmLayout,
  type ResolvedImage
} from "../src/host.js"
import {
  ImageDigest,
  ImageNotAllowed,
  VmInfo
} from "../src/protocol.js"

const sha256Of = (bytes: string | Buffer): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`

const ZERO_DIGEST = `sha256:${"0".repeat(64)}`
const decodeDigest = Schema.decodeUnknownResult(ImageDigest)
const decodeManifest = Schema.decodeUnknownResult(ImageManifest)
const decodeVmInfo = Schema.decodeUnknownResult(VmInfo)

const roots: Array<string> = []
const servers: Array<Server> = []

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
  while (servers.length > 0) {
    const server = servers.pop()!
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

const tempRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const arch = process.arch === "arm64" ? "aarch64" : "x86_64"
const uid = process.getuid?.() ?? 0
const gid = process.getgid?.() ?? 0

const resolved = (absolutePath: string, digest: string, name = "node"): ResolvedImage => ({
  manifest: new ImageManifest({
    name,
    file: `${name}.raw`,
    imageDigest: digest,
    arch,
    sizeBytes: undefined,
    rootDevice: undefined
  }),
  absolutePath,
  imageDigest: digest
})

describe("ImageDigest wire schema", () => {
  it("accepts only sha256 plus 64 lowercase hex digits", () => {
    expect(decodeDigest(sha256Of("pin"))._tag).toBe("Success")
    expect(decodeDigest(ZERO_DIGEST)._tag).toBe("Success")

    for (const value of [
      "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde",
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0",
      "SHA256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "sha512:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ""
    ]) {
      expect(decodeDigest(value)._tag).toBe("Failure")
    }
  })

  it("requires imageDigest on the manifest and VmInfo", () => {
    expect(decodeManifest({ name: "node", file: "node.raw", arch })._tag).toBe("Failure")
    expect(decodeManifest({
      name: "node",
      file: "node.raw",
      arch,
      imageDigest: sha256Of("node")
    })._tag).toBe("Success")

    const vm = {
      vmId: "mvm-abc12345",
      owningHost: "local",
      state: "running" as const,
      image: "node",
      cpus: 1,
      memMib: 512,
      createdAtEpochMs: 1,
      expiresAtEpochMs: undefined
    }
    expect(decodeVmInfo(vm)._tag).toBe("Failure")
    expect(decodeVmInfo({ ...vm, imageDigest: ZERO_DIGEST })._tag).toBe("Success")
  })
})

describe("allowlist pins request to manifest before allocation", () => {
  const resolve = (dir: string, digest: string) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const allowlist = yield* ImageAllowlist
        return yield* allowlist.resolve("node", digest)
      }).pipe(Effect.provide(ImageAllowlist.layer(dir)))
    )

  it("keeps decoded manifest digest when request and manifest match", async () => {
    const dir = await tempRoot("mvm-image-allow-")
    const bytes = "allowlisted-rootfs"
    const digest = sha256Of(bytes)
    await writeFile(join(dir, "node.raw"), bytes)
    await writeFile(join(dir, "node.json"), JSON.stringify({
      name: "node",
      file: "node.raw",
      arch,
      imageDigest: digest
    }))
    const image = await resolve(dir, digest)
    expect(image.imageDigest).toBe(digest)
    expect(image.manifest.imageDigest).toBe(digest)
    expect(await readFile(image.absolutePath, "utf8")).toBe(bytes)
  })

  it("rejects a digest that does not match the manifest", async () => {
    const dir = await tempRoot("mvm-image-mismatch-")
    const bytes = "allowlisted-rootfs"
    await writeFile(join(dir, "node.raw"), bytes)
    await writeFile(join(dir, "node.json"), JSON.stringify({
      name: "node",
      file: "node.raw",
      arch,
      imageDigest: sha256Of(bytes)
    }))
    await expect(resolve(dir, ZERO_DIGEST)).rejects.toBeInstanceOf(ImageNotAllowed)
  })
})

describe("private copy measurement", () => {
  const layoutFor = (root: string, vmId: string) =>
    vmLayout({
      runStateDir: root,
      firecrackerBinary: "firecracker",
      kernelImage: "vmlinux",
      jailerParentCgroup: undefined
    }, vmId)

  it("returns the measured copy digest and ignores later guest writes", async () => {
    const root = await tempRoot("mvm-image-copy-")
    const bytes = "private-rootfs-bytes"
    const digest = sha256Of(bytes)
    const imagePath = join(root, "node.raw")
    const kernelPath = join(root, "vmlinux")
    await writeFile(imagePath, bytes)
    await writeFile(kernelPath, "kernel")
    const vmId = "mvm-copyok01"
    const layout = layoutFor(root, vmId)

    const provisioned = await Effect.runPromise(
      provisionChroot(vmId, layout, resolved(imagePath, digest), kernelPath, uid, gid)
    )
    expect(provisioned.imageDigest).toBe(digest)
    expect(await readFile(layout.rootfsPath, "utf8")).toBe(bytes)

    await writeFile(layout.rootfsPath, `${bytes}-guest-write`)
    expect(sha256Of(await readFile(layout.rootfsPath))).not.toBe(digest)
    expect(provisioned.imageDigest).toBe(digest)
  })

  it("rejects when the copied bytes do not match the pinned digest", async () => {
    const root = await tempRoot("mvm-image-wrong-")
    const imagePath = join(root, "node.raw")
    const kernelPath = join(root, "vmlinux")
    await writeFile(imagePath, "actual-bytes")
    await writeFile(kernelPath, "kernel")
    const vmId = "mvm-wrongcpy1"
    const layout = layoutFor(root, vmId)

    const result = await Effect.runPromise(Effect.result(
      provisionChroot(vmId, layout, resolved(imagePath, ZERO_DIGEST), kernelPath, uid, gid)
    ))
    expect(Result.isFailure(result) && result.failure._tag).toBe("VmDiskError")
    expect(existsSync(layout.rootfsPath)).toBe(true)
  })

  it("rejects a TOCTOU swap of source bytes after resolve", async () => {
    const root = await tempRoot("mvm-image-toctou-")
    const original = "original-rootfs"
    const swapped = "swapped-rootfs"
    const digest = sha256Of(original)
    const imagePath = join(root, "node.raw")
    const kernelPath = join(root, "vmlinux")
    await writeFile(imagePath, original)
    await writeFile(join(root, "node.json"), JSON.stringify({
      name: "node",
      file: "node.raw",
      arch,
      imageDigest: digest
    }))
    await writeFile(kernelPath, "kernel")

    const image = await Effect.runPromise(
      Effect.gen(function*() {
        const allowlist = yield* ImageAllowlist
        return yield* allowlist.resolve("node", digest)
      }).pipe(Effect.provide(ImageAllowlist.layer(root)))
    )
    await writeFile(imagePath, swapped)

    const vmId = "mvm-toctou001"
    const layout = layoutFor(root, vmId)
    const result = await Effect.runPromise(Effect.result(
      provisionChroot(vmId, layout, image, kernelPath, uid, gid)
    ))
    expect(Result.isFailure(result) && result.failure._tag).toBe("VmDiskError")
    expect(await readFile(layout.rootfsPath, "utf8")).toBe(swapped)
  })

  it("settles copy I/O before an interrupted provision returns", async () => {
    const root = await tempRoot("mvm-image-intr-")
    const bytes = Buffer.alloc(1_048_576, 7)
    const digest = sha256Of(bytes)
    const imagePath = join(root, "node.raw")
    const kernelPath = join(root, "vmlinux")
    await writeFile(imagePath, bytes)
    await writeFile(kernelPath, "kernel")
    const vmId = "mvm-intrcopy1"
    const layout = layoutFor(root, vmId)

    await Effect.runPromise(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(
        provisionChroot(vmId, layout, resolved(imagePath, digest), kernelPath, uid, gid),
        { startImmediately: true }
      )
      while (!existsSync(layout.rootfsPath) && fiber.pollUnsafe() === undefined) {
        yield* Effect.sleep(1)
      }
      yield* Fiber.interrupt(fiber)
      expect(existsSync(layout.rootfsPath)).toBe(true)
      expect(statSync(layout.rootfsPath).size).toBe(bytes.length)
    }))
  })
})

describe("jailer does not start on copy mismatch", () => {
  it("fails boot before the jailer process is spawned", async () => {
    const root = await tempRoot("mvm-image-jail-")
    const imagePath = join(root, "node.raw")
    const kernel = join(root, "vmlinux")
    const jailer = join(root, "jailer")
    const firecracker = join(root, "firecracker")
    const spawned = join(root, "jailer-spawned")
    await writeFile(imagePath, "image-bytes")
    await writeFile(kernel, "kernel")
    await writeFile(firecracker, "fake")
    await writeFile(jailer, `#!/bin/sh
echo spawned > ${JSON.stringify(spawned)}
while true; do sleep 1; done
`)
    await chmod(jailer, 0o755)

    const vmId = "mvm-nospawn01"
    const layout = vmLayout({
      runStateDir: root,
      firecrackerBinary: firecracker,
      kernelImage: kernel,
      jailerParentCgroup: undefined
    }, vmId)
    const config = {
      firecrackerBinary: firecracker,
      flockBinary: undefined,
      jailerBinary: jailer,
      kernelImage: kernel,
      imagesDir: root,
      runStateDir: root,
      jailerUidRange: [uid, uid] as const,
      jailerGidRange: [gid, gid] as const,
      jailerParentCgroup: undefined,
      guestCidRange: [10, 10] as const,
      vmmOverheadMib: 1,
      maxPidsPerVm: 16,
      jailerFsizeBytes: 1_048_576,
      jailerNoFileLimit: 64,
      bootTimeoutMs: 500,
      guestReadinessTimeoutMs: 75
    }

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fc = yield* Firecracker
        return yield* Effect.result(fc.boot({
          vmId,
          guestCid: 10,
          cpus: 1,
          memMib: 64,
          kernelArgs: "console=ttyS0",
          layout,
          uid,
          gid
        }, resolved(imagePath, ZERO_DIGEST)))
      }).pipe(Effect.provide(FirecrackerLive(config)))
    )

    expect(Result.isFailure(result)).toBe(true)
    expect(existsSync(spawned)).toBe(false)
  })
})

describe("daemon stores measured identity", () => {
  const adminToken = "admin-token-for-image-identity"
  const requestBytes = "pinned-rootfs"
  const requestDigest = sha256Of(requestBytes)
  const measuredDigest = sha256Of("measured-private-copy")

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
      jailerUidRange: [23_000, 23_099],
      jailerGidRange: [23_000, 23_099],
      jailerParentCgroup: undefined,
      guestCidRange: [8_000, 8_099],
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

  const writePinnedImage = async (root: string) => {
    await mkdir(join(root, "images"), { recursive: true })
    await mkdir(join(root, "run"), { recursive: true })
    await writeFile(join(root, "vmlinux"), "test")
    await writeFile(join(root, "images", "node.raw"), requestBytes)
    await writeFile(join(root, "images", "node.json"), JSON.stringify({
      name: "node",
      file: "node.raw",
      arch,
      imageDigest: requestDigest
    }))
  }

  const prereqs = Layer.succeed(HostPrereqs, HostPrereqs.of({
    verifyAll: () => Effect.succeed({
      kvmDeviceAccess: true,
      cgroupV2: true,
      arch
    })
  }))

  const waitForListener = (server: Server) =>
    Effect.gen(function*() {
      while (!server.listening) yield* Effect.sleep(5)
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("test listener has no TCP port")
      return address.port
    })

  const startHarness = (root: string, maxVms = 2) =>
    Effect.gen(function*() {
      let boots = 0
      const server = createServer()
      servers.push(server)
      const firecracker = Layer.succeed(Firecracker, Firecracker.of({
        boot: (spec) => Effect.promise(async () => {
          boots += 1
          await mkdir(spec.layout.vmDir, { recursive: true })
          return {
            pid: 51_000 + boots,
            stop: () => Effect.void,
            exited: Effect.never,
            imageDigest: measuredDigest
          }
        })
      }))
      yield* daemonLayer(configFor(root, maxVms), {
        firecracker,
        prereqs,
        server,
        unsafeSkipKernelLockForTests: true
      }).pipe(
        Layer.launch,
        Effect.forkScoped
      )
      const port = yield* waitForListener(server)
      return { url: `http://127.0.0.1:${port}`, bootCount: () => boots }
    })

  const createPayload = {
    image: "node",
    imageDigest: requestDigest,
    cpus: undefined,
    memMib: undefined,
    ttlSeconds: undefined
  } as const

  it("does not boot or consume capacity when the request digest mismatches", async () => {
    const root = await tempRoot("mvm-image-daemon-miss-")
    await writePinnedImage(root)
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const harness = yield* startHarness(root, 1)
      const admin = yield* makeMicrovmClient({ url: harness.url, token: adminToken })
      const mismatched = yield* Effect.result(admin.create({
        ...createPayload,
        imageDigest: ZERO_DIGEST
      }))
      expect(Result.isFailure(mismatched) && mismatched.failure._tag).toBe("ImageNotAllowed")
      expect(harness.bootCount()).toBe(0)

      const created = yield* admin.create(createPayload)
      expect(created.vm.imageDigest).toBe(measuredDigest)
      expect(harness.bootCount()).toBe(1)
    })))
  })

  it("inspects and lists the verified pre-boot identity after image-name and disk changes", async () => {
    const root = await tempRoot("mvm-image-daemon-id-")
    await writePinnedImage(root)
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const harness = yield* startHarness(root)
      const admin = yield* makeMicrovmClient({ url: harness.url, token: adminToken })
      const created = yield* admin.create(createPayload)
      expect(created.vm.image).toBe("node")
      expect(created.vm.imageDigest).toBe(measuredDigest)
      expect(created.vm.imageDigest).not.toBe(requestDigest)

      yield* Effect.promise(() => writeFile(join(root, "images", "node.raw"), "guest-or-host-mutation"))
      yield* Effect.promise(() => writeFile(join(root, "images", "node.json"), JSON.stringify({
        name: "node",
        file: "node.raw",
        arch,
        imageDigest: sha256Of("renamed-claim")
      })))

      const inspected = yield* admin.inspect({ vmId: created.vm.vmId })
      expect(inspected.image).toBe("node")
      expect(inspected.imageDigest).toBe(measuredDigest)

      const listed = yield* admin.list({})
      expect(listed.vms.map((vm) => vm.imageDigest)).toEqual([measuredDigest])

      const state = JSON.parse(
        yield* Effect.promise(() => readFile(join(root, "run", "vms", created.vm.vmId, "state.json"), "utf8"))
      ) as { imageDigest?: string; image?: string }
      expect(state.image).toBe("node")
      expect(state.imageDigest).toBe(measuredDigest)
    })))
  })
})