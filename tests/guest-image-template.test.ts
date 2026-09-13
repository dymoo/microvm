import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

const repositoryRoot = resolve(import.meta.dirname, "..")
const templateDirectory = join(repositoryRoot, "guest/image/next-template")
const initializer = join(repositoryRoot, "guest/image/microvm-next-init")
const buildScript = readFileSync(join(repositoryRoot, "scripts/build-guest-image.sh"), "utf8")
const packageManifest = JSON.parse(
  readFileSync(join(templateDirectory, "package.json"), "utf8")
) as {
  packageManager: string
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}
const lockfile = readFileSync(join(templateDirectory, "pnpm-lock.yaml"), "utf8")
const npmrc = readFileSync(join(templateDirectory, ".npmrc"), "utf8")
const workspacePolicy = readFileSync(
  join(templateDirectory, "pnpm-workspace.yaml"),
  "utf8"
)
const temporaryDirectories: string[] = []

const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "microvm-next-template-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("Next.js guest image inputs", () => {
  it("pins the public Free Vibecode dependency family without the unpublished SDK", () => {
    expect(packageManifest.packageManager).toBe("pnpm@11.13.1")
    expect(packageManifest.dependencies).toEqual({
      effect: "4.0.0-beta.107",
      next: "16.3.3",
      react: "19.2.8",
      "react-dom": "19.2.8"
    })
    expect(packageManifest.devDependencies).toEqual({
      "@types/node": "26.4.0",
      "@types/react": "19.2.18",
      "@types/react-dom": "19.2.5",
      typescript: "6.0.3"
    })
    expect(JSON.stringify(packageManifest)).not.toContain("@free-vibecode/site-sdk")
    expect(lockfile).not.toContain("@free-vibecode/site-sdk")
  })

  it("locks exact imports and both supported Linux native Next.js packages", () => {
    for (const pin of [
      "specifier: 4.0.0-beta.107",
      "specifier: 16.3.3",
      "specifier: 19.2.8",
      "specifier: 26.4.0",
      "specifier: 19.2.18",
      "specifier: 19.2.5",
      "specifier: 6.0.3",
      "'@next/swc-linux-x64-gnu@16.3.3'",
      "'@next/swc-linux-arm64-gnu@16.3.3'"
    ]) {
      expect(lockfile).toContain(pin)
    }
    const packageSection = lockfile
      .split("\npackages:\n")[1]!
      .split("\nsnapshots:\n")[0]!
    const packageCount = (packageSection.match(/^  \S.*:$/gm) ?? []).length
    const integrityCount = (
      packageSection.match(/^    resolution: \{integrity: sha512-[A-Za-z0-9+/=]+\}$/gm) ?? []
    ).length
    expect(packageCount).toBeGreaterThan(0)
    expect(integrityCount).toBe(packageCount)
  })

  it("pins and verifies the official pnpm tarball integrity", () => {
    const integrity = buildScript.match(/dist\.integrity sha512-([^\n]+)/)?.[1]
    const digest = buildScript.match(/PNPM_SHA512=([0-9a-f]{128})/)?.[1]
    expect(integrity).toBe(
      "svx2g7imUlQU59E+G6KMqt3elr9m7FQL+ut+cCuB8+C+TR8pXt9/n+A5Z0Co3ORQnFgt33mJH0VD/qMtN2RfJQ=="
    )
    expect(Buffer.from(integrity!, "base64").toString("hex")).toBe(digest)
    expect(buildScript).toContain(
      'https://registry.npmjs.org/pnpm/-/pnpm-$PNPM_VERSION.tgz'
    )
    expect(buildScript).toContain('sha512sum --check --status')
  })

  it("installs Git only through the pinned Debian snapshot", () => {
    expect(buildScript).toContain("--include=ca-certificates,git,python3")
    expect(buildScript).toContain(
      '"$DEBIAN_SUITE" "$ROOTFS" "$MAIN_SNAPSHOT" "$SECURITY_SNAPSHOT"'
    )
    expect(buildScript).toContain('chroot "$ROOTFS" /usr/bin/git --version')
  })

  it("bakes an offline install while keeping the per-VM store writable by UID 1000", () => {
    expect(npmrc).toContain("offline=true")
    expect(npmrc).toContain("store-dir=/var/lib/microvm/pnpm-store")
    expect(workspacePolicy).toBe("allowBuilds:\n  msgpackr-extract: false\n")
    expect(buildScript).toContain(
      "fetch \\\n    --frozen-lockfile --config.offline=false"
    )
    expect(buildScript).toContain(
      "install \\\n    --offline --frozen-lockfile --config.package-import-method=copy"
    )
    expect(buildScript).toContain('chown -R 0:0 "$ROOTFS/opt/microvm/next-template"')
    expect(buildScript).toContain(
      'chown -R 1000:1000 "$ROOTFS/var/lib/microvm/pnpm-store"'
    )
    expect(buildScript).toMatch(
      /fetch[\s\S]*--config\.offline=false[\s\S]*rm -f "\$ROOTFS\/etc\/resolv\.conf"[\s\S]*: >"\$ROOTFS\/etc\/resolv\.conf"[\s\S]*install[\s\S]*--offline/
    )
  })

  it("binds development and production servers only to guest loopback port 3000", () => {
    expect(packageManifest.scripts.dev).toBe(
      "next dev --hostname 127.0.0.1 --port 3000"
    )
    expect(packageManifest.scripts.start).toBe(
      "next start --hostname 127.0.0.1 --port 3000"
    )
  })
})

describe("microvm-next-init", () => {
  it("materializes a ready offline project into an empty target", () => {
    const root = temporaryDirectory()
    const source = join(root, "source")
    const target = join(root, "project")
    mkdirSync(join(source, "app"), { recursive: true })
    mkdirSync(join(source, "node_modules", ".pnpm"), { recursive: true })
    writeFileSync(join(source, "app/page.tsx"), "export default 1\n")
    writeFileSync(join(source, "node_modules/.pnpm/ready"), "prewarmed\n")
    symlinkSync(".pnpm/ready", join(source, "node_modules/ready-link"))
    writeFileSync(join(source, ".npmrc"), npmrc)
    mkdirSync(target)

    const result = spawnSync(process.execPath, [initializer, target], {
      encoding: "utf8",
      env: { ...process.env, MICROVM_NEXT_TEMPLATE_DIR: source }
    })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(target, "app/page.tsx"), "utf8")).toBe(
      "export default 1\n"
    )
    expect(readFileSync(join(target, "node_modules/.pnpm/ready"), "utf8")).toBe(
      "prewarmed\n"
    )
    expect(readlinkSync(join(target, "node_modules/ready-link"))).toBe(".pnpm/ready")
    expect(readFileSync(join(target, "node_modules/ready-link"), "utf8")).toBe("prewarmed\n")
    expect(readFileSync(join(target, ".npmrc"), "utf8")).toContain("offline=true")
  })

  it("supports a coherent ephemeral checkpoint without a remote", () => {
    const root = temporaryDirectory()
    const target = join(root, "project")
    const initialized = spawnSync(process.execPath, [initializer, target], {
      encoding: "utf8",
      env: { ...process.env, MICROVM_NEXT_TEMPLATE_DIR: templateDirectory }
    })
    expect(initialized.status, initialized.stderr).toBe(0)

    const git = (...arguments_: string[]) =>
      spawnSync("git", arguments_, {
        cwd: target,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z"
        }
      })
    for (const arguments_ of [
      ["init", "--quiet", "--initial-branch=main"],
      ["config", "--local", "user.name", "MicroVM Checkpoint"],
      ["config", "--local", "user.email", "checkpoint@microvm.invalid"],
      ["add", "--all"],
      ["commit", "--quiet", "--no-gpg-sign", "--no-verify", "-m", "Checkpoint Next.js workspace"]
    ]) {
      const result = git(...arguments_)
      expect(result.status, result.stderr).toBe(0)
    }

    mkdirSync(join(target, ".next/cache"), { recursive: true })
    mkdirSync(join(target, "node_modules/.pnpm"), { recursive: true })
    writeFileSync(join(target, ".next/cache/ready"), "generated\n")
    writeFileSync(join(target, "node_modules/.pnpm/state"), "generated\n")

    const status = git("status", "--porcelain=v1", "--untracked-files=all")
    expect(status.status, status.stderr).toBe(0)
    expect(status.stdout).toBe("")
    expect(git("diff", "--quiet").status).toBe(0)
    expect(git("diff", "--cached", "--quiet").status).toBe(0)

    const head = git("rev-parse", "--verify", "HEAD^{commit}")
    expect(head.status, head.stderr).toBe(0)
    expect(head.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
    const remotes = git("remote")
    expect(remotes.status, remotes.stderr).toBe(0)
    expect(remotes.stdout).toBe("")
    expect(git("push").status).not.toBe(0)
  })

  it("refuses a non-empty target without overwriting existing source", () => {
    const root = temporaryDirectory()
    const source = join(root, "source")
    const target = join(root, "project")
    mkdirSync(join(source, "app"), { recursive: true })
    mkdirSync(join(target, "app"), { recursive: true })
    writeFileSync(join(source, "app/page.tsx"), "new source\n")
    writeFileSync(join(target, "app/page.tsx"), "existing source\n")

    const result = spawnSync(process.execPath, [initializer, target], {
      encoding: "utf8",
      env: { ...process.env, MICROVM_NEXT_TEMPLATE_DIR: source }
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("refusing to overwrite")
    expect(readFileSync(join(target, "app/page.tsx"), "utf8")).toBe(
      "existing source\n"
    )
  })

  it("rejects a symbolic-link target", () => {
    const root = temporaryDirectory()
    const source = join(root, "source")
    const actualTarget = join(root, "actual")
    const target = join(root, "project")
    mkdirSync(source)
    mkdirSync(actualTarget)
    symlinkSync(actualTarget, target, "dir")

    const result = spawnSync(process.execPath, [initializer, target], {
      encoding: "utf8",
      env: { ...process.env, MICROVM_NEXT_TEMPLATE_DIR: source }
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("must not be a symbolic link")
  })
})
