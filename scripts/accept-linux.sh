#!/usr/bin/env bash
set -euo pipefail

: "${MICROVM_URL:?set MICROVM_URL to the real daemon endpoint}"
: "${MICROVM_TOKEN:?set MICROVM_TOKEN to an admin token}"
: "${MICROVM_IMAGE:?set MICROVM_IMAGE to an allowlisted image name}"
: "${MICROVM_RUN_STATE_DIR:?set MICROVM_RUN_STATE_DIR to the daemon runStateDir on this host}"
: "${MICROVM_CGROUP_ROOT:?set MICROVM_CGROUP_ROOT to the daemon jailer cgroup parent directory}"
MICROVM_BIN=${MICROVM_BIN:-microvm}
ADMIN_TOKEN=$MICROVM_TOKEN
VM1_ID=
VM2_ID=
VM1_TOKEN=
VM2_TOKEN=
VM1_PROCESS_REFS=
VM2_PROCESS_REFS=

[[ $(uname -s) == Linux ]] || { echo "daemon acceptance requires Linux" >&2; exit 1; }
command -v "$MICROVM_BIN" >/dev/null || { echo "microvm client not found: $MICROVM_BIN" >&2; exit 1; }
command -v python3 >/dev/null || { echo "host python3 is required" >&2; exit 1; }
[[ -d $MICROVM_RUN_STATE_DIR ]] || { echo "daemon runStateDir does not exist: $MICROVM_RUN_STATE_DIR" >&2; exit 1; }
[[ $MICROVM_CGROUP_ROOT == /sys/fs/cgroup/* && -d $MICROVM_CGROUP_ROOT ]] || {
  echo "MICROVM_CGROUP_ROOT must be an existing directory below /sys/fs/cgroup" >&2
  exit 1
}

json_field() {
  local field=$1
  local document=$2
  python3 -c 'import json,sys; value=json.load(sys.stdin)[sys.argv[1]]; print("true" if value is True else "false" if value is False else value)' "$field" <<<"$document"
}

assert_json() {
  local program=$1
  local document=$2
  python3 -c "$program" <<<"$document"
}

capture_process_refs() {
  local vm_id=$1
  local cgroup=$MICROVM_CGROUP_ROOT/$vm_id
  local procs=
  for _ in {1..100}; do
    if [[ -r $cgroup/cgroup.procs ]]; then
      procs=$(<"$cgroup/cgroup.procs")
      [[ -n ${procs//[[:space:]]/} ]] && break
    fi
    sleep 0.05
  done
  [[ -n ${procs//[[:space:]]/} ]] || {
    echo "VM $vm_id has no live process in its expected cgroup $cgroup" >&2
    return 1
  }
  python3 - "$procs" <<'PY'
from pathlib import Path
import sys

pids = sys.argv[1].split()
if not pids:
    raise SystemExit("cgroup.procs was empty")
for pid in pids:
    stat = Path("/proc", pid, "stat").read_text()
    fields_after_comm = stat[stat.rfind(")") + 2:].split()
    print(f"{pid}:{fields_after_comm[19]}")
PY
}

process_identity_alive() {
  local reference=$1
  python3 - "$reference" <<'PY'
from pathlib import Path
import sys

pid, expected_start = sys.argv[1].split(":", 1)
try:
    stat = Path("/proc", pid, "stat").read_text()
except FileNotFoundError:
    raise SystemExit(1)
fields_after_comm = stat[stat.rfind(")") + 2:].split()
raise SystemExit(0 if fields_after_comm[19] == expected_start else 1)
PY
}

wait_for_release() {
  local vm_id=$1
  local process_refs=$2
  local released ref
  for _ in {1..200}; do
    released=true
    [[ ! -e $MICROVM_RUN_STATE_DIR/vms/$vm_id ]] || released=false
    [[ ! -e $MICROVM_CGROUP_ROOT/$vm_id ]] || released=false
    while IFS= read -r ref; do
      [[ -n $ref ]] || continue
      if process_identity_alive "$ref"; then
        released=false
      fi
    done <<<"$process_refs"
    [[ $released == true ]] && return 0
    sleep 0.05
  done
  echo "VM $vm_id leaked run state, cgroup, or its original process identity after destroy" >&2
  return 1
}

cleanup() {
  local vm_id
  # Run once even if a second signal arrives; default disposition then applies.
  trap - EXIT INT TERM
  for vm_id in "${VM1_ID:-}" "${VM2_ID:-}"; do
    [[ -n $vm_id ]] || continue
    MICROVM_TOKEN=$ADMIN_TOKEN "$MICROVM_BIN" destroy --vm "$vm_id" --json >/dev/null 2>&1 || true
  done
}
# Cleanup belongs to EXIT only. INT/TERM must exit immediately (128+signal) so
# the acceptance body can never resume provisioning after the handler runs;
# `exit` unwinds through the EXIT trap, keeping best-effort destroy behavior.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

CREATE1_JSON=$(MICROVM_TOKEN=$ADMIN_TOKEN "$MICROVM_BIN" create --image "$MICROVM_IMAGE" --cpus 2 --mem-mib 1024 --ttl-s 300 --json)
VM1_ID=$(json_field vmId "$CREATE1_JSON")
VM1_TOKEN=$(json_field sandboxToken "$CREATE1_JSON")
CREATE2_JSON=$(MICROVM_TOKEN=$ADMIN_TOKEN "$MICROVM_BIN" create --image "$MICROVM_IMAGE" --cpus 1 --mem-mib 768 --ttl-s 300 --json)
VM2_ID=$(json_field vmId "$CREATE2_JSON")
VM2_TOKEN=$(json_field sandboxToken "$CREATE2_JSON")
[[ -n $VM1_ID && -n $VM1_TOKEN && -n $VM2_ID && -n $VM2_TOKEN && $VM1_ID != "$VM2_ID" ]] || {
  echo "create omitted distinct VM ids or one-time sandbox tokens" >&2
  exit 1
}
[[ -d $MICROVM_RUN_STATE_DIR/vms/$VM1_ID && -d $MICROVM_RUN_STATE_DIR/vms/$VM2_ID ]] || {
  echo "daemon reported create before both VM run-state directories existed" >&2
  exit 1
}
VM1_PROCESS_REFS=$(capture_process_refs "$VM1_ID")
VM2_PROCESS_REFS=$(capture_process_refs "$VM2_ID")

NODE_JSON=$(MICROVM_TOKEN=$VM1_TOKEN "$MICROVM_BIN" exec --vm "$VM1_ID" --json -- /usr/bin/node --version)
assert_json 'import json,re,sys; v=json.load(sys.stdin); assert v["exitCode"] == 0 and re.fullmatch(r"v\d+\.\d+\.\d+\s*", v["stdout"]); assert v["stderr"] == ""' "$NODE_JSON"
PYTHON_JSON=$(MICROVM_TOKEN=$VM2_TOKEN "$MICROVM_BIN" exec --vm "$VM2_ID" --json -- /usr/bin/python3 --version)
assert_json 'import json,re,sys; v=json.load(sys.stdin); assert v["exitCode"] == 0 and re.fullmatch(r"Python 3\.\d+\.\d+\s*", v["stdout"])' "$PYTHON_JSON"

MARKER1_JSON=$(MICROVM_TOKEN=$VM1_TOKEN "$MICROVM_BIN" exec --vm "$VM1_ID" --json -- /usr/bin/python3 -c "from pathlib import Path; Path('/workspace/marker-one').write_text('one')")
MARKER2_JSON=$(MICROVM_TOKEN=$VM2_TOKEN "$MICROVM_BIN" exec --vm "$VM2_ID" --json -- /usr/bin/python3 -c "from pathlib import Path; Path('/workspace/marker-two').write_text('two')")
assert_json 'import json,sys; assert json.load(sys.stdin)["exitCode"] == 0' "$MARKER1_JSON"
assert_json 'import json,sys; assert json.load(sys.stdin)["exitCode"] == 0' "$MARKER2_JSON"
ISOLATION1_JSON=$(MICROVM_TOKEN=$VM1_TOKEN "$MICROVM_BIN" exec --vm "$VM1_ID" --json -- /usr/bin/python3 -c "from pathlib import Path; assert Path('/workspace/marker-one').read_text() == 'one'; assert not Path('/workspace/marker-two').exists()")
ISOLATION2_JSON=$(MICROVM_TOKEN=$VM2_TOKEN "$MICROVM_BIN" exec --vm "$VM2_ID" --json -- /usr/bin/python3 -c "from pathlib import Path; assert Path('/workspace/marker-two').read_text() == 'two'; assert not Path('/workspace/marker-one').exists()")
assert_json 'import json,sys; assert json.load(sys.stdin)["exitCode"] == 0' "$ISOLATION1_JSON"
assert_json 'import json,sys; assert json.load(sys.stdin)["exitCode"] == 0' "$ISOLATION2_JSON"

set +e
CROSS1_OUTPUT=$(MICROVM_TOKEN=$VM1_TOKEN "$MICROVM_BIN" exec --vm "$VM2_ID" --json -- /usr/bin/true 2>&1)
CROSS1_STATUS=$?
CROSS2_OUTPUT=$(MICROVM_TOKEN=$VM2_TOKEN "$MICROVM_BIN" exec --vm "$VM1_ID" --json -- /usr/bin/true 2>&1)
CROSS2_STATUS=$?
set -e
[[ $CROSS1_STATUS -eq 2 && $CROSS2_STATUS -eq 2 ]] || { echo "cross-VM sandbox scope was not rejected as Forbidden" >&2; exit 1; }
assert_json 'import json,sys; assert json.load(sys.stdin)["error"] == "Forbidden"' "$CROSS1_OUTPUT"
assert_json 'import json,sys; assert json.load(sys.stdin)["error"] == "Forbidden"' "$CROSS2_OUTPUT"

LIST1_JSON=$(MICROVM_TOKEN=$VM1_TOKEN "$MICROVM_BIN" list --json)
LIST2_JSON=$(MICROVM_TOKEN=$VM2_TOKEN "$MICROVM_BIN" list --json)
assert_json "import json,sys; v=json.load(sys.stdin); assert [item['vmId'] for item in v['vms']] == ['$VM1_ID']" "$LIST1_JSON"
assert_json "import json,sys; v=json.load(sys.stdin); assert [item['vmId'] for item in v['vms']] == ['$VM2_ID']" "$LIST2_JSON"

set +e
INVALID_OUTPUT=$(MICROVM_TOKEN=$VM1_TOKEN "$MICROVM_BIN" exec --vm "$VM1_ID" --cwd /etc --json -- /usr/bin/true 2>&1)
INVALID_STATUS=$?
set -e
[[ $INVALID_STATUS -eq 1 ]] || { echo "unsafe cwd returned $INVALID_STATUS, expected operation error" >&2; exit 1; }
assert_json 'import json,sys; v=json.load(sys.stdin); assert v["error"] == "GuestExecError" and v["code"] == "INVALID_REQUEST"' "$INVALID_OUTPUT"

set +e
SHADOW_JSON=$(MICROVM_TOKEN=$VM1_TOKEN "$MICROVM_BIN" exec --vm "$VM1_ID" --json -- /usr/bin/python3 -c "open('/etc/shadow').read()" 2>/dev/null)
SHADOW_STATUS=$?
set -e
[[ $SHADOW_STATUS -eq 1 ]] || { echo "unprivileged command read /etc/shadow or returned wrong status" >&2; exit 1; }
assert_json 'import json,sys; v=json.load(sys.stdin); assert v["exitCode"] != 0 and "PermissionError" in v["stderr"]' "$SHADOW_JSON"

set +e
NETWORK_JSON=$(MICROVM_TOKEN=$VM2_TOKEN "$MICROVM_BIN" exec --vm "$VM2_ID" --timeout-ms 2000 --json -- /usr/bin/python3 -c "import socket; s=socket.socket(); s.settimeout(.5); s.connect(('1.1.1.1',53))" 2>/dev/null)
NETWORK_STATUS=$?
set -e
[[ $NETWORK_STATUS -ne 0 ]] || { echo "guest unexpectedly reached an external network" >&2; exit 1; }
assert_json 'import json,sys; assert json.load(sys.stdin)["exitCode"] != 0' "$NETWORK_JSON"

set +e
TIMEOUT_JSON=$(MICROVM_TOKEN=$VM1_TOKEN "$MICROVM_BIN" exec --vm "$VM1_ID" --timeout-ms 50 --json -- /usr/bin/sleep 2 2>/dev/null)
TIMEOUT_STATUS=$?
set -e
[[ $TIMEOUT_STATUS -eq 137 ]] || { echo "timeout returned $TIMEOUT_STATUS, expected 137" >&2; exit 1; }
assert_json 'import json,sys; v=json.load(sys.stdin); assert v["exitCode"] == 137 and v["signal"] == "SIGKILL" and v["timedOut"] is True' "$TIMEOUT_JSON"

set +e
TRUNCATED_JSON=$(MICROVM_TOKEN=$VM2_TOKEN "$MICROVM_BIN" exec --vm "$VM2_ID" --max-output-bytes 1024 --json -- /usr/bin/python3 -c "import os; exec(\"while True: os.write(1,b'x'*4096)\")" 2>/dev/null)
TRUNCATED_STATUS=$?
set -e
[[ $TRUNCATED_STATUS -eq 137 ]] || { echo "output limit returned $TRUNCATED_STATUS, expected killed command status 137" >&2; exit 1; }
assert_json 'import json,sys; v=json.load(sys.stdin); assert len(v["stdout"].encode()) == 1024 and v["outputTruncated"] is True and v["timedOut"] is False' "$TRUNCATED_JSON"

set +e
MICROVM_TOKEN=$VM1_TOKEN "$MICROVM_BIN" cleanup --json >/dev/null 2>&1
CLEANUP_STATUS=$?
set -e
[[ $CLEANUP_STATUS -eq 2 ]] || { echo "sandbox token was allowed to run admin cleanup" >&2; exit 1; }

STATUS1_JSON=$(MICROVM_TOKEN=$VM1_TOKEN "$MICROVM_BIN" status --vm "$VM1_ID" --json)
STATUS2_JSON=$(MICROVM_TOKEN=$VM2_TOKEN "$MICROVM_BIN" status --vm "$VM2_ID" --json)
[[ -n $(json_field state "$STATUS1_JSON") && -n $(json_field state "$STATUS2_JSON") ]] || { echo "VM had no state before destroy" >&2; exit 1; }

DESTROY1_JSON=$(MICROVM_TOKEN=$VM1_TOKEN "$MICROVM_BIN" destroy --vm "$VM1_ID" --json)
[[ $(json_field destroyed "$DESTROY1_JSON") == true ]] || { echo "first destroy did not report resource destruction" >&2; exit 1; }
wait_for_release "$VM1_ID" "$VM1_PROCESS_REFS"
set +e
REVOKED1_OUTPUT=$(MICROVM_TOKEN=$VM1_TOKEN "$MICROVM_BIN" status --vm "$VM1_ID" --json 2>&1)
REVOKED1_STATUS=$?
ADMIN_GONE1_OUTPUT=$(MICROVM_TOKEN=$ADMIN_TOKEN "$MICROVM_BIN" status --vm "$VM1_ID" --json 2>&1)
ADMIN_GONE1_STATUS=$?
set -e
[[ $REVOKED1_STATUS -eq 2 ]] || { echo "destroyed sandbox token was not revoked as Unauthenticated" >&2; exit 1; }
assert_json 'import json,sys; assert json.load(sys.stdin)["error"] == "Unauthenticated"' "$REVOKED1_OUTPUT"
[[ $ADMIN_GONE1_STATUS -eq 3 ]] || { echo "destroyed VM remained addressable to admin" >&2; exit 1; }
assert_json 'import json,sys; assert json.load(sys.stdin)["error"] == "VmNotFound"' "$ADMIN_GONE1_OUTPUT"
VM1_ID=

DESTROY2_JSON=$(MICROVM_TOKEN=$VM2_TOKEN "$MICROVM_BIN" destroy --vm "$VM2_ID" --json)
[[ $(json_field destroyed "$DESTROY2_JSON") == true ]] || { echo "second destroy did not report resource destruction" >&2; exit 1; }
wait_for_release "$VM2_ID" "$VM2_PROCESS_REFS"
set +e
REVOKED2_OUTPUT=$(MICROVM_TOKEN=$VM2_TOKEN "$MICROVM_BIN" status --vm "$VM2_ID" --json 2>&1)
REVOKED2_STATUS=$?
set -e
[[ $REVOKED2_STATUS -eq 2 ]] || { echo "second destroyed sandbox token was not revoked as Unauthenticated" >&2; exit 1; }
assert_json 'import json,sys; assert json.load(sys.stdin)["error"] == "Unauthenticated"' "$REVOKED2_OUTPUT"
VM2_ID=

echo "daemon/client two-sandbox Linux acceptance passed"
