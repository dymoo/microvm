# Operations

Running `microvm-daemon` on a Linux KVM host, sized for the dymoo homelab
Proxmox cluster. Read `README.md` (security model, limitations) first.

## Deployment shape

- A **dedicated Linux VM** on the Proxmox cluster (x86_64) with **nested
  KVM** enabled — not the Proxmox host itself. Proxmox VM CPU type must be
  `host` (or another type exposing VT-x) so `/dev/kvm` exists inside.
- The daemon listens on a **private, authenticated TLS endpoint** and is never
  exposed as a public origin. In the approved cutover, Workers reach it only
  through the fixed Cloudflare VPC Service → Cloudflare Tunnel path, with
  origin TLS verification set to `verify_full`. Operator deploy/admin traffic
  remains on the private management path. Detailed Cloudflare binding and
  application handoff configuration is deliberately documented elsewhere.
- No placement assumptions are made about which Proxmox node runs the VM.
  Size the VM from the quotas you configure (see below); remember guests add
  their `memMib` plus the configured `vmmOverheadMib` to host memory pressure.
  The example uses 256 MiB of VMM overhead; it is a required operator setting,
  not an implicit default.

## Workers VPC, Tunnel, and canary qualification

This is the fixed operator target, not a menu of fallback architectures.
Workers VPC is an open-beta service, and this repository has **not yet
verified** that a Durable Object can use its VPC Service binding to reach this
daemon end to end. The evidence and remaining unknowns are tracked in the
[Workers VPC + Durable Object qualification research](research/workers-vpc-durable-object-qualification.md).
No permanent cutover is allowed until every P0 gate below has observed
evidence.

Provision one fixed **VPC Service** for each daemon node; do not substitute a
VPC Network binding:

- **node1:** private origin `node1.internal.dylans.link`; fixed VPC
  Service target at that host's configured HTTPS port; node1 tunnel.
- **node2 canary:** private origin `node2.internal.dylans.link`; fixed
  VPC Service target at that host's configured HTTPS port; node2 tunnel.

Each daemon certificate must be issued by Cloudflare Origin CA for its exact
private origin name. Configure the VPC Service TLS mode as `verify_full`, so
both the chain and hostname are checked; never use `verify_ca`, disabled
verification, or `noTLSVerify`. The origin names resolve only on the private
resolver network available to the connectors. There is no public daemon DNS
route, Tunnel published application, or caller-selectable daemon URL. A Worker
may use the pinned private origin as the request `Host`/SNI value required by
the fixed service binding, but it must never accept that value from a caller
or use it to choose a target.

Create one Cloudflare Tunnel per node. Run two connectors for each tunnel on
separate connector hosts/failure domains, both attached to the same private
resolver network and both restricted to their node's private origin and HTTPS
port. Tunnel replicas provide redundancy, not traffic steering; node
selection remains the explicit VPC Service binding. The node2 canary must use
its own host-local `runStateDir` and jailer cgroup parent. Never mount, copy, or
share node1 runtime state into node2.

Keep capability boundaries explicit:

- The daemon admin token exists only in the daemon's root-owned environment
  file and the approved Cloudflare Worker secret store used by the Worker that
  performs admin RPCs. It never enters a Durable Object record, backend
  request, URL, cookie, log, or sandbox.
- Per-VM `sandboxToken` and `httpIngressToken` values are stored only in that
  sandbox's versioned Durable Object record, cleared on destroy/expiry, and
  exposed only to request-scoped sandbox/ingress clients. They never enter
  module-global state or a public response.
- Origin private keys stay on their daemon nodes. Tunnel credentials stay on
  the connector hosts for that node. A VPC binding or successful TLS
  handshake never replaces daemon bearer authorization.

Run these as separate deployed P0 gates against node2 before any permanent
route or traffic change:

1. **DO → fixed VPC Service binding:** from a deployed Durable Object, call
   daemon `info` through the node2 VPC Service and observe the exact qualified
   version, closed/open admission state, and zero-VM baseline. A local
   Miniflare binding is not evidence for this gate.
2. **Origin identity failure:** prove the valid node2 Cloudflare Origin CA
   certificate succeeds with `verify_full`; then prove both a wrong-host
   certificate and a certificate from an untrusted/wrong CA fail the TLS
   handshake without reaching daemon authorization.
3. **Effect in workerd:** use `effect/unstable/http/FetchHttpClient` with the
   repository's request-scoped client inside deployed workerd. Prove
   `info`, create, status, and destroy, then reconstruct the client from the
   persisted Durable Object record in a second invocation.
4. **HTTP and SSE:** independently prove an ordinary HTTP request and an SSE
   response through Worker → DO → VPC Service → Tunnel → node2. SSE must
   arrive incrementally rather than as a buffered terminal body, and both
   paths must preserve status, headers, cancellation, and configured limits.
5. **WebSocket:** run a separate real upgrade attempt over the same deployed
   path. The current HTTP-only ingress contract must produce an explicit
   fail-closed refusal; record that result and the product decision. Do not
   infer WebSocket support from HTTP/SSE success or from a platform error-code
   reference.

Workers VPC beta behavior and Durable Object binding support remain unverified
until these gates pass. This section authorizes no production deployment,
Cloudflare resource mutation, DNS change, public route, or Free Vibecode
cutover; those actions remain outside this repository task.

## Startup checks and operator requirements

Before listening, the daemon checks and aggregates these failures in one
`HostPrereqFailed`:

1. the process runs as root, `/dev/kvm` opens read/write, and cgroup v2 is
   mounted at `/sys/fs/cgroup`;
2. configured Firecracker, jailer, and util-linux `flock` paths are executable,
   root-owned, not group- or world-writable, and have no symlink in the
   checked ancestry;
3. the kernel is readable and has the same trusted-path posture;
4. the image and run-state directories are trusted; the daemon creates the
   run-state directory with mode 0700 when absent;
5. UID/GID ranges are positive and ordered, `maxPidsPerVm` is at least 8, and
   `vmmOverheadMib` is a non-negative integer.

Configuration validation separately requires TLS on a non-loopback listener,
non-empty TLS PEM values, a secure advertised origin, an admin token of at
least 16 characters, ordered quota bounds, and allocation ranges large enough
for `maxVms`.

Operators must additionally supply a compatible Firecracker/jailer pair, a
kernel with the Firecracker-required block, ext4, vsock, and cgroup features,
and reserve the configured numeric UID/GID ranges from other host workloads.
The startup probes do not inspect binary linkage/version compatibility, kernel
`CONFIG_*` values, or host account databases. Image manifest and architecture
checks happen when an image is resolved. Guest runner/cgroup readiness is
proved separately for each VM before `create` returns.

## Configuration reference

`/etc/microvm/config.json` — `${ENV_VAR}` references expand from the daemon's
environment; unresolved references are a fatal config error.

```jsonc
{
  "listen": { "host": "192.0.2.10", "port": 9443 },
  "advertisedUrl": "https://192.0.2.10:9443",
  // Required. Every service start/restart used for deployment is closed until
  // an authenticated operator explicitly opens admission.
  "acceptingAtStartup": false,
  // PEM contents, not filenames. TLS is required off loopback.
  "tls": {
    "cert": "${MICROVM_TLS_CERT_PEM}",
    "key": "${MICROVM_TLS_KEY_PEM}",
    "ca": "${MICROVM_TLS_CA_PEM}"
  },
  "auth": { "adminTokens": ["${MICROVM_ADMIN_TOKEN}"] },
  "firecracker": {
    "firecrackerBinary": "/usr/local/bin/firecracker",
    "flockBinary": "/usr/bin/flock",
    "jailerBinary": "/usr/local/bin/jailer",
    "kernelImage": "/var/lib/microvm/images/node.kernel",
    "imagesDir": "/var/lib/microvm/images",
    "runStateDir": "/var/lib/microvm/run",
    "jailerUidRange": [20000, 20099],
    "jailerGidRange": [20000, 20099],
    "jailerParentCgroup": "microvm.slice",
    "guestCidRange": [5000, 5099],
    "kernelArgs": "console=ttyS0 reboot=k panic=-1 pci=off nomodule random.trust_cpu=on root=/dev/vda rw init=/sbin/init",
    "bootTimeoutMs": 30000,
    "guestReadinessTimeoutMs": 30000,
    "vmmOverheadMib": 256,
    "maxPidsPerVm": 1024,
    "jailerFsizeBytes": 2147483648,
    "jailerNoFileLimit": 4096
  },
  "limits": {
    "maxVms": 16,
    "defaultCpus": 2,
    "maxCpus": 4,
    "defaultMemMib": 512,
    "maxMemMib": 4096,
    "maxTtlSeconds": 3600
  }
}
```

`192.0.2.10` is a documentation-only address. Replace it with the dedicated
daemon VM's assigned private address, never a Proxmox host management address.
The example assumes the 2 GiB image produced below.

Notes:

- `kernelArgs` is operator-owned and caller-invisible. The example uses the
  same kernel arguments as the image's `/sbin/init` and as the jailed boot the
  hosted acceptance workflow dispatches; a boot on your own host remains
  unverified until you run the acceptance there.
- The image includes pnpm 11.13.1 and an operator-owned, offline-ready
  `/opt/microvm/next-template`. Run `microvm-next-init` once against an empty
  `/workspace`; it never merges into existing source. `pnpm dev` then binds
  guest loopback `127.0.0.1:3000`.
- The lockfile is policy-verified exactly once, during the image build's
  resolver-enabled online fetch, which forces `trustLockfile=false`. Every
  later pnpm step — the image's own offline materialization and any in-guest
  install — runs with the template's `trustLockfile: true` and `offline: true`;
  the lockfile is root-owned and baked into the image, and re-verification is
  registry-backed, which the no-NIC guest cannot do. A missing store entry
  fails with `ERR_PNPM_NO_OFFLINE_TARBALL` rather than reaching a registry, and
  the builder refuses to build if the shipped template stops resolving those
  settings.
- The UID-1000-writable pnpm store and cache live at
  `/var/lib/microvm/pnpm-store` and `/var/lib/microvm/pnpm-cache`, outside
  `/workspace` so `microvm-next-init` still sees an empty target.
- Git comes from the same pinned Debian snapshot. A guest-local commit is
  optional and ephemeral: set a non-secret repository-local author, commit,
  prove a clean index/worktree, and record `git rev-parse HEAD` if you need a
  coherent local revision for inspection. This repository does not export that
  commit and does not block destroy on it. Guests have no Git credentials,
  remote, NIC, DNS, or push path.
- `memory.max` per VM = guest `memMib` + the configured `vmmOverheadMib`; do
  not drop the overhead or the OOM killer can take valid VMs.
- `jailerFsizeBytes` must be at least the largest allowed root image.
- `runStateDir` stores one private logical full-size root disk per live VM.
  Provisioning requests a copy-on-write reflink and automatically falls back
  to an ordinary private copy when unsupported. That private disk also isolates
  the UID-1000-writable `/var/lib/microvm/pnpm-store` and
  `/var/lib/microvm/pnpm-cache`; never replace either with a path shared across
  VMs. Put `runStateDir` on disk-backed storage and size for
  the worst case: `maxVms × image size` plus headroom, because fallback copies,
  dependency-store writes, and project writes can consume the full space.
- `create` returns only after the guest runner answers a readiness probe
  bounded by `guestReadinessTimeoutMs`.
- `create` requires `imageDigest` from the image manifest (`sha256:` and 64
  lowercase hex of the final raw rootfs). The daemon resolves the allowlisted
  name against that digest, then hashes the private rootfs copy before boot.
  `VmInfo.imageDigest` is the measured copy. `--print-manifest` requires the
  already-measured `--image-digest` and never invents a placeholder.
- `maxTtlSeconds` is both the default lifetime when `create` omits a TTL and
  the hard upper bound.
- The daemon holds an advisory kernel `flock` on
  `runStateDir/daemon.lock`. It never unlinks that inode or trusts stale owner
  metadata. If the lock-helper process dies, the HTTP listener and daemon
  scope shut down.

## Credential lifecycle

- Admin tokens come from config (via env refs — never commit them; the
  cluster convention stores secrets in `.tfvars`/k8s Secrets, never in git).
- `create` mints a sandbox token (`mvs_…`) and returns it **once**. The state
  evidence contains VM metadata but no credential material.
- A daemon restart destroys every VM and invalidates its sandbox credential;
  there is no credential or VM adoption across restart.
- `destroy` drops the VM's sandbox credentials immediately.

## Recovery semantics (honest)

- The daemon is authoritative and in-memory; `runStateDir/vms/<id>/` is
  evidence, not a session store.
- **A daemon restart destroys all VMs found on disk**: orphan jailer cgroups
  are killed (`cgroup.kill`), then the VM directories are removed. There is
  no VM adoption.
- State writes are atomic (temp file + rename); a crash mid-write cannot
  produce a torn state file.

## Immutable non-production host release

`.github/workflows/release.yml` is manual and non-production-only. Its required
inputs are an exact lowercase 40-hex `source_sha`, a new `vX.Y.Z` `tag` matching
`package.json`, and an explicit `publish` boolean. It first calls the hosted
Linux/KVM acceptance workflow for that exact commit. The build then performs a
frozen install, `pnpm check-all`, guest Go race tests, deterministic host
packaging, SBOM generation, GitHub build-provenance attestation, and Actions
artifact upload. `publish: false` stops without a tag or release write.

Publishing is always a prerelease and never marks the release latest. It
requires the repository's immutable-releases setting, refuses an existing tag,
release, or asset, creates the tag at the requested commit, uploads each asset
once to a draft release, verifies the exact asset-name set and the
GitHub-reported digests of both primary artifacts against the built
checksums, and only then publishes the draft and requires GitHub to report
`isImmutable: true`. Any verification failure removes the just-created
release and tag and fails; the release is never sealed while unverified. The
workflow uses only the built-in `GITHUB_TOKEN`; it has no host, SSH,
Cloudflare, daemon-token, or TLS secret and does not deploy anything. Do not
add provenance-doc mutations after tagging: the workflow's sidecars and
attestation are the immutable evidence.

`scripts/build-release-artifact.sh` requires the toolchain qualified by hosted
acceptance: Node.js `v24.20.0`, pnpm `10.34.5`, and a prebuilt `dist/`. It uses
`pnpm deploy --prod --legacy --os=linux --cpu=x64 --libc=glibc` for the
production dependency tree and emits:

```text
microvm-<version>-<40sha>.tgz
microvm-<version>-<40sha>.tgz.sha256
microvm-<version>-<40sha>.tgz.inventory.txt
microvm-<version>-<40sha>.tgz.provenance.json
microvm-host-linux-x86_64-<version>-<40sha>.tar.gz
microvm-host-linux-x86_64-<version>-<40sha>.tar.gz.sha256
microvm-host-linux-x86_64-<version>-<40sha>.tar.gz.inventory.txt
microvm-host-linux-x86_64-<version>-<40sha>.tar.gz.provenance.json
microvm-host-linux-x86_64-<version>-<40sha>.tar.gz.spdx.json
```

The `.tgz` is the npm-consumable SDK package from the same deterministic
run: the manifest's `files` whitelist (`dist`, README, `docs`) plus
`package.json` under an npm `package/` root, with `dependencies` declared
and never vendored (no `node_modules` in the tarball). The builder refuses
stale `dist` output without a source file, requires every declared
export/bin target to exist, and rejects removed legacy subpaths. Consumers
pin the exact immutable release URL plus the independently recorded
SHA-256; this is a `private` GitHub prerelease, never an npm publication.
Both primary artifacts are attested together and digest-verified against
the release assets before the immutable seal.

The tar is path-sorted with normalized timestamps, numeric root ownership, and
read-only `0555` directories plus `0444`/`0555` files. The inventory is sorted
and binds every regular file and symlink by mode, owner, byte count, SHA-256,
and path. The embedded release manifest binds version, source commit, platform,
entrypoints, fail-closed admission generation, systemd unit, and the external
runtime contract.

Node is intentionally **not** bundled: this repository has no reviewed host
Node archive digest. Deployment therefore requires `/usr/bin/node` to report
exactly `v24.20.0`; a mismatch fails rather than weakening immutable rollback.
The package contains production dependencies, but not Firecracker, jailer,
the guest kernel, images, config, or secrets. Firecracker `v1.17.0` and jailer
binary hashes are fixed in the manifest. The operator supplies and verifies the
promoted kernel SHA-256 and image `imageDigest` separately.

## systemd service

The canonical unit is `deploy/systemd/microvm-daemon.service`. It runs as root
because the daemon must open KVM, manage cgroup v2, prepare jailer chroots, and
then let jailer drop each VMM to its configured UID/GID. It uses:

```text
WorkingDirectory=/opt/microvm/current/package
EnvironmentFile=/etc/microvm/microvm.env
ExecStart=/usr/bin/node /opt/microvm/current/package/dist/bin/daemon.js --config /etc/microvm/config.json
```

The environment file and config are root-owned, non-symlinked, and not
group/world-writable. The environment file defines `MICROVM_ADMIN_TOKEN`; TLS
PEM environment references remain host-owned. `/etc/microvm/ca.pem` is the CA
used by the administrative CLI. Releases live below
`/opt/microvm/releases/<version>-<40sha>/`; `/opt/microvm/current` is an atomic
symlink. Firecracker/jailer binaries, images, and run state remain under their
operator paths in `/var/lib/microvm` and are not replaced by an application
deploy.

`KillMode=mixed` sends SIGTERM to the daemon first, allowing its scoped shutdown
to destroy VMs and prove cgroup/run-state release. `TimeoutStopSec=30s` is
longer than the existing 20-second daemon shutdown bound; only then may systemd
SIGKILL remaining children. The unit deliberately avoids generic sandboxing
options that would block KVM, cgroup, jailer/chroot, image, or run-state access.
Every automatic restart is safe only because `acceptingAtStartup` is required
to be `false`.

## Canary deployment and rollback

Run `scripts/deploy-host.sh` locally as root on an approved, unrouted or
drained Linux x86_64 canary. It never uses SSH and never writes Cloudflare.
`--help` documents every argument; `--validate-only` verifies the archive,
checksum, sorted inventory, safe member/link paths, manifest, exact identities,
and versioned/symlink plan off-host without requiring root or mutating systemd
or the install root.

The real path additionally verifies trusted config/environment/CA paths,
`/usr/bin/node`, configured Firecracker/jailer/kernel bytes, and the selected
image manifest/raw digest. It takes a kernel-held deployment flock, refuses an
existing release directory, and preserves diagnostics under
`/var/lib/microvm/deploy`.

For an existing admission-compatible daemon the sequence is fixed:

1. `microvm set-admission --no --json`, then require `microvm info --json` to
   report the old version and `accepting: false`. Allow the configured drain
   grace; if VMs remain, list their exact IDs, destroy each within the separate
   forced-destruction bound, and require `liveVms: 0`.
2. Prove both the daemon run-state VM directory and dedicated jailer cgroup
   parent contain no VM residue. Stop systemd within the configured bound;
   residue is retained for diagnosis on failure, never deleted to force green.
3. Move the verified tree into its immutable version directory, install the
   checked-in unit, and atomically replace `current` with a same-directory
   temporary symlink plus rename.
4. Start the daemon and require `info` to report the requested version,
   `accepting: false`, and `liveVms: 0`. Require empty VM run-state/cgroup
   directories and verify the systemd main process working directory resolves
   to the selected release.
5. Prove a real create fails specifically with `AdmissionClosed`, then run
   `microvm set-admission --yes --json`.
6. Run one bounded create/exec/status/destroy lifecycle against the exact
   operator-supplied image digest; require `liveVms: 0` and no VM run-state or
   cgroup residue afterward.

Any failure after the old daemon is stopped or the new symlink is switched
closes admission, stops the new unit, restores exactly one captured compatible
symlink/unit, starts it closed, repeats the version, closed-create, zero-VM,
and residue gates, removes only the failed candidate tree, then opens it. The
diagnostic log remains outside the release tree and there is no retry loop. If
rollback cannot be proved, the service remains stopped/admission closed and
all diagnostic state is retained. `--simulate-post-switch-failure` deliberately
fails after the new closed-start gates and requires a compatible prior release;
its expected nonzero run proves this exact single rollback path before a normal
canary run can reuse the verified artifact.

The pre-cutover `v0.2.0` daemon has no admission gate and is not a safe rollback
target after routing exists. `--bootstrap` therefore permits no compatible
prior release only while the service is already inactive on an unrouted
canary; a failed bootstrap remains stopped. Establish an admission-aware
baseline before enabling the Cloudflare route.

On the primary approved canary, first run the rollback simulation and require
the previous version to be restored, closed-checked, residue-free, and reopened;
then rerun normally and require exact version, closed-start, `AdmissionClosed`,
lifecycle, and zero-residue evidence. Only then apply the same artifact and
checksums normally to the approved second canary host. A greenfield
`--bootstrap` has no compatible prior release and therefore cannot simulate
rollback: keep it unrouted and accept only a fail-closed stopped result until an
admission-aware baseline exists. Production changes, VPC Service/Tunnel
configuration, and Free Vibecode implementation are outside this workflow and
script.

## Acceptance

Run on a native Linux KVM host. Build inputs are explicit:

```bash
export KERNEL_SHA256='<trusted 64-hex digest>'
sudo scripts/build-guest-image.sh \
  --arch x86_64 \
  --kernel /operator/microvm.kernel \
  --kernel-sha256 "$KERNEL_SHA256" \
  --output-dir /var/lib/microvm/images \
  --name node \
  --size-mib 2048

export MICROVM_URL='https://192.0.2.10:9443'
export MICROVM_TOKEN='<admin token from the secret manager>'
export MICROVM_IMAGE='node'
export MICROVM_IMAGE_MANIFEST='/var/lib/microvm/images/node.json'
export MICROVM_RUN_STATE_DIR='/var/lib/microvm/run'
export MICROVM_CGROUP_ROOT='/sys/fs/cgroup/microvm.slice'
scripts/accept-linux.sh
```

The base image prewarms only the pinned public Free Vibecode dependency graph.
`@free-vibecode/site-sdk@0.2.0` is not on the public npm registry; a trusted
project materializer must supply that package or its source when required.
Image construction intentionally never fetches it.

### Hosted acceptance (CI)

`.github/workflows/acceptance.yml` remains manually dispatchable and is also a
least-permission reusable workflow for an exact 40-hex commit. It runs the real
path on a standard public `ubuntu-24.04` runner with `contents: read` and a
bounded job timeout: a fail-closed KVM/cgroup/disk preflight (a missing
capability fails the job, it never skips), digest-verified pinned
Firecracker/jailer
installed under the dedicated root-owned `/var/lib/microvm/bin` prefix (the CI
job does not depend on or modify shared `/usr/local`), and the pinned kernel
under `/var/lib/microvm/images` (provenance and trust labels in
`docs/runtime-artifacts.md`; the kernel digest is a TOFU observation of the
first-party CI fixture, not an upstream signature), `pnpm test` with the
kernel-flock test asserted unskipped, guest `go test -race`, a hosted-only
tagged real-AF_VSOCK peer-authorization test compiled and run as the runner
user under a hard timeout after a root-only `vsock_loopback` module load, the
pinned image build, then the guest exec v1 protocol against a jailed VM the
daemon booted. That guest check covers the idle request-header deadline,
Git and pnpm/template pins, UID-1000 store ownership, empty runtime resolver,
offline initialization without overwrites, and a Next.js dev server listening
only on `127.0.0.1:3000`. It creates and commits a guest-local repository with
a non-secret local author, proves the index/worktree clean, records
`git rev-parse HEAD`, and proves no remote or push destination exists. The
runtime isolation checks and two-VM daemon acceptance follow. The daemon's
admin token is generated
ephemerally, masked before any output, and passed only through the config's
`${ENV}` reference; teardown rides the daemon's native shutdown lifecycle plus
an always-step cleanup, and the uploaded evidence contains versions,
checksums, logs, and timings only — never tokens, the rootfs image, or daemon
config.

## Troubleshooting

- `HostPrereqFailed: …` — the reason lists every failed check by name; fix
  all of them (the aggregation is deliberate).
- `VmPoisoned` — the guest's state became unknowable (transport violation,
  exec deadline, or VMM death). `destroy` and create a new VM; never reuse.
- `DestroyUncertain` — teardown could not be proven complete; retry destroy.
  The VM must not be treated as released while this persists.
- CLI exit codes: 0 ok · 1 operation error · 2 auth · 3 not found ·
  4 capacity · 5 prereq/boot · 10 transport. Exec exits with the guest's
  exit code (signal death = 128+signum, so a guest timeout kill is 137).
