#!/usr/bin/env bash
set -euo pipefail

DEBIAN_SUITE=trixie
DEBIAN_SNAPSHOT=20260911T202741Z
DEBIAN_SECURITY_SNAPSHOT=20260911T204307Z
SOURCE_DATE_EPOCH=1789158461
NODE_VERSION=24.21.0
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
Node.js 24 LTS and Python 3.13 runtimes, the minimal PID 1, and the AF_VSOCK
guest runner. The kernel is deliberately not downloaded: an operator must
supply a Firecracker-compatible kernel and its trusted SHA-256 digest.
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

for tool in chroot curl file find go install mke2fs mmdebstrap sha256sum tar truncate xz; do
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
OUTPUT_DIR=$(cd -- "$OUTPUT_DIR" && pwd)
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/microvm-image.XXXXXXXX")
trap 'rm -rf -- "$WORK_DIR"' EXIT
ROOTFS=$WORK_DIR/rootfs
BUILD_DIR=$WORK_DIR/bin
IMAGE_TMP=$WORK_DIR/rootfs.raw
NODE_ARCHIVE=$WORK_DIR/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz
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
  --include=ca-certificates,python3 \
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

(
  cd "$REPO_DIR/guest"
  CGO_ENABLED=0 GOOS=linux GOARCH=$GOARCH go build \
    -trimpath -buildvcs=false -ldflags='-s -w -buildid=' \
    -o "$BUILD_DIR/microvm-guest" ./cmd/microvm-guest
  CGO_ENABLED=0 GOOS=linux GOARCH=$GOARCH go build \
    -trimpath -buildvcs=false -ldflags='-s -w -buildid=' \
    -o "$BUILD_DIR/microvm-init" ./cmd/microvm-init
)

install -D -o 0 -g 0 -m 0755 "$BUILD_DIR/microvm-guest" "$ROOTFS/usr/local/sbin/microvm-guest"
install -D -o 0 -g 0 -m 0755 "$BUILD_DIR/microvm-init" "$ROOTFS/usr/local/sbin/microvm-init"
rm -f "$ROOTFS/sbin/init"
ln -s /usr/local/sbin/microvm-init "$ROOTFS/sbin/init"

if chroot "$ROOTFS" /usr/bin/getent passwd 1000 >/dev/null; then
  echo "snapshot already assigns uid 1000; refusing ambiguous execution identity" >&2
  exit 1
fi
chroot "$ROOTFS" /usr/sbin/useradd \
  --uid 1000 --user-group --home-dir /workspace --no-create-home \
  --shell /usr/sbin/nologin agent
install -d -o 1000 -g 1000 -m 0700 "$ROOTFS/workspace"
install -d -o 0 -g 0 -m 0755 \
  "$ROOTFS/dev/pts" "$ROOTFS/proc" "$ROOTFS/run" \
  "$ROOTFS/sys/fs/cgroup/microvm-exec" "$ROOTFS/tmp"
chmod 1777 "$ROOTFS/tmp"

chroot "$ROOTFS" /usr/bin/node --version
chroot "$ROOTFS" /usr/bin/python3 --version
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
{"name":"$IMAGE_NAME","file":"$IMAGE_NAME.raw","arch":"$TARGET_ARCH","rootDevice":"/dev/vda"}
EOF
(
  cd "$OUTPUT_DIR"
  sha256sum "$IMAGE_NAME.raw" "$IMAGE_NAME.kernel" "$IMAGE_NAME.json" >"$IMAGE_NAME.sha256"
)

printf 'root image: %s\nkernel: %s\nmanifest: %s\nchecksums: %s\n' \
  "$IMAGE_OUTPUT" "$KERNEL_OUTPUT" "$MANIFEST_OUTPUT" "$CHECKSUM_OUTPUT"
