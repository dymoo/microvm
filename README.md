# microvm

A fail-closed Firecracker microVM runtime built with Effect v4 RPC, a jailed
per-VM filesystem and cgroup, and a small Go guest runner. The daemon is a
single trusted in-memory supervisor reached over one authenticated RPC
endpoint; Cloudflare Workers reach it through a fixed VPC Service over
Cloudflare Tunnel (the
[greenfield cutover](docs/adr/0001-in-memory-daemon-and-cloudflare-cutover.md),
[dymoo/microvm#1](https://github.com/dymoo/microvm/issues/1)).

This is not a container wrapper. Every sandbox is a Firecracker VM started
only through `jailer`; no direct-Firecracker or degraded execution path
exists. There is no static cluster, no placement/failover API, no
sandbox-handle layer, no admin reaper RPC, and no daemon-side durable store:
a daemon restart destroys every VM it finds on disk and starts
admission-closed.

## Platform support

The daemon is Linux-only and must run as root with KVM and cgroup v2. macOS
can build, typecheck, run portable tests, and use the client, but it cannot
perform a real Firecracker boot because macOS does not expose Linux
`/dev/kvm`. A probe that opens `/dev/kvm` is only a prerequisite check; the
Linux acceptance run is the proof that nested KVM and the complete boot path
work.

References: [Firecracker getting started](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md),
[Firecracker jailer](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md),
[Effect RPC](https://effect.website/docs/rpc/introduction/), and the
[Vercel AI SDK tool guide](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling).

## Install and verify

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Build the pinned Debian Trixie guest image on a native Linux host as root.
The kernel and digest are trusted operator inputs:

```sh
export KERNEL_SHA256='<trusted 64-hex digest>'
sudo scripts/build-guest-image.sh \
  --arch x86_64 \
  --kernel /operator/microvm.kernel \
  --kernel-sha256 "$KERNEL_SHA256" \
  --output-dir /var/lib/microvm/images \
  --name node \
  --size-mib 2048
```

The builder emits `node.raw`, `node.kernel`, `node.json`, and `node.sha256`;
do not create a second manifest manually. After the final raw writes it
hashes those bytes, writes `imageDigest` (`sha256:` plus 64 lowercase hex)
into `node.json`, and reuses that digest for the raw sidecar entry. Kernel
checksums stay separate trusted operator input; they are not folded into
`imageDigest`. `--print-manifest` reprints a manifest only when you pass
that already-measured `--image-digest`; it never invents a placeholder.
Create callers must supply the same digest from the operator-held manifest —
never a made-up hash.

It verifies Debian snapshot metadata, the pinned official Node.js checksum,
pnpm **11.13.1**'s official npm `dist.integrity`, the template lockfile, and
the supplied kernel digest. The image contains Git from the pinned Debian
snapshot, an operator-owned Next.js template, its ready `node_modules`, and
a private writable pnpm store and cache. The lockfile is supply-chain
verified once by the build's resolver-enabled fetch; the shipped template
then installs strictly offline. In a new VM, run `microvm-next-init` once in
the empty `/workspace`, then `pnpm dev`; the app binds only
`127.0.0.1:3000`. Neither command downloads packages.

A guest-local Git commit is optional and ephemeral with the private VM disk.
Configure a non-secret local author, `git add --all`, commit, require a
clean status, and record `git rev-parse HEAD` if you need a coherent local
revision for inspection. The guest has no remote, Git credentials, NIC, DNS,
or push path. This repository does not export that commit and does not block
destroy on it.

## Hosted acceptance

A dispatch-only GitHub Actions workflow
(`.github/workflows/acceptance.yml`) exercises the real path on a hosted
`ubuntu-24.04` KVM runner: a fail-closed KVM/cgroup preflight; digest-verified
pinned Firecracker/jailer installed under the dedicated root-owned
`/var/lib/microvm/bin` prefix; a hosted-only real AF_VSOCK
peer-authorization gate run as the runner user after a root-only loopback
module load; the pinned kernel and image build; the guest protocol over a
jailed VM's vsock, including its idle request-header deadline; and the
two-VM daemon acceptance. Artifact provenance and trust labels live in
[docs/runtime-artifacts.md](docs/runtime-artifacts.md); what the workflow
runs is described in [docs/operations.md](docs/operations.md).

## Daemon

Configuration is JSON. String values may use `${ENV_NAME}`; resolved secrets
are never included in configuration errors or normal logs.

```json
{
  "listen": { "host": "127.0.0.1", "port": 9443 },
  "advertisedUrl": "http://127.0.0.1:9443",
  "acceptingAtStartup": false,
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
    "guestCidRange": [5000, 5099],
    "kernelArgs": "console=ttyS0 reboot=k panic=-1 pci=off nomodule random.trust_cpu=on root=/dev/vda rw init=/sbin/init",
    "bootTimeoutMs": 30000,
    "guestReadinessTimeoutMs": 10000,
    "vmmOverheadMib": 32,
    "maxPidsPerVm": 256,
    "jailerFsizeBytes": 2147483648,
    "jailerNoFileLimit": 1024
  },
  "limits": {
    "maxVms": 10,
    "defaultCpus": 1,
    "maxCpus": 2,
    "defaultMemMib": 256,
    "maxMemMib": 1024,
    "maxTtlSeconds": 3600
  }
}
```

`acceptingAtStartup` is required and must literally be `false`: every
process start is admission-closed, and an authenticated operator opens
admission with `set-admission` only after health checks. A daemon restart
re-reads this config and adopts nothing.

`runStateDir` holds a private logical full-size root disk per live VM.
Provisioning requests a copy-on-write reflink and automatically falls back
to an ordinary private copy when the filesystem does not support reflinks.
Keep it on disk-backed storage, not `/run` or another tmpfs, and provision
for the worst case: at least `maxVms × image size` plus filesystem headroom.
`jailerFsizeBytes` must be no smaller than the largest allowed root image.

For a non-loopback listener, add `tls` with non-empty PEM `cert`, `key`, and
`ca` values and use an HTTPS `advertisedUrl`. The daemon validates all host
prerequisites and acquires an exclusive kernel `flock` before listening.
The lock file and `daemon.owner.json` are only diagnostics: stale contents
are never treated as ownership and the lock file is never unlinked. A second
daemon for the same `runStateDir` fails, and loss of the lock-helper process
shuts the owning daemon down.

```sh
export MICROVM_ADMIN_TOKEN="$(openssl rand -hex 32)"
# Store this value in the host secret manager so daemon restarts retain admin access.
node dist/bin/daemon.js --config /etc/microvm/config.json
```

See [operations](docs/operations.md) for the deployment shape, immutable
release/rollback runbook, canary ordering, and failure semantics.

## CLI

```sh
export MICROVM_URL=https://node1.internal.dylans.link:9443
export MICROVM_TOKEN="$MICROVM_ADMIN_TOKEN"
export MICROVM_IMAGE_DIGEST='sha256:<64 lowercase hex from the image manifest>'

microvm info --json                                   # admin: version, accepting, liveVms
microvm set-admission --yes --json                    # admin: open the create gate
microvm create --image node --image-digest "$MICROVM_IMAGE_DIGEST" --cpus 1 --mem-mib 256 --ttl-s 300 --json
microvm status --vm mvm-example --json
microvm exec --vm mvm-example --cwd /workspace -- /usr/bin/node --version
microvm list --json
microvm destroy --vm mvm-example --json
microvm set-admission --no --json                     # admin: close the create gate
```

`create` requires `--image-digest` matching the allowlisted image manifest;
omitting it fails before any network call with a usage error. Its response
carries the VM record, the once-only sandbox token, and the HTTP ingress
token when the image declares a `web` endpoint — store them as secrets.
`create`, `info`, and `set-admission` are admin-only RPCs. `exec`, `status`,
`list`, and `destroy` accept an admin token or the VM's own sandbox token;
a sandbox token lists and destroys only its own VM. The CLI runs every
command except `exec`/`status` through the admin client, so those need the
admin token. Commands are argv arrays executed directly; no shell is
inserted. There is no `cleanup` command: the daemon's own periodic reaper
reclaims expired, poisoned, and quarantined VMs.

Exit codes: 0 ok · 1 operation error · 2 auth · 3 not found · 4 capacity or
admission-closed · 5 prereq/boot · 10 transport. `exec` exits with the
guest's exit code (signal death = 128+signum, so a guest timeout kill is
137).

## TypeScript clients

Every client is request-scoped: constructed per use with exactly one bearer
credential, holding no process-global state. Each request is one
self-contained HTTP exchange (`POST /rpc`); the transport keeps no durable
session and a disconnect interrupts in-flight work. Two runtime roots share
one runtime-neutral core:

- `microvm/client` is the Node surface — the scoped admin and sandbox views
  over a CA-honoring Node transport (`ca?` for privately issued daemon
  certificates, optional `httpClient?` transport override), and nothing
  else;
- `microvm/workerd` is the edge surface with the same two constructors plus
  `makeSandboxHttpIngress` and `decodeExecResult`; its `fetch` option is
  **required** and must be the caller's VPC binding fetch, so a missing or
  mis-bound binding cannot become an accidental public-network call. Its
  verified import graph contains no Node builtins and no Node platform
  module.

`makeAdminClient` probes the daemon with `info` at construction and fails
`ClientConfigurationError` on any version mismatch against
`MICROVM_VERSION`, so a client never speaks a protocol the daemon cannot
interpret. `create` is exactly one RPC: no health, list, placement,
failover, or retry — including `CapacityExceeded`. An ambiguous create
cannot invent a vmId and is not retried.

```ts
import { Effect } from "effect"
import { makeAdminClient } from "microvm"

const program = Effect.scoped(Effect.gen(function* () {
  const admin = yield* makeAdminClient({
    url: "https://node1.internal.dylans.link:9443",
    token: process.env.MICROVM_TOKEN!
  })
  const created = yield* admin.create({
    image: "node",
    imageDigest: process.env.MICROVM_IMAGE_DIGEST!,
    cpus: 2,
    memMib: 2048,
    ttlSeconds: 300
  })
  // created: { vm, sandboxToken, httpIngressToken?, sandbox }
  const executed = yield* created.sandbox.execute({
    argv: ["/usr/bin/node", "--version"],
    cwd: "/workspace"
  })
  return executed
}))

await Effect.runPromise(program)
```

`makeSandboxScopedClient({ url, token, vmId })` builds a VM-bound client
with `execute`, `inspect`, `startWebService`, `webServiceStatus`, and
`stopWebService` only — no create, list, destroy, or admission surface. The
wire contract still lets a VM's own sandbox token destroy its own VM and
list just that VM; the scoped view deliberately omits them, which is why
this is the type AI tools receive. A sandbox credential authorizes exactly
its own VM (an admin token also works server-side, but never hand one to a
sandboxed consumer).

Both subpaths are scoped-only: no raw full-surface RPC client is exported,
and the public surface is exactly the two scoped constructors per runtime
subpath.

## HTTP preview and durable web service

One durable, unnamed `web` service runs per VM (port 3000 in the standard
Node image). `startWebService` takes `argv` plus optional `cwd` and `env`;
caller `HOSTNAME`/`PORT` entries are rejected; the guest injects
`HOSTNAME=127.0.0.1` and the manifest port; a second start is refused. The
service outlives the control connection; ordinary `execute` remains
available.

```ts
import { Effect } from "effect"
import { makeAdminClient } from "microvm"

const program = Effect.scoped(Effect.gen(function* () {
  const admin = yield* makeAdminClient({
    url: "https://node1.internal.dylans.link:9443",
    token: process.env.MICROVM_TOKEN!
  })
  const created = yield* admin.create({
    image: "node",
    imageDigest: process.env.MICROVM_IMAGE_DIGEST!,
    cpus: 2,
    memMib: 2048,
    ttlSeconds: 900
  })
  const status = yield* created.sandbox.startWebService({
    argv: ["/usr/local/bin/pnpm", "dev"],
    cwd: "/workspace"
  })
  return { vm: created.vm, status, httpIngressToken: created.httpIngressToken }
}))

await Effect.runPromise(program)
```

`httpIngressToken` is the VM's HTTP data-plane capability: it authorizes
only `/http/v1/vms/<vmId><target>` on the image's immutable `web` endpoint
and is revoked on destroy. Trusted fronting code constructs
`makeSandboxHttpIngress({ url, vmId, httpIngressToken, fetch? })`
explicitly — there is no auto-created ingress on a create result — with the
default or CA-bound fetch on Node. On the edge, import it from
`microvm/workerd`, where the binding fetch is **required** (the workerd
adapter throws before any I/O if it is absent and never falls back to
`globalThis.fetch`). The adapter is a request-scoped
Fetch-native adapter with independently enforced bounds: `Upgrade` is
refused `426` and `Expect`/`Trailer`/`Transfer-Encoding` refused `400` on
the caller's raw headers; `CONNECT`/`TRACE` are refused `405`; only
origin-form targets within the preview byte bounds pass; hop-by-hop,
connection-nominated, caller-forwarding, `proxy-*`, and reserved
`microvm-*` fields are stripped or refused; `Proxy-Authorization` is
injected exactly once on the final hop. A declared body above
`HTTP_PREVIEW_LIMITS.maxRequestBodyBytes` is refused `413` before any I/O,
an undeclared body is counted on the fly and the daemon hop is aborted the
moment the cap or the 30 s upload-idle window trips (nothing is buffered),
and a response head that misses the 120 s deadline aborts the hop (`504`):

```ts
import { makeSandboxHttpIngress } from "microvm"
// edge: import { makeSandboxHttpIngress } from "microvm/workerd" — fetch required

const ingress = makeSandboxHttpIngress({
  url: "https://node1.internal.dylans.link",
  vmId: created.vm.vmId,
  httpIngressToken: created.httpIngressToken!
})
const response = await ingress.handle(new Request("https://front.example/"))
```

The adapter has no server to close and holds no listening socket; lifetime
and revocation are the caller's (`destroy`, expiry). The guest-side
contract — fixed vsock purposes, the manifest endpoint, refusal semantics —
lives in [docs/protocol.md](docs/protocol.md). For the approved Cloudflare
serving path (Worker + one Durable Object per sandbox route), see
[ADR 0001](docs/adr/0001-in-memory-daemon-and-cloudflare-cutover.md), the
[qualification research](docs/research/workers-vpc-durable-object-qualification.md),
and the [Free Vibecode handoff](docs/handoff/free-vibecode-cloudflare-cutover.md).

## Trust boundaries

- RPC callers select an allowlisted image name and its required
  `imageDigest`, never host paths or kernel args. The daemon hashes the
  private rootfs copy before boot; `VmInfo.imageDigest` is that measured
  digest.
- Every VM receives a private root disk copy and no network interface.
- Guest I/O is vsock-only; exec has bounded time, frame size, chunk count,
  and per-stream output.
- HTTP ingress is capability-scoped to one VM and can dial only that image's
  fixed manifest target; callers never receive a guest socket or choose a
  target. Admin and sandbox control tokens are never ingress tokens, and
  ingress tokens never authorize control-plane RPCs.
- Transport uncertainty poisons the VM. Destroy stops the VMM promptly and
  queued execs re-check liveness before reaching the guest. Destroy is
  explicit; `DestroyUncertain` means the VM must not be treated as released.
- The daemon starts admission-closed and adopts nothing on restart; orphan
  jailer cgroups are killed and VM directories removed.
- Workers reach the daemon only through the fixed VPC Service → Tunnel path
  with `verify_full` origin verification; admin bearer tokens live only in
  approved secret managers.
- AI tools close over a sandbox-scoped client bound to one VM ID; model
  input cannot choose a host, credential, or another VM.

The guest wire contract is in [docs/protocol.md](docs/protocol.md); module
and trust-boundary details are in [docs/architecture.md](docs/architecture.md).
