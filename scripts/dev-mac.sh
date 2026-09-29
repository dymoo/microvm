#!/usr/bin/env bash
# Real jailed-Firecracker development on an Apple Silicon Mac (M3 or later,
# macOS 15+): an arm64 Lima VM with nested KVM runs the same phases as
# .github/workflows/acceptance.yml through scripts/ci-acceptance.sh, with the
# aarch64 pins from docs/runtime-artifacts.md. Nothing here weakens a daemon
# prerequisite; the VM is a genuine Linux/KVM/cgroup v2 host.
#
#   scripts/dev-mac.sh up       create/start the VM, sync this checkout to ~/microvm
#   scripts/dev-mac.sh accept   up, then preflight/artifacts/tests/image/daemon
#   scripts/dev-mac.sh phase P  rerun one ci-acceptance.sh phase on the VM as-is
#   limactl shell microvm-dev   interactive shell (cd ~/microvm)
#
# The real-VSOCK peer test stays GitHub-hosted only (ci-acceptance.sh enforces it).
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
VM=microvm-dev

die() { echo "dev-mac: $*" >&2; exit 1; }

[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || die "requires an Apple Silicon Mac"
command -v limactl >/dev/null || die "limactl not found; brew install lima"

PINS=(
  FIRECRACKER_URL=https://github.com/firecracker-microvm/firecracker/releases/download/v1.17.0/firecracker-v1.17.0-aarch64.tgz
  FIRECRACKER_SHA256=e351ebe4f7a16b5873bbd51005d2e6767103cff4d5ebc829df2d3f95a93e2256
  FIRECRACKER_MEMBER=release-v1.17.0-aarch64/firecracker-v1.17.0-aarch64
  JAILER_MEMBER=release-v1.17.0-aarch64/jailer-v1.17.0-aarch64
  FIRECRACKER_BIN_SHA256=fe726e0b43c04363ac07e358be4dee982c3947c65ed3ae10c770fef5e1cd756c
  JAILER_BIN_SHA256=4d8d2dd4dfc1d47932b2bd261479181dd0c54f0a2f32714421a7e7f9f07ddec8
  KERNEL_URL=https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20260909-a8e1c3830545-0/aarch64/vmlinux-6.18.44
  KERNEL_SHA256=3b0233769ed8c89f1f47fdbcc4ff9300a2b1b5c618e25ade966a484481b151dc
  KERNEL_CONFIG_URL=https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20260909-a8e1c3830545-0/aarch64/vmlinux-6.18.44.config
  KERNEL_CONFIG_SHA256=9d9438039dc83026d0c86085e00acfec0c0a49454b35203eb7b315708f17a1dd
  KEYRING_URL=https://snapshot.debian.org/archive/debian/20260911T202741Z/pool/main/d/debian-archive-keyring/debian-archive-keyring_2025.1_all.deb
  KEYRING_SHA256=9ea7778e443144ca490668737a8ab22dd3e748bb99e805e22ec055abeb3c7fac
)

in_vm() { limactl shell --workdir / "$VM" bash -c "cd ~/microvm && $1"; }
as_root() { in_vm "sudo env PATH=\"\$PATH\" MICROVM_CI_HUGE_PAGES=2M ${PINS[*]} bash scripts/ci-acceptance.sh $1"; }

up() {
  if ! limactl list -q | grep -qx "$VM"; then
    limactl create --tty=false --name="$VM" \
      --set ".mounts=[{\"location\":\"$ROOT\",\"writable\":false}]" \
      "$ROOT/deploy/lima/microvm-dev.yaml"
  fi
  [[ $(limactl list --format '{{.Status}}' "$VM") == Running ]] || limactl start --tty=false "$VM"
  # The VM's bash, not this shell, expands $1 and ~.
  # shellcheck disable=SC2016
  limactl shell --workdir / "$VM" bash -c \
    'rsync -a --delete --exclude=node_modules --exclude=dist "$1/" ~/microvm/' _ "$ROOT"
}

clean_on_exit() {
  trap 'as_root clean || echo "dev-mac: clean reported leftovers; state kept in the VM for diagnosis" >&2' EXIT
}

accept() {
  up
  in_vm 'mkdir -p /tmp/microvm-acceptance-evidence'
  clean_on_exit
  as_root preflight
  as_root artifacts
  in_vm 'bash scripts/ci-acceptance.sh tests'
  as_root image
  as_root daemon
  echo "dev-mac: acceptance passed; evidence in $VM:/tmp/microvm-acceptance-evidence"
}

case ${1:-} in
  up) up ;;
  accept) accept ;;
  phase)
    [[ -n ${2:-} ]] || die "usage: $0 phase <ci-acceptance.sh phase>"
    [[ $2 != daemon ]] || clean_on_exit
    if [[ $2 == tests ]]; then in_vm 'bash scripts/ci-acceptance.sh tests'; else as_root "$2"; fi
    ;;
  *) die "usage: $0 up|accept|phase <name>" ;;
esac
