#!/usr/bin/env bash
# Guest exec v1 protocol acceptance against an ALREADY-BOOTED jailed microVM.
#
# This script never boots a VM. Every Firecracker boot in this repository goes
# through the daemon's jailed boot lifecycle (src/firecracker.ts; invariant 2:
# the jailer is mandatory and no direct-firecracker path exists). The caller
# creates a VM with the real daemon CLI, resolves its host-side vsock UDS
# (src/host.ts vmLayout:
#   <runStateDir>/vms/<vmId>/jailer/<firecracker-basename>/<vmId>/root/v.sock),
# passes that socket here, and owns destroy/cleanup afterwards.
set -euo pipefail

VSOCK_UDS=
PYTHON_BIN=python3

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/accept-guest-linux.sh --vsock-uds /path/to/v.sock [--python /usr/bin/python3]

Exercises the guest exec v1 protocol through the real vsock of a jailed VM the
microvm daemon already booted. The caller owns the VM lifecycle:

  id=$(microvm create --image <name> ... --json | jq -r .vmId)
  sock="<runStateDir>/vms/$id/jailer/<firecracker-basename>/$id/root/v.sock"
  scripts/accept-guest-linux.sh --vsock-uds "$sock"
  microvm destroy --vm "$id" --json   # cleanup stays with the caller
USAGE
}

while (($#)); do
  case "$1" in
    --vsock-uds) VSOCK_UDS=${2:-}; shift 2 ;;
    --python) PYTHON_BIN=${2:-}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[[ $(uname -s) == Linux ]] || { echo "guest protocol acceptance requires Linux" >&2; exit 1; }
[[ -n $VSOCK_UDS && -S $VSOCK_UDS ]] || {
  echo "--vsock-uds must name the booted jailed VM's vsock socket; this script boots nothing" >&2
  exit 2
}
command -v "$PYTHON_BIN" >/dev/null || { echo "required tool not found: $PYTHON_BIN" >&2; exit 1; }

# No resources are owned here: the jailer tree and VM credentials belong to the
# daemon and the caller. Signals must terminate the run (128+signal), never
# resume the protocol exercise.
trap 'exit 130' INT
trap 'exit 143' TERM

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
"$PYTHON_BIN" "$SCRIPT_DIR/guest_protocol_acceptance.py" --vsock-uds "$VSOCK_UDS"
echo "guest protocol acceptance passed against the jailed VM's vsock"
