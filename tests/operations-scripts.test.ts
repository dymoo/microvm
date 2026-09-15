import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../", import.meta.url))
const builder = join(root, "scripts/build-release-artifact.sh")
const deployer = join(root, "scripts/deploy-host.sh")
const packageDocument: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
if (packageDocument === null || typeof packageDocument !== "object" ||
  !("version" in packageDocument) || typeof packageDocument.version !== "string") {
  throw new Error("package.json has no string version")
}
const version = packageDocument.version
const sourceSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const firecrackerSha = "99ad0f5cd0514a88aad0e9ae8cfdb3cc3b4ab9d190e1194602406c786b5de7a5"
const jailerSha = "65ef226e96f0ceda55ba643f445801ef2cc0ea667ef67cad8ac4f406c9c8434f"
const kernelSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const imageDigest = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
const acceptanceDigest = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
const roots: Array<string> = []

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "microvm-operations-"))
  roots.push(directory)
  return directory
}

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex")

const run = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: env === undefined ? process.env : env,
    timeout: 30_000
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  }
}

const installFakeToolchain = (directory: string): NodeJS.ProcessEnv => {
  const bin = join(directory, "bin")
  mkdirSync(bin)
  const node = join(bin, "node")
  writeFileSync(node, "#!/usr/bin/env bash\n[[ ${1:-} == --version ]] && { echo v24.20.0; exit 0; }\nexit 2\n")
  chmodSync(node, 0o755)
  const pnpm = join(bin, "pnpm")
  writeFileSync(pnpm, `#!/usr/bin/env bash
set -euo pipefail
if [[ \${1:-} == --version ]]; then
  echo 10.34.5
  exit 0
fi
target=\${!#}
mkdir -p "$target/dist/bin" "$target/node_modules/effect"
cp "$FAKE_REPO/package.json" "$target/package.json"
printf '%s\\n' '{"name":"effect","version":"4.0.0-beta.107","license":"MIT"}' >"$target/node_modules/effect/package.json"
printf '%s\\n' '#!/usr/bin/env node' >"$target/dist/bin/daemon.js"
printf '%s\\n' '#!/usr/bin/env node' >"$target/dist/bin/client.js"
chmod 0755 "$target/dist/bin/daemon.js" "$target/dist/bin/client.js"
ln -s effect "$target/node_modules/effect-alias"
`)
  chmodSync(pnpm, 0o755)
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FAKE_REPO: root
  }
}

const buildArtifact = (output: string, env: NodeJS.ProcessEnv): { host: string; sdk: string } => {
  mkdirSync(output)
  const result = run("bash", [
    builder,
    "--version", version,
    "--source-sha", sourceSha,
    "--source-date-epoch", "1700000000",
    "--acceptance-run-url", "https://github.com/dymoo/microvm/actions/runs/123",
    "--acceptance-evidence-digest", acceptanceDigest,
    "--output-dir", output
  ], env)
  expect(result.status, result.stderr).toBe(0)
  return {
    host: join(output, `microvm-host-linux-x86_64-${version}-${sourceSha}.tar.gz`),
    sdk: join(output, `microvm-${version}-${sourceSha}.tgz`)
  }
}

const validationArguments = (artifact: string, digest: string = sha256(artifact)): Array<string> => [
  deployer,
  "--artifact", artifact,
  "--checksum", `${artifact}.sha256`,
  "--inventory", `${artifact}.inventory.txt`,
  "--expected-artifact-sha256", digest,
  "--expected-version", version,
  "--expected-source-sha", sourceSha,
  "--expected-firecracker-sha256", firecrackerSha,
  "--expected-jailer-sha256", jailerSha,
  "--expected-kernel-sha256", kernelSha,
  "--image", "node",
  "--image-digest", imageDigest,
  "--url", "https://microvm-canary.invalid:9443",
  "--install-root", join(artifact, "..", "planned-install"),
  "--validate-only"
]

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe("non-production release operations", () => {
  it("builds byte-identical normalized artifacts with explicit runtime and provenance contracts", () => {
    const directory = temporaryDirectory()
    const env = installFakeToolchain(directory)
    const first = buildArtifact(join(directory, "first"), env)
    const second = buildArtifact(join(directory, "second"), env)

    expect(readFileSync(first.host).equals(readFileSync(second.host))).toBe(true)
    expect(readFileSync(`${first.host}.inventory.txt`, "utf8")).toBe(
      readFileSync(`${second.host}.inventory.txt`, "utf8")
    )
    expect(readFileSync(`${first.host}.provenance.json`, "utf8")).toBe(
      readFileSync(`${second.host}.provenance.json`, "utf8")
    )
    expect(readFileSync(`${first.host}.sha256`, "utf8")).toBe(`${sha256(first.host)}  ${basename(first.host)}\n`)
    expect(readFileSync(first.sdk).equals(readFileSync(second.sdk))).toBe(true)
    expect(readFileSync(`${first.sdk}.inventory.txt`, "utf8")).toBe(
      readFileSync(`${second.sdk}.inventory.txt`, "utf8")
    )
    expect(readFileSync(`${first.sdk}.provenance.json`, "utf8")).toBe(
      readFileSync(`${second.sdk}.provenance.json`, "utf8")
    )
    expect(readFileSync(`${first.sdk}.sha256`, "utf8")).toBe(`${sha256(first.sdk)}  ${basename(first.sdk)}\n`)

    expect(readdirSync(join(directory, "first")).sort()).toEqual([
      basename(first.sdk),
      `${basename(first.sdk)}.inventory.txt`,
      `${basename(first.sdk)}.provenance.json`,
      `${basename(first.sdk)}.sha256`,
      basename(first.host),
      `${basename(first.host)}.inventory.txt`,
      `${basename(first.host)}.provenance.json`,
      `${basename(first.host)}.sha256`,
      `${basename(first.host)}.spdx.json`
    ])

    const listing = execFileSync("tar", ["-tzf", first.host], { encoding: "utf8" })
    expect(listing).toContain("package/release-manifest.json")
    expect(listing).toContain("package/release.spdx.json")
    expect(listing).toContain("package/deploy/systemd/microvm-daemon.service")
    expect(listing).not.toContain("firecracker")
    expect(listing).not.toContain("node.raw")

    const sdkListing = execFileSync("tar", ["-tzf", first.sdk], { encoding: "utf8" })
    expect(sdkListing).toContain("package/package.json")
    expect(sdkListing).toContain("package/README.md")
    expect(sdkListing).toContain("package/dist/index.js")
    expect(sdkListing).toContain("package/dist/client.js")
    expect(sdkListing).toContain("package/dist/client-workerd.js")
    expect(sdkListing).toContain("package/dist/bin/daemon.js")
    expect(sdkListing).toContain("package/dist/bin/client.js")
    expect(sdkListing).toContain("package/dist/protocol.js")
    expect(sdkListing).toContain("package/dist/ai.js")
    expect(sdkListing).toContain("package/docs/")
    expect(sdkListing).not.toMatch(/node_modules/)
    expect(sdkListing).not.toContain("package/dist/cluster.js")
    const provenance = JSON.parse(readFileSync(`${first.sdk}.provenance.json`, "utf8")) as {
      artifact: string
      dependenciesBundled: boolean
      source: { commit: string }
      subject: { name: string; sha256: string }
    }
    expect(provenance.artifact).toBe("microvm-sdk")
    expect(provenance.dependenciesBundled).toBe(false)
    expect(provenance.source.commit).toBe(sourceSha)
    expect(provenance.subject).toEqual({
      name: basename(first.sdk),
      sha256: sha256(first.sdk),
      bytes: readFileSync(first.sdk).length
    })
  })

  it("validates a complete artifact and reports a non-mutating versioned deployment plan off-host", () => {
    const directory = temporaryDirectory()
    const artifact = buildArtifact(join(directory, "release"), installFakeToolchain(directory)).host
    const installRoot = join(directory, "release", "planned-install")
    const result = run("bash", validationArguments(artifact))

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      validated: true,
      mutated: false,
      releaseId: `${version}-${sourceSha}`,
      releaseDirectory: `${installRoot}/releases/${version}-${sourceSha}`,
      currentLink: `${installRoot}/current`,
      service: "microvm-daemon.service"
    })
    expect(existsSync(installRoot)).toBe(false)
  })

  it("rejects a checksum-valid archive whose member escapes package root", () => {
    const directory = temporaryDirectory()
    const artifact = join(directory, `microvm-host-linux-x86_64-${version}-${sourceSha}.tar.gz`)
    const python = `
import gzip, io, tarfile
with open(${JSON.stringify(artifact)}, "wb") as raw:
    with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w") as archive:
            item=tarfile.TarInfo("../escape")
            item.uid=item.gid=0
            item.mode=0o444
            item.size=1
            archive.addfile(item, io.BytesIO(b"x"))
`
    execFileSync("python3", ["-c", python])
    writeFileSync(`${artifact}.sha256`, `${sha256(artifact)}  ${basename(artifact)}\n`)
    writeFileSync(`${artifact}.inventory.txt`, "# deliberately unreachable inventory\n")

    const result = run("bash", validationArguments(artifact))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("unsafe archive path")
  })

  it("rejects an artifact that does not match the independently supplied digest", () => {
    const directory = temporaryDirectory()
    const artifact = buildArtifact(join(directory, "release"), installFakeToolchain(directory)).host
    const result = run("bash", validationArguments(artifact, "e".repeat(64)))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--expected-artifact-sha256")
  })

  it("ships only built supported package targets and refuses deleted legacy subpaths", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version: string
      exports: Record<string, Record<string, string>>
      bin: Record<string, string>
    }
    expect(manifest.version).toBe(version)
    expect(manifest.exports["./cluster"]).toBeUndefined()
    expect(manifest.exports["./http-proxy"]).toBeUndefined()
    expect(manifest.exports["./sandbox-binding"]).toBeUndefined()
    const targets = [
      ...Object.values(manifest.exports).flatMap((entry) => Object.values(entry)),
      ...Object.values(manifest.bin)
    ]
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) {
      expect(existsSync(join(root, target)), target).toBe(true)
    }
    // Deliberate dynamic import inside a node child: this test exercises the
    // module-loading boundary itself, and vitest's resolver must not intercept
    // the raw Node ERR_PACKAGE_PATH_NOT_EXPORTED behavior.
    execFileSync("node", ["--input-type=module", "-e", `
try {
  await import("microvm/cluster")
} catch (error) {
  if (error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") process.exit(0)
  console.error(error)
  process.exit(1)
}
console.error("microvm/cluster unexpectedly resolved")
process.exit(1)
`], { cwd: root, encoding: "utf8" })
  })
})
