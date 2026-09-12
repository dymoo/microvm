/**
 * Host-side enforcement: platform prerequisites, the operator image
 * allowlist, per-VM filesystem layout, and resource-scope allocation.
 *
 * Everything here fails closed. A host that cannot prove KVM device access,
 * cgroup v2, the jailer, the kernel, and the allowlist directory will refuse
 * to run VMs rather than degrade.
 */
import { Context, Effect, Layer, Schema } from "effect"
import { randomBytes } from "node:crypto"
import { accessSync, constants as fsConstants, statSync, lstatSync, mkdirSync, type Stats } from "node:fs"
import {
  chmod,
  chown,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises"
import { arch as osArch, tmpdir, userInfo } from "node:os"
import { basename, isAbsolute, join } from "node:path"
import { HostPrereqFailed, ImageName, ImageNotAllowed } from "./protocol.js"

// ---------------------------------------------------------------------------
// Trusted-path probes
// ---------------------------------------------------------------------------

const isReadable = (path: string): boolean => {
  try {
    accessSync(path, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Trusted-input posture per jailer docs: paths the operator supplies must be
 * root-owned, not group- or world-writable, and not symlinks (which could
 * retarget the jail's inputs). The kernel is the only path interpreter: the
 * raw path is probed as given, then each bare upward prefix down to `/`,
 * stripping only redundant separators — never a named component — so any
 * input the kernel cannot resolve (`file/..`, a trailing slash on a file,
 * missing paths) fails closed, and nothing a `..`, dot segment, or trailing
 * slash passes through escapes its own bare probe. Paths of any finite depth
 * are judged by their whole chain; relative paths are rejected outright.
 */
const isTrustedLocation = (path: string): boolean => {
  if (!isAbsolute(path)) return false
  let probe = path
  for (;;) {
    let stats: Stats
    try {
      stats = lstatSync(probe)
    } catch {
      return false
    }
    if (stats.isSymbolicLink() || stats.uid !== 0) return false
    // eslint-disable-next-line no-bitwise
    if ((stats.mode & 0o022) !== 0) return false
    let end = probe.length
    while (end > 1 && probe.charCodeAt(end - 1) === 47 /* "/" */) end--
    if (end === 1) return true
    if (end !== probe.length) {
      // Trailing separators made the probe above follow a final symlink; the
      // bare name has not been probed yet, so probe it before stepping up.
      probe = probe.slice(0, end)
      continue
    }
    let cut = probe.lastIndexOf("/", end - 1)
    while (cut > 0 && probe.charCodeAt(cut - 1) === 47 /* "/" */) cut--
    probe = cut <= 0 ? "/" : probe.slice(0, cut)
  }
}

const runAsRoot = (): boolean => {
  try {
    return userInfo().uid === 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Daemon host configuration subset owned here
// ---------------------------------------------------------------------------

export interface HostConfig {
  readonly firecrackerBinary: string
  readonly jailerBinary: string
  readonly kernelImage: string
  readonly imagesDir: string
  readonly runStateDir: string
  /**
   * Unprivileged uid/gid ranges; one pair is allocated per VM. Distinct uids
   * keep firecracker processes from signalling each other or reading sibling
   * chroots. The operator provisions these users/groups in advance (see
   * docs/operations.md).
   */
  readonly jailerUidRange: readonly [number, number]
  readonly jailerGidRange: readonly [number, number]
  /** Optional parent cgroup (e.g. `microvm.slice`) for the jailer. */
  readonly jailerParentCgroup?: string | undefined
  readonly guestCidRange: readonly [number, number]
  /** VMM memory overhead added on top of guest RAM for memory.max. */
  readonly vmmOverheadMib: number
  /** Per-VM firecracker process thread/pid ceiling (cgroup pids.max). */
  readonly maxPidsPerVm: number
  /** Jailer rlimit fsize for the firecracker process. */
  readonly jailerFsizeBytes: number
  /** Jailer rlimit no-file for the firecracker process. */
  readonly jailerNoFileLimit: number
  /**
   * util-linux `flock` binary backing the kernel-held single-daemon lock.
   * Defaults to /usr/bin/flock when omitted.
   */
  readonly flockBinary?: string | undefined
  /** Wall-clock budget for a full jailed boot. */
  readonly bootTimeoutMs: number
  /** Budget for the guest runner readiness handshake before create returns. */
  readonly guestReadinessTimeoutMs: number
}

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

export interface HostCapabilities {
  /** /dev/kvm exists and opens r/w. Usable nested KVM is only proven by a
   *  real guest boot (Linux acceptance script), not by this probe. */
  readonly kvmDeviceAccess: boolean
  readonly cgroupV2: boolean
  readonly arch: "x86_64" | "aarch64"
}

interface FailedCheck {
  readonly name: string
  readonly detail: string
}

export class HostPrereqs extends Context.Service<HostPrereqs, {
  /**
   * Verifies every prerequisite and returns capabilities. Fails with a single
   * `HostPrereqFailed` aggregating all missing requirements, so operators see
   * the full gap at once.
   */
  readonly verifyAll: () => Effect.Effect<HostCapabilities, HostPrereqFailed>
}>()("microvm/host/HostPrereqs") {
  static readonly layer = (config: HostConfig): Layer.Layer<HostPrereqs> =>
    Layer.effect(HostPrereqs)(Effect.sync(() => {
      const verifyAll = (): Effect.Effect<HostCapabilities, HostPrereqFailed> =>
        Effect.gen(function*() {
          const failures: Array<FailedCheck> = []
          if (!runAsRoot()) {
            failures.push({ name: "privileges", detail: "daemon must run as root (jailer requirement)" })
          }

          const kvm = yield* Effect.result(checkKvmDeviceAccess())
          if (kvm._tag === "Failure") {
            failures.push({ name: "kvm", detail: String(kvm.failure) })
          }
          if (!isReadable("/sys/fs/cgroup/cgroup.controllers")) {
            failures.push({ name: "cgroup", detail: "cgroup v2 not mounted at /sys/fs/cgroup" })
          }
          if (!isExecutable(config.firecrackerBinary)) {
            failures.push({ name: "firecracker", detail: `not executable: ${config.firecrackerBinary}` })
          } else if (!isTrustedLocation(config.firecrackerBinary)) {
            failures.push({ name: "firecracker", detail: `untrusted location (must be root-owned, not group- or world-writable, no symlinks): ${config.firecrackerBinary}` })
          }
          if (!isExecutable(config.jailerBinary)) {
            failures.push({ name: "jailer", detail: `not executable: ${config.jailerBinary}` })
          } else if (!isTrustedLocation(config.jailerBinary)) {
            failures.push({ name: "jailer", detail: `untrusted location (must be root-owned, not group- or world-writable, no symlinks): ${config.jailerBinary}` })
          }
          const flockBinary = config.flockBinary ?? "/usr/bin/flock"
          if (!isExecutable(flockBinary)) {
            failures.push({
              name: "flock",
              detail: `single-daemon lock requires util-linux flock, not executable: ${flockBinary}`
            })
          } else if (!isTrustedLocation(flockBinary)) {
            failures.push({
              name: "flock",
              detail: `untrusted location: ${flockBinary}`
            })
          }
          if (!isReadable(config.kernelImage)) {
            failures.push({ name: "kernel", detail: `not readable: ${config.kernelImage}` })
          } else if (!isTrustedLocation(config.kernelImage)) {
            failures.push({ name: "kernel", detail: `untrusted location: ${config.kernelImage}` })
          }
          if (!isTrustedLocation(config.imagesDir)) {
            failures.push({ name: "images", detail: `untrusted location: ${config.imagesDir}` })
          }

          // runStateDir: create root-only when absent; reject bad posture.
          try {
            mkdirSync(config.runStateDir, { recursive: true, mode: 0o700 })
          } catch (cause) {
            failures.push({ name: "runstate", detail: `cannot create ${config.runStateDir}: ${String(cause)}` })
          }
          if (!isTrustedLocation(config.runStateDir)) {
            failures.push({ name: "runstate", detail: `untrusted location: ${config.runStateDir}` })
          }

          const badRange = (range: readonly [number, number]): boolean =>
            !Number.isInteger(range[0]) || !Number.isInteger(range[1]) ||
            range[0] < 1 || range[1] < range[0]
          if (badRange(config.jailerUidRange)) {
            failures.push({
              name: "jailer-uid-range",
              detail: `must be positive integers min<=max, got ${config.jailerUidRange[0]}..${config.jailerUidRange[1]}`
            })
          }
          if (badRange(config.jailerGidRange)) {
            failures.push({
              name: "jailer-gid-range",
              detail: `must be positive integers min<=max, got ${config.jailerGidRange[0]}..${config.jailerGidRange[1]}`
            })
          }
          if (config.maxPidsPerVm < 8 || !Number.isInteger(config.maxPidsPerVm)) {
            failures.push({ name: "max-pids-per-vm", detail: "must be an integer >= 8" })
          }
          if (config.vmmOverheadMib < 0 || !Number.isInteger(config.vmmOverheadMib)) {
            failures.push({ name: "vmm-overhead-mib", detail: "must be a non-negative integer" })
          }

          if (failures.length > 0) {
            const detail = failures.map((f) => `${f.name}: ${f.detail}`).join("; ")
            return yield* Effect.fail(new HostPrereqFailed({ reason: detail }))
          }
          const detected = osArch()
          if (detected !== "x64" && detected !== "arm64") {
            return yield* Effect.fail(
              new HostPrereqFailed({ reason: `unsupported host architecture: ${detected}` })
            )
          }
          return {
            kvmDeviceAccess: kvm._tag === "Success",
            cgroupV2: true,
            arch: detected === "arm64" ? "aarch64" : "x86_64"
          }
        })

      return HostPrereqs.of({ verifyAll })
    }))
}

/** Opens /dev/kvm read/write to prove device access, then closes it. */
const checkKvmDeviceAccess = (): Effect.Effect<void, string> =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open("/dev/kvm", fsConstants.O_RDWR)
      await handle.close()
    },
    catch: (cause) => `cannot open /dev/kvm for r/w: ${String(cause)}`
  })

// ---------------------------------------------------------------------------
// Image allowlist
// ---------------------------------------------------------------------------

export class ImageManifest extends Schema.Class<ImageManifest>("ImageManifest")({
  name: ImageName,
  /** Raw disk image file, relative to the allowlist directory. */
  file: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]*\.raw$/)),
  arch: Schema.Literals(["x86_64", "aarch64"]),
  /** Informational builder metadata; builders may omit either field. */
  sizeBytes: Schema.optional(Schema.Number),
  /** Guest device the root filesystem appears on (informational). */
  rootDevice: Schema.optional(Schema.String)
}) {}

export interface ResolvedImage {
  readonly manifest: ImageManifest
  /** Absolute path of the raw base image. Never exposed to RPC callers. */
  readonly absolutePath: string
}

const decodeManifest = Schema.decodeUnknownResult(ImageManifest)
const isImageName = Schema.is(ImageName)

export class ImageAllowlist extends Context.Service<ImageAllowlist, {
  readonly resolve: (name: string) => Effect.Effect<ResolvedImage, ImageNotAllowed>
  readonly names: () => Effect.Effect<Array<string>, ImageNotAllowed>
}>()("microvm/host/ImageAllowlist") {
  static readonly layer = (imagesDir: string): Layer.Layer<ImageAllowlist> =>
    Layer.effect(ImageAllowlist)(Effect.sync(() => {
      const resolve = (name: string): Effect.Effect<ResolvedImage, ImageNotAllowed> =>
        Effect.gen(function*() {
          const notAllowed = new ImageNotAllowed({ image: name })
          if (!isImageName(name)) return yield* Effect.fail(notAllowed)

          const raw = yield* Effect.tryPromise({
            try: () => readFile(join(imagesDir, `${name}.json`), "utf8"),
            catch: () => notAllowed
          })
          const parsed: unknown = yield* Effect.try({
            try: () => JSON.parse(raw),
            catch: () => notAllowed
          })
          const decoded = decodeManifest(parsed)
          if (decoded._tag === "Failure") return yield* Effect.fail(notAllowed)
          const manifest = decoded.success
          if (manifest.name !== name) return yield* Effect.fail(notAllowed)

          const absolutePath = join(imagesDir, manifest.file)
          if (!isReadable(absolutePath)) return yield* Effect.fail(notAllowed)
          return { manifest, absolutePath }
        })

      const names = (): Effect.Effect<Array<string>, ImageNotAllowed> =>
        Effect.tryPromise({
          try: () => readdir(imagesDir),
          catch: () => new ImageNotAllowed({ image: "*" })
        }).pipe(Effect.map((entries) =>
          entries
            .filter((entry) => entry.endsWith(".json"))
            .map((entry) => entry.slice(0, -".json".length))
            .sort()
        ))

      return ImageAllowlist.of({ resolve, names })
    }))
}

// ---------------------------------------------------------------------------
// Per-VM filesystem layout (private disks, jailer chroots)
// ---------------------------------------------------------------------------

/** Filesystem layout for one VM; never leaves the daemon process. */
export interface VmLayout {
  /** `<runStateDir>/vms/<vmId>` */
  readonly vmDir: string
  /** Jailer chroot base. */
  readonly chrootBase: string
  /**
   * Host path of the chrooted firecracker root. Per jailer docs the jail
   * lives at `<chroot-base-dir>/<exec_file_name>/<id>/root`.
   */
  readonly chrootRoot: string
  /** Host path of the per-VM private root disk (inside the chroot). */
  readonly rootfsPath: string
  /** Host path of the kernel copy (inside the chroot). */
  readonly kernelPath: string
  /** Host path of the firecracker API socket (inside the chroot). */
  readonly apiSocket: string
  /** Host path of the vsock multiplexer socket (inside the chroot). */
  readonly vsockSocket: string
  /** Host path of the jailer cgroup directory for this VM. */
  readonly cgroupDir: string
  /** Persisted VM state file. */
  readonly statePath: string
}

export const vmLayout = (
  config: Pick<HostConfig, "runStateDir" | "firecrackerBinary" | "kernelImage" | "jailerParentCgroup">,
  vmId: string
): VmLayout => {
  const vmDir = join(config.runStateDir, "vms", vmId)
  const chrootBase = join(vmDir, "jailer")
  const chrootRoot = join(chrootBase, basename(config.firecrackerBinary), vmId, "root")
  const cgroupParent = config.jailerParentCgroup ?? basename(config.firecrackerBinary)
  return {
    vmDir,
    chrootBase,
    chrootRoot,
    rootfsPath: join(chrootRoot, "rootfs.raw"),
    kernelPath: join(chrootRoot, basename(config.kernelImage)),
    apiSocket: join(chrootRoot, "api.sock"),
    vsockSocket: join(chrootRoot, "v.sock"),
    cgroupDir: join("/sys/fs/cgroup", cgroupParent, vmId),
    statePath: join(vmDir, "state.json")
  }
}

export class VmDiskError extends Schema.TaggedError<VmDiskError>()("VmDiskError", {
  vmId: Schema.String,
  reason: Schema.String
}) {}

/**
 * Provisions the jail chroot: per-VM private root disk (best-effort CoW
 * reflink with ordinary-copy fallback) and a kernel copy — per jailer docs
 * both must live inside the jail — then hands ownership to the unprivileged
 * jailer user. The base image and kernel are never opened writable by the
 * guest.
 */
export const provisionChroot = (
  vmId: string,
  layout: VmLayout,
  image: ResolvedImage,
  kernelSourcePath: string,
  uid: number,
  gid: number
): Effect.Effect<void, VmDiskError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(layout.chrootRoot, { recursive: true, mode: 0o700 })
      // A reflink has independent identity; Node falls back to a private copy when unsupported.
      await copyFile(image.absolutePath, layout.rootfsPath, fsConstants.COPYFILE_FICLONE)
      await copyFile(kernelSourcePath, layout.kernelPath)
      await chmod(layout.rootfsPath, 0o600)
      await chmod(layout.kernelPath, 0o444)
      await chown(layout.chrootRoot, uid, gid)
      await chown(layout.rootfsPath, uid, gid)
      await chown(layout.kernelPath, uid, gid)
    },
    catch: (cause) => new VmDiskError({ vmId, reason: `chroot provisioning failed: ${String(cause)}` })
  })

/** Removes a VM directory tree; refuses paths outside the VM root. */
export const destroyVmDir = (runStateDir: string, vmId: string): Effect.Effect<void, VmDiskError> =>
  Effect.gen(function*() {
    const layout = vmLayout({ runStateDir, firecrackerBinary: "firecracker", kernelImage: "vmlinux", jailerParentCgroup: undefined }, vmId)
    const vmRoot = join(runStateDir, "vms") + "/"
    if (!layout.vmDir.startsWith(vmRoot) || vmId.includes("/")) {
      return yield* Effect.fail(new VmDiskError({ vmId, reason: "layout escaped vm root" }))
    }
    yield* Effect.tryPromise({
      try: () => rm(layout.vmDir, { recursive: true, force: true }),
      catch: (cause) => new VmDiskError({ vmId, reason: `rm failed: ${String(cause)}` })
    })
  })

// ---------------------------------------------------------------------------
// VM diagnostic state evidence (never used for adoption)
// ---------------------------------------------------------------------------

/** Operator-readable metadata for crash diagnosis; startup destroys stale VMs. */
export class VmStateFile extends Schema.Class<VmStateFile>("VmStateFile")({
  vmId: Schema.String,
  image: ImageName,
  cpus: Schema.Number,
  memMib: Schema.Number,
  guestCid: Schema.Number,
  createdAtEpochMs: Schema.Number,
  expiresAtEpochMs: Schema.UndefinedOr(Schema.Number),
  poisoned: Schema.Boolean
}) {}


export const saveVmState = (statePath: string, state: VmStateFile) =>
  Effect.tryPromise({
    try: async () => {
      // Write sibling temp file then rename: readers either see the previous
      // complete state or the new one, never a torn write.
      const tmpPath = `${statePath}.tmp-${randomBytes(4).toString("hex")}`
      await writeFile(tmpPath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 })
      await rename(tmpPath, statePath)
    },
    catch: (cause) => new VmDiskError({ vmId: state.vmId, reason: `state save failed: ${String(cause)}` })
  })


// ---------------------------------------------------------------------------
// Resource-scope allocators (guest CIDs, per-VM uids/gids)
// ---------------------------------------------------------------------------

/** Deterministic first-free scan: no false exhaustion, stable release. */
const makeRangeAllocator = (label: string, range: readonly [number, number]) => {
  const [min, max] = range
  const live = new Set<number>()
  return {
    allocate: (): number => {
      for (let value = min; value <= max; value++) {
        if (!live.has(value)) {
          live.add(value)
          return value
        }
      }
      throw new Error(`${label} space exhausted`)
    },
    release: (value: number): void => {
      live.delete(value)
    },
    isAllocated: (value: number): boolean => live.has(value)
  }
}

export class CidAllocator extends Context.Service<CidAllocator, {
  readonly allocate: () => number
  readonly release: (cid: number) => void
  readonly isAllocated: (cid: number) => boolean
}>()("microvm/host/CidAllocator") {
  static readonly layer = (config: HostConfig): Layer.Layer<CidAllocator> =>
    Layer.effect(CidAllocator)(Effect.sync(() => {
      return CidAllocator.of(makeRangeAllocator("guest CID", config.guestCidRange))
    }))
}

export class JailerUidAllocator extends Context.Service<JailerUidAllocator, {
  readonly allocate: () => { readonly uid: number; readonly gid: number }
  readonly release: (uid: number, gid: number) => void
}>()("microvm/host/JailerUidAllocator") {
  static readonly layer = (config: HostConfig): Layer.Layer<JailerUidAllocator> =>
    Layer.effect(JailerUidAllocator)(Effect.sync(() => {
      const uids = makeRangeAllocator("jailer uid", config.jailerUidRange)
      const gids = makeRangeAllocator("jailer gid", config.jailerGidRange)
      return JailerUidAllocator.of({
        allocate: () => {
          const uid = uids.allocate()
          try {
            const gid = gids.allocate()
            return { uid, gid }
          } catch (cause) {
            // Roll the uid back so a gid failure cannot leak it.
            uids.release(uid)
            throw cause
          }
        },
        release: (uid, gid) => {
          uids.release(uid)
          gids.release(gid)
        }
      })
    }))
}

/** Scratch directory for short-lived artifacts (never guest-visible). */
export const stagingDir = () => mkdtemp(join(tmpdir(), "microvm-"))
