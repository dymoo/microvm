#!/usr/bin/env bash
# Hosted Linux/KVM acceptance driver (GitHub ubuntu-24.04 or an equivalent
# native Linux root host). One boring script with subcommands; every real boot
# goes through the daemon's jailed Firecracker lifecycle — this script never
# invokes firecracker or jailer directly, and never skips a missing capability.
#
#   preflight  hard capability checks under the daemon's real root privilege
#   artifacts  verify + install pinned Firecracker/jailer/kernel/keyring (root)
#   tests      pnpm typecheck/build + vitest (structured zero-skip gate) + go -race
#   image      build the pinned guest image via scripts/build-guest-image.sh
#   daemon     boot the real daemon as an owned child, run guest-protocol and
#              two-VM acceptance, then prove release on native shutdown
#   clean      identity-verified fallback teardown; reports uncertainty and
#              never deletes diagnostic state to fake a green result
#
# Pins come from docs/runtime-artifacts.md (resolved by that research note and
# promoted by engineering review) and are passed as environment variables.
# Kernel digest labels are "local HTTPS observation (TOFU), demonstration-only
# CI fixture"; they are NOT upstream-published. No secret is ever printed,
# logged, or uploaded: the ephemeral admin token is masked before any output
# and only ever reaches the daemon through a ${ENV} config reference.
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
EVIDENCE_DIR=${MICROVM_CI_EVIDENCE_DIR:-/tmp/microvm-acceptance-evidence}
STAGE_DIR=

PRIVATE_PREFIX=/var/lib/microvm
BIN_DIR=$PRIVATE_PREFIX/bin
FIRECRACKER_INSTALL=$BIN_DIR/firecracker
JAILER_INSTALL=$BIN_DIR/jailer
IMAGES_DIR=$PRIVATE_PREFIX/images
RUN_STATE_DIR=$PRIVATE_PREFIX/run
KERNEL_INSTALL=$IMAGES_DIR/microvm.kernel
CGROUP_SLICE=/sys/fs/cgroup/microvm.slice
CI_STATE_DIR=/var/lib/microvm/ci
PORT=${MICROVM_CI_PORT:-9443}
URL=http://127.0.0.1:$PORT
FC_BASENAME=$(basename "$FIRECRACKER_INSTALL")

die() { echo "ci-acceptance: $*" >&2; exit 1; }

pin_hex() { # name value
  [[ $2 =~ ^[0-9a-f]{64}$ ]] || die "$1 must be a pinned 64-hex SHA-256 (got: ${2:-missing})"
}

require_pins() {
  local name
  for name in FIRECRACKER_URL FIRECRACKER_SHA256 FIRECRACKER_MEMBER JAILER_MEMBER \
    FIRECRACKER_BIN_SHA256 JAILER_BIN_SHA256 KERNEL_URL KERNEL_SHA256 \
    KERNEL_CONFIG_URL KERNEL_CONFIG_SHA256 KEYRING_URL KEYRING_SHA256; do
    [[ -n ${!name:-} ]] || die "missing pinned artifact variable: $name (see docs/runtime-artifacts.md)"
  done
  pin_hex FIRECRACKER_SHA256 "$FIRECRACKER_SHA256"
  pin_hex FIRECRACKER_BIN_SHA256 "$FIRECRACKER_BIN_SHA256"
  pin_hex JAILER_BIN_SHA256 "$JAILER_BIN_SHA256"
  pin_hex KERNEL_SHA256 "$KERNEL_SHA256"
  pin_hex KERNEL_CONFIG_SHA256 "$KERNEL_CONFIG_SHA256"
  pin_hex KEYRING_SHA256 "$KEYRING_SHA256"
}

fetch() { # url dest
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --output "$2" "$1"
}

verify_sha() { # expected file label
  printf '%s  %s\n' "$1" "$2" | sha256sum --check --status \
    || die "SHA-256 mismatch for $3 (pinned digest does not match the downloaded artifact)"
}

now_ms() { date +%s%3N; }

# ---------------------------------------------------------------- preflight --
# Runs under the same actual root privilege the daemon itself will use.
preflight() {
  [[ $EUID -eq 0 ]] || die "preflight must run with the daemon's real privilege (root)"
  [[ $(uname -s) == Linux ]] || die "hosted acceptance requires a native Linux host"
  [[ -e /dev/kvm && -c /dev/kvm ]] || die "no /dev/kvm character device; nested KVM is required and must not be skipped"
  exec {kvm_fd}<>"/dev/kvm" || die "/dev/kvm is not openable read/write (KVM access is a hard prerequisite)"
  exec {kvm_fd}>&-
  [[ $(stat -fc %T /sys/fs/cgroup) == cgroup2fs ]] || die "/sys/fs/cgroup is not a cgroup v2 mount"
  local controllers
  controllers=$(< /sys/fs/cgroup/cgroup.controllers)
  local needed
  for needed in cpu memory pids; do
    [[ " $controllers " == *" $needed "* ]] || die "cgroup v2 controller $needed is unavailable on this host"
  done
  local root_avail var_avail
  root_avail=$(df -BM --output=avail / | tail -1 | tr -dc '0-9')
  var_avail=$(df -BM --output=avail /var/lib | tail -1 | tr -dc '0-9')
  (( root_avail >= 7000 )) || die "only ${root_avail}MiB free on /; at least 7000MiB required"
  (( var_avail >= 7000 )) || die "only ${var_avail}MiB free on /var/lib; at least 7000MiB required"
  (( $(nproc) >= 2 )) || die "at least 2 CPUs are required"
  local tool
  for tool in git curl python3 openssl tar xz sha256sum file dpkg-deb go pnpm node; do
    command -v "$tool" >/dev/null || die "required tool not found: $tool"
  done
  [[ -x /usr/bin/flock ]] || die "util-linux flock not found at /usr/bin/flock (daemon kernel-lock prerequisite)"
  mkdir -p "$EVIDENCE_DIR"
  {
    echo "host: $(uname -srm)"
    echo "privilege: root (same privilege the daemon enforces at startup)"
    echo "cpus: $(nproc)"
    echo "kvm: /dev/kvm opened read/write"
    echo "cgroup2 controllers: $controllers"
    echo "disk avail MiB: /=$root_avail /var/lib=$var_avail"
    echo "node: $(node --version)"
    echo "pnpm: $(pnpm --version)"
    echo "go: $(go version)"
    echo "python3: $(python3 --version)"
  } >"$EVIDENCE_DIR/preflight.txt"
  echo "preflight passed (KVM, cgroup v2 controllers, disk, tools)"
}

# --------------------------------------------------------------- artifacts --
artifacts() {
  [[ $EUID -eq 0 ]] || die "artifacts must run as root"
  require_pins
  mkdir -p "$EVIDENCE_DIR"
  STAGE_DIR=$(mktemp -d /tmp/microvm-ci-artifacts.XXXXXXXX)
  trap 'rm -rf -- "$STAGE_DIR"' EXIT

  # mmdebstrap for the image build; Ubuntu archive signatures stay enforced.
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends mmdebstrap >/dev/null

  # Debian archive keyring from the pinned Trixie snapshot: the builder's
  # snapshot signatures must verify against 2025-era Debian keys that Ubuntu
  # 24.04's packaged keyring predates. The .deb digest is pinned from a local
  # observation; NO_PUBKEY failures are never bypassed with unauthenticated
  # apt options. check-valid-until=no in the builder only tolerates the pinned
  # historical snapshot timestamp; it never weakens signature verification.
  fetch "$KEYRING_URL" "$STAGE_DIR/keyring.deb"
  verify_sha "$KEYRING_SHA256" "$STAGE_DIR/keyring.deb" "debian-archive-keyring"
  dpkg -i "$STAGE_DIR/keyring.deb" >/dev/null

  # Official Firecracker release archive: upstream-published digest.
  fetch "$FIRECRACKER_URL" "$STAGE_DIR/firecracker.tgz"
  verify_sha "$FIRECRACKER_SHA256" "$STAGE_DIR/firecracker.tgz" "firecracker archive"
  local member
  while IFS= read -r member; do
    [[ $member == */* && $member != /* && $member != *..* ]] || die "unsafe archive entry: $member"
  done < <(tar -tzf "$STAGE_DIR/firecracker.tgz")
  tar -xzf "$STAGE_DIR/firecracker.tgz" -C "$STAGE_DIR"
  verify_sha "$FIRECRACKER_BIN_SHA256" "$STAGE_DIR/$FIRECRACKER_MEMBER" "firecracker binary"
  verify_sha "$JAILER_BIN_SHA256" "$STAGE_DIR/$JAILER_MEMBER" "jailer binary"
  # Keep acceptance-owned binaries under one root-owned prefix that is not
  # group- or world-writable. Do not depend on or change the shared
  # /usr/local tree.
  install -d -o 0 -g 0 -m 0755 "$PRIVATE_PREFIX" "$BIN_DIR"
  install -o 0 -g 0 -m 0755 "$STAGE_DIR/$FIRECRACKER_MEMBER" "$FIRECRACKER_INSTALL"
  install -o 0 -g 0 -m 0755 "$STAGE_DIR/$JAILER_MEMBER" "$JAILER_INSTALL"

  # Kernel + bound config from the first-party Firecracker CI bucket. Trust
  # label: local HTTPS observation (TOFU), demonstration-only fixture,
  # promoted by engineering review for this controlled acceptance run only.
  install -d -o 0 -g 0 -m 0755 "$IMAGES_DIR"
  install -d -o 0 -g 0 -m 0700 "$RUN_STATE_DIR"
  fetch "$KERNEL_URL" "$STAGE_DIR/vmlinux"
  verify_sha "$KERNEL_SHA256" "$STAGE_DIR/vmlinux" "guest kernel"
  fetch "$KERNEL_CONFIG_URL" "$STAGE_DIR/vmlinux.config"
  verify_sha "$KERNEL_CONFIG_SHA256" "$STAGE_DIR/vmlinux.config" "guest kernel config"
  install -o 0 -g 0 -m 0644 "$STAGE_DIR/vmlinux" "$KERNEL_INSTALL"

  {
    echo "firecracker archive: $FIRECRACKER_URL"
    echo "firecracker archive sha256: $FIRECRACKER_SHA256 (upstream-published)"
    echo "kernel: $KERNEL_URL"
    echo "kernel sha256: $KERNEL_SHA256 (local HTTPS observation / TOFU, demonstration-only CI fixture)"
    echo "kernel config sha256: $KERNEL_CONFIG_SHA256 (local HTTPS observation / TOFU; CONFIG_IKCONFIG-bound)"
    echo "keyring: $KEYRING_URL"
    echo "keyring sha256: $KEYRING_SHA256 (local observation; Debian snapshot signature verification stays enforced)"
    echo "boot evidence: deferred to the real KVM run; nothing here claims a successful boot"
  } >"$EVIDENCE_DIR/artifacts.txt"
  {
    "$FIRECRACKER_INSTALL" --version
    "$JAILER_INSTALL" --version
    file -b "$KERNEL_INSTALL"
  } >>"$EVIDENCE_DIR/artifacts.txt"
  echo "artifacts installed and digest-verified"
}

# ------------------------------------------------------------------- tests --
tests() {
  cd "$ROOT"
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm build
  chmod +x dist/bin/daemon.js dist/bin/client.js
  mkdir -p "$EVIDENCE_DIR"
  # Readable default reporter plus structured JSON counters; the zero-skip
  # gate reads machine-readable numbers, never ANSI human text.
  pnpm exec vitest run --reporter=default --reporter=json \
    --outputFile="$EVIDENCE_DIR/tests-vitest.json" | tee "$EVIDENCE_DIR/tests-vitest.txt"
  python3 - "$EVIDENCE_DIR/tests-vitest.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as handle:
    summary = json.load(handle)

executed = summary.get("numTotalTests", 0)
failed = (
    summary.get("numFailedTests", 0)
    + summary.get("numFailedTestSuites", 0)
    + summary.get("numSuiteErrors", 0)
)
unrun = (
    summary.get("numPendingTests", 0)
    + summary.get("numSkippedTests", 0)
    + summary.get("numTodoTests", 0)
)
if executed < 1:
    raise SystemExit("ci-acceptance: vitest executed no tests")
if failed:
    raise SystemExit(f"ci-acceptance: {failed} vitest test(s)/suite(s) failed")
if unrun:
    raise SystemExit(
        "ci-acceptance: "
        f"{unrun} vitest test(s) did not run; the Linux kernel-flock test must execute"
    )
print(f"ci-acceptance: vitest gate passed ({executed} executed, 0 failed, 0 skipped/pending)")
PY
  node --version >"$EVIDENCE_DIR/versions.txt"
  pnpm --version >>"$EVIDENCE_DIR/versions.txt"
  ( cd guest && CGO_ENABLED=1 go test -race ./... ) | tee "$EVIDENCE_DIR/tests-go.txt" >/dev/null
  go version >>"$EVIDENCE_DIR/versions.txt"
  echo "portable tests (structured zero-skip gate) and guest go -race tests passed"
}

# ------------------------------------------------------------------- image --
image() {
  [[ $EUID -eq 0 ]] || die "image build must run as root"
  pin_hex KERNEL_SHA256 "${KERNEL_SHA256:-}"
  [[ -f $KERNEL_INSTALL ]] || die "kernel missing at $KERNEL_INSTALL; run the artifacts phase first"
  mkdir -p "$EVIDENCE_DIR"
  local started finished
  started=$(now_ms)
  "$ROOT/scripts/build-guest-image.sh" \
    --arch x86_64 \
    --kernel "$KERNEL_INSTALL" \
    --kernel-sha256 "$KERNEL_SHA256" \
    --output-dir "$IMAGES_DIR" \
    --name node
  finished=$(now_ms)
  {
    echo "image build ms: $((finished - started))"
    echo "image size MiB: 2048 (builder default; jailerFsizeBytes 2GiB ceiling matches)"
  } >"$EVIDENCE_DIR/image-build.txt"
  cp "$IMAGES_DIR/node.json" "$IMAGES_DIR/node.sha256" "$EVIDENCE_DIR/"
  echo "guest image built"
}

# ------------------------------------------------------------------ daemon --
# Process start time (field 22) parsed after the comm field's closing paren,
# the same after-last-`)` approach accept-linux.sh uses for process identity:
# a comm containing spaces or parentheses cannot shift the field index.
stat_starttime() { # /proc/<pid>/stat content as $1
  local stat=${1##*) } fields
  IFS=' ' read -r -a fields <<<"$stat"
  printf '%s\n' "${fields[19]}"
}

process_start_identity() { # pid -> process start time
  local stat
  [[ -r /proc/$1/stat ]] || return 1
  stat=$(< "/proc/$1/stat")
  stat_starttime "$stat"
}

wait_for_port() { # pid seconds label
  local pid=$1 deadline=$(( $(date +%s) + $2 )) label=$3
  while (( $(date +%s) < deadline )); do
    if python3 -c 'import socket,sys; s=socket.create_connection(("127.0.0.1", int(sys.argv[1])), 1)' "$PORT" 2>/dev/null; then
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || { tail -20 "$EVIDENCE_DIR/daemon.log" >&2 || true; die "daemon exited before $label"; }
    sleep 0.5
  done
  tail -20 "$EVIDENCE_DIR/daemon.log" >&2 || true
  die "timed out waiting for $label"
}

enable_cgroup_controllers() { # dir
  local dir=$1 needed have
  for needed in cpu memory pids; do
    have=$(< "$dir/cgroup.controllers")
    [[ " $have " == *" $needed "* ]] || continue
    have=$(< "$dir/cgroup.subtree_control")
    [[ " $have " == *" $needed "* ]] && continue
    printf '+%s' "$needed" >> "$dir/cgroup.subtree_control"
  done
}

# Proves the daemon's native shutdown released every VM: no per-VM run-state
# entries and no child cgroup DIRECTORIES (expected cgroup control files are
# not leftovers). Inspection failure is a hard failure, never a silent pass;
# an empty walk is reported as positive proof; leftovers fail loudly and
# diagnostic state is never deleted here.
verify_vm_release() { # run_state_vms_dir cgroup_slice_dir
  local run_state_vms=$1 cgroup_slice=$2
  local leftovers=() entry walk
  if [[ -e $run_state_vms ]]; then
    walk=$(find "$run_state_vms" -mindepth 1 -maxdepth 1 -print) || {
      echo "ci-acceptance: cannot inspect $run_state_vms" >&2
      return 1
    }
    while IFS= read -r entry; do
      [[ -n $entry ]] && leftovers+=("run state $entry")
    done <<<"$walk"
  fi
  if [[ -d $cgroup_slice ]]; then
    walk=$(find "$cgroup_slice" -mindepth 1 -maxdepth 1 -type d -print) || {
      echo "ci-acceptance: cannot inspect $cgroup_slice" >&2
      return 1
    }
    while IFS= read -r entry; do
      [[ -n $entry ]] && leftovers+=("cgroup $entry")
    done <<<"$walk"
  fi
  if (( ${#leftovers[@]} > 0 )); then
    die "VM release is unproven after daemon shutdown; leftover: ${leftovers[*]} (state kept for diagnosis)"
  fi
  echo "ci-acceptance: release verified: no run-state or cgroup leftovers"
}

stop_daemon_bounded() { # pid -> succeeds only with a proven exit
  local pid=$1
  kill -TERM "$pid" 2>/dev/null || true
  local waited=0
  while kill -0 "$pid" 2>/dev/null && (( waited < 200 )); do
    sleep 0.1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  wait "$pid" 2>/dev/null || true
  return 0
}

daemon() {
  [[ $EUID -eq 0 ]] || die "daemon acceptance must run as root"
  require_pins
  mkdir -p "$EVIDENCE_DIR" "$CI_STATE_DIR"
  enable_cgroup_controllers /sys/fs/cgroup
  mkdir -p "$CGROUP_SLICE"
  enable_cgroup_controllers "$CGROUP_SLICE"
  # The jailer writes cpu/memory/pid ceilings into the VM's own cgroup below
  # this slice; the controllers must actually be delegated to the child path
  # or the boot would fail later with a much less specific error.
  local have_controllers needed
  have_controllers=$(< "$CGROUP_SLICE/cgroup.controllers")
  for needed in cpu memory pids; do
    [[ " $have_controllers " == *" $needed "* ]] \
      || die "cgroup controller $needed is not available to $CGROUP_SLICE; the jailer cannot enforce VM ceilings"
  done

  # Ephemeral admin credential: generated, masked, and never printed. It only
  # reaches the daemon through the config's ${MICROVM_ADMIN_TOKEN} reference.
  local admin_token started finished create_json vm_id vsock destroy_json
  local daemon_listen_ms protocol_vm_create_ms protocol_accept_ms two_vm_accept_ms
  local daemon_pid
  admin_token=$(openssl rand -hex 32)
  printf '::add-mask::%s\n' "$admin_token"

  cat >"$CI_STATE_DIR/daemon.json" <<EOF
{
  "listen": { "host": "127.0.0.1", "port": $PORT },
  "advertisedUrl": "$URL",
  "auth": { "adminTokens": ["\${MICROVM_ADMIN_TOKEN}"] },
  "firecracker": {
    "firecrackerBinary": "$FIRECRACKER_INSTALL",
    "flockBinary": "/usr/bin/flock",
    "jailerBinary": "$JAILER_INSTALL",
    "kernelImage": "$KERNEL_INSTALL",
    "imagesDir": "$IMAGES_DIR",
    "runStateDir": "$RUN_STATE_DIR",
    "jailerUidRange": [20000, 20099],
    "jailerGidRange": [20000, 20099],
    "jailerParentCgroup": "microvm.slice",
    "guestCidRange": [5000, 5099],
    "kernelArgs": "console=ttyS0 reboot=k panic=-1 pci=off nomodule random.trust_cpu=on root=/dev/vda rw init=/sbin/init",
    "bootTimeoutMs": 30000,
    "guestReadinessTimeoutMs": 30000,
    "vmmOverheadMib": 256,
    "maxPidsPerVm": 1024,
    "jailerFsizeBytes": 2147483648,
    "jailerNoFileLimit": 4096
  },
  "limits": {
    "maxVms": 4,
    "defaultCpus": 1,
    "maxCpus": 2,
    "defaultMemMib": 512,
    "maxMemMib": 1024,
    "maxTtlSeconds": 3600
  }
}
EOF
  chmod 0600 "$CI_STATE_DIR/daemon.json"

  client() { MICROVM_URL=$URL MICROVM_TOKEN=$admin_token node "$ROOT/dist/bin/client.js" "$@"; }

  # Failure/interrupt path: destroy what we created, stop the daemon we own,
  # and report — never claim green, never delete diagnostic state. The normal
  # path below performs the same teardown with hard verification instead.
  cleanup() {
    trap - EXIT INT TERM
    if [[ -n ${vm_id:-} ]]; then
      client destroy --vm "$vm_id" --json >/dev/null 2>&1 || true
    fi
    if [[ -n ${daemon_pid:-} ]] && kill -0 "$daemon_pid" 2>/dev/null; then
      if ! stop_daemon_bounded "$daemon_pid"; then
        kill -KILL "$daemon_pid" 2>/dev/null || true
        wait "$daemon_pid" 2>/dev/null || true
        echo "ci-acceptance: WARNING daemon ignored SIGTERM and was SIGKILLed; VM release is unproven; state kept for diagnosis" >&2
      fi
    fi
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # Owned child in this shell: wait/reap works and the pid file carries the
  # kernel start-time identity so the always-step cannot hit PID reuse. The
  # token rides an environment assignment prefix — never argv, never logged.
  started=$(now_ms)
  MICROVM_ADMIN_TOKEN=$admin_token node dist/bin/daemon.js --config "$CI_STATE_DIR/daemon.json" \
    >"$EVIDENCE_DIR/daemon.log" 2>&1 &
  daemon_pid=$!
  printf '%s:%s\n' "$daemon_pid" "$(process_start_identity "$daemon_pid")" >"$CI_STATE_DIR/daemon.pid"
  wait_for_port "$daemon_pid" 60 "the daemon to listen (prereq failure exits 5)"
  finished=$(now_ms)
  daemon_listen_ms=$((finished - started))

  # Guest exec v1 protocol acceptance against a VM the daemon booted through
  # the jailer. The vsock UDS lives inside the per-VM jailer chroot; see
  # vmLayout in src/host.ts — this only resolves the documented path.
  started=$(now_ms)
  create_json=$(client create --image node --cpus 1 --mem-mib 512 --ttl-s 900 --json)
  vm_id=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["vmId"])' <<<"$create_json")
  finished=$(now_ms)
  protocol_vm_create_ms=$((finished - started))
  unset create_json
  vsock="$RUN_STATE_DIR/vms/$vm_id/jailer/$FC_BASENAME/$vm_id/root/v.sock"
  [[ -S $vsock ]] || die "jailed VM $vm_id has no vsock socket at the documented layout path: $vsock"
  started=$(now_ms)
  "$ROOT/scripts/accept-guest-linux.sh" --vsock-uds "$vsock" | tee "$EVIDENCE_DIR/guest-protocol.log"
  finished=$(now_ms)
  protocol_accept_ms=$((finished - started))
  destroy_json=$(client destroy --vm "$vm_id" --json)
  python3 -c 'import json,sys; assert json.load(sys.stdin)["destroyed"] is True' <<<"$destroy_json"
  vm_id=

  # Full two-sandbox daemon/client acceptance (auth, isolation, capability
  # denial, timeouts, output bounds, process/cgroup/disk release).
  started=$(now_ms)
  MICROVM_URL=$URL MICROVM_TOKEN=$admin_token MICROVM_IMAGE=node \
    MICROVM_RUN_STATE_DIR="$RUN_STATE_DIR" MICROVM_CGROUP_ROOT="$CGROUP_SLICE" \
    MICROVM_BIN="$ROOT/dist/bin/client.js" \
    bash "$ROOT/scripts/accept-linux.sh" | tee "$EVIDENCE_DIR/accept-linux.log"
  finished=$(now_ms)
  two_vm_accept_ms=$((finished - started))

  # Native lifecycle stop, bounded and proven: the daemon's shutdown destroys
  # any remaining VMs; leftovers here are a failure, not something to clean up
  # quietly.
  if ! stop_daemon_bounded "$daemon_pid"; then
    tail -20 "$EVIDENCE_DIR/daemon.log" >&2 || true
    die "daemon did not exit within 20s of SIGTERM; VM release is unproven and state is left for diagnosis"
  fi
  rm -f "$CI_STATE_DIR/daemon.pid" "$CI_STATE_DIR/daemon.json"
  verify_vm_release "$RUN_STATE_DIR/vms" "$CGROUP_SLICE"

  {
    echo "host: ubuntu-24.04 GitHub-hosted runner, nested KVM (not representative of any Proxmox latency)"
    echo "daemon cold start to listening ms: $daemon_listen_ms"
    echo "protocol VM create (jailer boot + readiness) ms: $protocol_vm_create_ms"
    echo "guest protocol acceptance ms: $protocol_accept_ms"
    echo "two-VM daemon acceptance ms: $two_vm_accept_ms"
  } >"$EVIDENCE_DIR/timings.txt"
  echo "daemon acceptance passed"
}

# ------------------------------------------------------------------- clean --
# Always-step fallback: identity-verified kill of a daemon this job started,
# then release verification. Reports uncertainty with a failing exit instead
# of deleting diagnostic state; no-op when nothing is left to stop.
clean() {
  local record pid
  if [[ -f $CI_STATE_DIR/daemon.pid ]]; then
    record=$(< "$CI_STATE_DIR/daemon.pid")
    pid=${record%%:*}
    if process_identity_alive "$record"; then
      if ! stop_daemon_bounded "$pid"; then
        kill -KILL "$pid" 2>/dev/null || true
        sleep 1
        process_identity_alive "$record" \
          && die "daemon $record survived SIGKILL; VM release is unproven; state kept for diagnosis"
      fi
    fi
    rm -f "$CI_STATE_DIR/daemon.pid"
  fi
  if [[ -e $RUN_STATE_DIR/vms || -d $CGROUP_SLICE ]]; then
    verify_vm_release "$RUN_STATE_DIR/vms" "$CGROUP_SLICE"
  fi
  echo "clean finished"
}

case ${1:-} in
  preflight) preflight ;;
  artifacts) artifacts ;;
  tests) tests ;;
  image) image ;;
  daemon) daemon ;;
  clean) clean ;;
  *) echo "usage: scripts/ci-acceptance.sh <preflight|artifacts|tests|image|daemon|clean>" >&2; exit 2 ;;
esac
