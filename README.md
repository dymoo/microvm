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
the pinned official Node.js checksum, pnpm **11.13.1**'s official npm
`dist.integrity`, the template lockfile, and the supplied kernel digest. The
image contains Git from the pinned Debian snapshot, an operator-owned Next.js
template, its ready `node_modules`, and a private writable pnpm store and cache.
The lockfile is supply-chain verified once by the build's resolver-enabled
fetch; the shipped template then installs strictly offline. In a new VM, run
`microvm-next-init` once in the empty `/workspace`, then `pnpm dev`; the app
binds only `127.0.0.1:3000`. Neither command downloads packages.

Before destroying a VM, Git can create a coherent guest-local checkpoint:
configure a non-secret local author, `git add --all`, commit, require a clean
status, and record `git rev-parse HEAD`. That commit remains ephemeral with the
private VM disk until a trusted external export verifies and persists it; that
export is not implemented here. The guest has no remote, Git credentials, NIC,
DNS, or push path.

## Hosted acceptance

A dispatch-only GitHub Actions workflow
(`.github/workflows/acceptance.yml`) exercises the real path on a hosted
`ubuntu-24.04` KVM runner: a fail-closed KVM/cgroup preflight; digest-verified
pinned Firecracker/jailer installed under the dedicated root-owned
`/var/lib/microvm/bin` prefix; a hosted-only real AF_VSOCK peer-authorization
gate run as the runner user after a root-only loopback module load; the pinned
kernel and image build; the guest protocol over a jailed VM's vsock, including
its idle request-header deadline; and the two-VM daemon acceptance. Artifact
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

## HTTP preview and durable web service (current `main` source)

These APIs are **not in the immutable `v0.1.0` release**. The published
`microvm-0.1.0-*.tgz` asset contains the typed RPC client, cluster placement,
and AI tools, but no `SandboxHandle.http()`, `startWebService`, or guest HTTP
bridge. The example below is a source-revision contract on `main`; treat it as
unreleased until a later tag contains it.

`sandbox.http()` binds the VM's ingress capability to the image's immutable
`web` endpoint. No caller supplies a socket path, guest host, or guest TCP
port, and an image without `httpEndpoints.web.port` fails with
`HttpNotConfigured` before any guest I/O. `startWebService` runs one durable
service per VM with direct argv execution; a second start is refused, and the
service outlives the control connection that started it.

```ts
import { Effect } from "effect"
import { createServer, type Server } from "node:http"
import type { Socket } from "node:net"
import { makeMicrovmCluster } from "microvm"

const program = Effect.scoped(Effect.gen(function* () {
  const cluster = yield* makeMicrovmCluster({
    endpoints: [
      { url: "https://host-a.example:9443", token: process.env.HOST_A_TOKEN! }
    ]
  })
  const sandbox = yield* cluster.create({
    image: "node", cpus: 1, memMib: 512, ttlSeconds: 900
  })

  // One durable service per VM; argv runs directly, with no shell.
  const service = yield* sandbox.startWebService({
    argv: ["/usr/local/bin/pnpm", "dev"],
    cwd: "/workspace"
  })

  // Node routes these four events independently, so wire all four: a missing
  // `connect` or `checkContinue` listener changes the refusal into a silent
  // hang-up or an interim `100 Continue` this adapter never forwards.
  const proxy = yield* sandbox.http()

  // The trusted host owns the listener and every socket it accepted. Node
  // detaches upgraded sockets from the server's own accounting, so
  // `closeAllConnections()` never closes them and the `close` callback never
  // fires while one is open. `acquireRelease` runs the same release on
  // failure or interruption, so neither the listener nor a socket leaks
  // before the happy path.
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async (): Promise<{ server: Server; sockets: Set<Socket> }> => {
        const sockets = new Set<Socket>()
        const server = createServer(proxy.handleRequest)
        server.on("connection", (socket) => {
          sockets.add(socket)
          socket.once("close", () => sockets.delete(socket))
        })
        server.on("upgrade", proxy.handleUpgrade)
        server.on("connect", proxy.handleConnect)
        server.on("checkContinue", proxy.handleCheckContinue)
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject)
          server.listen(8_080, "127.0.0.1", resolve)
        })
        return { server, sockets }
      },
      catch: (cause) => new Error(`preview listener failed: ${String(cause)}`)
    }),
    ({ server, sockets }) => Effect.promise(async () => {
      // Stop accepting, then destroy every accepted socket -- including the
      // upgraded ones `closeAllConnections()` leaves open -- before awaiting
      // the close callback.
      const closed = new Promise<void>((resolve, reject) => {
        server.close((cause) => (cause === undefined ? resolve() : reject(cause)))
      })
      for (const socket of sockets) socket.destroy()
      await closed
    })
  )

  // Destroy is the caller's explicit step, and this example destroys only when
  // no checkpoint is unexported: a guest-local commit stays ephemeral until a
  // trusted external export verifies it. Leaving the scope closes the
  // listener, its sockets, and the scoped clients; it never destroys the VM.
  yield* service.stop()
  return yield* sandbox.destroy()
}))

await Effect.runPromise(program)
```

The guest-side contract, including the fixed vsock purposes, the manifest
endpoint, and the refusal semantics for CONNECT and `Expect`, lives in
[docs/protocol.md](docs/protocol.md).

For model-bound `run_command`, `read_file`, and `write_file` tools using
`generateText` or `streamText`, see [Vercel AI SDK tools](docs/ai-tools.md).

## Trust boundaries

- RPC callers select an allowlisted image name, never host paths or kernel args.
- Every VM receives a private root disk copy and no network interface.
- Guest I/O is vsock-only; exec has bounded time, frame size, chunk count, and
  per-stream output.
- HTTP ingress is capability-scoped to one VM and can dial only that image's
  fixed manifest target; callers never receive a guest socket or choose a
  target.
- Transport uncertainty poisons the VM. Destroy stops the VMM promptly and
  queued execs re-check liveness before reaching the guest.
- Failed cleanup retains capacity, UID/GID, CID, and VM-ID reservations in
  quarantine until cleanup is proven complete.
- AI tools close over a sandbox-scoped client and VM ID; model input cannot
  choose a host, credential, or another VM.

The guest wire contract is in [docs/protocol.md](docs/protocol.md); module and
trust-boundary details are in [docs/architecture.md](docs/architecture.md).
