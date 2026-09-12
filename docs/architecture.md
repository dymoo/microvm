# Architecture

One Firecracker runtime, two credential scopes, three trust boundaries.

## Modules and seams

| Module | Interface (what callers know) | Implementation (what it hides) |
| --- | --- | --- |
| `src/protocol.ts` | `MicrovmRpc` group, wire schemas, `Auth`/`SandboxContext` seam, request bounds | Everything about what crosses the wire |
| `src/auth.ts` | `CredentialStore`, `authLayer`, `requireAdmin`/`authorizeVm`, `clientAuthLayer` | Digest storage, constant-time admin compare, token mint/revoke |
| `src/host.ts` | `HostPrereqs`, `ImageAllowlist`, `vmLayout`, diagnostic state evidence, allocators | Trusted-path posture, chroot layout, atomic writes, CID/UID ranges |
| `src/firecracker.ts` | `Firecracker.boot`, `VmHandle`, `GuestExecChannel`, readiness probe | Jailer argv, UDS HTTP API, vsock framing, transactional teardown |
| `src/daemon.ts` | `daemonLayer(config)` | Registry, quotas, per-VM exec serialization, TTL reaper, recovery, HTTP(S) serving |
| `src/client.ts` | `makeMicrovmClient` | Endpoint resolution, TLS enforcement, wire decoding |
| `src/ai.ts` | `createSandboxTools`, prompt exports | Tool schemas, bounds, cancellation wiring |

All outward adapters depend inward on `protocol.ts`: the daemon composes
`auth`, `host`, and `firecracker`; the client composes auth and RPC transport;
`cluster` and `ai` build only on the typed client. No runtime module imports
from either higher-level consumer.

## Trust boundaries

1. **RPC caller -> daemon.** Authenticated by bearer token (`Auth`
   middleware). Authorized by scope: admin sees everything; a sandbox token
   touches only its own VM. Callers can influence exactly three things about
   a VM's guest: which allowlisted image, resource sizes within quotas, and
   the exec request — itself bounded (absolute argv, byte ceilings) before it
   reaches any transport.
2. **Daemon -> Firecracker.** The daemon runs as root; firecracker never
   does. Every boot goes through `jailer` with per-VM uid/gid and chroot;
   cgroup v2 ceilings and rlimits are set by the jailer. The Firecracker API
   is reachable only through a per-VM UDS inside the chroot.
3. **Guest runner -> guest workloads.** The runner (root, inside the guest)
   drops every exec to a fixed unprivileged UID/GID inside a per-exec cgroup
   (`cgroup.kill` teardown — `setsid` cannot escape a cgroup). One command
   per connection; disconnect kills the group.

## Failure philosophy

- **Fail closed at startup.** Prerequisites (KVM device access, cgroup v2,
  Firecracker, jailer, kernel `flock`, trusted paths, positive uid/gid ranges)
  are verified before the daemon serves; any gap produces one aggregated
  `HostPrereqFailed`.
- **Poison on uncertainty.** The exec channel distinguishes protocol outcomes
  (exit frame, pre-exec `error` frame) from transport faults (EOF without
  terminal frame, bad frames, cap overruns, deadline expiry). Transport
  faults mark the VM **poisoned**: it must be destroyed before reuse. Exec
  success is never reported for a VM in doubt.
- **Transactional boot.** Any configure, start, or guest-readiness failure
  after spawn stops the jailer process group and removes the cgroup. If that
  teardown cannot prove completion, boot fails with `VmTeardownFault` rather
  than reporting a clean rollback; the wire exposes the same uncertainty as
  `DestroyUncertain` on destroy/cleanup.
- **No blind retries.** `create` has no client-side retry (a VM may have
  booted); `execute` interruption poisons and destroys the VM instead of
  leaving unowned work running.

## Guest exec v1

`docs/protocol.md` is the single source of truth for the vsock wire contract
(shared with `guest/`). Highlights: AF_VSOCK port 1024 via the Firecracker
vsock UDS (`CONNECT 1024\n` → `OK <port>\n` on the same connection), one
JSONL request, framed base64 output with per-sequence numbering, exactly one
terminal frame, hard caps (600 s, 8 MiB per stream, 8 MiB lines), and strict
frame validation on the host (version, id, seq, base64, unknown types).

## Testing shape

- `tests/transport.test.ts` — host transport against an in-test UDS peer.
- `tests/firecracker.test.ts` — actual core boot timeout/readiness
  transactions with a spawned fake jailer process.
- `tests/auth.test.ts` and `tests/protocol.test.ts` — credential lifecycle,
  authorization, request bounds, and wire patterns.
- `tests/prereq.test.ts` — fail-closed trusted-path checks and allocators.
- `tests/integration.test.ts` and `tests/cluster.test.ts` — real HTTP RPC
  listeners with Firecracker/guest services replaced at the Context seam.
- `tests/ai.test.ts` — actual AI SDK `generateText` and `streamText` tool
  execution through a scoped authenticated RPC client.
- `tests/lock.test.ts` — Linux-only util-linux `flock` race and holder-death
  behavior.
