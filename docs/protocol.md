# Guest exec protocol v1 (host <-> guest runner)

This is the exact wire contract between the host daemon (`src/firecracker.ts`)
and the Go guest runner (`guest/`). Both sides MUST implement it byte-for-byte.
Error enums and limits here are final.

## Transport

1. At VM configure time the daemon supplies Firecracker `uds_path: "v.sock"`,
   relative to the jailed root. The host-side socket is
   `<runStateDir>/vms/<id>/jailer/<firecracker-basename>/<id>/root/v.sock`
   (`VmLayout.vsockSocket`).
2. For each exec the host connects to that **vsock UDS** (never the Firecracker
   API socket), then immediately writes `CONNECT 1024\n` (ASCII, `\n` = 0x0A).
3. The host requires the acknowledgement `OK <port>\n` (decimal port number).
   Per Firecracker's vsock docs, **the same UDS connection then becomes the
   data channel** — the host must not reconnect or open a second socket.
4. AF_VSOCK port is fixed at **1024**.
5. One exec per connection. Closing/crashing the connection cancels the exec.

## Request (host -> guest), one UTF-8 JSON line

```json
{"version":1,"id":"<1..128 safe chars>","argv":["/usr/bin/node","--version"],"cwd":"/workspace","env":{"KEY":"VALUE"},"timeoutMs":30000,"maxOutputBytes":1048576}
```

- `version` must be `1`; anything else => `error` frame `INVALID_REQUEST`.
- `id`: 1..128 chars, `[A-Za-z0-9._:-]`.
- `argv`: non-empty; executed directly with no shell. The daemon requires
  `argv[0]` to be an absolute guest path before opening the transport. There
  is no executable allowlist; isolation comes from the VM/image boundary and
  the fixed unprivileged workload identity.
- `cwd`: optional and defaults to `/workspace`; after cleaning, it must be
  `/workspace` or a descendant. Any other path => `INVALID_REQUEST`.
- `env`: optional `string->string` map passed to the process verbatim; if
  `PATH` is unset the guest supplies its own default.
- `timeoutMs`: optional, default `30000`, hard maximum `600000`.
- `maxOutputBytes`: optional, default `1048576` **per stream**, hard maximum
  `8388608`. Values above the hard maximum, or non-integers => `INVALID_REQUEST`
  (the daemon clamps caller-supplied values to its own configured ceilings
  before they reach the guest; the guest caps are defense in depth).
- A request line larger than `8388608` bytes is rejected before execution with
  `INVALID_REQUEST`. An oversized guest response line is a host transport
  fault: the daemon poisons/destroys the VM and returns no false exec success.

## Output frames (guest -> host), JSON lines in read order

Data frames:

```json
{"version":1,"id":"...","seq":0,"type":"stdout","data":"<base64>"}
{"version":1,"id":"...","seq":3,"type":"stderr","data":"<base64>"}
```

- `seq` starts at 0 per stream and increases monotonically.
- `data` is base64 (standard alphabet, padded) of raw bytes.

Terminal frame — exactly one, then the guest closes:

```json
{"version":1,"id":"...","type":"exit","code":0,"signal":null,"timedOut":false,"outputTruncated":false}
```

- `code`: process exit status. When the workload is killed for timeout:
  `code: 137`, `signal: "SIGKILL"`, `timedOut: true`.
- `signal`: POSIX signal name string only when the process was killed by a
  signal, else `null`.
- `outputTruncated: true` when either stream hit its byte cap. Hitting the cap
  kills the entire per-exec cgroup and the terminal frame still reports the
  truncation (no `error` frame for this case).
- Unknown `type` values, malformed/empty data frames, sequence gaps, excess
  chunks, or a missing terminal frame are protocol violations. The host fails
  closed, poisons the VM, and never reports success.

Pre-exec / protocol failures (no process ran, or the request was invalid):

```json
{"version":1,"id":"...","type":"error","code":"INVALID_REQUEST","message":"bounded safe text"}
```

- `code` is exactly one of `INVALID_REQUEST | EXEC_FAILED | INTERNAL`.
- `message` is short, single-line, and must never contain host paths or secrets.

## Execution guarantees

- The runner executes each workload inside a dedicated **cgroup v2** subtree
  (per-exec `memory.max` / `pids.max` / `cpu.max`), moves the child in before
  privilege drop, and kills via freeze + `cgroup.kill`. `setsid` or double-fork
  descendants cannot escape a cgroup.
- The fixed unprivileged UID/GID owns execution; the runner socket side does not
  leak root privileges into workload context.
- A terminal frame is emitted only after the process (or the whole cgroup) is
  confirmed dead. No success is ever reported for work that might still run.
- Disconnect before a terminal frame => the guest kills the cgroup; the host
  additionally marks the VM poisoned and requires `destroy` before reuse.
- If required cgroup v2 controllers or the execution subtree are unavailable
  at runner startup, the runner exits before opening the vsock listener.
  A later per-command isolation setup failure returns a bounded `INTERNAL`
  error before starting the workload; there is no degraded execution mode.
- No guest network interfaces exist; vsock is the only guest I/O channel.
