# Guest protocols v1 (host <-> guest)

This is the exact wire contract between the host daemon and the Go guest
services. Both sides MUST implement it byte-for-byte. Error enums and limits
here are final.

## Exec transport

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

## Shared fixed-purpose transport

Every channel begins by connecting to the VM's Firecracker vsock UDS and
writing one ASCII selector:

| Purpose | Selector | Guest listener |
| --- | --- | --- |
| exec | `CONNECT 1024\n` | AF_VSOCK 1024 |
| HTTP preview | `CONNECT 1025\n` | AF_VSOCK 1025 |
| web-service control | `CONNECT 1026\n` | AF_VSOCK 1026 |

The host accepts one bounded `OK <uint32>\n` Firecracker acknowledgement and
continues on that same socket. Fragmented acknowledgements are accumulated;
bytes coalesced after the newline remain application data. No public API
accepts a UDS path, vsock port, guest host, or guest TCP port.

## HTTP preview v1

The image manifest may declare exactly one immutable endpoint:

```json
{"httpEndpoints":{"web":{"port":3000}}}
```

The port is an integer from 1024 through 65535. PID 1 raises loopback before
starting the HTTP bridge as UID/GID 1001. The bridge dials only
`tcp4 127.0.0.1:<manifest-port>` and handles one HTTP/1.1 exchange per vsock
connection. A connection refusal is `503 Service Unavailable`; an origin head
timeout is `504 Gateway Timeout`; an invalid origin response is `502 Bad
Gateway`. None poisons the VM.

The host daemon route is `/http/v1/vms/<vm-id><raw-suffix>`. It authenticates
one VM-bound HTTP-ingress capability in `Proxy-Authorization: Bearer ...`
before acquiring a VM or opening vsock. Admin and sandbox-control tokens are
not ingress tokens. The external Node adapter owns capability injection, and
neither the token nor the daemon route is exposed through `SandboxHttpProxy`.

Request and response handling is semantic, not a raw byte tunnel:

- origin-form targets only; raw path/query bytes are preserved after removing
  the daemon prefix;
- `CONNECT`, `TRACE`, malformed upgrades, trailers, `Expect`, ambiguous
  framing, and reserved `Microvm-*` fields are rejected;
- `Proxy-*`, hop-by-hop and connection-nominated fields, caller forwarding
  metadata, `Host`, and transport framing are stripped and reconstructed;
- application `Authorization` is preserved, while `Proxy-Authorization` never
  reaches the guest;
- request target, headers, field count, request body, upload idle time, and
  response-head time are bounded; bodies remain streaming and backpressured;
- SSE flushes immediately and occupies one of eight per-VM long-lived slots.

A WebSocket request is admitted only after a valid RFC 6455 version/key and a
valid guest `101` accept/subprotocol response. Extensions are disabled.
Client-to-server frames must be masked, server-to-client frames unmasked, RSV
bits and reserved opcodes are rejected, control/fragmentation rules are
checked, and an aggregate message is capped at 1 MiB. Neither public nor guest
sockets become available to callers.

Destroy blocks new admissions, aborts active HTTP/SSE/WebSocket scopes, waits
a bounded interval, stops the VM, and proves the captured scopes closed before
returning success. Teardown revokes ingress and sandbox-control credentials.

## Durable web-service control v1

Port 1026 accepts one UTF-8 JSON line and returns one UTF-8 JSON line, then
closes. The service process is owned by the guest controller, not by that
connection, so it continues running after a successful `start` response.

Start request:

```json
{"version":1,"id":"<safe-id>","op":"start","argv":["/usr/local/bin/pnpm","dev"],"cwd":"/workspace","env":{"NODE_ENV":"development"},"port":3000}
```

`argv` is direct execution with no shell; `cwd` is `/workspace` or a
descendant. The daemon supplies the immutable manifest `port`; caller
`HOSTNAME` and `PORT` environment entries are rejected and the guest injects
`HOSTNAME=127.0.0.1` plus the manifest port. Exactly one web service may run.
It runs as UID/GID 1000 in `/sys/fs/cgroup/microvm-service/web` with the same
CPU, memory, PID, and group-kill posture as exec. stdout and stderr are drained
into bounded 64 KiB tails so an unattended service cannot deadlock.

Status and stop requests contain only `version`, `id`, and `op` (`status` or
`stop`). Status returns `not_started`, `running`, or `exited` with start time
and, after exit, code/signal. Stop freezes and kills the service cgroup, waits
for confirmed exit, and is idempotent. Malformed control frames and unknown
operations return bounded `INVALID_REQUEST`; start conflicts return
`START_FAILED`. A well-formed guest service error is not VM poison, while a
service-channel framing/transport fault is.
