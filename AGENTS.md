# AGENTS.md — microvm

Effect v4 runtime for jailed Firecracker microVMs, exposed over authenticated
Effect RPC, with Vercel AI SDK tools scoped to existing sandboxes.

## Effect

This repository uses the Effect TypeScript library, **v4** (`effect`
`4.0.0-beta.107` line — never mix in v3 idioms or `@effect/schema`, Schema
lives in core as `effect/Schema`).

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect APIs and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

v4 idioms proven in this codebase (copy these, do not guess):
- Refined schemas: `Schema.String.check(Schema.isPattern(/re/))`,
  `Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))`.
- `Schema.Union([A, B])` (array), `Schema.Record(key, value)` (two args).
- Decoding unknown data: `Schema.decodeUnknownResult(schema)` (Result with
  `_tag: "Success" | "Failure"`), `Schema.is(schema)` guards,
  `Schema.decodeUnknownSync`. There is no `decodeUnknownEither`.
- Callback APIs: `Effect.callback((resume, signal) => { ... })` — the register
  function returns `void` or an Effect, never a cleanup function; clean up via
  the `AbortSignal`.
- Timeouts: `Effect.timeout({ milliseconds: n })`; `TimeoutError` has no
  `_tag` — branch with `Cause.isTimeoutError(cause)` inside `Effect.catch`.
- `Effect.result`/`Effect.option` (there is no `Effect.either`),
  `Effect.andThen` (there is no `Effect.zipRight`).
- `Headers` lives in `effect/unstable/http`; `Headers.get` returns an Option.
- Relative imports use the `.js` suffix (NodeNext + tsc emit).

## Source map

- `src/protocol.ts` — the wire: RPC contracts, the auth seam (`Credential`,
  `SandboxContext`, `Auth`), guest exec v1 constants, and request bounds.
  Single source of truth for everything that crosses the wire.
- `src/auth.ts` — credential store (SHA-256 digests, constant-time admin
  comparison), server auth middleware layer, handler-side `requireAdmin` /
  `authorizeVm`, client header middleware.
- `src/host.ts` — host prerequisite enforcement (KVM access, cgroup v2,
  trusted operator paths), image allowlist, jailer chroot layout, credential-free
  diagnostic VM state evidence, and CID/UID allocators.
- `src/firecracker.ts` — jailed boot (cgroup v2 ceilings, rlimits,
  transactional teardown), the Firecracker UDS API client, and the guest exec
  v1 channel over the vsock UDS with strict frame validation. Any transport
  violation is a `GuestTransportFault` (VM gets poisoned; success is never
  reported for a VM in doubt).
- `src/vsock.ts` — fragment-safe bounded Firecracker UDS acknowledgement
  parsing behind the fixed-purpose exec, HTTP, and service socket openers.
- `src/daemon-http-proxy.ts` — authenticated `/http/v1/vms/:id/*` HTTP and
  WebSocket data plane: admission quotas, semantic parsing, sanitization,
  streaming, frame validation, and destroy-time request-lease closure.
- `src/daemon.ts` — daemon assembly: config, kernel-held single-daemon lock,
  VM registry (quotas, reservations, TTL reaper, recovery), RPC handlers, and
  bounded HTTP/TLS serving.
- `src/client.ts` — scoped RPC client and direct single-daemon sandbox creation.
- `src/sandbox-binding.ts` — private shared handle binding, rollback, and
  `http()`/`startWebService` handles.
- `src/cluster.ts` — bounded health polling, static multi-daemon placement,
  and capacity-only create failover.
- `src/http-proxy.ts` — the trusted Node reverse-proxy hop: binds one VM's
  ingress capability and exposes `request`, `upgrade`, `connect`, and
  `checkContinue` handlers that can reach only the image's fixed HTTP target.
- `src/ai.ts` — Vercel AI SDK tools bound to one already-created sandbox VM;
  never receives cluster credentials.
- `src/bin/` — `microvm-daemon` and `microvm` CLI entrypoints.

`guest/**` contains the Go guest runner, HTTP bridge, and PID 1; `scripts/**`
the image builder and acceptance scripts. The host speaks the guest exec,
HTTP preview, and durable web-service contracts exactly as specified in
`docs/protocol.md`.

## Security invariants (load-bearing — never weaken)

1. Callers can never pass host paths, kernel paths, kernel boot args, or image
   paths; creation requires an allowlisted image name and its raw-image digest.
2. Jailer is mandatory for every Firecracker boot; no direct-firecracker path.
3. Every VM gets a private root disk copy verified against the requested digest
   before boot; the base image is never shared RW.
4. No guest network interfaces are ever configured (no egress); guest I/O is
   vsock-only.
5. Missing KVM device access, cgroup v2, or jailer => daemon fails closed (no
   degraded mode).
6. Sandbox-scoped credentials authorize only their own VM; AI tools never see
   cluster credentials.
7. TLS is required for any non-loopback daemon connection.
8. An exec is reported successful only after the guest confirms the whole
   process group/cgroup is dead or exited; any uncertain transport failure
   marks the VM poisoned and requires destroy before reuse.

## Commands

- `npx tsc --noEmit` — typecheck (do not weaken `tsconfig.json` strictness:
  `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` stay on)
- `npx vitest run` — tests
- `pnpm build` — emit `dist/`

## Docs

- `README.md` — what this is, quickstart, honest limitation list.
- `docs/architecture.md` — module/seam design, trust boundaries.
- `docs/protocol.md` — guest exec, HTTP preview, and durable web-service v1
  wire contracts (shared with `guest/`).
- `docs/operations.md` — daemon config, prerequisites, Linux deployment shape.
- `docs/ai-tools.md` — Vercel AI SDK tool usage and prompt guidance.

## Agent skills

### Issue tracker
Issues and specs use GitHub Issues for `dymoo/microvm`.
See `docs/agents/issue-tracker.md`.

### Triage labels
Use the five canonical triage labels without overrides.
See `docs/agents/triage-labels.md`.

### Domain docs
Single-context layout: root `CONTEXT.md` and `docs/adr/`.
See `docs/agents/domain.md`.
