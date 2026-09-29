# Handoff: the microvm abstraction Free Vibecode builds on

**For**: Free Vibecode coding agents. **From**: microvm, 2026-09-29.
**Purpose**: one page on what microvm is, the contract you code against,
and what is still open. The task-specific cutover plan remains
[free-vibecode-cloudflare-cutover.md](free-vibecode-cloudflare-cutover.md).
Where the two disagree, this page describes the current state.

## 1. What it is

microvm gives every sandbox its own **Firecracker microVM**. Each VM is
started only through `jailer`, with a private copy of a digest-verified
root disk, per-VM cgroup v2 ceilings, and **no network interface**. Host
and guest talk only over vsock. A root daemon is the single in-memory
supervisor for these VMs, and callers drive it over one authenticated Effect
RPC endpoint plus an HTTP preview data plane.

It is deliberately small:

- No cluster, placement, or failover.
- No durable daemon state. A daemon restart destroys every VM and starts
  admission-closed.
- No retries on `create`.
- No guest egress.
- Callers own sandbox lifetime and cleanup policy.

```
Free Vibecode (trusted orchestrator)
  │  Effect RPC, POST /rpc          admin or sandbox bearer token
  │  HTTP preview /http/v1/vms/:id  VM-bound ingress token
  ▼
microvm-daemon (root, Linux + KVM + cgroup v2)
  │  jailer: per-VM uid/gid, chroot, cgroup ceilings
  ▼
Firecracker VM ── vsock ── guest runner (exec, files, web service on :3000)
```

## 2. Version and install

- The protocol version is `MICROVM_VERSION = "0.3.0"`. The admin client
  refuses a daemon that reports any other version.
- Install the **v0.3.0 GitHub release tarball, pinned by SHA-256**. It is a
  prerelease and the package is not on npm.
- `main` also contains the 2026-09-29 changes: a Mac dev loop and opt-in
  guest huge pages. Neither changes the wire, the clients, or the version,
  so Free Vibecode needs no dependency bump for them.

## 3. The contract you code against

**Package roots**

| Import | Runtime | Contents |
| --- | --- | --- |
| `microvm` | Node | `makeAdminClient`, `makeSandboxScopedClient`, `makeSandboxHttpIngress`, and the AI tools |
| `microvm/client` | Node | Just the two scoped clients, plus `decodeExecResult` and `ClientConfigurationError` |
| `microvm/workerd` | Cloudflare | The same two clients plus `makeSandboxHttpIngress` and `decodeExecResult`. `fetch` is required and must be your VPC binding's fetch; there is never a `globalThis.fetch` fallback. |
| `microvm/ai` | Node | `createSandboxTools`, `SANDBOX_SYSTEM_PROMPT` |
| `microvm/protocol` | any | Wire schemas, typed errors, `HTTP_PREVIEW_LIMITS` |

**Clients**

- Both clients are **request-scoped**. Construct one per use, inside an
  Effect `Scope`, with exactly one credential. Nothing is process-global.
- The admin client covers the RPCs `create`, `setAdmission`, `info`,
  `list`, `inspect`, `destroy`, `execute`, `startWebService`,
  `webServiceStatus`, and `stopWebService`.
- `create({ image, imageDigest, cpus, memMib, ttlSeconds })` returns
  `{ vm, sandboxToken, httpIngressToken?, sandbox }`.
  - The `imageDigest` must match the allowlisted image manifest.
  - `httpIngressToken` exists only when the image declares a `web` endpoint.
  - `sandbox` is a ready `SandboxScopedClient`.
- The **sandbox-scoped client** is bound to one VM. It offers only
  `execute`, `inspect`, `startWebService`, `webServiceStatus`, and
  `stopWebService`: no create, list, destroy, or admission. This is the
  only client an AI or tenant path may receive.
- `execute` takes an argv array and runs it directly, with no shell. The
  result is terminal-only: exit code, signal, `timedOut`, and bounded
  stdout/stderr. A guest timeout kill reports 137 with `timedOut: true`.

**Errors**

These are exact tagged errors; do not widen them:
`Unauthenticated`, `Forbidden`, `VmNotFound`, `CapacityExceeded`,
`VmPoisoned`, `HostPrereqFailed`, `BootFailed`, `GuestExecError`,
`ImageNotAllowed`, `DestroyUncertain`, `AdmissionClosed`, `ServiceError`.

- `VmPoisoned`: the VM's transport state is uncertain. Destroy it and
  create a new one; never reuse it.
- `DestroyUncertain`: release is unproven, so treat the capacity as still
  held.

**Web service and preview**

- Each VM runs one durable `web` service on guest `127.0.0.1:3000`, started
  with `startWebService({ argv, cwd?, env? })`.
  - Do not set `HOSTNAME` or `PORT` in `env`; they are rejected.
  - A second start is refused.
- To serve a preview, your trusted fronting code builds
  `makeSandboxHttpIngress({ url, vmId, httpIngressToken, fetch })` and
  calls `handle(request)`.
  - Nothing creates the ingress automatically.
  - It strips hop-by-hop and proxy headers, and refuses
    `CONNECT`/`TRACE`.
  - Bodies are capped by `HTTP_PREVIEW_LIMITS`, with a 30 s upload-idle
    abort and a 120 s response-head `504`.
  - The fetch adapter refuses WebSocket upgrades with `426`.

**AI tools**

- `createSandboxTools({ client, workdir: "/workspace" })` provides
  `run_command`, `read_file`, and `write_file`, all bounded and bound to
  one sandbox client.
- Construct the tools in trusted code after `create`. Model text must never
  pick the URL, token, VM, or image.

## 4. The guest you get (`node` image)

- **Base system:** Debian trixie from a pinned snapshot, Node 24.21.0,
  pnpm 11.13.1, git, and python3.
- **Next.js template:** a prewarmed Next.js 16.3.3 / React 19.2.8 template
  lives at `/opt/microvm/next-template`, owned by root and read-only.
  `/usr/local/bin/microvm-next-init` copies it into an empty `/workspace`.
  `pnpm install --offline --frozen-lockfile` then works without any
  network.
- **Offline by design:** there is no NIC, no DNS, and no egress, so the
  guest cannot reach any package registry. Dependencies must come from the
  prewarmed store or from a trusted host-side materializer.
- **Git:** guest-local only, with no remote, credentials, or push path. A
  guest commit is ephemeral until your orchestrator exports it and verifies
  its SHA.
- **Private root disk:** every VM gets its own copy, and it is discarded on
  destroy.

## 5. Rules that must hold on the Free Vibecode side

1. The admin token lives only in the orchestrator's secret store. It never
   goes to a sandbox, a Durable Object record, a URL, a log, or an AI tool.
2. `sandboxToken` and `httpIngressToken` are per-VM secrets. Store them
   only with that sandbox's record, and clear them on destroy or expiry.
3. Never let model or tenant input choose the daemon URL, VM id, image,
   kernel arguments, or paths. Callers cannot pass host paths at all.
4. Own the lifecycle: set `ttlSeconds`, `destroy` explicitly when a
   session ends, and never retry an ambiguous `create`. The daemon's reaper
   is only a backstop.
5. A daemon restart loses every VM and starts admission-closed. Reconcile
   by destroying and recreating, not by re-adopting.

## 6. Running it

- **Production shape:** one dedicated x86_64 Linux VM with nested KVM on
  the Proxmox cluster, running `microvm-daemon` under systemd from the
  release artifact. See `docs/operations.md` for configuration, startup
  checks, deploy, and rollback.
- **Local development on an Apple Silicon Mac** (M3 or later, macOS 15+):
  run `brew install lima`, then `scripts/dev-mac.sh accept`. This boots
  real jailed Firecracker VMs inside an arm64 Lima VM and runs the full
  acceptance suite. A fresh run on an M3 Max passes every phase.
  - `scripts/dev-mac.sh up` syncs the checkout into the VM.
  - `limactl shell microvm-dev` opens a shell; the checkout is at
    `~/microvm`.
- **Huge pages:** the optional daemon config `firecracker.hugePages: "2M"`
  backs guest RAM with 2 MiB pages. Under nested virtualization it is
  essential: it took `pnpm --version` from 7–12 s down to 0.8 s. The
  per-VM memory ceiling stays exact. Consider it for the Proxmox host too.

## 7. Open items (check with Dylan before building on them)

- **Workers VPC → Tunnel path unverified.** The P0 gates in
  `docs/operations.md` have not passed: DO → VPC Service, origin TLS
  failure, Effect in workerd, HTTP/SSE, WebSocket.
- **Possible single-VM simplification (proposed, not decided).** Run the
  Free Vibecode orchestrator and microvm on one Linux VM:
  - The unprivileged app process talks to the root supervisor over a
    local UNIX socket.
  - That would drop TLS, the network listener, the Tunnel/VPC path, and
    likely `microvm/workerd`.
  - It would reverse part of ADR 0001, so it needs a new ADR first.
  - Do not deepen the Cloudflare DO path until this is settled.
- **WASM or in-browser Linux sandboxes were evaluated and rejected**
  (2026-09-29). They cannot run real Node, Next.js, or Vite, and
  qemu-wasm was hundreds of times slower than native. To test Workers,
  run `wrangler dev` (real workerd) inside a microVM instead.

## 8. Where the detail lives

- `README.md`: install, CLI, clients, preview.
- `docs/protocol.md`: guest exec, preview, and web-service wire contracts.
- `docs/architecture.md`: modules and trust boundaries.
- `docs/operations.md`: daemon configuration, deploy, acceptance, macOS
  development.
- `docs/ai-tools.md`: tool usage and prompts.
- `docs/adr/0001-in-memory-daemon-and-cloudflare-cutover.md`: why it is
  shaped this way.
