# Dependency network policy

Status: architecture decision and future rollout plan. The offline path is the
required default. A host-mediated egress profile is **not implemented** by this
document or by the current daemon.

Tracking: [free-vibecode #51](https://github.com/dymoo/free-vibecode/issues/51).

## Decision

Coding guests do not get a general network. Keep the existing no-NIC invariant
and treat dependencies as supplied artifacts:

1. Start from a promoted image with a prewarmed pnpm store and install with the
   lockfile fully offline.
2. When a project lockfile is not already represented, prefer a trusted
   host-side materializer that produces another integrity-identified store
   artifact before the guest runs.
3. Only if an agent must choose a previously unknown package during a live job,
   an administrator may select a fixed, named, HTTPS-only dependency profile at
   VM creation. Implement that future exception as a package-aware registry
   gateway over the existing per-VM vsock seam, not as TAP/NAT and not as a
   generic proxy.

Git is outside the dependency profile. Guests receive no Git credential and do
not push. Repository durability is handled by the trusted export seam described
in [Workspace persistence](workspace-persistence.md).

## Current invariant

The current runtime configures a private root disk and a vsock device but no
Firecracker network interface. The guest image clears `resolv.conf`, and the
real-VM abuse suite requires the guest to see only loopback and no external
route. Firecracker guest I/O is therefore vsock-only.

Relevant implementation:

- [`src/firecracker.ts`](../src/firecracker.ts) deliberately makes no
  `/network-interfaces` request;
- [`scripts/build-guest-image.sh`](../scripts/build-guest-image.sh) builds the
  offline guest image;
- [`scripts/abuse-linux.sh`](../scripts/abuse-linux.sh) checks the no-network
  property;
- [`src/protocol.ts`](../src/protocol.ts) makes VM creation admin-only.

A future dependency profile changes “no egress” into “one bounded package-read
capability” for that VM incarnation. It does **not** change “no NIC”. Product
copy, audit evidence, and tests must distinguish an offline VM from a VM with
this explicit exception.

## Alternatives

| Model | Result |
| --- | --- |
| No NIC plus prewarmed store | Safest, fastest, and reproducible for a known lockfile. This is the default. |
| Trusted package materializer | Safest cache-miss path. The guest never receives a network-like capability. Prefer it whenever orchestration can supply a lockfile first. |
| Package-aware registry gateway over vsock | Acceptable optional path for interactive `pnpm add`; keeps policy and credentials on the host but admits a bounded exfiltration channel. |
| Generic HTTPS proxy over vsock | Rejected. `CONNECT` hides methods, paths, request bodies, and redirects from host policy and turns each allowed origin into an opaque tunnel. |
| TAP/NAT plus firewall | Rejected for dependencies. It adds virtio-net, TAP, address allocation, routes, DNS, conntrack, firewall, UDP/QUIC, and teardown state while still lacking package-level policy. |
| Unrestricted guest network | Rejected. It permits scanning, metadata/private-network access, C2, bulk exfiltration, and arbitrary downloads. |

Firecracker documents that it performs no guest traffic filtering; TAP policy
belongs to host networking. Its vsock implementation already maps a
guest-initiated connection for host CID 2 and port `N` to the per-VM Unix
listener `<v.sock>_N`. A missing listener is reset. That per-VM seam is narrower
than attaching an L2/L3 device.

## Offline dependency artifacts

Pin the pnpm binary and identify a store artifact by every input that can affect
its contents:

- pnpm version/store format and Node version/ABI;
- target OS, CPU, and libc, including target-specific optional dependencies;
- `pnpm-lock.yaml`, `pnpm-workspace.yaml`, patches, `.pnpmfile.*`, and other
  resolution-affecting trusted configuration;
- registry identity and each admitted package integrity value.

Populate the store in a trusted build or materialization worker with `pnpm
fetch`; never run untrusted dependency lifecycle scripts in the host daemon's
trust domain. For a store baked into the per-VM private root disk, the guest
install is:

```sh
pnpm install --offline --frozen-lockfile
```

`--offline` makes a missing package a deterministic failure rather than a
network fallback. Guest mutation is confined to that VM's private copy; it must
never affect the promoted base or a sibling. If a later materializer attaches a
read-only store artifact, add pnpm's `--frozen-store` option:

```sh
pnpm install --frozen-store --offline --frozen-lockfile
```

Never expose one guest-writable store to mutually untrusted VMs. pnpm explicitly
treats a shared writable store as part of a common trust domain.

Local workspace dependencies arrive with the workspace. Reject or mirror
`git+ssh`, `git+https`, and direct remote tarball dependencies rather than
silently widening the profile. Do not rely on repository-owned pnpm or `.npmrc`
settings to enforce host policy.

## Deep module and seam

The proposed `DependencySupply` module has one small interface and two real
adapters: `OfflineStore` and `RegistryGateway`. Tests use an internal fake
registry adapter. The module earns its depth by hiding store selection,
per-VM vsock identity, broker isolation, TLS, DNS, redirects, credentials,
budgets, audit, and cleanup behind one acquisition operation.

Illustrative future interface, not current code:

```ts
type DependencyProfileName = string

type DependencyProfileEvidence = {
  readonly name: DependencyProfileName
  readonly digest: string
  readonly mode: "offline" | "registry"
}

interface DependencySupply {
  readonly acquire: (input: {
    readonly vmId: VmId
    readonly profile: DependencyProfileName
    readonly image: ResolvedImage
    readonly layout: VmLayout
    readonly expiresAtEpochMs: number
  }) => Effect.Effect<DependencyProfileEvidence, DependencySupplyError, Scope.Scope>
}

interface DependencyMaterializer {
  readonly materialize: (input: {
    readonly source: SourceArtifactRef
    readonly profile: DependencyProfileName
    readonly target: {
      readonly os: "linux"
      readonly arch: "x86_64" | "aarch64"
      readonly node: string
      readonly pnpm: string
    }
  }) => Effect.Effect<DependencyStoreArtifactRef, DependencyMaterializeError>
}
```

The only future wire field should be an optional safe-name
`create.dependencyProfile`; absence means `offline`. `create` is admin-only.
Origins, ports, credentials, CA material, TLS flags, and limits remain trusted
configuration and never cross the public interface. A sandbox credential cannot
select, renew, or widen a profile.

If callers would otherwise have to coordinate “provision chroot, bind vsock
listener, boot, roll back” themselves, keep that ordering inside the VM boot
transaction. Do not expose a shallow series of lifecycle methods.

## Future registry gateway policy

The guest-side adapter listens only on loopback and forwards a local package
registry protocol to one fixed guest-initiated vsock port. The host creates
exactly one corresponding listener for that VM. The per-VM socket path, not a
guest-provided VM identifier or token, binds traffic to its profile.

The host endpoint is a registry gateway, not a general HTTP proxy:

- allow only bounded npm/pnpm packument and tarball reads needed for install;
- allow `GET` and `HEAD`; reject `CONNECT`, request bodies, publish/login/audit
  methods, WebSocket/upgrade, arbitrary URL fetching, and non-package traffic;
- perform and validate all upstream HTTPS on the host;
- parse bounded metadata and rewrite admitted `dist.tarball` URLs to opaque
  local gateway URLs;
- do not trust a tarball origin merely because registry metadata or a lockfile
  names it;
- disable unnecessary audit, telemetry, and update requests in trusted guest
  configuration.

Run the parser/fetcher as a per-VM unprivileged broker under a different UID
from the jailer/VMM. The root daemon owns its profile and lifecycle but does not
parse hostile HTTP or third-party metadata. Give the broker a dedicated network
namespace, default-deny firewall, cgroup/rlimits, bounded temporary storage, and
no route to daemon management, WireGuard/Proxmox/LAN, or metadata networks.

### Destination, DNS, redirect, and TLS checks

Apply the following checks independently to the first request and every
redirect:

1. Parse and canonicalize the URL. Reject userinfo, fragments, malformed IDNA,
   IP literals, non-HTTPS schemes, and every port except an explicitly permitted
   443.
2. Match an exact configured origin. Profiles enumerate metadata registry and
   tarball/CDN origins separately; avoid suffix wildcards.
3. Resolve with a trusted host resolver. Normalize IPv4-mapped IPv6. Reject the
   complete answer set if any address is non-global-unicast or is loopback,
   RFC1918, link-local/metadata, CGNAT, ULA, multicast, unspecified/reserved,
   host-local, daemon, or configured management space.
4. Connect directly to a validated address so the HTTP client cannot perform a
   second DNS lookup. Preserve the configured hostname for SNI, `Host`, and
   certificate hostname verification.
5. Require ordinary CA and hostname validation and modern TLS. Never accept a
   guest-controlled CA, SNI, proxy, validation bypass, or HTTPS-to-HTTP
   downgrade.
6. Bound redirects and re-run every check for each `Location`. Never carry
   authorization to a different origin.

These steps close DNS rebinding and policy-resolution/connect TOCTOU. An
operator-approved CDN redirect passes only when its exact origin is already in
the profile.

### Credentials, exfiltration, cache, and limits

A public profile has no credential. If private registries are later approved,
use a short-lived, read-only/install-only host secret scoped to one exact origin
and path. Never write it to guest environment, disk, `.npmrc`, output, or logs.
Strip guest authorization, cookies, proxy headers, and client-certificate
requests; inject the host credential only after authorization and never across
an origin-changing redirect.

A read-only gateway reduces but cannot eliminate exfiltration: hostile code can
encode some data in an allowed package-name or path request. Bound that residual
channel with a strict request grammar, no request bodies, short leases, and
request/URL/byte caps. Do not describe an online-profile VM as having zero
egress.

Each profile has hard limits for:

- total and per-response bytes;
- packument/tarball size and temporary disk use;
- request count, concurrent connections, and retries;
- connect, header, idle/progress, total-operation, and lease time;
- redirect count, URL/header size, and bytes-per-second burst/rate.

Attempts, retries, and partial transfers consume the same budget. Use streaming
backpressure. Promote a cache entry only after complete integrity verification
and an atomic rename. Share only public, content-addressed entries; partition
private/authorization-dependent cache state by tenant and credential scope.

Audit broker and request lifecycle with VM incarnation, profile name/digest,
request category, configured origin, selected address class, redirect decision,
status, bytes, integrity result, budget use, terminal result, and denial reason.
Never log credentials, bodies, arbitrary headers, or unbounded attacker query
text.

## VM lifecycle

Dependency resources join the existing transactional VM lifecycle:

- resolve the immutable profile and acquire the store/listener/broker before
  `create` succeeds;
- if acquisition, boot, or readiness fails, roll back the broker, sockets,
  temporary cache, VM, cgroup, and run state as one transaction;
- destroy, TTL expiry, poison teardown, failed create, daemon interruption, and
  restart close listeners and workers, revoke/zeroize credentials, and remove
  private temporary state before releasing capacity;
- never adopt an egress lease across daemon restart;
- a broker crash after boot closes dependency access. It need not poison guest
  execution unless the exec channel itself is uncertain.

The profile digest and budget/audit identity belong in diagnostic evidence, but
credential material never does.

## Non-goals

- Give a guest a NIC, TAP device, NAT, route, DNS resolver, unrestricted socket,
  LAN/WireGuard/Proxmox/metadata access, or arbitrary Internet access.
- Provide application runtime egress, inbound networking, UDP/QUIC, browsing,
  `apt`, arbitrary `curl`/`wget`, or remote asset downloads.
- Support arbitrary URLs, protocols, ports, TCP/UDP forwarding, Git hosts,
  Git/SSH dependencies, guest Git credentials, or guest `git push`.
- Let sandbox input, repository-owned configuration, or package metadata define
  or widen authorities, CIDRs, credentials, TLS roots, proxy behavior, or
  limits.
- Make the egress milestone a hidden prerequisite for the deterministic cached
  Next.js template.
- Claim that an allowed package is benign. Package code remains hostile and
  runs only inside the VM.
- Claim an online resolution is reproducible before its lockfile, pnpm/store
  version, integrity set, profile digest, and promoted store artifact are
  captured.

## Rollout

1. **Offline performance floor.** Pin pnpm, seed the target-native Next.js store,
   run frozen/offline installs, and retain real-KVM no-NIC proof. Measure store
   misses and install latency.
2. **Trusted materializer.** Build and cache target-specific, read-only store
   artifacts from imported lockfiles in an isolated worker. Reject exotic
   sources. This should cover most arbitrary projects without runtime egress.
3. **Public registry profile.** Only after measured interactive-add demand, add
   the create-time named profile, loopback-to-vsock adapter, unprivileged broker,
   policy, budgets, audit, and capture of the resulting store artifact.
4. **Private registry credentials.** Add only if required, with exact-origin,
   short-lived read credentials and tenant-partitioned cache. Never couple this
   to Git access.

## Abuse acceptance

Before enabling any registry profile, portable and hosted real-KVM coverage must
prove:

- both modes still expose only loopback; direct IPv4/IPv6, DNS, metadata, host,
  and LAN connections fail;
- seeded frozen/offline install succeeds, while missing content, lock mismatch,
  wrong target/store version, and exotic sources fail without outbound access;
- guest store mutation cannot affect a base artifact, cache, or sibling;
- sandbox input cannot select/change/renew a profile or add an origin, port,
  credential, CA, proxy, or limit override;
- per-VM socket identity prevents cross-VM broker use and other vsock ports reach
  no host module;
- HTTP, `CONNECT`, POST/body, non-443, IP literal, userinfo, upgrade, malformed
  URL/header, unlisted origin, and project proxy/CA bypass are denied;
- loopback, private, link-local/metadata, CGNAT, ULA, reserved, host/management,
  IPv4-mapped private, and mixed public/private DNS answers are rejected before
  connect;
- rebinding cannot replace the validated/pinned address, and TLS still verifies
  the configured hostname;
- bad certificates and downgrade, private/unlisted/looping redirects, and
  hostile `dist.tarball` origins fail; allowed CDN redirects are rechecked and
  never receive unrelated credentials;
- slowloris, connection/retry floods, huge/chunked responses, partial transfers,
  and URL-query exfiltration hit cumulative count/concurrency/byte/rate/time/disk
  limits with backpressure;
- integrity failures and incomplete downloads never enter the cache;
- create cancellation, broker crash, destroy, TTL, poison, and restart leave no
  listener, worker, namespace, credential, temporary cache, UDS, cgroup, or
  released capacity without teardown proof;
- audit records every allow/deny/redirect/integrity/budget/lifecycle decision
  without credentials or dependency bodies.

## Primary references

- [Firecracker v1.17.0 design](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/design.md)
- [Firecracker v1.17.0 network setup](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/network-setup.md)
- [Firecracker v1.17.0 vsock](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/vsock.md)
- [pnpm fetch](https://pnpm.io/cli/fetch)
- [pnpm store and frozen-store settings](https://pnpm.io/settings/store)
- [pnpm supply-chain guidance](https://pnpm.io/supply-chain-security)
- [npm registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)
