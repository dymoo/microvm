# ADR 0001: In-memory daemon with a greenfield Cloudflare cutover

**Status**: accepted — 2026-09-14 ([dymoo/microvm#1](https://github.com/dymoo/microvm/issues/1))

## Decision

The daemon stays a **single trusted, in-memory Firecracker supervisor**. It
keeps no durable session store of its own: no daemon journal, no embedded
SQLite, no daemon-owned Postgres. VM runtime truth — the registry, quotas,
credential digests, TTL reaping, quarantine — lives in memory; a restart
destroys every VM found on disk, adopts nothing, and starts
admission-closed — `acceptingAtStartup` must literally be `false`, so every
deploy, restart, and upgrade begins closed. `info.liveVms` counts admitted
in-flight create reservations (quarantines keep theirs) so a drain cannot
report zero while a boot is active.
`runStateDir` artifacts are evidence of what booted, swept at startup, never
re-adopted, and never an authority.

VMs are reached by **direct VM RPCs** over one authenticated Effect RPC
group (`POST /rpc`): admin-scoped `create`, `setAdmission`, `info`;
admin-or-own-VM `list` (a sandbox token lists only its own VM), `execute`,
`inspect`, `destroy`, `startWebService`, `webServiceStatus`,
`stopWebService`. Every request is one self-contained HTTP exchange; the
transport holds no durable session and a disconnect interrupts in-flight
work. Clients are **request-scoped Scoped Clients** over one
runtime-neutral core: `makeAdminClient` for operational/CLI use and
`makeSandboxScopedClient` for a bound VM, each constructed per use with
exactly one bearer credential. The Node root (`microvm/client`) honors a
PEM CA bundle; the `microvm/workerd` root requires the caller's VPC
binding `fetch` and never falls back to `globalThis.fetch`, so a mis-bound
binding cannot become an accidental public-network call. `create` returns
the VM, its credentials, and its sandbox client — never an auto-created
ingress; fronting code constructs `makeSandboxHttpIngress` explicitly with
the same transport fetch. No process-global credential-bearing client
state exists anywhere; both package subpaths are scoped-only — the raw
full-surface client stays an internal test seam and is exported by no
subpath.

The **cluster, sandbox-handle/binding, trusted Node reverse-proxy, and
cleanup APIs are removed** with all callers and exports: `makeMicrovm`,
`makeMicrovmCluster`, `SandboxHandle`, `SandboxBindingError`,
`SandboxHttpProxy`, the `cleanup` RPC, and `VmInfo.owningHost`. Static
multi-daemon placement, capacity failover, response-supplied rerouting,
one-admin-destroy rollback binding, and the reaper RPC all go with them.
Callers own lifetime and cleanup policy; the daemon owns runtime truth.

For the Cloudflare path, a **stateless Worker router fronts one Durable
Object Sandbox Session per sandbox route**, which proxies control RPCs and
the VM's HTTP data plane through a fixed per-host **VPC Service** over
Cloudflare Tunnel with `verify_full` origin verification. The DO record is
one overwritten, versioned adapter-state record with a pre-create fence; the
product Postgres remains the business and lifecycle authority. The previous
trusted Node preview hop remains on node1 only until the Worker+DO path
qualifies against the approved node2 canary; then node1 drains. Rollback
across the pair is destructive and accepts preview loss.

## Why

- **In-memory daemon**: adoption across restarts would require persisting
  and re-verifying jailer/cgroup/KVM state that cannot be trusted secondhand;
  fail-closed restart with clean sweep is the only honest state.
- **No daemon DB**: VMs are disposable and bounded by TTL; durable state
  belongs to the product that funds the lifetime, not to the runtime.
- **Direct VM RPCs, no cluster**: one daemon per fixed host removes the
  routing problem the cluster/handle layers solved; re-introducing placement
  adds the exact surfaces that failed closed nowhere.
- **Request-scoped clients**: Workers are request-scoped and any shared
  credential-bearing client would be a credential leak surface; the RPC
  transport already carries no session.
- **Admission/info seam**: the only way to prove "the new daemon is the one
  serving, and it is not yet accepting" without a fleet API.
- **No cleanup RPC**: reaping is the daemon's own TTL/quota responsibility;
  an admin force-reap invited mass destruction and hid per-VM uncertainty.

## Consequences

- A daemon restart is a destructive event by design; the caller's own
  durable records must survive it (Free Vibecode Postgres + one DO record).
- `AdmissionClosed`, `BootFailed`, `DestroyUncertain`, and `VmPoisoned`
  remain the only honest failure surfaces; no client retries an ambiguous
  create, and an ambiguous create leaves an orphan until its daemon TTL
  expires (accepted cost, bounded by `maxTtlSeconds`).
- The HTTP data-plane rules in `docs/protocol.md` now bind whatever trusted
  hop fronts the daemon route — the Cloudflare DO after cutover — not a
  Node adapter in this repository.
- Security posture: nothing is exposed as a public origin; Workers reach the
  daemon only via the fixed VPC Service → Tunnel path; admin bearer tokens
  live only in approved secret managers and never in a DO record, a cookie,
  or a URL.
- Node2 qualification gates the permanent Free Vibecode cutover; the
  DO→VPC-Service binding, streaming, WebSocket, and workerd behaviors must be
  proven first (see
  [the qualification research](../research/workers-vpc-durable-object-qualification.md)
  and the [Free Vibecode handoff](../handoff/free-vibecode-cloudflare-cutover.md)).
