#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION=v24.20.0
PNPM_VERSION=10.34.5
FIRECRACKER_VERSION=1.17.0
FIRECRACKER_SHA256=99ad0f5cd0514a88aad0e9ae8cfdb3cc3b4ab9d190e1194602406c786b5de7a5
JAILER_SHA256=65ef226e96f0ceda55ba643f445801ef2cc0ea667ef67cad8ac4f406c9c8434f
SOURCE_REPOSITORY=https://github.com/dymoo/microvm

usage() {
  cat <<'USAGE'
Usage: scripts/build-release-artifact.sh \
  --version X.Y.Z \
  --source-sha 40_HEX_COMMIT \
  --source-date-epoch UNIX_SECONDS \
  --acceptance-run-url HTTPS_GITHUB_ACTIONS_RUN_URL \
  --acceptance-evidence-digest sha256:64_HEX \
  --output-dir DIR

Builds a deterministic linux-x86_64 daemon artifact from an already-built
checkout. The release contract requires exactly Node.js v24.20.0 and pnpm
10.34.5. Node is deliberately not bundled: there is no approved host-runtime
archive digest in this repository, so deployment fails unless /usr/bin/node
reports the exact required version.

The same run also emits the deterministic npm-style SDK package
`microvm-<version>-<40sha>.tgz` plus `.sha256`, `.inventory.txt`, and
`.provenance.json` sidecars, for immutable GitHub-release consumption on
Node and workerd. The SDK contains the built `dist`, package manifest,
README, and `docs/` only: dependencies are declared by the manifest, never
vendored. The host archive contract is unchanged by this addition.
USAGE
}

die() {
  printf 'build-release-artifact: %s\n' "$*" >&2
  exit 1
}

VERSION=
SOURCE_SHA=
SOURCE_DATE_EPOCH=
ACCEPTANCE_RUN_URL=
ACCEPTANCE_EVIDENCE_DIGEST=
OUTPUT_DIR=

while (($# > 0)); do
  case $1 in
    --version) VERSION=${2:-}; shift 2 ;;
    --source-sha) SOURCE_SHA=${2:-}; shift 2 ;;
    --source-date-epoch) SOURCE_DATE_EPOCH=${2:-}; shift 2 ;;
    --acceptance-run-url) ACCEPTANCE_RUN_URL=${2:-}; shift 2 ;;
    --acceptance-evidence-digest) ACCEPTANCE_EVIDENCE_DIGEST=${2:-}; shift 2 ;;
    --output-dir) OUTPUT_DIR=${2:-}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ $VERSION =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || die "--version must be an unprefixed X.Y.Z semantic version"
[[ $SOURCE_SHA =~ ^[0-9a-f]{40}$ ]] || die "--source-sha must be 40 lowercase hexadecimal characters"
[[ $SOURCE_DATE_EPOCH =~ ^[1-9][0-9]*$ ]] || die "--source-date-epoch must be positive UNIX seconds"
[[ $ACCEPTANCE_RUN_URL =~ ^https://github\.com/dymoo/microvm/actions/runs/[1-9][0-9]*$ ]] \
  || die "--acceptance-run-url must identify a dymoo/microvm GitHub Actions run"
[[ $ACCEPTANCE_EVIDENCE_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] \
  || die "--acceptance-evidence-digest must be sha256: followed by 64 lowercase hex characters"
[[ -n $OUTPUT_DIR ]] || die "--output-dir is required"

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
UNIT=$ROOT/deploy/systemd/microvm-daemon.service
[[ -f $ROOT/package.json ]] || die "package.json is missing"
[[ -d $ROOT/dist ]] || die "dist is missing; run pnpm build first"
[[ -f $ROOT/dist/bin/daemon.js && -f $ROOT/dist/bin/client.js ]] \
  || die "built daemon/client entrypoints must exist"
[[ -f $UNIT ]] || die "checked-in systemd unit is missing: $UNIT"

for tool in node pnpm python3; do
  command -v "$tool" >/dev/null || die "required tool not found: $tool"
done
[[ $(node --version) == "$NODE_VERSION" ]] \
  || die "release builds require Node.js $NODE_VERSION exactly (observed: $(node --version 2>/dev/null || printf missing))"
[[ $(pnpm --version) == "$PNPM_VERSION" ]] \
  || die "release builds require pnpm $PNPM_VERSION exactly (observed: $(pnpm --version 2>/dev/null || printf missing))"

PACKAGE_VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])' "$ROOT/package.json")
[[ $PACKAGE_VERSION == "$VERSION" ]] \
  || die "package.json version $PACKAGE_VERSION does not match requested version $VERSION"

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR=$(cd -- "$OUTPUT_DIR" && pwd)
STEM=microvm-host-linux-x86_64-$VERSION-$SOURCE_SHA
ARTIFACT=$OUTPUT_DIR/$STEM.tar.gz
CHECKSUM=$ARTIFACT.sha256
INVENTORY=$ARTIFACT.inventory.txt
PROVENANCE=$ARTIFACT.provenance.json
SBOM=$ARTIFACT.spdx.json
SDK_ARTIFACT=$OUTPUT_DIR/microvm-$VERSION-$SOURCE_SHA.tgz
SDK_CHECKSUM=$SDK_ARTIFACT.sha256
SDK_INVENTORY=$SDK_ARTIFACT.inventory.txt
SDK_PROVENANCE=$SDK_ARTIFACT.provenance.json
for output in "$ARTIFACT" "$CHECKSUM" "$INVENTORY" "$PROVENANCE" "$SBOM" \
  "$SDK_ARTIFACT" "$SDK_CHECKSUM" "$SDK_INVENTORY" "$SDK_PROVENANCE"; do
  [[ ! -e $output ]] || die "refusing to overwrite existing output: $output"
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/microvm-release.XXXXXXXX")
cleanup_work() {
  chmod -R u+w "$WORK" 2>/dev/null || true
  rm -rf -- "$WORK"
}
trap cleanup_work EXIT
trap 'cleanup_work; exit 130' INT
trap 'cleanup_work; exit 143' TERM
PAYLOAD=$WORK/payload
mkdir -p "$PAYLOAD"

# Materialize production dependencies for the target host. Nothing is resolved
# on the host during deployment; the lockfile was frozen before this script.
pnpm --filter microvm deploy --prod --legacy --os=linux --cpu=x64 --libc=glibc "$PAYLOAD/package"
[[ -x $PAYLOAD/package/dist/bin/daemon.js && -x $PAYLOAD/package/dist/bin/client.js ]] \
  || die "pnpm deploy omitted built daemon/client entrypoints"
SDK_STAGE=$WORK/sdk
mkdir -p "$PAYLOAD/package/deploy/systemd"
install -m 0644 "$UNIT" "$PAYLOAD/package/deploy/systemd/microvm-daemon.service"
mkdir -p "$SDK_STAGE/package"

python3 - "$PAYLOAD" "$WORK/inventory.rows" "$ARTIFACT" "$SBOM" \
  "$SDK_STAGE" "$WORK/sdk-inventory.rows" "$SDK_ARTIFACT" "$ROOT" \
  "$VERSION" "$SOURCE_SHA" "$SOURCE_DATE_EPOCH" "$NODE_VERSION" "$PNPM_VERSION" \
  "$FIRECRACKER_VERSION" "$FIRECRACKER_SHA256" "$JAILER_SHA256" "$SOURCE_REPOSITORY" <<'PY'
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tarfile

(
    payload_arg,
    rows_arg,
    artifact_arg,
    sbom_sidecar_arg,
    sdk_stage_arg,
    sdk_rows_arg,
    sdk_artifact_arg,
    repo_root,
    version,
    source_sha,
    epoch_raw,
    node_version,
    pnpm_version,
    firecracker_version,
    firecracker_sha,
    jailer_sha,
    source_repository,
) = sys.argv[1:]
payload = Path(payload_arg).resolve()
package = payload / "package"
epoch = int(epoch_raw)

manifest = {
    "schemaVersion": 1,
    "artifact": "microvm-host",
    "version": version,
    "sourceRepository": source_repository,
    "sourceCommit": source_sha,
    "platform": {"os": "linux", "arch": "x86_64", "libc": "glibc"},
    "entrypoints": {
        "daemon": "package/dist/bin/daemon.js",
        "cli": "package/dist/bin/client.js",
        "systemdUnit": "package/deploy/systemd/microvm-daemon.service",
    },
    "runtime": {
        "nodeBundled": False,
        "nodeExecutable": "/usr/bin/node",
        "nodeVersion": node_version,
        "pnpmBuildVersion": pnpm_version,
        "contract": "Deployment fails unless /usr/bin/node reports the exact version; no runtime dependency installation occurs on the host.",
    },
    "admission": {"protocolVersion": 1, "acceptingAtStartup": False},
    "externalRuntime": {
        "bundled": False,
        "firecracker": {"version": firecracker_version, "binarySha256": firecracker_sha},
        "jailer": {"version": firecracker_version, "binarySha256": jailer_sha},
        "guestKernel": {
            "digest": None,
            "contract": "Operator-promoted digest supplied to deploy-host.sh and verified against the configured kernel bytes; no demonstration/TOFU kernel is promoted by this artifact.",
        },
        "guestImages": {
            "digest": None,
            "contract": "Operator allowlist manifest imageDigest supplied to deploy-host.sh; raw images, kernels, and manifests are not bundled.",
        },
        "config": {
            "daemon": "/etc/microvm/config.json",
            "environment": "/etc/microvm/microvm.env",
            "ca": "/etc/microvm/ca.pem",
            "mutableState": ["/var/lib/microvm/bin", "/var/lib/microvm/images", "/var/lib/microvm/run"],
        },
    },
}
(package / "release-manifest.json").write_text(
    json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)

packages = {}
for candidate in sorted(package.rglob("package.json"), key=lambda p: p.as_posix()):
    try:
        value = json.loads(candidate.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        continue
    name = value.get("name")
    package_version = value.get("version")
    if not isinstance(name, str) or not isinstance(package_version, str):
        continue
    license_value = value.get("license")
    license_name = license_value if isinstance(license_value, str) and license_value else "NOASSERTION"
    packages[(name, package_version)] = license_name

def spdx_id(name, package_version):
    safe = re.sub(r"[^A-Za-z0-9.-]", "-", f"{name}-{package_version}")
    return f"SPDXRef-Package-{safe}"

spdx_packages = []
for (name, package_version), license_name in sorted(packages.items()):
    spdx_packages.append({
        "SPDXID": spdx_id(name, package_version),
        "name": name,
        "versionInfo": package_version,
        "downloadLocation": "NOASSERTION",
        "filesAnalyzed": False,
        "licenseConcluded": "NOASSERTION",
        "licenseDeclared": license_name,
        "copyrightText": "NOASSERTION",
    })
sbom = {
    "spdxVersion": "SPDX-2.3",
    "dataLicense": "CC0-1.0",
    "SPDXID": "SPDXRef-DOCUMENT",
    "name": f"microvm-host-{version}-{source_sha}",
    "documentNamespace": f"{source_repository}/releases/{version}/{source_sha}/spdx",
    "creationInfo": {
        "created": "1970-01-01T00:00:00Z",
        "creators": ["Tool: scripts/build-release-artifact.sh"],
    },
    "packages": spdx_packages,
    "documentDescribes": [spdx_id("microvm", version)],
}
sbom_bytes = (json.dumps(sbom, sort_keys=True, separators=(",", ":")) + "\n").encode()
(package / "release.spdx.json").write_bytes(sbom_bytes)
Path(sbom_sidecar_arg).write_bytes(sbom_bytes)

def normalize_and_pack(payload_dir, artifact_path, rows_path):
    """Safety-normalize one payload tree and pack it deterministically."""
    control = re.compile(r"[\x00-\x1f\x7f]")
    entries = []
    for path in sorted(payload_dir.rglob("*"), key=lambda p: p.relative_to(payload_dir).as_posix()):
        relative = path.relative_to(payload_dir).as_posix()
        pure = PurePosixPath(relative)
        if pure.is_absolute() or ".." in pure.parts or control.search(relative) or "\\" in relative:
            raise SystemExit(f"unsafe payload path: {relative!r}")
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(path)
            if not target or PurePosixPath(target).is_absolute() or control.search(target) or "\\" in target:
                raise SystemExit(f"unsafe symlink target: {relative!r} -> {target!r}")
            resolved = (path.parent / target).resolve(strict=False)
            try:
                resolved.relative_to(payload_dir)
            except ValueError:
                raise SystemExit(f"escaping symlink target: {relative!r} -> {target!r}")
            entries.append((path, relative, "symlink", 0o777, target.encode()))
        elif stat.S_ISDIR(info.st_mode):
            path.chmod(0o555)
            entries.append((path, relative, "dir", 0o555, b""))
        elif stat.S_ISREG(info.st_mode):
            mode = 0o555 if info.st_mode & 0o111 else 0o444
            path.chmod(mode)
            entries.append((path, relative, "file", mode, path.read_bytes()))
        else:
            raise SystemExit(f"unsupported payload entry type: {relative!r}")
        try:
            os.utime(path, (epoch, epoch), follow_symlinks=False)
        except (NotImplementedError, PermissionError):
            if not path.is_symlink():
                raise
    rows = []
    for _path, relative, kind, mode, content in entries:
        if kind == "dir":
            continue
        rows.append(
            f"{mode:06o} 0 0 {len(content)} {hashlib.sha256(content).hexdigest()} {relative}"
        )
    Path(rows_path).write_text("\n".join(rows) + "\n", encoding="utf-8")
    with open(artifact_path, "xb") as output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for path, relative, kind, mode, content in entries:
                    item = tarfile.TarInfo(relative)
                    item.uid = 0
                    item.gid = 0
                    item.uname = ""
                    item.gname = ""
                    item.mode = mode
                    item.mtime = epoch
                    if kind == "dir":
                        item.type = tarfile.DIRTYPE
                        item.size = 0
                        archive.addfile(item)
                    elif kind == "symlink":
                        item.type = tarfile.SYMTYPE
                        item.linkname = content.decode()
                        item.size = 0
                        archive.addfile(item)
                    else:
                        item.type = tarfile.REGTYPE
                        item.size = len(content)
                        archive.addfile(item, io.BytesIO(content))

normalize_and_pack(payload, artifact_arg, rows_arg)

# Stage the npm-style SDK package: the manifest's `files` whitelist plus
# package.json itself. Dependencies are declared by the manifest, never
# vendored; the tarball must not contain node_modules.
sdk_package = (Path(sdk_stage_arg) / "package").resolve()
manifest_source = Path(repo_root) / "package.json"
package_document = json.loads(manifest_source.read_text(encoding="utf-8"))
whitelist = package_document.get("files")
if not isinstance(whitelist, list) or not all(isinstance(entry, str) for entry in whitelist) or not whitelist:
    raise SystemExit("package.json files must be a non-empty list of strings")
glob_like = re.compile(r"[*?\[]")
for entry in whitelist:
    pure = PurePosixPath(entry)
    if glob_like.search(entry) or pure.is_absolute() or ".." in pure.parts or "node_modules" in pure.parts:
        raise SystemExit(f"unsupported package.json files entry: {entry!r}")
    source = Path(repo_root) / entry
    if source.is_dir():
        shutil.copytree(source, sdk_package / entry, symlinks=True)
    elif source.is_file():
        (sdk_package / pure).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, sdk_package / pure)
    else:
        raise SystemExit(f"package.json files entry is missing: {entry!r}")
shutil.copy2(manifest_source, sdk_package / "package.json")
if not (sdk_package / "README.md").is_file():
    raise SystemExit("SDK package requires a README.md")
# The SDK ships `dist` from a possibly reused checkout; a stale build that
# still contains deleted legacy modules would betray the package contract.
dist_dir = Path(repo_root) / "dist"
source_dir = Path(repo_root) / "src"
for built in dist_dir.rglob("*.js"):
    counterpart = source_dir / built.relative_to(dist_dir).with_suffix(".ts")
    if not counterpart.is_file():
        raise SystemExit(f"dist contains stale output without a source file: {built.relative_to(dist_dir)}")
for path in sdk_package.rglob("*"):
    if "node_modules" in path.relative_to(sdk_package).parts:
        raise SystemExit("SDK package must not contain node_modules")
targets = []
exports_map = package_document.get("exports")
if isinstance(exports_map, dict):
    for value in exports_map.values():
        if isinstance(value, str):
            targets.append(value)
        elif isinstance(value, dict):
            targets.extend(str(item) for item in value.values() if isinstance(item, str))
bin_map = package_document.get("bin")
if isinstance(bin_map, dict):
    targets.extend(str(item) for item in bin_map.values() if isinstance(item, str))
if not targets:
    raise SystemExit("package.json declares no export or bin targets")
for target in targets:
    if PurePosixPath(target).is_absolute():
        raise SystemExit(f"package target must be relative: {target!r}")
    candidate = sdk_package / PurePosixPath(target)
    if not candidate.is_file():
        raise SystemExit(f"package target is not built: {target}")
    try:
        candidate.resolve(strict=False).relative_to(sdk_package)
    except ValueError:
        raise SystemExit(f"package target escapes the package root: {target!r}")
normalize_and_pack(Path(sdk_stage_arg).resolve(), sdk_artifact_arg, sdk_rows_arg)
PY

ARTIFACT_SHA256=$(python3 -c 'import hashlib,sys; h=hashlib.sha256(); f=open(sys.argv[1],"rb"); [h.update(b) for b in iter(lambda:f.read(1024*1024),b"")]; print(h.hexdigest())' "$ARTIFACT")
ARTIFACT_BYTES=$(python3 -c 'import os,sys; print(os.path.getsize(sys.argv[1]))' "$ARTIFACT")
printf '%s  %s\n' "$ARTIFACT_SHA256" "$(basename "$ARTIFACT")" >"$CHECKSUM"
{
  printf '# microvm host artifact inventory\n'
  printf '# artifact: %s\n' "$(basename "$ARTIFACT")"
  printf '# artifact_sha256: %s\n' "$ARTIFACT_SHA256"
  printf '# artifact_bytes: %s\n' "$ARTIFACT_BYTES"
  printf '# package: microvm@%s\n' "$VERSION"
  printf '# source_commit: %s\n' "$SOURCE_SHA"
  printf '# source_repository: %s\n' "$SOURCE_REPOSITORY"
  printf '# row_format: mode uid gid bytes sha256 path\n'
  cat "$WORK/inventory.rows"
} >"$INVENTORY"

python3 - "$PROVENANCE" "$VERSION" "$SOURCE_SHA" "$ARTIFACT_SHA256" "$ARTIFACT_BYTES" \
  "$ACCEPTANCE_RUN_URL" "$ACCEPTANCE_EVIDENCE_DIGEST" "$NODE_VERSION" "$PNPM_VERSION" \
  "$SOURCE_REPOSITORY" "$(basename "$ARTIFACT")" <<'PY'
import json
import sys
(
    output,
    version,
    source_sha,
    artifact_sha,
    artifact_bytes,
    acceptance_url,
    acceptance_digest,
    node_version,
    pnpm_version,
    source_repository,
    artifact_name,
) = sys.argv[1:]
value = {
    "schemaVersion": 1,
    "builder": "scripts/build-release-artifact.sh",
    "artifact": "microvm-host",
    "source": {"repository": source_repository, "commit": source_sha},
    "packageVersion": version,
    "subject": {"name": artifact_name, "sha256": artifact_sha, "bytes": int(artifact_bytes)},
    "toolchain": {"node": node_version, "pnpm": pnpm_version},
    "hostRuntimeBundled": False,
    "acceptance": {"runUrl": acceptance_url, "evidenceDigest": acceptance_digest},
}
with open(output, "x", encoding="utf-8") as handle:
    json.dump(value, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
PY

SDK_SHA256=$(python3 -c 'import hashlib,sys; h=hashlib.sha256(); f=open(sys.argv[1],"rb"); [h.update(b) for b in iter(lambda:f.read(1024*1024),b"")]; print(h.hexdigest())' "$SDK_ARTIFACT")
SDK_BYTES=$(python3 -c 'import os,sys; print(os.path.getsize(sys.argv[1]))' "$SDK_ARTIFACT")
printf '%s  %s\n' "$SDK_SHA256" "$(basename "$SDK_ARTIFACT")" >"$SDK_CHECKSUM"
{
  printf '# microvm sdk package inventory\n'
  printf '# artifact: %s\n' "$(basename "$SDK_ARTIFACT")"
  printf '# artifact_sha256: %s\n' "$SDK_SHA256"
  printf '# artifact_bytes: %s\n' "$SDK_BYTES"
  printf '# package: microvm@%s\n' "$VERSION"
  printf '# source_commit: %s\n' "$SOURCE_SHA"
  printf '# source_repository: %s\n' "$SOURCE_REPOSITORY"
  printf '# row_format: mode uid gid bytes sha256 path\n'
  cat "$WORK/sdk-inventory.rows"
} >"$SDK_INVENTORY"

python3 - "$SDK_PROVENANCE" "$VERSION" "$SOURCE_SHA" "$SDK_SHA256" "$SDK_BYTES" \
  "$ACCEPTANCE_RUN_URL" "$ACCEPTANCE_EVIDENCE_DIGEST" "$NODE_VERSION" "$PNPM_VERSION" \
  "$SOURCE_REPOSITORY" "$(basename "$SDK_ARTIFACT")" <<'PY'
import json
import sys
(
    output,
    version,
    source_sha,
    artifact_sha,
    artifact_bytes,
    acceptance_url,
    acceptance_digest,
    node_version,
    pnpm_version,
    source_repository,
    artifact_name,
) = sys.argv[1:]
value = {
    "schemaVersion": 1,
    "builder": "scripts/build-release-artifact.sh",
    "artifact": "microvm-sdk",
    "source": {"repository": source_repository, "commit": source_sha},
    "packageVersion": version,
    "subject": {"name": artifact_name, "sha256": artifact_sha, "bytes": int(artifact_bytes)},
    "toolchain": {"node": node_version, "pnpm": pnpm_version},
    "dependenciesBundled": False,
    "acceptance": {"runUrl": acceptance_url, "evidenceDigest": acceptance_digest},
}
with open(output, "x", encoding="utf-8") as handle:
    json.dump(value, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
PY

printf 'artifact=%s\nchecksum=%s\ninventory=%s\nprovenance=%s\nsbom=%s\nsha256=%s\n' \
  "$ARTIFACT" "$CHECKSUM" "$INVENTORY" "$PROVENANCE" "$SBOM" "$ARTIFACT_SHA256"
printf 'sdk_artifact=%s\nsdk_checksum=%s\nsdk_inventory=%s\nsdk_provenance=%s\nsdk_sha256=%s\n' \
  "$SDK_ARTIFACT" "$SDK_CHECKSUM" "$SDK_INVENTORY" "$SDK_PROVENANCE" "$SDK_SHA256"
