# microvm

A fail-closed Firecracker microVM runtime built with Effect v4 RPC, a jailed
per-VM filesystem and cgroup, a small Go guest runner, and Vercel AI SDK tools
bound to one sandbox.

This is not a container wrapper. Every sandbox is a Firecracker VM started only
through `jailer`; no direct-Firecracker or degraded execution path exists.

## Platform support

The daemon is Linux-only and must run as root with KVM and cgroup v2. macOS can
build, typecheck, run portable tests, and use the client, but it cannot perform
a real Firecracker boot because macOS does not expose Linux `/dev/kvm`. A probe
that opens `/dev/kvm` is only a prerequisite check; the Linux acceptance run is
the proof that nested KVM and the complete boot path work.

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

Build the pinned Debian Trixie guest image on a native Linux host as root. The
kernel and digest are trusted operator inputs:

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

The builder emits `node.raw`, `node.kernel`, `node.json`, and `node.sha256`; do
not create a second manifest manually. It verifies Debian snapshot metadata,
the pinned official Node.js tarball checksum, and the supplied kernel digest.
It never fetches an unpinned `latest` artifact.

## Hosted acceptance

A dispatch-only GitHub Actions workflow
(`.github/workflows/acceptance.yml`) exercises the real path on a hosted
`ubuntu-24.04` KVM runner: a fail-closed KVM/cgroup preflight; digest-verified
pinned Firecracker/jailer installed under the dedicated root-owned
`/var/lib/microvm/bin` prefix; the pinned kernel and image build; the guest
protocol over a jailered VM's vsock; and the two-VM daemon acceptance. Artifact
provenance and trust labels live in
[docs/runtime-artifacts.md](docs/runtime-artifacts.md);
what the workflow runs is described in
[docs/operations.md](docs/operations.md).

## Daemon

Configuration is JSON. String values may use `${ENV_NAME}`; resolved secrets are
never included in configuration errors or normal logs.

```json
{
  "listen": { "host": "127.0.0.1", "port": 9443 },
  "advertisedUrl": "http://127.0.0.1:9443",
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

`runStateDir` holds a private logical full-size root disk per live VM.
Provisioning requests a copy-on-write reflink and automatically falls back to
an ordinary private copy when the filesystem does not support reflinks. Keep it
on disk-backed storage, not `/run` or another tmpfs, and provision for the
worst case: at least `maxVms × image size` plus filesystem headroom, because
fallback copies and guest writes can consume the full space. `jailerFsizeBytes`
must be no smaller than the largest allowed root image; the 2 GiB value above
matches the builder command.

For a non-loopback listener, add `tls` with non-empty PEM `cert`, `key`, and
`ca` values and use an HTTPS `advertisedUrl`. The daemon validates all host
prerequisites and acquires an exclusive kernel `flock` before listening. The
lock file and `daemon.owner.json` are only diagnostics: stale contents are
never treated as ownership and the lock file is never unlinked. A second
daemon for the same `runStateDir` fails, and loss of the lock-helper process
shuts the owning daemon down.

```sh
export MICROVM_ADMIN_TOKEN="$(openssl rand -hex 32)"
# Store this value in the host secret manager so daemon restarts retain admin access.
node dist/bin/daemon.js --config /etc/microvm/config.json
```

See [operations](docs/operations.md) for deployment and failure semantics.

## CLI

```sh
export MICROVM_URL=http://127.0.0.1:9443
export MICROVM_TOKEN="$MICROVM_ADMIN_TOKEN"

microvm create --image node --cpus 1 --mem-mib 256 --ttl-s 300 --json
microvm status --vm mvm-example --json
microvm exec --vm mvm-example --cwd /workspace -- /usr/bin/node --version
microvm list --json
microvm destroy --vm mvm-example --json
microvm cleanup --json
```

`create` returns a sandbox token only in its response. Store it as a secret; it
can be reused only for that VM and is revoked on destroy. Admin credentials
are required for create and cleanup. Commands are argv arrays executed
directly; no shell is inserted.

## TypeScript client

```ts
import { Effect } from "effect"
import { makeMicrovmClient } from "microvm"

const program = Effect.scoped(Effect.gen(function* () {
  const client = yield* makeMicrovmClient({
    url: "https://host-a.example:9443",
    token: process.env.MICROVM_TOKEN!
  })
  const created = yield* client.create({
    image: "node", cpus: 1, memMib: 256, ttlSeconds: 300
  })
  return created
}))

await Effect.runPromise(program)
```

The client sends each request once; it does not retry ambiguous creates or
silently reroute to the `owningHost` supplied in a response.

## Static cluster client

`makeMicrovmCluster` polls a configured daemon set with bounded health checks,
places on a responsive host, and retries only an explicit capacity rejection:

```ts
import { Effect } from "effect"
import { makeMicrovmCluster } from "microvm"

const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const cluster = yield* makeMicrovmCluster({
    endpoints: [
      { url: "https://host-a.example:9443", token: process.env.HOST_A_TOKEN! },
      { url: "https://host-b.example:9443", token: process.env.HOST_B_TOKEN! }
    ],
    healthTimeoutMs: 2000
  })
  const sandbox = yield* cluster.create({
    image: "node", cpus: 1, memMib: 256, ttlSeconds: 300
  })
  return yield* sandbox.execute({
    argv: ["/usr/bin/node", "--version"],
    cwd: "/workspace",
    env: undefined,
    timeoutMs: 30000,
    maxOutputBytes: 1048576
  })
})))
```

For model-bound `run_command`, `read_file`, and `write_file` tools using
`generateText` or `streamText`, see [Vercel AI SDK tools](docs/ai-tools.md).

## Trust boundaries

- RPC callers select an allowlisted image name, never host paths or kernel args.
- Every VM receives a private root disk copy and no network interface.
- Guest I/O is vsock-only; exec has bounded time, frame size, chunk count, and
  per-stream output.
- Transport uncertainty poisons the VM. Destroy stops the VMM promptly and
  queued execs re-check liveness before reaching the guest.
- Failed cleanup retains capacity, UID/GID, CID, and VM-ID reservations in
  quarantine until cleanup is proven complete.
- AI tools close over a sandbox-scoped client and VM ID; model input cannot
  choose a host, credential, or another VM.

The guest wire contract is in [docs/protocol.md](docs/protocol.md); module and
trust-boundary details are in [docs/architecture.md](docs/architecture.md).
