# microvm

The microvm context: a fail-closed Firecracker microVM runtime exposed over
authenticated Effect RPC, and the Cloudflare Workers cutover that lets a
trusted product backend create and serve ephemeral sandboxes. Decisions live
in [ADR 0001](docs/adr/0001-in-memory-daemon-and-cloudflare-cutover.md);
Cloudflare-path evidence in
[the Workers VPC qualification research](docs/research/workers-vpc-durable-object-qualification.md).

## Language

**Daemon**:
The trusted Linux root process that jails and supervises Firecracker microVMs,
enforces prerequisites and quotas, and serves the authenticated RPC and HTTP
data planes. It owns VM runtime truth and TTL in memory only.
_Avoid_: server, cluster, host agent, orchestrator

**Daemon Admission**:
The daemon's create gate: closed at every process start (the config marker
must literally be `false`), toggled only by the authenticated `setAdmission`
RPC, and reported by the admin-only `info` RPC. Creates while closed fail
with typed `AdmissionClosed`.
_Avoid_: admission control switch, accepting flag, maintenance mode

**Sandbox Lifetime**:
The product-side funded lifetime of one admitted sandbox turn: the Free
Vibecode Postgres record binding workspace, project, operation, reservation,
image pins and absolute expiry. The daemon never owns or reconstructs it.
_Avoid_: sandbox session (that is DO-side), lease, job

**Sandbox Session**:
The Cloudflare Durable Object-side adapter state for one sandbox route: one
overwritten versioned record with pre-create fence and
serving/install/access/revoke fields. It locates and fronts a sandbox; it is
never the business authority.
_Avoid_: sandbox lifetime, session store, sandbox state machine

**Runtime Locator**:
The fixed origin that addresses exactly one daemon for control-plane RPC: the
approved VPC Service hostname over Cloudflare Tunnel (`verify_full` origin
TLS). It is not a preview URL and never redirects.
_Avoid_: owningHost, cluster endpoint, advertised fallback

**Scoped Client**:
A request-scoped RPC client constructed per use with exactly one bearer
credential; admin and sandbox scopes never share one instance, and nothing
client-side is process-global. Two runtime roots share one neutral core:
`microvm/client` (Node, CA bundle) and `microvm/workerd`, which requires
the caller's VPC binding fetch.
_Avoid_: global client, singleton client, shared transport

**Runtime Generation**:
The immutable generation marker minted when a sandbox execution is planned;
every grant, fence and session record carries it so stale authority can be
recognized.
_Avoid_: incarnation, epoch, deployment id

**VM Identity**:
The daemon-assigned `mvm-*` id plus the measured `imageDigest` of the private
rootfs copy actually booted; create callers supply the manifest digest, the
daemon returns the measured one.
_Avoid_: container id, instance name, host identity

**Preview Capability**:
The VM-scoped HTTP-ingress credential (`mvi_…`) the daemon mints for the
image's immutable `web` endpoint; it authorizes only that VM's data plane and
is revoked on destroy.
_Avoid_: proxy token, admin token, sandbox token

**Sandbox Token**:
The VM-scoped control credential (`mvs_…`) authorizing exec, inspect,
destroy, and the web-service RPCs for exactly one VM (and `list`, which
shows only that VM).
_Avoid_: admin token, preview capability

**Route ID**:
A random 128-bit opaque locator minted by the trusted backend, persisted on
the existing lifetime binding before the first DO call, and mapped by
`idFromName("fv-sandbox:<routeId>")` to exactly one Sandbox Session. Public
identifiers only locate; they grant nothing.
_Avoid_: vmId, public sandbox name, URL slug

**VPC Service**:
The Cloudflare One network service that exposes one daemon host over the
Cloudflare network at a fixed private hostname through Cloudflare Tunnel, so
Workers reach the origin without publishing a public origin.
_Avoid_: public origin, tunnel subdomain, ngrok-style relay

**Canary Node**:
An approved daemon host in the rollout order: node1 (current) and node2 (the
approved second canary). The new Worker+DO path qualifies against node2
before node1 drains.
_Avoid_: production host, staging, blue/green pair

## State ownership

- **Product Postgres** (Free Vibecode) is the business and lifecycle
  authority: funding, lifetimes, grants, revocation intent, revisions.
- **The Durable Object record** is one overwritten, versioned adapter-state
  record per Sandbox Session; it is derived, never an event journal.
- **The daemon** is the in-memory truth for live VMs, credentials, quotas and
  TTL; a restart destroys all VMs and adopts nothing.
- **HTTP Effect RPC** (POST `/rpc`) has no durable session: each request is
  one self-contained exchange; disconnect interrupts in-flight work.

## Invariants

1. Fail closed: daemon startup, admission, TLS off loopback, jailer, cgroup
   v2, and digest-verified private rootfs all gate before work (see
   [ADR 0001](docs/adr/0001-in-memory-daemon-and-cloudflare-cutover.md)).
2. Callers never pass host paths, kernel paths, kernel args, sockets, or
   ports; identity comes from the allowlisted image name and its digest.
3. Guest I/O is vsock-only; guests have no NIC and no egress.
4. Credentials are VM-scoped or admin, stored as SHA-256 digests; HTTP ingress
   capabilities never authorize control-plane RPCs and vice versa.
5. Ambiguous create results are never retried; uncertainty is surfaced
   (`AdmissionClosed`, `BootFailed`, `DestroyUncertain`), not guessed away.
