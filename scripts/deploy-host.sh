#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION=v24.20.0
MANIFEST_FIRECRACKER_SHA256=99ad0f5cd0514a88aad0e9ae8cfdb3cc3b4ab9d190e1194602406c786b5de7a5
MANIFEST_JAILER_SHA256=65ef226e96f0ceda55ba643f445801ef2cc0ea667ef67cad8ac4f406c9c8434f

usage() {
  cat <<'USAGE'
Usage: sudo scripts/deploy-host.sh \
  --artifact PATH --checksum PATH --inventory PATH \
  --expected-artifact-sha256 64_HEX \
  --expected-version X.Y.Z --expected-source-sha 40_HEX \
  --expected-firecracker-sha256 64_HEX \
  --expected-jailer-sha256 64_HEX \
  --expected-kernel-sha256 64_HEX \
  --image NAME --image-digest sha256:64_HEX \
  --url HTTPS_URL [options]

The operator independently supplies --expected-artifact-sha256, copied from
the immutable GitHub release page or attestation; the artifact bytes are
refused unless they hash to it. Artifact/checksum/inventory must be ordinary
files (no symlinks) and are copied once into a private work directory before
validation.

Options:
  --install-root DIR       Versioned releases/current link (default /opt/microvm)
  --config PATH            Daemon JSON (default /etc/microvm/config.json)
  --env-file PATH          Root-only systemd environment (default /etc/microvm/microvm.env)
  --ca-file PATH           Operator CA for CLI TLS (default /etc/microvm/ca.pem)
  --service NAME           systemd unit (default microvm-daemon.service)
  --lock-file PATH         Deployment flock (default /run/lock/microvm-deploy.lock)
  --drain-timeout SEC      Zero-VM drain bound (default 300)
  --destroy-timeout SEC    Forced known-VM destruction bound (default 60)
  --start-timeout SEC      Startup/info bound (default 60)
  --smoke-timeout SEC      Direct lifecycle bound (default 120)
  --rollback-timeout SEC   Per-step rollback bound (default 90), applied
                           separately to stop, start, and each health wait
  --bootstrap              Permit no compatible prior release, but only while
                           the service is inactive; failure stays stopped/closed
  --simulate-post-switch-failure
                           Exercise one real rollback after the new closed
                           version/residue/admission gates; exits nonzero
  --validate-only          Validate artifact/checksum/inventory/manifest and
                           print the immutable plan; no root/Linux/systemd or
                           host-path checks and no install/service mutation
  --help                   Show this text

The script never reads secrets from arguments. MICROVM_ADMIN_TOKEN is read from
the canonical root-owned environment file. It performs no SSH or Cloudflare
operation and never installs Firecracker, jailer, a kernel, or guest images.
USAGE
}

die() {
  printf 'deploy-host: %s\n' "$*" >&2
  exit 1
}

ARTIFACT=
CHECKSUM=
INVENTORY=
EXPECTED_VERSION=
EXPECTED_ARTIFACT_SHA256=
EXPECTED_SOURCE_SHA=
EXPECTED_FIRECRACKER_SHA256=
EXPECTED_JAILER_SHA256=
EXPECTED_KERNEL_SHA256=
IMAGE=
IMAGE_DIGEST=
URL=
INSTALL_ROOT=/opt/microvm
CONFIG=/etc/microvm/config.json
ENV_FILE=/etc/microvm/microvm.env
CA_FILE=/etc/microvm/ca.pem
SERVICE=microvm-daemon.service
LOCK_FILE=/run/lock/microvm-deploy.lock
DRAIN_TIMEOUT=300
DESTROY_TIMEOUT=60
START_TIMEOUT=60
SMOKE_TIMEOUT=120
ROLLBACK_TIMEOUT=90
BOOTSTRAP=false
SIMULATE_POST_SWITCH_FAILURE=false
VALIDATE_ONLY=false

while (($# > 0)); do
  case $1 in
    --artifact) ARTIFACT=${2:-}; shift 2 ;;
    --checksum) CHECKSUM=${2:-}; shift 2 ;;
    --inventory) INVENTORY=${2:-}; shift 2 ;;
    --expected-artifact-sha256) EXPECTED_ARTIFACT_SHA256=${2:-}; shift 2 ;;
    --expected-version) EXPECTED_VERSION=${2:-}; shift 2 ;;
    --expected-source-sha) EXPECTED_SOURCE_SHA=${2:-}; shift 2 ;;
    --expected-firecracker-sha256) EXPECTED_FIRECRACKER_SHA256=${2:-}; shift 2 ;;
    --expected-jailer-sha256) EXPECTED_JAILER_SHA256=${2:-}; shift 2 ;;
    --expected-kernel-sha256) EXPECTED_KERNEL_SHA256=${2:-}; shift 2 ;;
    --image) IMAGE=${2:-}; shift 2 ;;
    --image-digest) IMAGE_DIGEST=${2:-}; shift 2 ;;
    --url) URL=${2:-}; shift 2 ;;
    --install-root) INSTALL_ROOT=${2:-}; shift 2 ;;
    --config) CONFIG=${2:-}; shift 2 ;;
    --env-file) ENV_FILE=${2:-}; shift 2 ;;
    --ca-file) CA_FILE=${2:-}; shift 2 ;;
    --service) SERVICE=${2:-}; shift 2 ;;
    --lock-file) LOCK_FILE=${2:-}; shift 2 ;;
    --drain-timeout) DRAIN_TIMEOUT=${2:-}; shift 2 ;;
    --destroy-timeout) DESTROY_TIMEOUT=${2:-}; shift 2 ;;
    --start-timeout) START_TIMEOUT=${2:-}; shift 2 ;;
    --smoke-timeout) SMOKE_TIMEOUT=${2:-}; shift 2 ;;
    --rollback-timeout) ROLLBACK_TIMEOUT=${2:-}; shift 2 ;;
    --bootstrap) BOOTSTRAP=true; shift ;;
    --simulate-post-switch-failure) SIMULATE_POST_SWITCH_FAILURE=true; shift ;;
    --validate-only) VALIDATE_ONLY=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -f $ARTIFACT && ! -L $ARTIFACT ]] || die "--artifact must name an ordinary readable file (not a symlink)"
[[ -f $CHECKSUM && ! -L $CHECKSUM ]] || die "--checksum must name an ordinary readable file (not a symlink)"
[[ -f $INVENTORY && ! -L $INVENTORY ]] || die "--inventory must name an ordinary readable file (not a symlink)"
[[ $EXPECTED_ARTIFACT_SHA256 =~ ^[0-9a-f]{64}$ ]] \
  || die "--expected-artifact-sha256 must be 64 lowercase hexadecimal characters"
[[ $EXPECTED_VERSION =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || die "--expected-version must be an unprefixed X.Y.Z semantic version"
[[ $EXPECTED_SOURCE_SHA =~ ^[0-9a-f]{40}$ ]] \
  || die "--expected-source-sha must be 40 lowercase hexadecimal characters"
[[ $EXPECTED_FIRECRACKER_SHA256 =~ ^[0-9a-f]{64}$ ]] \
  || die "--expected-firecracker-sha256 must be 64 lowercase hexadecimal characters"
[[ $EXPECTED_JAILER_SHA256 =~ ^[0-9a-f]{64}$ ]] \
  || die "--expected-jailer-sha256 must be 64 lowercase hexadecimal characters"
[[ $EXPECTED_KERNEL_SHA256 =~ ^[0-9a-f]{64}$ ]] \
  || die "--expected-kernel-sha256 must be 64 lowercase hexadecimal characters"
[[ $IMAGE =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || die "--image is invalid"
[[ $IMAGE_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] \
  || die "--image-digest must be sha256: followed by 64 lowercase hex characters"
[[ $URL =~ ^https://[^/[:space:]]+(:[1-9][0-9]{0,4})?/?$ ]] \
  || die "--url must be an HTTPS origin without a path"
[[ $SERVICE =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || die "--service must be a systemd .service unit name"
for value in "$DRAIN_TIMEOUT" "$DESTROY_TIMEOUT" "$START_TIMEOUT" "$SMOKE_TIMEOUT" "$ROLLBACK_TIMEOUT"; do
  [[ $value =~ ^[1-9][0-9]*$ && $value -le 3600 ]] || die "timeouts must be integers from 1 to 3600 seconds"
done
[[ $EXPECTED_FIRECRACKER_SHA256 == "$MANIFEST_FIRECRACKER_SHA256" ]] \
  || die "expected Firecracker identity does not match this release contract"
[[ $EXPECTED_JAILER_SHA256 == "$MANIFEST_JAILER_SHA256" ]] \
  || die "expected jailer identity does not match this release contract"

command -v python3 >/dev/null || die "required tool not found: python3"
ARTIFACT=$(cd -- "$(dirname -- "$ARTIFACT")" && pwd)/$(basename -- "$ARTIFACT")
CHECKSUM=$(cd -- "$(dirname -- "$CHECKSUM")" && pwd)/$(basename -- "$CHECKSUM")
INVENTORY=$(cd -- "$(dirname -- "$INVENTORY")" && pwd)/$(basename -- "$INVENTORY")
RELEASE_ID=$EXPECTED_VERSION-$EXPECTED_SOURCE_SHA
RELEASE_DIR=$INSTALL_ROOT/releases/$RELEASE_ID
CURRENT=$INSTALL_ROOT/current

WORK=$(mktemp -d "${TMPDIR:-/tmp}/microvm-deploy.XXXXXXXX")
EXTRACTED=$WORK/extracted
STAGED=$WORK/staged
mkdir -p "$EXTRACTED" "$STAGED"
cleanup_work() {
  chmod -R u+w "$WORK" 2>/dev/null || true
  rm -rf -- "$WORK"
}
trap cleanup_work EXIT
trap 'cleanup_work; exit 130' INT
trap 'cleanup_work; exit 143' TERM

# Copy each mutable input once into the private work directory and use only
# the copies afterwards, so the bytes validated are the bytes installed.
cp -p -- "$ARTIFACT" "$STAGED/$(basename -- "$ARTIFACT")"
cp -p -- "$CHECKSUM" "$STAGED/$(basename -- "$CHECKSUM")"
cp -p -- "$INVENTORY" "$STAGED/$(basename -- "$INVENTORY")"
ARTIFACT=$STAGED/$(basename -- "$ARTIFACT")
CHECKSUM=$STAGED/$(basename -- "$CHECKSUM")
INVENTORY=$STAGED/$(basename -- "$INVENTORY")

# Validate before extraction. Only ordinary files, directories, and confined
# relative symlinks below package/ are accepted. Inventory comparison covers
# every file and symlink, including mode/owner/size/content or link target hash.
python3 - "$ARTIFACT" "$CHECKSUM" "$INVENTORY" "$EXTRACTED" \
  "$EXPECTED_ARTIFACT_SHA256" \
  "$EXPECTED_VERSION" "$EXPECTED_SOURCE_SHA" "$MANIFEST_FIRECRACKER_SHA256" \
  "$MANIFEST_JAILER_SHA256" <<'PY'
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tarfile

artifact, checksum_path, inventory_path, destination, expected_artifact_sha, version, source_sha, firecracker_sha, jailer_sha = sys.argv[1:]
artifact_path = Path(artifact)
destination_path = Path(destination)
expected_name = f"microvm-host-linux-x86_64-{version}-{source_sha}.tar.gz"
if artifact_path.name != expected_name:
    raise SystemExit(f"deploy-host: artifact name must be {expected_name}")
if artifact_path.stat().st_size > 1_073_741_824:
    raise SystemExit("deploy-host: compressed artifact exceeds 1 GiB")

def digest_bytes(data):
    return hashlib.sha256(data).hexdigest()

def digest_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

artifact_sha = digest_file(artifact_path)
if artifact_sha != expected_artifact_sha:
    raise SystemExit(
        "deploy-host: artifact bytes do not match the independently supplied "
        f"--expected-artifact-sha256 (observed {artifact_sha}, expected {expected_artifact_sha})"
    )
checksum_lines = Path(checksum_path).read_text(encoding="utf-8").splitlines()
if checksum_lines != [f"{artifact_sha}  {artifact_path.name}"]:
    raise SystemExit("deploy-host: checksum sidecar is malformed or does not match the artifact")

control = re.compile(r"[\x00-\x1f\x7f]")
members = []
seen = set()
total_bytes = 0
with tarfile.open(artifact_path, mode="r:gz") as archive:
    for member in archive:
        name = member.name.rstrip("/")
        pure = PurePosixPath(name)
        if (
            not name
            or pure.is_absolute()
            or name != pure.as_posix()
            or pure.parts[0] != "package"
            or ".." in pure.parts
            or control.search(name)
            or "\\" in name
        ):
            raise SystemExit(f"deploy-host: unsafe archive path: {member.name!r}")
        if name in seen:
            raise SystemExit(f"deploy-host: duplicate archive path: {name!r}")
        seen.add(name)
        if member.uid != 0 or member.gid != 0:
            raise SystemExit(f"deploy-host: non-root archive ownership: {name!r}")
        if member.isdir():
            if member.mode != 0o555:
                raise SystemExit(f"deploy-host: directory mode is not 0555: {name!r}")
            kind = "dir"
        elif member.isfile():
            if member.mode not in (0o444, 0o555):
                raise SystemExit(f"deploy-host: file mode is not 0444/0555: {name!r}")
            if member.size > 536_870_912:
                raise SystemExit(f"deploy-host: archive member exceeds 512 MiB: {name!r}")
            total_bytes += member.size
            kind = "file"
        elif member.issym():
            target = member.linkname
            if not target or PurePosixPath(target).is_absolute() or control.search(target) or "\\" in target:
                raise SystemExit(f"deploy-host: unsafe symlink: {name!r}")
            combined = PurePosixPath(name).parent.joinpath(PurePosixPath(target))
            parts = []
            for part in combined.parts:
                if part == ".":
                    continue
                if part == "..":
                    if not parts:
                        raise SystemExit(f"deploy-host: escaping symlink: {name!r}")
                    parts.pop()
                else:
                    parts.append(part)
            if not parts or parts[0] != "package":
                raise SystemExit(f"deploy-host: escaping symlink: {name!r}")
            kind = "symlink"
        else:
            raise SystemExit(f"deploy-host: unsupported archive entry type: {name!r}")
        members.append((member, name, kind))
    if len(members) > 100_000 or total_bytes > 2_147_483_648:
        raise SystemExit("deploy-host: archive exceeds member-count or expanded-size bound")

    # Extract without tarfile.extract: destinations and entry types stay explicit.
    for member, name, kind in members:
        target = destination_path.joinpath(*PurePosixPath(name).parts)
        if kind == "dir":
            target.mkdir(parents=True, exist_ok=False)
    for member, name, kind in members:
        target = destination_path.joinpath(*PurePosixPath(name).parts)
        if kind == "file":
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise SystemExit(f"deploy-host: cannot read archive file: {name!r}")
            with open(target, "xb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            target.chmod(member.mode)
    for member, name, kind in members:
        if kind == "symlink":
            target = destination_path.joinpath(*PurePosixPath(name).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(member.linkname)

headers = {}
rows = []
for line in Path(inventory_path).read_text(encoding="utf-8").splitlines():
    if line.startswith("# "):
        if ": " in line:
            key, value = line[2:].split(": ", 1)
            headers[key] = value
        continue
    if not line:
        continue
    parts = line.split(" ", 5)
    if len(parts) != 6:
        raise SystemExit("deploy-host: malformed inventory row")
    rows.append(parts)
if headers.get("artifact") != artifact_path.name or headers.get("artifact_sha256") != artifact_sha:
    raise SystemExit("deploy-host: inventory artifact identity mismatch")
if headers.get("package") != f"microvm@{version}" or headers.get("source_commit") != source_sha:
    raise SystemExit("deploy-host: inventory source identity mismatch")
paths = [row[5] for row in rows]
if paths != sorted(paths) or len(paths) != len(set(paths)):
    raise SystemExit("deploy-host: inventory rows must be uniquely path-sorted")

expected = {}
with tarfile.open(artifact_path, mode="r:gz") as archive:
    for member in archive:
        name = member.name.rstrip("/")
        if member.isfile():
            source = archive.extractfile(member)
            if source is None:
                raise SystemExit(f"deploy-host: cannot hash archive file: {name!r}")
            content = source.read()
            expected[name] = (f"{member.mode:06o}", "0", "0", str(len(content)), digest_bytes(content))
        elif member.issym():
            content = member.linkname.encode()
            expected[name] = ("000777", "0", "0", str(len(content)), digest_bytes(content))
actual = {row[5]: tuple(row[:5]) for row in rows}
if actual != expected:
    raise SystemExit("deploy-host: inventory does not exactly cover archive files and symlinks")

manifest_path = destination_path / "package/release-manifest.json"
try:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
except Exception as cause:
    raise SystemExit(f"deploy-host: release manifest is unreadable: {cause}")
required = (
    manifest.get("schemaVersion") == 1
    and manifest.get("artifact") == "microvm-host"
    and manifest.get("version") == version
    and manifest.get("sourceRepository") == "https://github.com/dymoo/microvm"
    and manifest.get("sourceCommit") == source_sha
    and manifest.get("platform") == {"os": "linux", "arch": "x86_64", "libc": "glibc"}
    and manifest.get("runtime", {}).get("nodeBundled") is False
    and manifest.get("runtime", {}).get("nodeExecutable") == "/usr/bin/node"
    and manifest.get("runtime", {}).get("nodeVersion") == "v24.20.0"
    and manifest.get("admission") == {"protocolVersion": 1, "acceptingAtStartup": False}
    and manifest.get("externalRuntime", {}).get("bundled") is False
    and manifest.get("externalRuntime", {}).get("firecracker", {}).get("binarySha256") == firecracker_sha
    and manifest.get("externalRuntime", {}).get("jailer", {}).get("binarySha256") == jailer_sha
)
if not required:
    raise SystemExit("deploy-host: release manifest contract mismatch")
for required_path in (
    destination_path / "package/dist/bin/daemon.js",
    destination_path / "package/dist/bin/client.js",
    destination_path / "package/deploy/systemd/microvm-daemon.service",
    destination_path / "package/release.spdx.json",
):
    if not required_path.is_file():
        raise SystemExit(f"deploy-host: required artifact file missing: {required_path.relative_to(destination_path)}")
PY

if [[ $VALIDATE_ONLY == true ]]; then
  python3 - "$RELEASE_ID" "$RELEASE_DIR" "$CURRENT" "$SERVICE" <<'PY'
import json, sys
release_id, release_dir, current, service = sys.argv[1:]
print(json.dumps({
    "validated": True,
    "mutated": False,
    "releaseId": release_id,
    "releaseDirectory": release_dir,
    "currentLink": current,
    "service": service,
}, sort_keys=True, separators=(",", ":")))
PY
  exit 0
fi

[[ $EUID -eq 0 ]] || die "deployment must run as root (use --validate-only off-host)"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] \
  || die "deployment requires Linux x86_64"
for tool in flock install ln mv readlink systemctl timeout; do
  command -v "$tool" >/dev/null || die "required host tool not found: $tool"
done
[[ -x /usr/bin/node ]] || die "/usr/bin/node is required by the immutable runtime contract"
[[ $(/usr/bin/node --version) == "$NODE_VERSION" ]] \
  || die "/usr/bin/node must report $NODE_VERSION exactly"

validate_trusted_file() {
  python3 - "$1" <<'PY'
import os, stat, sys
path = os.path.abspath(sys.argv[1])
current = "/"
for component in path.split(os.sep)[1:]:
    current = os.path.join(current, component)
    info = os.lstat(current)
    if stat.S_ISLNK(info.st_mode):
        raise SystemExit(f"deploy-host: trusted path contains symlink: {current}")
    if info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o022:
        raise SystemExit(f"deploy-host: trusted path must be root-owned and not group/world-writable: {current}")
if not stat.S_ISREG(os.lstat(path).st_mode):
    raise SystemExit(f"deploy-host: trusted path is not a regular file: {path}")
PY
}
validate_trusted_file "$CONFIG"
validate_trusted_file "$ENV_FILE"
validate_trusted_file "$CA_FILE"

ADMIN_TOKEN=$(python3 - "$ENV_FILE" <<'PY'
import shlex, sys
values = []
for raw in open(sys.argv[1], encoding="utf-8"):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("export "):
        line = line[7:].lstrip()
    if not line.startswith("MICROVM_ADMIN_TOKEN="):
        continue
    value = line.split("=", 1)[1]
    parsed = shlex.split(value, posix=True)
    if len(parsed) != 1:
        raise SystemExit("deploy-host: MICROVM_ADMIN_TOKEN in environment file is malformed")
    values.append(parsed[0])
if len(values) != 1 or len(values[0]) < 16 or "\n" in values[0]:
    raise SystemExit("deploy-host: environment file must define one valid MICROVM_ADMIN_TOKEN")
print(values[0], end="")
PY
)

verify_external_runtime() {
  python3 - "$CONFIG" "$EXPECTED_FIRECRACKER_SHA256" "$EXPECTED_JAILER_SHA256" \
    "$EXPECTED_KERNEL_SHA256" "$IMAGE" "$IMAGE_DIGEST" <<'PY'
import hashlib, json, os, re, sys
config_path, firecracker_sha, jailer_sha, kernel_sha, image_name, image_digest = sys.argv[1:]
with open(config_path, encoding="utf-8") as handle:
    config = json.load(handle)
if config.get("acceptingAtStartup") is not False:
    raise SystemExit("deploy-host: daemon config must set acceptingAtStartup to false")
fc = config["firecracker"]

def digest(path):
    value = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()
for label, path, expected in (
    ("firecracker", fc["firecrackerBinary"], firecracker_sha),
    ("jailer", fc["jailerBinary"], jailer_sha),
    ("kernel", fc["kernelImage"], kernel_sha),
):
    if digest(path) != expected:
        raise SystemExit(f"deploy-host: configured {label} digest mismatch")
manifest_path = os.path.join(fc["imagesDir"], f"{image_name}.json")
with open(manifest_path, encoding="utf-8") as handle:
    manifest = json.load(handle)
if manifest.get("name") != image_name or manifest.get("imageDigest") != image_digest:
    raise SystemExit("deploy-host: configured image manifest identity mismatch")
raw_name = manifest.get("file")
if not isinstance(raw_name, str) or os.path.basename(raw_name) != raw_name:
    raise SystemExit("deploy-host: configured image manifest file is unsafe")
if "sha256:" + digest(os.path.join(fc["imagesDir"], raw_name)) != image_digest:
    raise SystemExit("deploy-host: configured raw image bytes do not match imageDigest")
PY
}
verify_external_runtime

install -d -o 0 -g 0 -m 0755 "$(dirname -- "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || die "another microvm deployment holds $LOCK_FILE"
install -d -o 0 -g 0 -m 0755 "$INSTALL_ROOT" "$INSTALL_ROOT/releases" /var/lib/microvm/deploy
[[ ! -e $RELEASE_DIR ]] || die "release directory already exists; refusing overwrite: $RELEASE_DIR"

DIAGNOSTIC=/var/lib/microvm/deploy/$RELEASE_ID-$(date -u +%Y%m%dT%H%M%SZ).log
exec > >(tee -a "$DIAGNOSTIC") 2>&1
printf 'deploy-host: validated %s\n' "$(basename "$ARTIFACT")"

PREVIOUS_TARGET=
PREVIOUS_VERSION=
PREVIOUS_COMPATIBLE=false
if [[ -L $CURRENT ]]; then
  PREVIOUS_TARGET=$(readlink "$CURRENT")
  [[ $PREVIOUS_TARGET =~ ^releases/[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{40}$ ]] \
    || die "current symlink target is not a canonical versioned release: $PREVIOUS_TARGET"
  PREVIOUS_VERSION=${PREVIOUS_TARGET#releases/}
  PREVIOUS_VERSION=${PREVIOUS_VERSION%%-*}
  PREVIOUS_MANIFEST=$INSTALL_ROOT/$PREVIOUS_TARGET/package/release-manifest.json
  if python3 - "$PREVIOUS_MANIFEST" <<'PY'
import json, sys
try:
    value = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if value.get("admission") == {"protocolVersion": 1, "acceptingAtStartup": False} else 1)
PY
  then
    PREVIOUS_COMPATIBLE=true
  fi
elif [[ -e $CURRENT ]]; then
  die "current exists but is not a symlink: $CURRENT"
fi

if [[ $PREVIOUS_COMPATIBLE != true && $BOOTSTRAP != true ]]; then
  die "no admission-compatible rollback release; use --bootstrap only with an inactive unrouted canary"
fi
if [[ $PREVIOUS_COMPATIBLE != true ]] && systemctl is-active --quiet "$SERVICE"; then
  die "--bootstrap requires $SERVICE to be inactive"
fi
if [[ $SIMULATE_POST_SWITCH_FAILURE == true && $PREVIOUS_COMPATIBLE != true ]]; then
  die "--simulate-post-switch-failure requires an admission-compatible prior release"
fi

CLIENT=$CURRENT/package/dist/bin/client.js
cli() {
  timeout --signal=TERM --kill-after=5s "${2:-$START_TIMEOUT}s" \
    env MICROVM_URL="$URL" MICROVM_TOKEN="$ADMIN_TOKEN" NODE_EXTRA_CA_CERTS="$CA_FILE" \
    /usr/bin/node "$CLIENT" "${@:3}"
}

json_assert_info() {
  python3 -c '
import json,sys
value=json.load(sys.stdin)
expected_version, expected_accepting, require_zero = sys.argv[1:]
assert value["version"] == expected_version
assert value["accepting"] is (expected_accepting == "true")
assert isinstance(value["liveVms"], int) and value["liveVms"] >= 0
if require_zero == "true":
    assert value["liveVms"] == 0
' "$2" "$3" "$4" <<<"$1"
}

wait_for_info_closed() {
  local seconds=$1 expected_version=$2 deadline output
  deadline=$(( $(date +%s) + seconds ))
  while (( $(date +%s) < deadline )); do
    if output=$(cli info 5 info --json 2>/dev/null) && \
      json_assert_info "$output" "$expected_version" false true; then
      return 0
    fi
    sleep 1
  done
  return 1
}

set_admission() {
  local accepting=$1
  if [[ $accepting == true ]]; then
    cli set-admission 10 set-admission --yes --json >/dev/null
  else
    cli set-admission 10 set-admission --no --json >/dev/null
  fi
}

wait_for_zero_vms() {
  local seconds=$1 expected_version=$2 expected_accepting=$3 deadline output
  deadline=$(( $(date +%s) + seconds ))
  while (( $(date +%s) < deadline )); do
    if output=$(cli info 10 info --json 2>/dev/null) && \
      json_assert_info "$output" "$expected_version" "$expected_accepting" true; then
      return 0
    fi
    sleep 1
  done
  return 1
}

destroy_remaining_vms() {
  local seconds=$1 deadline listing ids_text vm_id remaining output status
  local -a vm_ids
  deadline=$(( $(date +%s) + seconds ))
  while (( $(date +%s) < deadline )); do
    listing=$(cli list 10 list --json) || return 1
    ids_text=$(python3 -c '
import json, re, sys
payload = json.load(sys.stdin)
items = payload.get("vms")
assert isinstance(items, list)
for item in items:
    vm_id = item.get("vmId") if isinstance(item, dict) else None
    assert isinstance(vm_id, str) and re.fullmatch(r"mvm-[0-9a-z]{8,24}", vm_id)
    print(vm_id)
' <<<"$listing") || return 1
    [[ -n $ids_text ]] || return 0
    mapfile -t vm_ids <<<"$ids_text"
    for vm_id in "${vm_ids[@]}"; do
      remaining=$(( deadline - $(date +%s) ))
      (( remaining > 0 )) || return 1
      set +e
      output=$(cli destroy "$remaining" destroy --vm "$vm_id" --json 2>/dev/null)
      status=$?
      set -e
      if (( status == 0 )); then
        python3 -c 'import json,sys; assert json.load(sys.stdin)["destroyed"] is True' <<<"$output" \
          || return 1
      else
        python3 -c 'import json,sys; assert json.load(sys.stdin)["error"] == "VmNotFound"' <<<"$output" \
          || return 1
      fi
    done
  done
  return 1
}

verify_no_host_vm_residue() {
  python3 - "$CONFIG" <<'PY'
import json
from pathlib import Path, PurePosixPath
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    firecracker = json.load(handle)["firecracker"]
run_state_vms = Path(firecracker["runStateDir"]) / "vms"
parent = firecracker["jailerParentCgroup"]
pure_parent = PurePosixPath(parent)
if pure_parent.is_absolute() or ".." in pure_parent.parts:
    raise SystemExit("deploy-host: unsafe jailerParentCgroup in daemon config")
cgroup_root = Path("/sys/fs/cgroup").joinpath(*pure_parent.parts)
if run_state_vms.exists() and any(run_state_vms.iterdir()):
    raise SystemExit("deploy-host: VM run-state residue remains after zero-VM gate")
if cgroup_root.exists() and any(item.is_dir() for item in cgroup_root.iterdir()):
    raise SystemExit("deploy-host: jailer cgroup residue remains after zero-VM gate")
PY
}

prove_admission_closed() {
  local output status
  set +e
  output=$(cli create 15 create --image "$IMAGE" --image-digest "$IMAGE_DIGEST" \
    --cpus 1 --mem-mib 256 --ttl-s 120 --json 2>/dev/null)
  status=$?
  set -e
  (( status != 0 )) || return 1
  python3 -c 'import json,sys; assert json.load(sys.stdin)["error"] == "AdmissionClosed"' <<<"$output"
}

SMOKE_VM_ID=
run_canary_smoke() {
  local created executed inspected destroyed
  created=$(cli create "$SMOKE_TIMEOUT" create --image "$IMAGE" --image-digest "$IMAGE_DIGEST" \
    --cpus 1 --mem-mib 256 --ttl-s 120 --json)
  SMOKE_VM_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["vmId"])' <<<"$created")
  unset created
  executed=$(cli exec "$SMOKE_TIMEOUT" exec --vm "$SMOKE_VM_ID" --json -- /usr/bin/true)
  python3 -c 'import json,sys; value=json.load(sys.stdin); assert value["exitCode"] == 0 and value["timedOut"] is False' <<<"$executed"
  inspected=$(cli status 15 status --vm "$SMOKE_VM_ID" --json)
  python3 -c 'import json,sys; assert json.load(sys.stdin)["state"] == "running"' <<<"$inspected"
  destroyed=$(cli destroy "$SMOKE_TIMEOUT" destroy --vm "$SMOKE_VM_ID" --json)
  python3 -c 'import json,sys; assert json.load(sys.stdin)["destroyed"] is True' <<<"$destroyed"
  SMOKE_VM_ID=
}

ADMISSION_CLOSED=false
SWITCHED=false
PREVIOUS_STOPPED=false
RELEASE_STAGED=false
UNIT_PREVIOUS=none
UNIT_TOUCHED=false
UNIT_BACKUP=$WORK/systemd-unit.previous

restore_previous_once() {
  local failed=false rollback_link output
  set +e
  if [[ -n $SMOKE_VM_ID ]]; then
    cli destroy 15 destroy --vm "$SMOKE_VM_ID" --json >/dev/null 2>&1
    SMOKE_VM_ID=
  fi
  set_admission false >/dev/null 2>&1
  timeout "${ROLLBACK_TIMEOUT}s" systemctl stop "$SERVICE" || failed=true
  if [[ $PREVIOUS_COMPATIBLE == true ]]; then
    rollback_link=$INSTALL_ROOT/.current.rollback.$$
    if [[ $failed == false ]]; then
      rm -f -- "$rollback_link"
      ln -s "$PREVIOUS_TARGET" "$rollback_link" || failed=true
      mv -Tf "$rollback_link" "$CURRENT" || failed=true
    fi
    if [[ $failed == false && $UNIT_TOUCHED == true ]]; then
      case $UNIT_PREVIOUS in
        file) install -o 0 -g 0 -m 0644 "$UNIT_BACKUP" "/etc/systemd/system/$SERVICE" || failed=true ;;
        link) rm -f -- "/etc/systemd/system/$SERVICE" && cp -P -- "$UNIT_BACKUP" "/etc/systemd/system/$SERVICE" || failed=true ;;
        none) rm -f -- "/etc/systemd/system/$SERVICE" || failed=true ;;
      esac
    fi
    if [[ $failed == false ]]; then
      systemctl daemon-reload || failed=true
    fi
    CLIENT=$CURRENT/package/dist/bin/client.js
    if [[ $failed == false ]]; then
      timeout "${ROLLBACK_TIMEOUT}s" systemctl start "$SERVICE" || failed=true
    fi
    if [[ $failed == false ]]; then
      wait_for_info_closed "$ROLLBACK_TIMEOUT" "$PREVIOUS_VERSION" || failed=true
    fi
    if [[ $failed == false ]]; then
      verify_no_host_vm_residue || failed=true
    fi
    if [[ $failed == false ]]; then
      prove_admission_closed || failed=true
    fi
    if [[ $failed == false && $RELEASE_STAGED == true ]]; then
      chmod -R u+w "$RELEASE_DIR" || failed=true
      [[ $failed == false ]] && rm -rf -- "$RELEASE_DIR" || failed=true
    fi
    if [[ $failed == false ]]; then
      set_admission true || failed=true
    fi
    if [[ $failed == false ]]; then
      if output=$(cli info 10 info --json 2>/dev/null); then
        json_assert_info "$output" "$PREVIOUS_VERSION" true true || failed=true
      else
        failed=true
      fi
    fi
  else
    if [[ $UNIT_TOUCHED == true ]]; then
      case $UNIT_PREVIOUS in
        file) install -o 0 -g 0 -m 0644 "$UNIT_BACKUP" "/etc/systemd/system/$SERVICE" || failed=true ;;
        link) rm -f -- "/etc/systemd/system/$SERVICE" && cp -P -- "$UNIT_BACKUP" "/etc/systemd/system/$SERVICE" || failed=true ;;
        none) rm -f -- "/etc/systemd/system/$SERVICE" || failed=true ;;
      esac
      systemctl daemon-reload || failed=true
    fi
    [[ $failed == false ]] && rm -f -- "$CURRENT"
    failed=true
  fi
  set -e
  [[ $failed == false ]]
}

on_failure() {
  local status=${1:-$?}
  trap - ERR INT TERM
  set +e
  printf 'deploy-host: deployment failed; preserving diagnostics at %s\n' "$DIAGNOSTIC" >&2
  if [[ $SWITCHED == true || $PREVIOUS_STOPPED == true ]]; then
    if restore_previous_once; then
      printf 'deploy-host: previous compatible release restored once\n' >&2
    else
      systemctl stop "$SERVICE" >/dev/null 2>&1 || true
      printf 'deploy-host: rollback could not be proven; service left stopped/admission closed\n' >&2
    fi
  elif [[ $ADMISSION_CLOSED == true ]]; then
    set_admission true >/dev/null 2>&1 || true
  fi
  exit "$status"
}

deployment_failure() {
  printf 'deploy-host: %s\n' "$1" >&2
  on_failure 1
}
trap on_failure ERR
trap 'on_failure 130' INT
trap 'on_failure 143' TERM

if [[ $PREVIOUS_COMPATIBLE == true ]]; then
  CLIENT=$CURRENT/package/dist/bin/client.js
  set_admission false
  ADMISSION_CLOSED=true
  info=$(cli info 10 info --json)
  json_assert_info "$info" "$PREVIOUS_VERSION" false false
  if ! wait_for_zero_vms "$DRAIN_TIMEOUT" "$PREVIOUS_VERSION" false; then
    destroy_remaining_vms "$DESTROY_TIMEOUT" \
      || deployment_failure "failed to destroy every known VM within ${DESTROY_TIMEOUT}s"
    wait_for_zero_vms 10 "$PREVIOUS_VERSION" false \
      || deployment_failure "daemon did not report zero VMs after forced destruction"
  fi
  verify_no_host_vm_residue \
    || deployment_failure "old daemon left VM run-state or cgroup residue"
  PREVIOUS_STOPPED=true
  if ! timeout "${DRAIN_TIMEOUT}s" systemctl stop "$SERVICE"; then
    if systemctl is-active --quiet "$SERVICE"; then
      deployment_failure "failed to stop old daemon within ${DRAIN_TIMEOUT}s; old admission was reopened"
    fi
    PREVIOUS_STOPPED=true
    deployment_failure "old daemon became inactive but its bounded stop command failed"
  fi
fi

mv "$EXTRACTED" "$RELEASE_DIR"
RELEASE_STAGED=true
chown -hR 0:0 "$RELEASE_DIR"
if [[ -L /etc/systemd/system/$SERVICE ]]; then
  cp -P -- "/etc/systemd/system/$SERVICE" "$UNIT_BACKUP"
  UNIT_PREVIOUS='link'
elif [[ -f /etc/systemd/system/$SERVICE ]]; then
  cp -p -- "/etc/systemd/system/$SERVICE" "$UNIT_BACKUP"
  UNIT_PREVIOUS='file'
fi
install -o 0 -g 0 -m 0644 \
  "$RELEASE_DIR/package/deploy/systemd/microvm-daemon.service" "/etc/systemd/system/$SERVICE"
UNIT_TOUCHED=true
systemctl daemon-reload

NEW_LINK=$INSTALL_ROOT/.current.new.$$
rm -f -- "$NEW_LINK"
ln -s "releases/$RELEASE_ID" "$NEW_LINK"
mv -Tf "$NEW_LINK" "$CURRENT"
SWITCHED=true
CLIENT=$CURRENT/package/dist/bin/client.js

timeout "${START_TIMEOUT}s" systemctl start "$SERVICE"
wait_for_info_closed "$START_TIMEOUT" "$EXPECTED_VERSION" \
  || deployment_failure "new daemon did not report startup-closed version/info within ${START_TIMEOUT}s"
verify_no_host_vm_residue \
  || deployment_failure "new daemon startup reconciliation left VM run-state or cgroup residue"
MAIN_PID=$(systemctl show --property MainPID --value "$SERVICE")
[[ $MAIN_PID =~ ^[1-9][0-9]*$ ]] \
  || deployment_failure "systemd did not report a live daemon MainPID"
PROCESS_CWD=$(readlink "/proc/$MAIN_PID/cwd")
[[ $PROCESS_CWD == "$RELEASE_DIR/package" ]] \
  || deployment_failure "running daemon does not belong to the selected immutable release"
prove_admission_closed \
  || deployment_failure "closed daemon did not reject create with AdmissionClosed"
if [[ $SIMULATE_POST_SWITCH_FAILURE == true ]]; then
  deployment_failure "requested post-switch rollback simulation after closed-start gates"
fi
set_admission true
info=$(cli info 10 info --json)
json_assert_info "$info" "$EXPECTED_VERSION" true true
run_canary_smoke
wait_for_zero_vms 30 "$EXPECTED_VERSION" true \
  || deployment_failure "canary smoke left a VM registered"
verify_no_host_vm_residue \
  || deployment_failure "canary smoke left VM run-state or cgroup residue"

trap - ERR INT TERM
ADMISSION_CLOSED=false
printf 'deploy-host: deployed %s; admission open after bounded canary smoke\n' "$RELEASE_ID"
printf 'deploy-host: diagnostics: %s\n' "$DIAGNOSTIC"
