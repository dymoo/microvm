# Architecture

One Firecracker runtime, three credential scopes, four trust boundaries.
The module/seam table below is the post-cutover shape (greenfield, no
cluster/handle/Node-proxy surfaces); the decision record is
[ADR 0001](adr/0001-in-memory-daemon-and-cloudflare-cutover.md).

## Modules and seams

| Module | Interface (what callers know) | Implementation (what it hides) |
| --- | --- | --- |
| `src/protocol.ts` | `MicrovmRpc` group, wire schemas, `MICROVM_VERSION`, `Auth`/`SandboxContext` seam, `DAEMON_HTTP_ROUTE_PREFIX`, fixed channel ports, request bounds, `HTTP_PREVIEW_LIMITS` | Everything about what crosses the wire |
| `src/auth.ts` | `CredentialStore`, `authLayer`, `requireAdmin`/`authorizeVm` | Digest-only admin, sandbox-control, and VM-bound HTTP-ingress capabilities |
| `src/host.ts` | `HostPrereqs`, `ImageAllowlist`, immutable image HTTP endpoint, diagnostic state evidence, allocators | Trusted-path posture, chroot layout, atomic writes, CID/UID ranges |
| `src/vsock.ts` | Fixed-purpose exec, HTTP, and service socket openers | Fragment-safe bounded Firecracker UDS acknowledgement parsing |
| `src/firecracker.ts` | `Firecracker.boot`, `VmHandle`, exec/HTTP/service channels, readiness probe | Jailer argv, UDS HTTP API, guest framing, transactional teardown |
| `src/daemon.ts` | `daemonLayer(config, options)` | Literal-false startup gate, registry, quotas, create reservations, request leases, service serialization, TTL reaper, in-memory recovery, HTTP(S) serving |
| `src/daemon-http-proxy.ts` | Authenticated `/http/v1/vms/:id/*` HTTP and WebSocket ingress | Admission quotas, semantic parsing, sanitization, streaming, frame validation |
| `src/endpoint.ts` | `secureOrigin`, `isLoopbackHost` | Origin parsing that rejects authority confusion and plaintext off loopback |
| `src/client-core.ts` | `MicrovmClientOptions`, `SandboxCreateInput`/`ExecuteInput`/`StartWebServiceInput`, error unions, `ClientConfigurationError` | Runtime-neutral client core: version gate, wire-request normalization, unstamped transport composition, per-call bearer views |
| `src/client.ts` | Node root (`microvm/client`): scoped `makeAdminClient`, `makeSandboxScopedClient` over a CA-honoring Node transport (`ca?`, optional `httpClient?` override) — scoped-only, no raw client | Node transport resolution |
| `src/client-workerd.ts` | Edge root (`microvm/workerd`): the same scoped constructors, `makeSandboxHttpIngress` (required binding `fetch`), `decodeExecResult` | `FetchHttpClient` composition behind the caller's VPC binding fetch; no Node imports, no silent `globalThis.fetch` fallback |
| `src/client-raw.ts` | (not exported) internal full-surface client used only by repository tests | The single seam where the wire is driven directly; deliberately not a package subpath |
| `src/http-ingress.ts` | `makeSandboxHttpIngress({ url, vmId, httpIngressToken, fetch? })` → `handle(Request)` | Fetch-native, request-scoped ingress fronting: one credential injection, header hygiene, origin-form enforcement, explicit streaming/request/refusal bounds (declared `413`, counted body cap + 30 s upload-idle abort, 120 s response-head `504`), no listening socket, runtime-neutral |
| `src/ai.ts` | `createSandboxTools`, prompt exports | Tool schemas, bounds, cancellation wiring over a `SandboxScopedClient` |

All outward adapters depend inward on `protocol.ts`: the daemon composes
`auth`, `host`, and `firecracker`; the clients compose auth headers and the
RPC/HTTP transport; `http-ingress` is a stateless function of its options;
`ai` builds only on the sandbox-scoped client. No runtime module imports
from a higher-level consumer. There is no static cluster, no shared binding
layer, and no Node reverse-proxy module: placement, lifetime, and preview
fronting belong to the caller (CLI, operational code, or the approved
Cloudflare Worker + Durable Object path — see
[the handoff](handoff/free-vibecode-cloudflare-cutover.md)).

## Trust boundaries

1. **RPC caller -> daemon control plane.** Authenticated by a bearer token
   (`Auth` middleware). Authorized by scope: admin sees everything; a
   sandbox token touches only its own VM. Neither credential authenticates
   HTTP data ingress. The admin client additionally pins the daemon's
   protocol version at construction (`info` probe), refusing a mismatch
   before any create.
2. **Trusted preview fronting -> daemon HTTP data plane.** The daemon route
   `/http/v1/vms/<vm-id>` authenticates one VM-bound ingress capability in
   `Proxy-Authorization: Bearer ...` before any guest I/O, strips routing,
   hop-by-hop, forwarding, proxy, and reserved headers, and dials only the
   registered VM's fixed HTTP channel. Whichever trusted hop fronts it —
   operational Node code through `makeSandboxHttpIngress`, or the approved
   Cloudflare Durable Object — applies the same independent validation on
   its own hop: the two hops deliberately do not share a validator.
   Application `Authorization` remains application data. `CONNECT` is
   refused (`405`) and `Expect: 100-continue` is refused without an interim
   `100`; the only reachable target stays the one VM-bound HTTP surface.
3. **Daemon -> Firecracker.** The daemon runs as root; Firecracker never
   does. Every boot goes through `jailer` with per-VM uid/gid and chroot;
   cgroup v2 ceilings and rlimits are set by the jailer. The Firecracker
   API and three fixed guest channels are reachable only through per-VM UDS
   paths inside the chroot.
4. **Guest supervisors -> guest workloads.** PID 1 raises loopback and
   starts the root guest runner plus the HTTP bridge as UID/GID 1001. Execs
   and the single durable web service run as UID/GID 1000 in separate
   bounded cgroup v2 scopes. The HTTP bridge can dial only
   `tcp4 127.0.0.1:<manifest-port>`; no guest NIC exists.

## Failure philosophy

- **Fail closed at startup.** Prerequisites (KVM device access, cgroup v2,
  Firecracker, jailer, kernel `flock`, trusted paths, positive uid/gid
  ranges) are verified before the daemon serves; any gap produces one
  aggregated `HostPrereqFailed`. Every process start is admission-closed:
  `acceptingAtStartup` must literally be `false`; creates fail with typed
  `AdmissionClosed` until an authenticated operator calls `setAdmission`,
  and admission state is memory-only — a restart re-reads the config and
  adopts nothing.
- **Poison only on infrastructure uncertainty.** Exec/service channel
  handshake faults, malformed trusted frames, or unexpected EOF poison the
  VM. A bounded guest rejection, application exit, loopback refusal,
  malformed application HTTP response, client disconnect, or public input
  rejection does not.
- **Transactional boot and teardown.** Any configure, start, or
  guest-readiness failure after spawn stops the jailer process group and
  removes the cgroup. Destroy first blocks new work, aborts and waits for
  active HTTP/SSE/WebSocket leases, tears down Firecracker, and proves
  those leases closed before it revokes credentials and reports success.
  Unproven teardown is `DestroyUncertain`.
- **Independent validation at every boundary.** The public ingress adapter,
  the daemon ingress, and the guest proxy each validate the same request,
  frame, and handshake rules rather than sharing one validator. That
  duplication is deliberate defence in depth: a bug in one boundary's
  parser must not become the next boundary's trust assumption. Do not
  de-duplicate these validators.
- **No blind retries.** `create`, exec, service control, and individual
  HTTP exchanges are sent exactly once and never replayed; an ambiguous
  request is surfaced as a failure, never retried into a duplicate VM.
  Exec interruption poisons and destroys the VM instead of leaving
  unowned work running.
- **Pinned image identity.** `create` requires `imageDigest`. The
  allowlist rejects a name/digest mismatch before allocation.
  Provisioning hashes the private rootfs copy before chown or jailer
  spawn; `VmInfo.imageDigest` is that measured digest, never a request
  echo. A mismatch fails closed without starting the jailer.
- **Version-sealed client.** `makeAdminClient` probes `info` exactly once
  and refuses a version mismatch with `ClientConfigurationError`; no
  calls follow the refusal. The daemon's own `info` reports its exact
  build so deployment gates on identity, not on guesswork.

## Guest protocols

`docs/protocol.md` is the single source of truth for the guest wire
contracts. The fixed AF_VSOCK purposes are exec `1024`, HTTP `1025`, and
durable service control `1026`; callers cannot supply a socket, target
host, or port. Exec uses strict JSONL frames, HTTP uses one HTTP/1.1
exchange (or one validated WebSocket tunnel) per connection, and service
control uses one bounded JSON request and response per connection while
the supervised process outlives it.

## Testing shape

- `tests/admission.test.ts` — literal-`false` startup config, the admin
  admission gate and its linearized create reservation, typed
  `AdmissionClosed`, `info.liveVms` counting admitted in-flight
  reservations (quarantines keep theirs), and a real two-launch restart
  proving an opened daemon comes back closed and adopts no VM.
- `tests/admin-client.test.ts` — request-scoped Node client and ingress
  seams against raw HTTP listeners: version probe, per-call bearer, single
  credential injection, header hygiene, malformed-target refusals.
- `tests/workerd-client.test.ts` — the `microvm/workerd` binding-fetch
  contract observed against a fake binding fetch: every daemon call (and
  the ingress hop) travels through the supplied fetch with the credential
  in the envelope, a booby-trapped `globalThis.fetch` is never consulted,
  and a missing/non-function binding `fetch` fails
  `ClientConfigurationError` before any I/O.
- `tests/client-abuse.test.ts` — the internal raw client seam against a raw
  listener: ambiguous requests are sent once and never retried; credentials
  never attach to a non-secure origin or authority-confused URL.
- `tests/api-abuse.test.ts` — hostile RPC surface over the real listener,
  auth middleware, registry, and request-bounding code: privilege
  escalation, bounds bypass, malformed payloads, quota leaks, ambiguous
  transport success, reservation release without proven teardown.
- `tests/integration.test.ts` — real HTTP RPC listeners with
  Firecracker/guest services replaced only at their Context seams.
- `tests/daemon-http-ingress.test.ts` — authenticated ingress, response
  validation, per-VM SSE admission, and destroy-time lease closure.
- `tests/http-preview-fixture.test.ts` — the guest HTTP preview contract
  against a real child process and TCP framing via
  `scripts/http-preview-fixture.mjs`.
- `tests/transport.test.ts` — all fixed host channels against in-test UDS
  peers, including fragmented/coalesced acknowledgement handling.
- `tests/endpoint.test.ts` — `secureOrigin`/`isLoopbackHost` authority and
  plaintext rules.
- `tests/auth.test.ts`, `tests/protocol.test.ts`, `tests/host.test.ts`,
  and `tests/image-identity.test.ts` — credential separation, request
  bounds, wire patterns, and required-digest identity.
- `guest/internal/httpproxy` and `guest/internal/runner` tests —
  loopback-only streaming proxy and durable single-service lifecycle.
- `tests/firecracker.test.ts` — core boot timeout/readiness transactions
  with a spawned fake jailer process.
- `tests/ai.test.ts` and `tests/ai-abuse.test.ts` — actual AI SDK
  `generateText`/`streamText` tool execution and hostile model input
  through a sandbox-scoped authenticated RPC client.
- `tests/exec-transport-abuse.test.ts`, `tests/trusted-path.test.ts`,
  `tests/prereq.test.ts`, `tests/guest-image-template.test.ts` — transport
  fault policy, trusted operator paths, prerequisite aggregation, and
  image/template pin conformance.
- `tests/lock.test.ts` — Linux-only util-linux `flock` race and
  holder-death behavior.
- `tests/operations-scripts.test.ts` — release/deploy script contracts
  (see `docs/operations.md`).
