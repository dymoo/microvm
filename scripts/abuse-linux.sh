#!/usr/bin/env bash
# Hostile-user acceptance against an already-running daemon and its real jailed
# microVMs. The harness owns every VM it creates, bounds every host-side client,
# and sends only guest paths and guest programs across the execution boundary.
set -euo pipefail

: "${MICROVM_URL:?set MICROVM_URL to the real daemon endpoint}"
: "${MICROVM_TOKEN:?set MICROVM_TOKEN to an admin token}"
: "${MICROVM_IMAGE:?set MICROVM_IMAGE to an allowlisted image name}"
: "${MICROVM_RUN_STATE_DIR:?set MICROVM_RUN_STATE_DIR to the daemon runStateDir on this host}"
: "${MICROVM_CGROUP_ROOT:?set MICROVM_CGROUP_ROOT to the daemon jailer cgroup parent directory}"
MICROVM_BIN=${MICROVM_BIN:-microvm}
CLI_TIMEOUT_SECONDS=${MICROVM_ABUSE_CLI_TIMEOUT_SECONDS:-45}
ADMIN_TOKEN=$MICROVM_TOKEN
WORK_DIR=
ATTACKER_ID=
ATTACKER_TOKEN=
VICTIM_ID=
VICTIM_TOKEN=
CLEAN_ID=
CLEAN_TOKEN=
CLI_OUTPUT=
CLI_STATUS=0
LAST_BACKGROUND_PID=
CHECKS_PASSED=0

declare -a ALL_VM_IDS=()
declare -a BACKGROUND_REFS=()
declare -A ACTIVE_VM_TOKENS=()
declare -A VM_PROCESS_REFS=()

[[ $(uname -s) == Linux ]] || { echo "abuse-linux: real guest abuse requires Linux" >&2; exit 1; }
[[ $CLI_TIMEOUT_SECONDS =~ ^[0-9]+$ && $CLI_TIMEOUT_SECONDS -ge 10 && $CLI_TIMEOUT_SECONDS -le 120 ]] || {
  echo "abuse-linux: MICROVM_ABUSE_CLI_TIMEOUT_SECONDS must be an integer from 10 through 120" >&2
  exit 2
}
command -v "$MICROVM_BIN" >/dev/null || { echo "abuse-linux: client not found: $MICROVM_BIN" >&2; exit 1; }
command -v python3 >/dev/null || { echo "abuse-linux: host python3 is required" >&2; exit 1; }
command -v timeout >/dev/null || { echo "abuse-linux: GNU timeout is required" >&2; exit 1; }
[[ -d $MICROVM_RUN_STATE_DIR ]] || { echo "abuse-linux: daemon runStateDir does not exist" >&2; exit 1; }
[[ $MICROVM_CGROUP_ROOT == /sys/fs/cgroup/* && -d $MICROVM_CGROUP_ROOT ]] || {
  echo "abuse-linux: MICROVM_CGROUP_ROOT must be an existing directory below /sys/fs/cgroup" >&2
  exit 1
}

WORK_DIR=$(mktemp -d "${RUNNER_TEMP:-/tmp}/microvm-abuse.XXXXXXXX")

pass() {
  CHECKS_PASSED=$((CHECKS_PASSED + 1))
  printf 'abuse-linux: PASS %s\n' "$1"
}

die() {
  echo "abuse-linux: FAIL $*" >&2
  exit 1
}

json_field() {
  local field=$1 document=$2
  python3 -c 'import json,sys; value=json.load(sys.stdin)[sys.argv[1]]; print("true" if value is True else "false" if value is False else value)' \
    "$field" <<<"$document"
}

assert_json() {
  local label=$1 program=$2 document=$3
  if ! python3 -c "$program" <<<"$document"; then
    die "$label returned an unexpected JSON result"
  fi
}

capture_cli() {
  local token=$1
  shift
  CLI_OUTPUT=
  CLI_STATUS=0
  set +e
  CLI_OUTPUT=$(timeout --signal=TERM --kill-after=5s "${CLI_TIMEOUT_SECONDS}s" \
    env MICROVM_URL="$MICROVM_URL" MICROVM_TOKEN="$token" "$MICROVM_BIN" "$@" 2>&1)
  CLI_STATUS=$?
  set -e
  if (( CLI_STATUS == 124 || CLI_STATUS == 125 || CLI_STATUS == 126 || CLI_STATUS == 127 )); then
    die "bounded client failed or exceeded its ${CLI_TIMEOUT_SECONDS}s host deadline"
  fi
}

expect_error() {
  local label=$1 expected_status=$2 expected_tag=$3 expected_code=${4:--}
  (( CLI_STATUS == expected_status )) \
    || die "$label returned client status $CLI_STATUS, expected $expected_status"
  assert_json_args "$label" '
import json, sys
expected_tag, expected_code = sys.argv[1:3]
payload = json.load(sys.stdin)
assert payload.get("error") == expected_tag
if expected_code != "-":
    assert payload.get("code") == expected_code
' "$CLI_OUTPUT" "$expected_tag" "$expected_code"
  pass "$label"
}

# assert_json normally takes exactly three shell arguments. This variant passes
# values to the Python predicate without ever interpolating credentials or VM
# data into Python source.
assert_json_args() {
  local label=$1 program=$2 document=$3
  shift 3
  if ! python3 -c "$program" "$@" <<<"$document"; then
    die "$label returned an unexpected JSON result"
  fi
}

expect_exec_ok() {
  local label=$1
  (( CLI_STATUS == 0 )) || die "$label returned client status $CLI_STATUS, expected success"
  assert_json "$label" '
import json, sys
payload = json.load(sys.stdin)
assert payload["exitCode"] == 0
assert payload.get("signal") is None
assert payload["timedOut"] is False
assert payload["outputTruncated"] is False
' "$CLI_OUTPUT"
  pass "$label"
}

process_identity() {
  local pid=$1 stat fields
  local -a stat_fields
  [[ -r /proc/$pid/stat ]] || return 1
  stat=$(<"/proc/$pid/stat")
  fields=${stat##*) }
  read -r -a stat_fields <<<"$fields"
  printf '%s\n' "${stat_fields[19]}"
}

process_identity_alive() {
  local reference=$1 pid expected actual
  pid=${reference%%:*}
  expected=${reference#*:}
  [[ $reference =~ ^[1-9][0-9]*:[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  actual=$(process_identity "$pid") || return 1
  [[ $actual == "$expected" ]]
}

capture_process_refs() {
  local vm_id=$1 cgroup=$MICROVM_CGROUP_ROOT/$1 procs='' pid='' identity='' result=''
  for _ in {1..100}; do
    if [[ -r $cgroup/cgroup.procs ]]; then
      procs=$(<"$cgroup/cgroup.procs")
      [[ -n ${procs//[[:space:]]/} ]] && break
    fi
    sleep 0.05
  done
  [[ -n ${procs//[[:space:]]/} ]] || die "created VM has no process in its expected cgroup"
  for pid in $procs; do
    identity=$(process_identity "$pid") || die "created VM process identity disappeared during capture"
    result+="$pid:$identity"$'\n'
  done
  printf '%s' "$result"
}

wait_for_release() {
  local vm_id=$1 references=${2-} attempts=${3:-200} released ref try
  for ((try = 0; try < attempts; try++)); do
    released=true
    [[ ! -e $MICROVM_RUN_STATE_DIR/vms/$vm_id ]] || released=false
    [[ ! -e $MICROVM_CGROUP_ROOT/$vm_id ]] || released=false
    while IFS= read -r ref; do
      [[ -n $ref ]] || continue
      process_identity_alive "$ref" && released=false
    done <<<"$references"
    [[ $released == true ]] && return 0
    sleep 0.05
  done
  return 1
}

start_background_cli() {
  local token=$1 output_file=$2 identity
  shift 2
  env MICROVM_URL="$MICROVM_URL" MICROVM_TOKEN="$token" \
    timeout --signal=TERM --kill-after=5s "${CLI_TIMEOUT_SECONDS}s" "$MICROVM_BIN" "$@" \
    >"$output_file" 2>&1 &
  LAST_BACKGROUND_PID=$!
  identity=$(process_identity "$LAST_BACKGROUND_PID") \
    || die "could not capture bounded background client identity"
  BACKGROUND_REFS+=("$LAST_BACKGROUND_PID:$identity")
}

wait_background_cli() {
  local pid=$1 output_file=$2
  if wait "$pid"; then
    CLI_STATUS=0
  else
    CLI_STATUS=$?
  fi
  CLI_OUTPUT=$(<"$output_file")
  if (( CLI_STATUS == 124 || CLI_STATUS == 125 || CLI_STATUS == 126 || CLI_STATUS == 127 )); then
    die "bounded background client failed or exceeded its ${CLI_TIMEOUT_SECONDS}s host deadline"
  fi
}

create_vm() {
  local id_var=$1 token_var=$2 cpus=$3 mem_mib=$4 ttl_seconds=${5:-600} id token refs
  (( ${#ACTIVE_VM_TOKENS[@]} < 2 )) || die "refusing to own more than two VMs"
  capture_cli "$ADMIN_TOKEN" create --image "$MICROVM_IMAGE" --cpus "$cpus" --mem-mib "$mem_mib" --ttl-s "$ttl_seconds" --json
  (( CLI_STATUS == 0 )) || die "VM create failed with client status $CLI_STATUS"
  assert_json "VM create" '
import json, re, sys
payload = json.load(sys.stdin)
assert re.fullmatch(r"mvm-[0-9a-z]{8,24}", payload["vmId"])
assert isinstance(payload["sandboxToken"], str) and len(payload["sandboxToken"]) >= 32
assert payload["state"] == "running"
' "$CLI_OUTPUT"
  id=$(json_field vmId "$CLI_OUTPUT")
  token=$(json_field sandboxToken "$CLI_OUTPUT")
  # Register ownership before any host observation that can fail. EXIT cleanup
  # can now bounded-destroy the VM even if state/cgroup identity capture races.
  ALL_VM_IDS+=("$id")
  ACTIVE_VM_TOKENS["$id"]=$token
  VM_PROCESS_REFS["$id"]=
  [[ -d $MICROVM_RUN_STATE_DIR/vms/$id ]] || die "created VM has no run-state directory"
  refs=$(capture_process_refs "$id")
  VM_PROCESS_REFS["$id"]=$refs
  printf -v "$id_var" '%s' "$id"
  printf -v "$token_var" '%s' "$token"
}

mark_released() {
  local vm_id=$1 references=${VM_PROCESS_REFS[$1]-}
  [[ -n $references ]] || die "destroy completed without captured process identity proof"
  wait_for_release "$vm_id" "$references" \
    || die "destroy left VM run state, cgroup, or its original host process identity"
  unset 'ACTIVE_VM_TOKENS[$vm_id]'
}

cleanup() {
  local original_status=$? release_failed=false identity_missing=false reference references pid vm_id
  trap - EXIT INT TERM
  set +e

  # These are only the exact timeout wrapper identities this shell started.
  # Signalling them asks the wrapper to terminate its client and monitored child.
  for reference in "${BACKGROUND_REFS[@]:-}"; do
    [[ -n $reference ]] || continue
    if process_identity_alive "$reference"; then
      pid=${reference%%:*}
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  for _ in {1..50}; do
    local any_alive=false
    for reference in "${BACKGROUND_REFS[@]:-}"; do
      [[ -n $reference ]] || continue
      process_identity_alive "$reference" && any_alive=true
    done
    [[ $any_alive == false ]] && break
    sleep 0.1
  done
  for reference in "${BACKGROUND_REFS[@]:-}"; do
    [[ -n $reference ]] || continue
    if process_identity_alive "$reference"; then
      pid=${reference%%:*}
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done

  # At most two VMs are live at once. Background-client stopping, two 6s
  # destroy bounds, and two 4s release checks fit the workflow's 30s grace.
  # A later hosted-workflow always-step additionally stops the owning daemon.
  for vm_id in "${!ACTIVE_VM_TOKENS[@]}"; do
    timeout --signal=TERM --kill-after=1s 5s \
      env MICROVM_URL="$MICROVM_URL" MICROVM_TOKEN="$ADMIN_TOKEN" \
      "$MICROVM_BIN" destroy --vm "$vm_id" --json >/dev/null 2>&1 || true
    references=${VM_PROCESS_REFS[$vm_id]-}
    if ! wait_for_release "$vm_id" "$references" 80; then
      release_failed=true
    elif [[ -z $references ]]; then
      identity_missing=true
    fi
    unset 'ACTIVE_VM_TOKENS[$vm_id]'
  done
  rm -rf -- "$WORK_DIR"
  unset ADMIN_TOKEN ATTACKER_TOKEN VICTIM_TOKEN CLEAN_TOKEN CLI_OUTPUT
  if [[ $release_failed == true ]]; then
    echo "abuse-linux: cleanup could not prove registered VM state/cgroup release; hosted daemon teardown must finish it" >&2
    (( original_status != 0 )) || original_status=1
  elif [[ $identity_missing == true ]]; then
    echo "abuse-linux: cleanup removed registered VM state/cgroup, but process identity proof is unavailable because capture did not complete" >&2
    (( original_status != 0 )) || original_status=1
  fi
  exit "$original_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------- credentials
create_vm ATTACKER_ID ATTACKER_TOKEN 4 2048 7200
assert_json "resource-capped create response" '
import json, sys
payload = json.load(sys.stdin)
assert payload["cpus"] == 2 and payload["memMib"] == 1024
assert payload["expiresAtEpochMs"] - payload["createdAtEpochMs"] == 3_600_000
' "$CLI_OUTPUT"
pass "oversized public create request is capped in its returned VM values"

capture_cli "$ATTACKER_TOKEN" status --vm "$ATTACKER_ID" --json
(( CLI_STATUS == 0 )) || die "resource-capped VM status failed"
assert_json "resource-capped VM status" '
import json, sys
payload = json.load(sys.stdin)
assert payload["cpus"] == 2 and payload["memMib"] == 1024
assert payload["expiresAtEpochMs"] - payload["createdAtEpochMs"] == 3_600_000
' "$CLI_OUTPUT"
pass "resource caps persist in public status"

capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --json -- /usr/bin/python3 -c '
import json
import os
cpus = os.cpu_count()
with open("/proc/meminfo") as handle:
    mem_kib = int(next(line.split()[1] for line in handle if line.startswith("MemTotal:")))
assert cpus is not None and 1 <= cpus <= 2
assert 1 <= mem_kib <= 1024 * 1024
print(json.dumps({"cpus": cpus, "memKiB": mem_kib}))
'
expect_exec_ok "guest-visible processors and memory do not exceed daemon caps"
assert_json "guest-visible resource caps" '
import json, sys
outer = json.load(sys.stdin)
visible = json.loads(outer["stdout"])
assert 1 <= visible["cpus"] <= 2
assert 1 <= visible["memKiB"] <= 1024 * 1024
' "$CLI_OUTPUT"

create_vm VICTIM_ID VICTIM_TOKEN 1 512
[[ $ATTACKER_ID != "$VICTIM_ID" ]] || die "daemon returned duplicate VM identifiers"

capture_cli "$ATTACKER_TOKEN" create --image "$MICROVM_IMAGE" --cpus 1 --mem-mib 512 --ttl-s 60 --json
expect_error "sandbox credential cannot create VMs" 2 Forbidden

capture_cli "$ATTACKER_TOKEN" cleanup --json
expect_error "sandbox credential cannot invoke admin cleanup" 2 Forbidden

capture_cli "$ATTACKER_TOKEN" status --vm "$VICTIM_ID" --json
expect_error "sandbox credential cannot inspect another VM" 2 Forbidden

capture_cli "$ATTACKER_TOKEN" exec --vm "$VICTIM_ID" --json -- /usr/bin/true
expect_error "sandbox credential cannot execute in another VM" 2 Forbidden

capture_cli "$ATTACKER_TOKEN" destroy --vm "$VICTIM_ID" --json
expect_error "sandbox credential cannot destroy another VM" 2 Forbidden

capture_cli "$ATTACKER_TOKEN" list --json
(( CLI_STATUS == 0 )) || die "sandbox-scoped list failed"
assert_json_args "sandbox-scoped list" '
import json, sys
payload = json.load(sys.stdin)
assert [item["vmId"] for item in payload["vms"]] == [sys.argv[1]]
' "$CLI_OUTPUT" "$ATTACKER_ID"
pass "sandbox list reveals only its own VM"

capture_cli "forged-abuse-token-not-valid" list --json
expect_error "forged credential is unauthenticated" 2 Unauthenticated

capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --json -- /usr/bin/python3 -c '
import os
for name in ("MICROVM_TOKEN", "MICROVM_ADMIN_TOKEN", "MICROVM_URL", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN"):
    assert name not in os.environ
'
expect_exec_ok "host credentials and endpoint are absent from guest environment"

# --------------------------------------------------------- malformed/pathological
capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --json -- usr/bin/true
expect_error "relative executable is rejected before execution" 1 GuestExecError INVALID_REQUEST

for unsafe_cwd in /etc /workspace/../etc /workspace/../../ /workspace-sibling relative/path; do
  capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --cwd "$unsafe_cwd" --json -- /usr/bin/true
  expect_error "cwd traversal is rejected" 1 GuestExecError INVALID_REQUEST
done

capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --json -- /definitely/not/an/executable
expect_error "missing executable fails without poisoning the VM" 1 GuestExecError EXEC_FAILED

capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --json -- /workspace
expect_error "directory executable fails without poisoning the VM" 1 GuestExecError EXEC_FAILED

LARGE_ARGUMENT=$(python3 -c 'print("x" * 4097)')
capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --json -- /usr/bin/true "$LARGE_ARGUMENT"
unset LARGE_ARGUMENT
expect_error "oversized argv entry is rejected" 1 GuestExecError INVALID_REQUEST

MANY_ARGUMENTS=(/usr/bin/true)
for _ in {1..64}; do MANY_ARGUMENTS+=(x); done
capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --json -- "${MANY_ARGUMENTS[@]}"
unset MANY_ARGUMENTS
expect_error "excess argv entries are rejected" 1 GuestExecError INVALID_REQUEST

capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --timeout-ms 0 --json -- /usr/bin/true
expect_error "nonpositive timeout is rejected by the CLI" 1 CliUsageError

capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --max-output-bytes 0 --json -- /usr/bin/true
expect_error "nonpositive output cap is rejected by the CLI" 1 CliUsageError

capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --json -- /usr/bin/python3 -c '
import json, sys
assert sys.argv[1:] == ["", "--json", "--token", "guest-data"]
' "" --json --token guest-data
expect_exec_ok "delimiter preserves empty and option-like guest arguments"

capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --json -- /usr/bin/python3 -c '
from pathlib import Path
Path("/workspace/nested").mkdir(exist_ok=True)
'
expect_exec_ok "VM remains usable after invalid requests"
capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --cwd /workspace/nested --json -- /usr/bin/python3 -c '
import os
assert os.getcwd() == "/workspace/nested"
'
expect_exec_ok "valid descendant cwd remains usable"

# ---------------------------------------------------- credentials/devices/privilege
capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --json -- /usr/bin/python3 -c '
import errno
import os
from pathlib import Path

assert os.getuid() == os.geteuid() == 1000
assert os.getgid() == os.getegid() == 1000
assert os.getgroups() == []
status = Path("/proc/self/status").read_text().splitlines()
cap_eff = next(line.split()[1] for line in status if line.startswith("CapEff:"))
assert int(cap_eff, 16) == 0
assert Path("/etc/shadow").exists()

for protected in ("/etc/shadow", "/proc/1/environ"):
    try:
        open(protected, "rb").read(1)
    except PermissionError:
        pass
    else:
        raise AssertionError(f"read unexpectedly allowed: {protected}")

for protected in ("/etc/abuse-write", "/sys/fs/cgroup/cgroup.kill"):
    try:
        os.open(protected, os.O_WRONLY | os.O_CREAT, 0o600)
    except OSError as error:
        assert error.errno in (errno.EACCES, errno.EPERM, errno.EROFS)
    else:
        raise AssertionError(f"write unexpectedly allowed: {protected}")

for device in ("/dev/vda", "/dev/mem", "/dev/kmem", "/dev/kvm", "/dev/console"):
    if not os.path.exists(device):
        continue
    try:
        os.open(device, os.O_RDWR)
    except OSError as error:
        assert error.errno in (errno.EACCES, errno.EPERM, errno.ENXIO, errno.ENODEV)
    else:
        raise AssertionError(f"device unexpectedly openable: {device}")

for operation in (lambda: os.setuid(0), lambda: os.setgid(0), lambda: os.setgroups([0]), lambda: os.chroot("/")):
    try:
        operation()
    except PermissionError:
        pass
    else:
        raise AssertionError("privilege operation unexpectedly succeeded")

try:
    os.kill(1, 0)
except PermissionError:
    pass
else:
    raise AssertionError("workload can signal guest PID 1")

fd = os.open("/dev/null", os.O_RDWR)
os.close(fd)
'
expect_exec_ok "workload has uid 1000, no capabilities, and no sensitive access"

# --------------------------------------------------------------------- egress
capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --timeout-ms 5000 --json -- /usr/bin/python3 -c '
import os
import socket

assert set(os.listdir("/sys/class/net")) == {"lo"}
with open("/proc/net/route") as handle:
    ipv4_routes = [line.split() for line in handle.read().splitlines()[1:]]
assert all(route[0] == "lo" for route in ipv4_routes)
from pathlib import Path
ipv6_routes_path = Path("/proc/net/ipv6_route")
if ipv6_routes_path.exists():
    ipv6_routes = [line.split() for line in ipv6_routes_path.read_text().splitlines()]
    assert all(route[-1] == "lo" for route in ipv6_routes)

def denied(family, address):
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.settimeout(0.35)
    try:
        sock.connect(address)
    except OSError:
        return
    finally:
        sock.close()
    raise AssertionError(f"network connection unexpectedly succeeded: {address!r}")

# RFC 5737 / RFC 3849 documentation ranges cannot identify or probe private
# infrastructure even if a future image accidentally acquires a route.
denied(socket.AF_INET, ("192.0.2.1", 80))
if socket.has_ipv6:
    denied(socket.AF_INET6, ("2001:db8::1", 80))
'
expect_exec_ok "no external or metadata route exists; documentation-range egress is unavailable"

# ---------------------------------------------------------- output and deadlines
capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --max-output-bytes 8192 --timeout-ms 5000 --json -- /usr/bin/python3 -c '
import os
while True:
    os.write(1, b"O" * 4096)
    os.write(2, b"E" * 4096)
'
(( CLI_STATUS == 137 )) || die "dual-stream output flood returned status $CLI_STATUS, expected 137"
assert_json "dual-stream output flood" '
import json, sys
payload = json.load(sys.stdin)
stdout = payload["stdout"].encode()
stderr = payload["stderr"].encode()
assert payload["exitCode"] == 137 and payload["signal"] == "SIGKILL"
assert payload["outputTruncated"] is True and payload["timedOut"] is False
assert 0 < len(stdout) <= 8192 and 0 < len(stderr) <= 8192
assert len(stdout) == 8192 or len(stderr) == 8192
' "$CLI_OUTPUT"
pass "dual-stream output flood is capped and killed"

capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --timeout-ms 100 --max-output-bytes 1024 --json -- /usr/bin/sleep 5
(( CLI_STATUS == 137 )) || die "hard timeout returned status $CLI_STATUS, expected 137"
assert_json "hard timeout" '
import json, sys
payload = json.load(sys.stdin)
assert payload["exitCode"] == 137 and payload["signal"] == "SIGKILL"
assert payload["timedOut"] is True and payload["outputTruncated"] is False
' "$CLI_OUTPUT"
pass "hard timeout kills the workload"

# ---------------------------------------------------- descendant/cgroup escape
capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --timeout-ms 5000 --json -- /usr/bin/python3 -c '
import os, time
from pathlib import Path
if os.fork() == 0:
    time.sleep(1.5)
    Path("/workspace/plain-fork-escaped").write_text("escaped")
    os._exit(0)
os._exit(0)
'
expect_exec_ok "plain fork descendants are reaped before success"

capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --timeout-ms 5000 --json -- /usr/bin/python3 -c '
import os, time
from pathlib import Path
if os.fork() == 0:
    os.setsid()
    time.sleep(1.5)
    Path("/workspace/setsid-escaped").write_text("escaped")
    os._exit(0)
os._exit(0)
'
expect_exec_ok "setsid descendants cannot escape the exec cgroup"

capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --timeout-ms 5000 --json -- /usr/bin/python3 -c '
import os, time
from pathlib import Path
if os.fork() == 0:
    os.setsid()
    if os.fork() != 0:
        os._exit(0)
    time.sleep(1.5)
    Path("/workspace/double-fork-escaped").write_text("escaped")
    os._exit(0)
os._exit(0)
'
expect_exec_ok "double-fork descendants cannot escape the exec cgroup"

capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --timeout-ms 4000 --json -- /usr/bin/sleep 2
expect_exec_ok "post-descendant observation delay completes"
capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --json -- /usr/bin/python3 -c '
from pathlib import Path
for marker in ("plain-fork-escaped", "setsid-escaped", "double-fork-escaped"):
    assert not Path("/workspace", marker).exists()
'
expect_exec_ok "fork, setsid, and double-fork descendants left no delayed effects"

# ----------------------------------------------------------- PID/disk pressure
capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --timeout-ms 8000 --max-output-bytes 4096 --json -- /usr/bin/python3 -c '
import errno, json, os, time
children = 0
while children < 144:
    try:
        pid = os.fork()
    except OSError as error:
        print(json.dumps({"errno": error.errno, "children": children}))
        assert error.errno == errno.EAGAIN
        break
    if pid == 0:
        time.sleep(10)
        os._exit(0)
    children += 1
else:
    raise AssertionError("144 forks completed without hitting the per-exec PID ceiling")
os._exit(0) if False else None
'
expect_exec_ok "PID pressure hits the per-exec cgroup ceiling"
assert_json "PID pressure result" '
import json, sys
outer = json.load(sys.stdin)
inner = json.loads(outer["stdout"])
assert inner["errno"] == 11
assert 1 <= inner["children"] < 144
' "$CLI_OUTPUT"

capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --timeout-ms 15000 --max-output-bytes 1024 --json -- /usr/bin/python3 -c '
import os
path = "/workspace/pressure-32m.bin"
chunk = b"D" * (1024 * 1024)
with open(path, "wb", buffering=0) as handle:
    for _ in range(32):
        handle.write(chunk)
    os.fsync(handle.fileno())
assert os.path.getsize(path) == 32 * 1024 * 1024
print(os.path.getsize(path))
'
expect_exec_ok "bounded disk-write pressure writes exactly the 32 MiB harness cap"
assert_json "disk pressure result" '
import json, sys
payload = json.load(sys.stdin)
assert payload["stdout"] == "33554432\n"
' "$CLI_OUTPUT"

capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --json -- /usr/bin/python3 -c '
import os
root = "/sys/fs/cgroup/microvm-exec"
children = [name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))]
assert len(children) == 1
'
expect_exec_ok "completed hostile exec cgroups leave no guest residue"

# ------------------------------------------------------- concurrency/destruction
capture_cli "$VICTIM_TOKEN" exec --vm "$VICTIM_ID" --json -- /usr/bin/python3 -c '
from pathlib import Path
Path("/workspace/control-sentinel").write_text("victim-intact")
'
expect_exec_ok "control VM sentinel is prepared"

SLOW_FILE=$WORK_DIR/concurrent-slow.json
FAST_FILE=$WORK_DIR/concurrent-fast.json
start_background_cli "$ATTACKER_TOKEN" "$SLOW_FILE" exec --vm "$ATTACKER_ID" --timeout-ms 5000 --json -- /usr/bin/python3 -c '
import time
time.sleep(1.2)
print("slow")
'
SLOW_PID=$LAST_BACKGROUND_PID
start_background_cli "$ATTACKER_TOKEN" "$FAST_FILE" exec --vm "$ATTACKER_ID" --timeout-ms 5000 --json -- /usr/bin/python3 -c 'print("fast")'
FAST_PID=$LAST_BACKGROUND_PID
wait_background_cli "$SLOW_PID" "$SLOW_FILE"
SLOW_STATUS=$CLI_STATUS
SLOW_OUTPUT=$CLI_OUTPUT
wait_background_cli "$FAST_PID" "$FAST_FILE"
FAST_STATUS=$CLI_STATUS
FAST_OUTPUT=$CLI_OUTPUT
(( SLOW_STATUS == 0 && FAST_STATUS == 0 )) || die "concurrent exec requests did not both complete"
assert_json "slow concurrent exec" 'import json,sys; p=json.load(sys.stdin); assert p["exitCode"] == 0 and p["stdout"] == "slow\n"' "$SLOW_OUTPUT"
assert_json "fast concurrent exec" 'import json,sys; p=json.load(sys.stdin); assert p["exitCode"] == 0 and p["stdout"] == "fast\n"' "$FAST_OUTPUT"
unset SLOW_OUTPUT FAST_OUTPUT
pass "concurrent exec requests serialize without corruption"

capture_cli "$ATTACKER_TOKEN" exec --vm "$ATTACKER_ID" --json -- /usr/bin/python3 -c '
import os
import shutil
from pathlib import Path
root = Path("/workspace")
for child in list(root.iterdir()):
    if child.is_symlink() or child.is_file():
        child.unlink()
    else:
        shutil.rmtree(child)
assert list(root.iterdir()) == []
(root / "rebuilt-after-delete").write_text("usable")
'
expect_exec_ok "destructive workspace deletion stays inside the attacker VM"

capture_cli "$VICTIM_TOKEN" exec --vm "$VICTIM_ID" --json -- /usr/bin/python3 -c '
from pathlib import Path
assert Path("/workspace/control-sentinel").read_text() == "victim-intact"
assert not Path("/workspace/rebuilt-after-delete").exists()
'
expect_exec_ok "destructive attacker filesystem actions do not cross VM boundaries"

RACE_FILE=$WORK_DIR/destroy-race.json
start_background_cli "$ATTACKER_TOKEN" "$RACE_FILE" exec --vm "$ATTACKER_ID" --timeout-ms 10000 --json -- /usr/bin/sleep 5
RACE_PID=$LAST_BACKGROUND_PID
sleep 0.2
capture_cli "$ATTACKER_TOKEN" destroy --vm "$ATTACKER_ID" --json
(( CLI_STATUS == 0 )) || die "destroy racing an active exec failed with status $CLI_STATUS"
assert_json_args "destroy racing active exec" '
import json, sys
payload = json.load(sys.stdin)
assert payload["vmId"] == sys.argv[1] and payload["destroyed"] is True
' "$CLI_OUTPUT" "$ATTACKER_ID"
wait_background_cli "$RACE_PID" "$RACE_FILE"
(( CLI_STATUS != 0 )) || die "exec racing destroy unexpectedly completed normally"
(( CLI_STATUS != 124 && CLI_STATUS != 125 && CLI_STATUS != 126 && CLI_STATUS != 127 )) \
  || die "exec racing destroy escaped its host deadline"
assert_json "exec racing destroy" '
import json, sys
payload = json.load(sys.stdin)
if "error" in payload:
    assert payload["error"] in {"VmPoisoned", "GuestExecError", "Unauthenticated", "RpcClientError"}
else:
    assert payload["exitCode"] != 0
' "$CLI_OUTPUT"
mark_released "$ATTACKER_ID"
pass "destroy races an active exec and proves VM/cgroup/process release"

capture_cli "$ATTACKER_TOKEN" status --vm "$ATTACKER_ID" --json
expect_error "destroy revokes the sandbox credential" 2 Unauthenticated
ATTACKER_ID=
unset ATTACKER_TOKEN

capture_cli "$VICTIM_TOKEN" exec --vm "$VICTIM_ID" --json -- /usr/bin/python3 -c '
from pathlib import Path
assert Path("/workspace/control-sentinel").read_text() == "victim-intact"
print("healthy")
'
expect_exec_ok "daemon and control VM remain usable after hostile destroy race"

capture_cli "$VICTIM_TOKEN" destroy --vm "$VICTIM_ID" --json
(( CLI_STATUS == 0 )) || die "control VM destroy failed"
assert_json "control VM destroy" 'import json,sys; assert json.load(sys.stdin)["destroyed"] is True' "$CLI_OUTPUT"
mark_released "$VICTIM_ID"
VICTIM_ID=
unset VICTIM_TOKEN
pass "control VM destroy leaves no VM/cgroup/process residue"

# ------------------------------------------------------------ clean-VM canary
create_vm CLEAN_ID CLEAN_TOKEN 1 512
capture_cli "$CLEAN_TOKEN" exec --vm "$CLEAN_ID" --json -- /usr/bin/python3 -c '
import os
from pathlib import Path
assert os.getuid() == 1000
assert list(Path("/workspace").iterdir()) == []
print("clean-vm-usable")
'
expect_exec_ok "fresh clean VM is usable and has no attacker filesystem state"
assert_json "fresh clean VM output" 'import json,sys; assert json.load(sys.stdin)["stdout"] == "clean-vm-usable\n"' "$CLI_OUTPUT"

capture_cli "$ADMIN_TOKEN" list --json
(( CLI_STATUS == 0 )) || die "admin list failed after abuse"
assert_json_args "admin list after abuse" '
import json, sys
payload = json.load(sys.stdin)
assert [item["vmId"] for item in payload["vms"]] == [sys.argv[1]]
' "$CLI_OUTPUT" "$CLEAN_ID"
pass "daemon inventory contains only the fresh clean VM"

capture_cli "$CLEAN_TOKEN" exec --vm "$CLEAN_ID" --json -- /usr/bin/python3 -c '
import os
root = "/sys/fs/cgroup/microvm-exec"
children = [name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))]
assert len(children) == 1
'
expect_exec_ok "fresh VM has no hostile per-exec cgroup residue"

capture_cli "$CLEAN_TOKEN" destroy --vm "$CLEAN_ID" --json
(( CLI_STATUS == 0 )) || die "fresh clean VM destroy failed"
assert_json "fresh clean VM destroy" 'import json,sys; assert json.load(sys.stdin)["destroyed"] is True' "$CLI_OUTPUT"
mark_released "$CLEAN_ID"
CLEAN_ID=
unset CLEAN_TOKEN
pass "fresh clean VM destroy leaves no VM/cgroup/process residue"

capture_cli "$ADMIN_TOKEN" cleanup --json
(( CLI_STATUS == 0 )) || die "admin cleanup failed after abuse"
assert_json "admin cleanup after abuse" '
import json, sys
payload = json.load(sys.stdin)
assert payload["destroyed"] == [] and payload["failed"] == []
' "$CLI_OUTPUT"
pass "post-abuse admin cleanup is healthy and has nothing to reap"

capture_cli "$ADMIN_TOKEN" list --json
(( CLI_STATUS == 0 )) || die "final admin list failed"
assert_json "final admin list" 'import json,sys; assert json.load(sys.stdin)["vms"] == []' "$CLI_OUTPUT"

for vm_id in "${ALL_VM_IDS[@]}"; do
  references=${VM_PROCESS_REFS[$vm_id]-}
  [[ -n $references ]] || die "final release proof is missing an owned VM process identity"
  wait_for_release "$vm_id" "$references" \
    || die "final release proof found owned VM state, cgroup, or process residue"
done
if ! python3 -c '
from pathlib import Path
import sys
run_state_vms, cgroup_root = map(Path, sys.argv[1:3])
assert not run_state_vms.exists() or list(run_state_vms.iterdir()) == []
assert [entry for entry in cgroup_root.iterdir() if entry.is_dir()] == []
' "$MICROVM_RUN_STATE_DIR/vms" "$MICROVM_CGROUP_ROOT"; then
  die "final release proof found unexpected daemon VM state or cgroup residue"
fi
pass "final daemon inventory, run state, and cgroup tree contain no VM residue"

printf 'abuse-linux: hostile jailed-VM abuse passed (%d checks)\n' "$CHECKS_PASSED"
