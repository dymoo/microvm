# Node.js Firecracker client evaluation

Decision: **do not adopt a Node.js Firecracker runtime client.** Keep the
current direct `node:http`/`node:net` implementation and use Firecracker's
versioned OpenAPI schema as the compatibility authority. The best focused
control-plane package, [`@sourceregistry/node-firecracker`](https://www.npmjs.com/package/@sourceregistry/node-firecracker),
only replaces the small HTTP-over-UDS request seam, while dropping response-size
bounds and Effect cancellation. The broader `@push.rocks/smartvm` launcher
omits the jailer and host resource isolation. No package inspected matches this
repository's security-critical launch, rollback, guest transport, and teardown
contract.

This evaluation covers direct, self-hosted Node/TypeScript clients discovered in
the npm registry and source repositories as of 2026-09-13. Hosted sandbox SDKs
are classified separately rather than treated as Firecracker clients. Claims are
from primary artifacts; conclusions marked `[INFERENCE]` follow from those
artifacts and this repository's source.

## Evidence base

| Source | Version / revision inspected | Observation |
| --- | --- | --- |
| Firecracker | [`v1.17.0`](https://github.com/firecracker-microvm/firecracker/releases/tag/v1.17.0), released 2026-09-10 | In-tree [Swagger 2.0 schema](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/src/firecracker/swagger/firecracker.yaml), [release policy](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/RELEASE_POLICY.md), [design](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/design.md), and [jailer documentation](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/jailer.md) |
| `@sourceregistry/node-firecracker` and `node-firecracker` | npm `1.5.0`, source [`4011398f`](https://github.com/SourceRegistry/node-firecracker/commit/4011398f9dabd1968bff9b3ff151bf732ecc621b), 2026-09-03 | Two npm names built from the same `gitHead`; zero runtime dependencies |
| `@push.rocks/smartvm` | npm `1.4.1`, source `4768faee`, 2026-05-01 | Node Firecracker process/UDS wrapper; five direct runtime dependencies, no jailer |
| `firecracker-sdk` | npm `1.0.0`, source [`32867eed`](https://github.com/mndhvn/firecracker-sdk/commit/32867eed3b2600126a210f5a27b3a1d603ecdab3), 2026-04-12 | Bun-oriented client explicitly tagged for Firecracker `1.15.0`; zero runtime dependencies |
| `firecracker-node` | npm `0.0.3`, source [`adaba9ba`](https://github.com/nitinrawat111/firecracker-node/commit/adaba9ba4f522352fcc32012156660fb0b2aaea6), 2026-01-26 | Early-stage API client plus direct process launcher; one runtime dependency (`undici`) |
| `vmsan` | npm `0.3.0`, source [`88c50a04`](https://github.com/angelorc/vmsan/commit/88c50a04232fd58592a677d90d9d6303a131dc9f), 2026-03-14 | Bun CLI/runtime with eight runtime dependencies, a Go guest agent, TAP networking, and generated Firecracker `v1.14.1` types |

Registry dates, version lists, dependency manifests, tarball sizes, and `gitHead`
values above come from the npm registry records for
[`@sourceregistry/node-firecracker`](https://registry.npmjs.org/%40sourceregistry%2Fnode-firecracker/1.5.0),
[`node-firecracker`](https://registry.npmjs.org/node-firecracker/1.5.0),
[`@push.rocks/smartvm`](https://registry.npmjs.org/%40push.rocks%2Fsmartvm/1.4.1),
[`firecracker-sdk`](https://registry.npmjs.org/firecracker-sdk/1.0.0),
[`firecracker-node`](https://registry.npmjs.org/firecracker-node/0.0.3), and
[`vmsan`](https://registry.npmjs.org/vmsan/0.3.0).

## What this repository actually needs

The four inspected files contain 2,501 lines, but a Firecracker API library can
address only a narrow part of them:

| Requirement | Current owner | What a candidate provides |
| --- | --- | --- |
| Bounded, timed HTTP requests over the per-VM Unix socket | `src/firecracker.ts:125-195` | Direct clients send API calls; none matches the existing body cap plus interruption semantics |
| Jailer process launch, trusted paths, chroot population, cgroup v2 CPU/memory/PID limits, and rlimits | `src/firecracker.ts`, `src/host.ts` | None of the API clients; Firecracker documents the jailer as a separate production requirement |
| Transactional boot and rollback on API failure, readiness failure, timeout, or cancellation | `src/firecracker.ts`, `src/daemon.ts` | None |
| Vsock UDS `CONNECT <port>\n` on the same data connection | `src/firecracker.ts`, `docs/protocol.md` | None; a client's `PUT /vsock` only configures the device |
| Guest readiness, bounded exec frames, and any HTTP-over-vsock proxy | `src/firecracker.ts`, `docs/protocol.md` | None |
| SIGTERM/SIGKILL process-group escalation, cgroup-empty proof, quarantine, and stale-VM recovery | `src/firecracker.ts`, `src/daemon.ts` | None |
| Effect services, typed errors, scoped finalizers, and cancellation | all three source modules | None |

Firecracker itself draws the same boundary: its API is HTTP over a Unix domain
socket, while production launch is through the separate `jailer`; the jailer
creates the chroot/cgroups, sets rlimits, drops privileges, and execs the VMM.
Its jailer docs also state that cleanup is the user's responsibility. A typed API
client therefore cannot replace the supervisor.

## Candidate assessment

### 1. `@sourceregistry/node-firecracker`: best direct client, still no adoption

This is the only serious drop-in candidate for the control-plane calls. Its
[`README`](https://github.com/SourceRegistry/node-firecracker/blob/4011398f9dabd1968bff9b3ff151bf732ecc621b/README.md)
explicitly says it does not spawn or manage Firecracker. Its
[`src/client.ts`](https://github.com/SourceRegistry/node-firecracker/blob/4011398f9dabd1968bff9b3ff151bf732ecc621b/src/client.ts)
uses `node:http`, exposes the endpoints this repository calls (`/boot-source`,
`/drives/{id}`, `/machine-config`, `/vsock`, `/actions`), and returns a specific
`FirecrackerApiError` for non-2xx responses. Its
[`package.json`](https://github.com/SourceRegistry/node-firecracker/blob/4011398f9dabd1968bff9b3ff151bf732ecc621b/package.json)
has no runtime dependencies and supports Node 18+.

The safety mismatch is decisive:

- `request()` appends every response chunk and then `Buffer.concat`s it; there is
  no response-size ceiling. The existing helper stops retaining data after 1 MiB
  and fails the request.
- No method accepts an `AbortSignal`. Its timeout destroys the request on the
  Node request timeout event, but caller interruption cannot be propagated from
  an Effect fiber. The existing callback destroys the request on Effect abort
  and applies a whole-operation deadline.
- Successful JSON is trusted with a TypeScript cast; there is no runtime schema
  validation. That is acceptable for Firecracker's local API only because this
  repository currently consumes no JSON success body during boot, but it is not
  a security improvement.
- [`src/types.ts`](https://github.com/SourceRegistry/node-firecracker/blob/4011398f9dabd1968bff9b3ff151bf732ecc621b/src/types.ts)
  says its hand-authored types mirror Firecracker's `main` schema; it does not
  pin the schema version. Version `1.5.0` was published seven days before
  Firecracker `v1.17.0`. Recent activity is positive, but a project created in
  June 2026 has not demonstrated long-term maintenance `[INFERENCE]`.
- The scoped and unscoped packages are duplicate publications from the same
  commit, not two independent implementations.

Gross replacement is at most the 71-line `apiRequest` helper and five boot API
calls. Preserving the present body bound, Effect cancellation, deadline, and
error mapping requires an adapter that retains most of that helper. The honest
net reduction is therefore negligible; adopting the package moves rather than
removes the risky code `[INFERENCE]`.

### 2. `@push.rocks/smartvm`: broader lifecycle, wrong isolation boundary

This is the broadest current Node wrapper found. Its
[`SocketClient`](https://code.foss.global/api/v1/repos/push.rocks/smartvm/raw/ts/classes.socketclient.ts?ref=4768faeec28d3a9ec4c7e95917670434413290c8)
sends HTTP over a Unix socket, while
[`MicroVM.start()`](https://code.foss.global/api/v1/repos/push.rocks/smartvm/raw/ts/classes.microvm.ts?ref=4768faeec28d3a9ec4c7e95917670434413290c8)
orders Firecracker configuration and invokes cleanup after a startup failure.
Its
[`FirecrackerProcess`](https://code.foss.global/api/v1/repos/push.rocks/smartvm/raw/ts/classes.firecrackerprocess.ts?ref=4768faeec28d3a9ec4c7e95917670434413290c8)
waits for the socket and escalates SIGTERM to SIGKILL.

Those are superficial overlaps, not the required guarantees. It launches the
Firecracker binary directly, never the jailer; configures no chroot, cgroup, or
rlimit; tests only the child PID rather than proving a process group/cgroup
empty; and exposes neither request cancellation nor response bounds. API
payloads are `Record<string, any>`, not generated Firecracker types. Its five
`@push.rocks/*` runtime dependencies replace built-in Node primitives with a
larger supply-chain surface. Seven npm versions since February 2026 show recent
work, but six landed across two days and the latest was in May; that is not yet
a sustained maintenance record `[INFERENCE]`. Adopting its launcher would remove
more lines than a focused client only by deleting mandatory isolation and
teardown semantics.

### 3. `firecracker-sdk`: a Bun client, not this Node runtime

The package [tracks Firecracker `1.15.0`](https://registry.npmjs.org/firecracker-sdk/1.0.0),
and Firecracker guarantees that an `X.Y.Z` client works with later `X.V.W`
versions where `V >= Y`, so its covered endpoints are forward-compatible with
`1.17.0`. Its [README](https://github.com/mndhvn/firecracker-sdk/blob/32867eed3b2600126a210f5a27b3a1d603ecdab3/README.md)
documents `bun add`, and its
[`src/http.ts`](https://github.com/mndhvn/firecracker-sdk/blob/32867eed3b2600126a210f5a27b3a1d603ecdab3/src/http.ts)
passes Bun's non-standard `RequestInit.unix` to `fetch`. Node's client would need
a custom fetch implementation, eliminating the advertised transport benefit.
It also exposes no timeout or signal option and consumes response JSON without a
size bound. One release, no repository tags, and an older explicit API target do
not justify replacing the stricter local transport.

### 4. `firecracker-node`: explicitly not production-ready

The project's own [README warning](https://github.com/nitinrawat111/firecracker-node/blob/adaba9ba4f522352fcc32012156660fb0b2aaea6/README.md)
says not to use it in production. Its
[`FirecrackerMicroVM`](https://github.com/nitinrawat111/firecracker-node/blob/adaba9ba4f522352fcc32012156660fb0b2aaea6/src/core/firecracker-microvm.ts)
spawns `firecracker` by name rather than the jailer, includes a `--no-seccomp`
option, configures no vsock, has no rollback around partial creation, and cleans
up with `child.kill()` plus socket unlink rather than process-group/cgroup proof.
Its
[`FirecrackerAPIClient`](https://github.com/nitinrawat111/firecracker-node/blob/adaba9ba4f522352fcc32012156660fb0b2aaea6/src/api/api-client.ts)
covers fewer endpoints, throws generic errors, exposes no per-request
cancellation or deadline, and adds `undici`. Adopting either its launcher or
client would be a security and lifecycle regression.

### 5. `firecrackerode`: direct but abandoned

The registry's older [`firecrackerode`](https://registry.npmjs.org/firecrackerode/1.0.2)
is a small zero-dependency UDS API wrapper, last published in April 2020. Its
[`modem.js`](https://github.com/apocas/firecrackerode/blob/31410967b391c154a0ae4d101733437c026e27ed/lib/modem.js)
has configurable connection/socket timers but no AbortSignal, whole-operation
deadline, response bound, process lifecycle, or typed TypeScript contract. It
offers less than the current helper and is not a maintained candidate.

### 6. Full runtimes are architectural replacements, not reusable clients

[`vmsan`](https://github.com/angelorc/vmsan/blob/88c50a04232fd58592a677d90d9d6303a131dc9f/README.md)
is actively developed and does use the jailer, but it is a Bun-only CLI/runtime
with a Go guest agent, TAP networking, WebSocket exec, snapshots, image download
and firewall management. Its
[`Firecracker service`](https://github.com/angelorc/vmsan/blob/88c50a04232fd58592a677d90d9d6303a131dc9f/src/services/firecracker.ts)
has the same unbounded `node:http` buffering and no cancellation; its checked-in
[generated types](https://github.com/angelorc/vmsan/blob/88c50a04232fd58592a677d90d9d6303a131dc9f/src/generated/firecracker-api.d.ts)
are pinned to now-unsupported Firecracker `v1.14.1`. Adopting it would replace
the no-NIC, Effect, guest-protocol, and teardown contracts rather than reduce a
local seam.

The registry also contains young system providers such as
[`@capsuleos/firecracker`](https://registry.npmjs.org/%40capsuleos%2Ffirecracker/0.1.0)
(Node 24+, three CapsuleOS runtime dependencies) and a multi-backend worker,
[`@multiplayer-app/sandbox`](https://registry.npmjs.org/%40multiplayer-app%2Fsandbox/7.0.1)
(AWS, Socket.IO, VNC, QEMU, Docker, and Firecracker dependencies). Neither is a
direct API client compatible with this repository's Node 22 surface.

## Hosted and higher-level SDKs are not candidates

Packages can be actively maintained yet answer a different question.
[`@folsom/fuse`](https://registry.npmjs.org/%40folsom%2Ffuse/0.30.0) calls the
Fuse HTTP control plane with bearer tokens, environments, hosts, snapshots, and
exec services; its
[`transport.ts`](https://github.com/folsomintel/fuse/blob/78126599027611664d172b29aef4df72f2fe9093/sdks/typescript/src/transport.ts)
is ordinary URL-based fetch, not Firecracker's UDS API. `sandkiln`, Vercel
Sandbox, E2B, Fly Machines, Krova, and ComputeSDK provider packages similarly
call a daemon or somebody else's service. They may replace the entire product
with that service, but they cannot be used to supervise this host's jailer or
remove code from `src/firecracker.ts`.

## The HTTP-over-vsock proxy is a separate concern

A Firecracker client's `vsock.set(...)` ends at `PUT /vsock`. The official
[`Vsock` schema](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/src/firecracker/swagger/firecracker.yaml#L1909-L1933)
separately specifies that a host-initiated connection must connect to the
backing UDS and send `CONNECT <guest-port>\n`; the same socket then carries guest
traffic. None of the direct packages implements that handshake, readiness,
stream ownership, framing, cancellation, response bounds, or an HTTP parser.
Therefore none helps the proposed HTTP-vsock proxy beyond typing the one-time
`PUT /vsock` body. That proxy should continue to use `node:net` for the CONNECT
phase and Node HTTP primitives only after the tunnel is established; its
fail-closed lifecycle remains repository-specific.

## Smaller reuse that is worthwhile

Use the official schema, not a third-party runtime client:

1. Pin the [Firecracker `v1.17.0` Swagger schema](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/src/firecracker/swagger/firecracker.yaml)
   to the same version as the installed Firecracker/jailer pair. The schema
   declares both API version `1.17.0` and Unix-domain-socket transport.
2. On a Firecracker upgrade, diff the pinned schemas and regenerate or review
   compile-time request types for the five used operations. A Swagger 2-capable
   TypeScript generator can produce checked-in types as a development step; it
   need not become a runtime dependency or own transport semantics.
3. Treat generated types as payload assistance, not a boot specification. The
   official [API change runbook](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/api-change-runbook.md)
   says Swagger cannot express whether an endpoint is mandatory or optional;
   ordering and state remain runtime logic. The `Drive` schema likewise leaves
   virtio-block's conditional `path_on_host`/`is_read_only` requirements in
   descriptions rather than its `required` list.
4. Do not check in the entire generated API surface merely to type five small
   request bodies. Add generation when the endpoint surface grows or drift has
   caused a real defect; until then, a schema-version/checksum assertion in the
   upgrade process provides most of the value with less code `[INFERENCE]`.
5. Keep the current bounded `node:http` request and Effect adapter. Generated
   types prevent payload drift; they do not validate Firecracker responses,
   prove teardown, or make cancellation safe.

Firecracker's release policy makes this approach stable: minor releases add
backwards-compatible APIs, and a client generated for `X.Y.Z` is guaranteed to
work with `X.V.W` for `V >= Y`. The jailer docs separately require Firecracker
and jailer binaries of the same version, so API typing must not be mistaken for
binary-pair compatibility.

## Final decision

**Do not adopt any evaluated package.** Reconsider
`@sourceregistry/node-firecracker` only if it adds a caller `AbortSignal`, a
whole-request deadline, a configurable response-body cap, an explicit pinned
Firecracker schema/release policy, and enough maintenance history to make its
transport safer than the 71 local lines. Even then, adoption would affect only
the API request seam. The jailer launch, chroot/cgroup/rlimit policy,
transactional rollback, vsock CONNECT transport, guest readiness/exec/HTTP
proxy, teardown proof, quarantine, and Effect error model remain necessarily
local.
