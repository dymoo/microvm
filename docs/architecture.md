# Architecture

One Firecracker runtime, three credential scopes, four trust boundaries.

## Modules and seams

| Module | Interface (what callers know) | Implementation (what it hides) |
| --- | --- | --- |
| `src/protocol.ts` | `MicrovmRpc` group, wire schemas, `Auth`/`SandboxContext` seam, fixed channel ports, request bounds | Everything about what crosses the wire |
| `src/auth.ts` | `CredentialStore`, `authLayer`, `requireAdmin`/`authorizeVm`, `clientAuthLayer` | Digest-only admin, sandbox-control, and VM-bound HTTP-ingress capabilities |
| `src/host.ts` | `HostPrereqs`, `ImageAllowlist`, immutable image HTTP endpoint, diagnostic state evidence, allocators | Trusted-path posture, chroot layout, atomic writes, CID/UID ranges |
| `src/vsock.ts` | Fixed-purpose exec, HTTP, and service socket openers | Fragment-safe bounded Firecracker UDS acknowledgement parsing |
| `src/firecracker.ts` | `Firecracker.boot`, `VmHandle`, exec/HTTP/service channels, readiness probe | Jailer argv, UDS HTTP API, guest framing, transactional teardown |
| `src/daemon-http-proxy.ts` | Authenticated `/http/v1/vms/:id/*` HTTP and WebSocket ingress | Admission quotas, semantic parsing, sanitization, streaming, frame validation |
| `src/daemon.ts` | `daemonLayer(config)` | Registry, quotas, request leases, service serialization, TTL reaper, recovery, HTTP(S) serving |
| `src/http-proxy.ts` | `SandboxHttpProxy` handlers for Node's `request`, `upgrade`, `connect`, and `checkContinue` events | Ingress capability injection and the trusted Node reverse-proxy hop |
| `src/client.ts` | `makeMicrovmClient` | Endpoint resolution, TLS enforcement, wire decoding |
| `src/cluster.ts` | `SandboxHandle`, `WebServiceHandle` | Endpoint ownership, hidden credentials, semantic HTTP and durable service APIs, normalization of omitted optional request keys |
| `src/ai.ts` | `createSandboxTools`, prompt exports | Tool schemas, bounds, cancellation wiring |

All outward adapters depend inward on `protocol.ts`: the daemon composes
`auth`, `host`, and `firecracker`; the client composes auth and RPC transport;
`cluster` and `ai` build only on the typed client. No runtime module imports
from either higher-level consumer.

## Trust boundaries

1. **RPC caller -> daemon control plane.** Authenticated by bearer token
   (`Auth` middleware). Authorized by scope: admin sees everything; a sandbox
   token touches only its own VM. Neither credential authenticates HTTP data
   ingress.
2. **Trusted web server -> daemon HTTP data plane.** `SandboxHandle.http()`
   closes over a dedicated VM-bound ingress capability and exposes only
   semantic Node handlers for the four server events Node routes separately
   (`request`, `upgrade`, `connect`, `checkContinue`). The daemon authenticates
   `Proxy-Authorization`, verifies the token-to-VM binding before guest I/O,
   strips routing, hop-by-hop, forwarding, proxy, and reserved headers, and
   dials only the registered VM's fixed HTTP channel. Application
   `Authorization` remains application data. A CONNECT is answered `405` on the
   detached socket and an `Expect: 100-continue` is refused without an interim
   `100`: neither can open, return, or dial anything, so the only reachable
   target stays the one VM-bound HTTP surface.
3. **Daemon -> Firecracker.** The daemon runs as root; Firecracker never does.
   Every boot goes through `jailer` with per-VM uid/gid and chroot; cgroup v2
   ceilings and rlimits are set by the jailer. The Firecracker API and three
   fixed guest channels are reachable only through per-VM UDS paths inside the
   chroot.
4. **Guest supervisors -> guest workloads.** PID 1 raises loopback and starts
   the root guest runner plus the HTTP bridge as UID/GID 1001. Execs and the
   single durable web service run as UID/GID 1000 in separate bounded cgroup v2
   scopes. The HTTP bridge can dial only `tcp4 127.0.0.1:<manifest-port>`; no
   guest NIC exists.

## Failure philosophy

- **Fail closed at startup.** Prerequisites (KVM device access, cgroup v2,
  Firecracker, jailer, kernel `flock`, trusted paths, positive uid/gid ranges)
  are verified before the daemon serves; any gap produces one aggregated
  `HostPrereqFailed`.
- **Poison only on infrastructure uncertainty.** Exec/service channel
  handshake faults, malformed trusted frames, or unexpected EOF poison the VM.
  A bounded guest rejection, application exit, loopback refusal, malformed
  application HTTP response, client disconnect, or public input rejection does
  not.
- **Transactional boot and teardown.** Any configure, start, or
  guest-readiness failure after spawn stops the jailer process group and
  removes the cgroup. Destroy first blocks new work, aborts and waits for active
  HTTP/SSE/WebSocket leases, tears down Firecracker, and proves those leases
  closed before it revokes credentials and reports success. Unproven teardown
  is `DestroyUncertain`.
- **No blind retries.** `create`, exec, service control, and individual HTTP
  exchanges are never replayed. Exec interruption poisons and destroys the VM
  instead of leaving unowned work running.

## Guest protocols

`docs/protocol.md` is the single source of truth for the guest wire contracts.
The fixed AF_VSOCK purposes are exec `1024`, HTTP `1025`, and durable service
control `1026`; callers cannot supply a socket, target host, or port. Exec uses
strict JSONL frames, HTTP uses one HTTP/1.1 exchange (or one validated
WebSocket tunnel) per connection, and service control uses one bounded JSON
request and response per connection while the supervised process outlives it.

## Testing shape

- `tests/transport.test.ts` — all fixed host channels against in-test UDS
  peers, including fragmented/coalesced acknowledgement handling.
- `tests/http-proxy.test.ts` — actual Node HTTP/SSE/WebSocket public adapter,
  sanitization, cancellation, and frame policy.
- `tests/daemon-http-ingress.test.ts` — authenticated ingress, response
  validation, per-VM SSE admission, and destroy-time lease closure.
- `guest/internal/httpproxy` and `guest/internal/runner` tests — loopback-only
  streaming proxy and durable single-service lifecycle.
- `tests/firecracker.test.ts` — core boot timeout/readiness transactions with
  a spawned fake jailer process.
- `tests/auth.test.ts`, `tests/protocol.test.ts`, and `tests/host.test.ts` —
  credential separation, request bounds, wire patterns, and manifest ports.
- `tests/integration.test.ts` and `tests/cluster.test.ts` — real HTTP RPC
  listeners and public handles with Firecracker/guest services replaced only
  at their Context seams.
- `tests/ai.test.ts` — actual AI SDK `generateText` and `streamText` tool
  execution through a scoped authenticated RPC client.
- `tests/lock.test.ts` — Linux-only util-linux `flock` race and holder-death
  behavior.
