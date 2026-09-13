#!/usr/bin/env bash
set -euo pipefail

DEBIAN_SUITE=trixie
DEBIAN_SNAPSHOT=20260911T202741Z
DEBIAN_SECURITY_SNAPSHOT=20260911T204307Z
SOURCE_DATE_EPOCH=1789158461
NODE_VERSION=24.21.0
PNPM_VERSION=11.13.1
# npm registry dist.integrity sha512-svx2g7imUlQU59E+G6KMqt3elr9m7FQL+ut+cCuB8+C+TR8pXt9/n+A5Z0Co3ORQnFgt33mJH0VD/qMtN2RfJQ==
PNPM_SHA512=b2fc7683b8a6525414e7d13e1ba28caaddde96bf66ec540bfaeb7e702b81f3e0be4d1f295edf7f9fe0396740a8dce4509c582ddf79891f4543fea32d37645f25
# Guest-side pnpm store and cache. The shipped template's pnpm-workspace.yaml
# must resolve to these exact paths; assert_template_setting enforces that.
GUEST_PNPM_STORE=/var/lib/microvm/pnpm-store
GUEST_PNPM_CACHE=/var/lib/microvm/pnpm-cache
IMAGE_SIZE_MIB=2048
IMAGE_NAME=microvm-agent
TARGET_ARCH=
KERNEL=
KERNEL_SHA256=
OUTPUT_DIR=

usage() {
  cat >&2 <<'USAGE'
Usage: sudo scripts/build-guest-image.sh \
  --arch x86_64|aarch64 \
  --kernel /path/to/operator-built-kernel \
  --kernel-sha256 64_HEX_DIGEST \
  --output-dir /path/to/images \
  [--name microvm-agent] [--size-mib 2048]

Builds a pinned Debian 13 (Trixie) snapshot root image containing the maintained
Node.js 24 LTS, Python 3.13, and Git runtimes, pnpm 11, an offline-ready
Next.js template, the minimal PID 1, and the AF_VSOCK guest runner. The kernel
is deliberately not downloaded: an operator must supply a Firecracker-compatible
kernel and its trusted SHA-256 digest.
USAGE
}

while (($#)); do
  case "$1" in
    --arch) TARGET_ARCH=${2:-}; shift 2 ;;
    --kernel) KERNEL=${2:-}; shift 2 ;;
    --kernel-sha256) KERNEL_SHA256=${2:-}; shift 2 ;;
    --output-dir) OUTPUT_DIR=${2:-}; shift 2 ;;
    --name) IMAGE_NAME=${2:-}; shift 2 ;;
    --size-mib) IMAGE_SIZE_MIB=${2:-}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[[ $(uname -s) == Linux ]] || { echo "guest images can only be built on Linux" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "guest image build requires root" >&2; exit 1; }
[[ $TARGET_ARCH == x86_64 || $TARGET_ARCH == aarch64 ]] || { echo "--arch must be x86_64 or aarch64" >&2; exit 2; }
[[ -n $KERNEL && -f $KERNEL ]] || { echo "--kernel must name an existing operator-supplied file" >&2; exit 2; }
[[ $KERNEL_SHA256 =~ ^[0-9a-fA-F]{64}$ ]] || { echo "--kernel-sha256 must be exactly 64 hexadecimal characters" >&2; exit 2; }
[[ -n $OUTPUT_DIR ]] || { echo "--output-dir is required" >&2; exit 2; }
[[ $IMAGE_NAME =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || { echo "--name must match [a-z0-9][a-z0-9._-]{0,63}" >&2; exit 2; }
[[ $IMAGE_SIZE_MIB =~ ^[0-9]+$ && $IMAGE_SIZE_MIB -ge 512 && $IMAGE_SIZE_MIB -le 16384 ]] || { echo "--size-mib must be between 512 and 16384" >&2; exit 2; }

for tool in chroot cp curl file find go install mke2fs mmdebstrap sha256sum sha512sum tar truncate xz; do
  command -v "$tool" >/dev/null || { echo "required tool not found: $tool" >&2; exit 1; }
done

case $(uname -m) in
  x86_64) HOST_ARCH=x86_64 ;;
  aarch64|arm64) HOST_ARCH=aarch64 ;;
  *) echo "unsupported build host architecture: $(uname -m)" >&2; exit 1 ;;
esac
[[ $HOST_ARCH == "$TARGET_ARCH" ]] || {
  echo "target $TARGET_ARCH requires a matching native Linux build host; refusing an implicit foreign-architecture chroot" >&2
  exit 1
}

printf '%s  %s\n' "${KERNEL_SHA256,,}" "$KERNEL" | sha256sum --check --status || {
  echo "operator kernel SHA-256 mismatch" >&2
  exit 1
}
KERNEL_DESCRIPTION=$(file -b "$KERNEL")
case $TARGET_ARCH in
  x86_64)
    [[ $KERNEL_DESCRIPTION == *x86-64* || $KERNEL_DESCRIPTION == *"x86 boot executable"* ]] || {
      echo "kernel does not look like an x86_64 vmlinux/bzImage: $KERNEL_DESCRIPTION" >&2
      exit 1
    }
    GOARCH=amd64
    DEB_ARCH=amd64
    NODE_ARCH=x64
    NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
    ;;
  aarch64)
    [[ $KERNEL_DESCRIPTION == *ARM64* || $KERNEL_DESCRIPTION == *aarch64* ]] || {
      echo "kernel does not look like an aarch64 Image: $KERNEL_DESCRIPTION" >&2
      exit 1
    }
    GOARCH=arm64
    DEB_ARCH=arm64
    NODE_ARCH=arm64
    NODE_SHA256=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
    ;;
esac

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
mkdir -p "$OUTPUT_DIR"
NEXT_TEMPLATE_SOURCE=$REPO_DIR/guest/image/next-template
NEXT_INIT_SOURCE=$REPO_DIR/guest/image/microvm-next-init
[[ -f $NEXT_TEMPLATE_SOURCE/pnpm-lock.yaml && -x $NEXT_INIT_SOURCE ]] || {
  echo "Next.js image sources are incomplete" >&2
  exit 1
}
OUTPUT_DIR=$(cd -- "$OUTPUT_DIR" && pwd)
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/microvm-image.XXXXXXXX")
trap 'rm -rf -- "$WORK_DIR"' EXIT
ROOTFS=$WORK_DIR/rootfs
BUILD_DIR=$WORK_DIR/bin
IMAGE_TMP=$WORK_DIR/rootfs.raw
NODE_ARCHIVE=$WORK_DIR/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz
PNPM_ARCHIVE=$WORK_DIR/pnpm-$PNPM_VERSION.tgz
mkdir -p "$ROOTFS" "$BUILD_DIR"

export SOURCE_DATE_EPOCH
export DEBIAN_FRONTEND=noninteractive
MAIN_SNAPSHOT="deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ ${DEBIAN_SUITE} main"
SECURITY_SNAPSHOT="deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${DEBIAN_SECURITY_SNAPSHOT}/ ${DEBIAN_SUITE}-security main"

# mmdebstrap, not this shell, expands $1 in the two hook commands.
# shellcheck disable=SC2016
mmdebstrap \
  --mode=root \
  --variant=minbase \
  --architectures="$DEB_ARCH" \
  --components=main \
  --include=ca-certificates,git,python3 \
  --aptopt='Acquire::Check-Valid-Until "false"' \
  --aptopt='Acquire::Languages "none"' \
  --dpkgopt='path-exclude=/usr/share/doc/*' \
  --dpkgopt='path-exclude=/usr/share/man/*' \
  --dpkgopt='path-exclude=/usr/share/locale/*' \
  --customize-hook='printf "microvm\n" > "$1/etc/hostname"' \
  --customize-hook='rm -f "$1/etc/resolv.conf"; : > "$1/etc/resolv.conf"' \
  "$DEBIAN_SUITE" "$ROOTFS" "$MAIN_SNAPSHOT" "$SECURITY_SNAPSHOT"

NODE_FILENAME=node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --output "$NODE_ARCHIVE" "https://nodejs.org/dist/v$NODE_VERSION/$NODE_FILENAME"
printf '%s  %s\n' "$NODE_SHA256" "$NODE_ARCHIVE" | sha256sum --check --status || {
  echo "Node.js archive SHA-256 mismatch" >&2
  exit 1
}
tar -xJf "$NODE_ARCHIVE" -C "$ROOTFS/usr/local" --strip-components=1 --no-same-owner
ln -s /usr/local/bin/node "$ROOTFS/usr/bin/node"

curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --output "$PNPM_ARCHIVE" "https://registry.npmjs.org/pnpm/-/pnpm-$PNPM_VERSION.tgz"
printf '%s  %s\n' "$PNPM_SHA512" "$PNPM_ARCHIVE" | sha512sum --check --status || {
  echo "pnpm archive integrity mismatch" >&2
  exit 1
}
install -d -o 0 -g 0 -m 0755 "$ROOTFS/usr/local/lib/pnpm"
tar -xzf "$PNPM_ARCHIVE" -C "$ROOTFS/usr/local/lib/pnpm" \
  --strip-components=1 --no-same-owner
ln -s ../lib/pnpm/bin/pnpm.mjs "$ROOTFS/usr/local/bin/pnpm"

(
  cd "$REPO_DIR/guest"
  CGO_ENABLED=0 GOOS=linux GOARCH=$GOARCH go build \
    -trimpath -buildvcs=false -ldflags='-s -w -buildid=' \
    -o "$BUILD_DIR/microvm-guest" ./cmd/microvm-guest
  CGO_ENABLED=0 GOOS=linux GOARCH=$GOARCH go build \
    -trimpath -buildvcs=false -ldflags='-s -w -buildid=' \
    -o "$BUILD_DIR/microvm-http-proxy" ./cmd/microvm-http-proxy
  CGO_ENABLED=0 GOOS=linux GOARCH=$GOARCH go build \
    -trimpath -buildvcs=false -ldflags='-s -w -buildid=' \
    -o "$BUILD_DIR/microvm-init" ./cmd/microvm-init
)

install -D -o 0 -g 0 -m 0755 "$BUILD_DIR/microvm-guest" "$ROOTFS/usr/local/sbin/microvm-guest"
install -D -o 0 -g 0 -m 0755 "$BUILD_DIR/microvm-http-proxy" "$ROOTFS/usr/local/sbin/microvm-http-proxy"
install -D -o 0 -g 0 -m 0755 "$BUILD_DIR/microvm-init" "$ROOTFS/usr/local/sbin/microvm-init"
rm -f "$ROOTFS/sbin/init"
ln -s /usr/local/sbin/microvm-init "$ROOTFS/sbin/init"
install -D -o 0 -g 0 -m 0755 "$NEXT_INIT_SOURCE" "$ROOTFS/usr/local/bin/microvm-next-init"

if chroot "$ROOTFS" /usr/bin/getent passwd 1000 >/dev/null; then
  echo "snapshot already assigns uid 1000; refusing ambiguous execution identity" >&2
  exit 1
fi
chroot "$ROOTFS" /usr/sbin/useradd \
  --uid 1000 --user-group --home-dir /workspace --no-create-home \
  --shell /usr/sbin/nologin agent
install -d -o 1000 -g 1000 -m 0700 "$ROOTFS/workspace"
install -d -o 1000 -g 1000 -m 0755 \
  "$ROOTFS/opt/microvm/next-template" \
  "$ROOTFS$GUEST_PNPM_STORE" "$ROOTFS$GUEST_PNPM_CACHE"
cp -a "$NEXT_TEMPLATE_SOURCE/." "$ROOTFS/opt/microvm/next-template/"
chown -R 1000:1000 "$ROOTFS/opt/microvm/next-template"

# Image-time pnpm work runs as the guest's own scrubbed UID 1000 identity, so no
# host HOME, credential, proxy, or registry-auth state can reach the image.
run_as_agent() {
  chroot --userspec=1000:1000 "$ROOTFS" /usr/bin/env -i \
    HOME=/workspace USER=agent LOGNAME=agent \
    PATH=/usr/local/bin:/usr/bin:/bin CI=true "$@"
}
assert_template_setting() { # setting expected-value
  local actual
  actual=$(run_as_agent /usr/local/bin/pnpm \
    --dir /opt/microvm/next-template config get "$1") || {
    echo "cannot read template setting $1" >&2
    exit 1
  }
  [[ $actual == "$2" ]] || {
    echo "shipped Next.js template must resolve $1 to '$2' (got '$actual')" >&2
    exit 1
  }
}

# The chroot may reach the builder's resolver only while the online fetch both
# downloads the pinned packages and verifies the lockfile against pnpm's
# supply-chain policies. Runtime DNS is removed again before the offline work.
BUILD_RESOLV_CONF=/etc/resolv.conf
[[ -r /run/systemd/resolve/resolv.conf ]] && BUILD_RESOLV_CONF=/run/systemd/resolve/resolv.conf
cp -L "$BUILD_RESOLV_CONF" "$ROOTFS/etc/resolv.conf"
# Trust ordering: this online fetch is forced to re-verify the operator-owned
# lockfile (trustLockfile=false) and to allow the one registry read that
# verification needs (offline=false). Everything after it is offline and reads
# only the store this fetch just verified and populated; the shipped template
# carries trustLockfile=true with offline=true because re-verification needs
# registry metadata the final image deliberately cannot reach.
run_as_agent /usr/local/bin/pnpm --dir /opt/microvm/next-template fetch \
  --frozen-lockfile --config.offline=false --config.trust-lockfile=false \
  --store-dir "$GUEST_PNPM_STORE" --config.cache-dir="$GUEST_PNPM_CACHE"
rm -f "$ROOTFS/etc/resolv.conf"
: >"$ROOTFS/etc/resolv.conf"

# Fail closed before the resolver-less work: the shipped template must resolve
# to exactly the policy the offline contract depends on, or the image would
# attempt registry-backed re-verification it can never complete offline.
assert_template_setting trustLockfile true
assert_template_setting offline true
assert_template_setting storeDir "$GUEST_PNPM_STORE"
assert_template_setting cacheDir "$GUEST_PNPM_CACHE"

# pnpm fetch may create a virtual store without project links. Recreate
# node_modules strictly from the now-prewarmed content-addressed store, with
# retries disabled so any accidental network use fails immediately instead of
# waiting out DNS timeouts.
rm -rf "$ROOTFS/opt/microvm/next-template/node_modules"
run_as_agent /usr/local/bin/pnpm --dir /opt/microvm/next-template install \
  --offline --frozen-lockfile --config.package-import-method=copy \
  --config.fetch-retries=0 \
  --store-dir "$GUEST_PNPM_STORE" --config.cache-dir="$GUEST_PNPM_CACHE"
run_as_agent /usr/local/bin/pnpm --dir /opt/microvm/next-template run typecheck

# microvm-next-init materializes the template into an empty target, so pnpm's
# store and cache must stay outside the guest home.
[[ -z $(find "$ROOTFS/workspace" -mindepth 1 -print -quit) ]] || {
  echo "image-time pnpm work left files in /workspace; microvm-next-init requires an empty target" >&2
  exit 1
}

chown -R 0:0 "$ROOTFS/opt/microvm/next-template"
chmod -R u=rwX,go=rX "$ROOTFS/opt/microvm/next-template"
chown -R 1000:1000 "$ROOTFS$GUEST_PNPM_STORE" "$ROOTFS$GUEST_PNPM_CACHE"
install -d -o 0 -g 0 -m 0755 \
  "$ROOTFS/dev/pts" "$ROOTFS/proc" "$ROOTFS/run" \
  "$ROOTFS/sys/fs/cgroup/microvm-exec" "$ROOTFS/tmp"
chmod 1777 "$ROOTFS/tmp"

chroot "$ROOTFS" /usr/bin/node --version
chroot "$ROOTFS" /usr/local/bin/pnpm --version
chroot "$ROOTFS" /usr/bin/python3 --version
chroot "$ROOTFS" /usr/bin/git --version
rm -rf "$ROOTFS/var/lib/apt/lists"/* "$ROOTFS/var/cache/apt/archives"/*
find "$ROOTFS" -xdev -exec touch --no-dereference --date="@$SOURCE_DATE_EPOCH" {} +

truncate -s "${IMAGE_SIZE_MIB}M" "$IMAGE_TMP"
E2FSPROGS_FAKE_TIME=$SOURCE_DATE_EPOCH mke2fs \
  -q -t ext4 -F -L microvm-root \
  -U 45a31e1a-4b6e-4a04-b123-838ad1b03331 \
  -E lazy_itable_init=0,lazy_journal_init=0,root_owner=0:0 \
  -d "$ROOTFS" "$IMAGE_TMP"

IMAGE_OUTPUT=$OUTPUT_DIR/$IMAGE_NAME.raw
KERNEL_OUTPUT=$OUTPUT_DIR/$IMAGE_NAME.kernel
MANIFEST_OUTPUT=$OUTPUT_DIR/$IMAGE_NAME.json
CHECKSUM_OUTPUT=$OUTPUT_DIR/$IMAGE_NAME.sha256
install -o 0 -g 0 -m 0644 "$IMAGE_TMP" "$IMAGE_OUTPUT"
install -o 0 -g 0 -m 0644 "$KERNEL" "$KERNEL_OUTPUT"
cat >"$MANIFEST_OUTPUT" <<EOF
{"name":"$IMAGE_NAME","file":"$IMAGE_NAME.raw","arch":"$TARGET_ARCH","rootDevice":"/dev/vda","httpEndpoints":{"web":{"port":3000}}}
EOF
(
  cd "$OUTPUT_DIR"
  sha256sum "$IMAGE_NAME.raw" "$IMAGE_NAME.kernel" "$IMAGE_NAME.json" >"$IMAGE_NAME.sha256"
)

printf 'root image: %s\nkernel: %s\nmanifest: %s\nchecksums: %s\n' \
  "$IMAGE_OUTPUT" "$KERNEL_OUTPUT" "$MANIFEST_OUTPUT" "$CHECKSUM_OUTPUT"
