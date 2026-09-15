# Handoff: Free Vibecode cutover to the Cloudflare Worker + Durable Object path

**For**: the next Free Vibecode coding agent. **From**: the microvm
documentation worker, 2026-09-14. **Primary task**: replace Free Vibecode's
Node-side private-Preview runtime (pinned `microvm` v0.2.0 direct SDK, Node
durable worker, loopback Node gateway) with a **greenfield Cloudflare
Worker + one Durable Object per sandbox route**, reaching the microvm daemon
only through a fixed per-host **VPC Service over Cloudflare Tunnel** with
`verify_full` origin TLS.

Read [dymoo/microvm#1](https://github.com/dymoo/microvm/issues/1) first; this
handoff implements its Free Vibecode half.

## 0. Read your own repo first

Before any code: Free Vibecode `AGENTS.md` and `CONTEXT.md`, then
[ADR 0002](https://github.com/dymoo/free-vibecode/blob/main/docs/adr/0002-effect-first-core.md)
(Effect-first core),
[ADR 0003](https://github.com/dymoo/free-vibecode/blob/main/docs/adr/0003-postgres-and-pg-boss.md)
(Postgres/pg-boss),
[ADR 0009](https://github.com/dymoo/free-vibecode/blob/main/docs/adr/0009-explicit-typed-runtime-profiles.md)
(runtime profiles), and
[ADR 0014](https://github.com/dymoo/free-vibecode/blob/main/docs/adr/0014-cloudflare-effect-authority.md)
(Cloudflare behind deep Effect services — its scope notice excludes private
Preview execution; **this cutover supersedes that exclusion** and must be
recorded as an FV ADR by you, not by microvm). Use the glossary's terms
(Workspace, Project, Sandbox Lifetime, Turn, Cost Reservation); do not call
the runtime a "cluster" or a "session store".

## 1. Current microvm contract and verification status

microvm at `MICROVM_VERSION = "0.3.0"` (source of truth: `src/protocol.ts`,
`docs/protocol.md`):

- **One authenticated RPC group** at `POST /rpc`. Admin-only: `create`,
  `setAdmission`, `info`. Admin-or-own-VM: `execute`, `inspect`, `destroy`,
  `startWebService`, `webServiceStatus`, `stopWebService`; `list` is
  admin-or-own too — a sandbox token lists only its own VM. Wire schemas and
  typed errors (`AdmissionClosed`, `BootFailed`, `CapacityExceeded`,
  `DestroyUncertain`, `ServiceError`, `VmPoisoned`, …) are exact; do not
  widen them client-side. Note the scope split: the VM-bound
  `SandboxScopedClient` view omits `destroy` (a sandbox token may still
  destroy its own VM over the wire; the DO's revoke path uses the admin
  client's `destroy`).
- **Request-scoped clients, scoped-only on both runtimes over one
  runtime-neutral core**: `microvm/client` is the Node surface —
  `makeAdminClient({ url, token, ca?, httpClient? })` and
  `makeSandboxScopedClient({ url, token, vmId, ... })` over a CA-honoring
  Node transport, and nothing else (no raw client, no handle layer).
  `microvm/workerd` is the edge surface with the same two constructors,
  `makeSandboxHttpIngress`, and `decodeExecResult`; its `fetch` is
  **required** and must be the caller's VPC binding fetch — the client
  never silently routes daemon calls through `globalThis.fetch`, and its
  verified import graph contains no Node builtins. Admin construction
  probes `info` and fails `ClientConfigurationError` on any version
  mismatch against `MICROVM_VERSION`; `create` returns
  `CreateOutcome { vm, sandboxToken, httpIngressToken?, sandbox:
  SandboxScopedClient }` — **no auto-created ingress**; every caller
  constructs the ingress adapter explicitly. `makeSandboxScopedClient`
  binds exactly one VM (no admin surface — this is what AI tools may
  receive). No process-global credential-bearing client state and no
  public raw full-surface client exists in either runtime.
- **Fetch-native ingress adapter, constructed explicitly**: on the Cloudflare
  side import `makeSandboxHttpIngress` from `"microvm/workerd"` — its
  `fetch` is **required** there (the workerd adapter throws before any I/O
  if it is absent, and never falls back to `globalThis.fetch`); the shared
  options shape is
  `{ url, vmId, httpIngressToken, fetch? }` →
  `{ handle(request: Request): Promise<Response> }`. It injects
  `Proxy-Authorization: Bearer <httpIngressToken>` on its own final hop to
  `<origin>/http/v1/vms/<vmId><target>`, strips caller
  `proxy-*`/hop-by-hop/`x-forwarded-*`/`microvm-*`/`host` headers, refuses
  `CONNECT`/`TRACE` (405), enforces origin-form targets, mirrors the
  daemon's response hygiene, and bounds the hop explicitly: a declared body
  over `HTTP_PREVIEW_LIMITS.maxRequestBodyBytes` is refused `413` before
  I/O, an undeclared body is counted on the fly and aborted at the cap or
  the 30 s upload-idle window (nothing is buffered), and a response head
  missing the 120 s deadline aborts the hop (`504`).
  **No WebSocket upgrade via fetch**; WebSocket qualification on the
  Workers path is a separate P0 gate (below).
- **Admission seam**: `acceptingAtStartup` must literally be `false` —
  every process start (deploy, restart, upgrade) is admission-closed until
  an authenticated operator toggles admission with
  `setAdmission(true|false)`. `info` reports exact
  `{ version, accepting, liveVms }`, and `liveVms` counts admitted
  in-flight create reservations (quarantines keep theirs), so a drain
  cannot report zero while a boot is active. Closed creates fail with typed
  `AdmissionClosed`. A daemon restart destroys all VMs, re-reads the
  config, and adopts nothing.
- **CLI**: `create/exec/status/list/destroy/info/set-admission` — no
  `cleanup`. Non-production release/deploy lives in microvm's
  `docs/operations.md`; **do not** re-derive it.

**Verification status (honest)**: the v0.2.0 package and its preview binder
are the last *published, hosted-accepted* evidence (run
[34822307078](https://github.com/dymoo/microvm/actions/runs/34822307078)).
The v0.3.0 surface is implemented in source and covered by the repo's test
suite, but **no v0.3.0 release artifact exists yet** and no live
Worker→VPC→Tunnel→daemon round trip has ever been run. Treat the v0.3.0
contract as implemented-but-unpublished; treat the Cloudflare path as
unqualified until the P0 spikes pass.

## 2. Boundary — out of scope, non-negotiable

- **No production writes**: no production Worker deployment, no populated
  migration, no production daemon replacement, no production
  Cloudflare/Proxmox configuration, no spending beyond any separately
  approved envelope, no public launch, no substitute provider, alias, or
  fake Preview.
- microvm's release/deploy/rollback (release workflow, `deploy-host.sh`,
  systemd, admission sequencing, canary ordering) is **owned by microvm's
  issue #1**, not by you. You consume its artifact; you do not operate its
  hosts.
- No guest Git, export, persistent disk, egress, model tools, HMR, SSE,
  WebSocket, clusters, or attachments in the Preview product shape (the
  `studio-microvm-preview` exclusions stand).
- The **business authority stays in Free Vibecode Postgres**: funding,
  lifetimes, grants, revocation intent, revisions, receipts. The DO record
  and the daemon are adapters. Never promote either into a second ledger —
  **no new operation ledger**, and **no daemon DB** (the daemon has no
  journal or datastore; its restart destroys all VMs by design).

## 3. Target topology (exact)

```
iPhone WebView ──HTTPS──▶ Preview Origin (exact HTTPS, distinct from API origin)
                             │
                    Cloudflare Worker  (stateless router, one process per request)
                             │            • authN: trusted-backend bearer  → DO control calls
                             │            • authN: __Host-fv-live-preview cookie → preview calls
                             ▼
        Durable Object  "fv-sandbox:<routeId>"   ← idFromName("fv-sandbox:" + routeId)
           one per sandbox route; ONE overwritten versioned record
                             │
                             ▼  (per-request fetch through the selected VPC Service binding)
        Two fixed VPC Service bindings (node1.internal.dylans.link / node2.internal.dylans.link)
                             ▼
        cloudflared tunnel connectors (redundant) ──▶ microvm daemon :9443 (TLS, verify_full)
                             ▼
                    Firecracker microVM (jailer, no NIC, web on 127.0.0.1:3000)
```

- **Two fixed VPC Service bindings, one per node** (Wrangler `vpc_services`
  entries: `binding` + `service_id`, e.g. `MICROVM_NODE1`/`MICROVM_NODE2`).
  The approved path **prohibits VPC Network bindings** (`vpc_networks`):
  code selects the named binding whose `nodeId` is already pinned in the DO
  fence — it never re-resolves a host per call. The runtime URL host only
  supplies `Host`/SNI and never changes the fixed destination (the VPC
  Service configuration's host and ports always route the call). Runtime
  Locators are configuration, not per-request routing.
- The **trusted backend (Next.js modular monolith) creates the routeId and
  persists it**; the **job worker / Worker** performs the daemon calls and
  DO writes. The backend never receives daemon credentials beyond the
  control secret it already holds (`PREVIEW_CONTROL_SECRET` pattern), and
  holds no microVM admin token.
- **No mixed incompatible pair**: a given sandbox lifetime runs against
  exactly one runtime pair (old Node↔node1, or new Worker+DO↔node2) recorded
  in its persisted state (`runtimeGeneration` + node identity). Old
  Node↔node1 remains until the new pair qualifies; then node1 drains.

## 4. The one Durable Object record

One DO class (e.g. `FvSandboxSession`) with **exactly one durable record**,
overwritten in place (DO storage, SQLite-backed, synchronous reads) — never
an event journal, never business authority:

```jsonc
{
  "version": "fv-sandbox-session.v1",        // single current version; unknown version ⇒ fail closed
  "routeId": "<128-bit opaque>",
  "runtimeGeneration": "<uuid>",              // from FundedPreviewControlOwner
  "node": "node1|node2",                      // runtime locator actually used
  "owner": { sandboxLifetimeId, workspaceId, projectId,
             operationId, reservationId },    // exact FundedPreviewControlOwner scope
  "fence": "planned | create-sent",           // persisted BEFORE exactly one create
  "serving": { vmId, nodeId, expiresAtEpochMs } | null,
  "capabilities": { sandboxToken, httpIngressToken }, // present while serving, cleared on revoke
  "install": { grantId, sourceRevisionId, sourceContentHash, state } | null,
  "access": {
    issuedGeneration?,
    bootstrap?: { keyVersion, wrapped } | null, // pending one-use URL bearer, wrapped ciphertext
    bootstrapState?: "pending | consumed | loaded | failed",
    cookieDigest?
  } | null,
  "revoke": { requestedAt, receipt? } | null
}
```

Rules that are load-bearing (encode them in code, not comments):

1. **Pre-create fence.** Persist the record with `fence: "planned"` and
   `node` **before** the first daemon `create`; then send **exactly one**
   create. On success, overwrite the record with the serving fields. On an
   ambiguous transport result, **never retry**: overwrite to
   `fence: "create-sent"` with `serving: null` and refuse the route. The
   possible orphan VM dies at its daemon TTL (bounded by the daemon's
   `maxTtlSeconds`) — accepted cost, by design (ADR 0001).
2. **Typed create failures are terminal for the route**: map
   `AdmissionClosed`, `CapacityExceeded`, `BootFailed`,
   `HostPrereqFailed`, `ImageNotAllowed` onto the record and report the same
   `_tag` to the durable authority; do not wrap them into a generic error.
   The daemon remains the sole writer of VM state — the DO records only what
   a create reply or typed error stated.
3. **One overwrite per state transition**; every transition is driven by the
   existing durable authority commands (install/issue/report/revoke). The
   record is derived state; the Postgres authority is replayable.
4. **Fail closed on unknown shapes**: any record decode failure — unknown
   `version`, unknown key, missing required field, wrong token format —
   must make the DO refuse (serve `4xx`/`5xx`, accept no control write that
   revives the session) rather than interpret. The same posture applies to
   the wrapped bootstrap (an unknown `keyVersion`, a wrong ciphertext
   format, or a non-`pending` state with a ciphertext present fails closed)
   and to the cookie digest format.
5. The DO proxies **preview HTTP** through `makeSandboxHttpIngress`
   constructed explicitly with the VPC binding fetch (VM-bound target fixed
   at construction) and **control RPCs** through a `SandboxScopedClient`/
   `makeAdminClient` from `microvm/workerd`, created per request with the
   same binding fetch. The daemon HTTP data plane rules in microvm
   `docs/protocol.md` remain the wire contract the DO must satisfy; the
   Node reverse-proxy hop from the old path does not move to the DO — the
   Fetch-native adapter replaces it.

## 5. Scoped-capability storage and security

- `sandboxToken` (`mvs_…`) and `httpIngressToken` (`mvi_…`) are created
  once, per VM, by one admin `create`. Persist them **only** inside the DO
  record, never in Postgres, never in a URL, never in logs, and never in a
  cookie. `Destroy` (or expiry) clears them from the record.
- **One-use bootstrap bearer is wrapped ciphertext, never a digest**: while
  access is `pending`, the record stores exactly `{ keyVersion, wrapped }`
  — the one-use URL bearer wrapped (encrypted) under the named key version —
  so the identical one-use URL can be replayed after a lost acknowledgment
  or DO eviction (a digest cannot reconstruct the URL it digests).
  Consumption is atomic with the issue response and expiry deletes the
  ciphertext: both transitions set `bootstrap: null` and advance
  `bootstrapState` (`pending → consumed → loaded | failed`). The App-Member
  session value lives in the `__Host-fv-live-preview` cookie exactly as
  today; the DO stores **only** its SHA-256 digest (`cookieDigest`) for
  comparison, never recoverable material. URLs and cookies are never
  persisted into install/revoke receipts (this matches the current
  `deploy/preview` receiver behavior).
- **Admin bearer tokens live only in approved secret managers** (Cloudflare
  Worker secrets for the Worker that makes daemon calls; `.tfvars`/secret
  store elsewhere). They never enter a DO record, the backend, a cookie, or
  a query string. The microvm daemon likewise stores digests only.
- Every DO control write must carry the trusted-backend bearer
  (`PREVIEW_CONTROL_SECRET`-shaped) and the exact owner scope; revoke is the
  only path that clears `capabilities`/`access`, and it must accept only a
  correlated receipt (`admission-fenced` / `drain-confirmed`), as the v2
  preview-control contract already requires.

## 6. routeId generation and persistence

1. The trusted backend mints `routeId` from **16 cryptographically random
   bytes** (base64url, 22 chars). It is opaque: it carries no workspace,
   VM, or version meaning.
2. Persist it on the **existing lifetime/owner binding** (see §7 migration)
   **before** any DO call — the DO is located by
   `env.FV_SANDBOX.idFromName("fv-sandbox:" + routeId)`.
3. Public ids **locate only**: knowing a routeId grants nothing. Public
   preview access still requires the one-use bootstrap → cookie exchange;
   control writes still require the bearer + exact owner scope. Never
   validate a request by routeId alone.

## 7. Exact Free Vibecode changes

**Dependency and imports**: move `apps/job-worker` (and, if needed, a new
worker entry) from the pinned v0.2.0 tarball to the **exact published
v0.3.0 release tarball + its SHA-256** from microvm's non-production
release workflow (§11: the artifact is an unresolved prerequisite). Keep
the one-place pin in `apps/job-worker/package.json`; `pnpm-lock.yaml`
records integrity. Import surface: the Node side (job worker, CLI glue)
imports the scoped constructors from `"microvm/client"`; the Cloudflare
side imports the two scoped constructors AND `makeSandboxHttpIngress` from
`"microvm/workerd"` and passes
`fetch: env.<NODE-BINDING>.fetch.bind(env.<NODE-BINDING>)` — never
`globalThis.fetch` — to every client and to the ingress adapter. Both
subpaths are scoped-only: no raw full-surface client is exported. There is
no `CreateOutcome.ingress` field: construct the adapter from
`httpIngressToken`.

**Contracts** (`packages/contracts/src/`, Effect Schema — not zod):

- Extend `execution.ts` with the sandbox-route types: `SandboxRouteId`
  (128-bit opaque pattern), the session-record schema
  (`fv-sandbox-session.v1`), and the DO-side command/result variants that
  map one-to-one onto the existing `DurableCommandV2` family.
- Extend `preview-control.ts` only where the transport changes shape
  (Worker route envelope reuses `PreviewControlCommandEnvelopeV2` /
  `PreviewControlResultEnvelopeV2` — do not invent a v3).
- Do **not** move `SandboxAdmissionPins` or the `microvm-preview.v1` policy;
  they stay the backend's (as today).

**Migration** (use the repo's own process — hand-written `NNNN_tag.sql` in
`apps/backend/migrations/`, contiguous numbering, `pnpm migrate`; see
`apps/backend/scripts/migrate.ts`/`migration-files.ts`; the highest existing
migration is `0032`):

- `0033_sandbox_lifetime_route.sql` — add the nullable, unique-once
  `preview_route_id` column (immutable after first write) to
  `sandbox_lifetimes`; do not backfill existing rows (there are none in a
  greenfield cutover, but the rule stands); no populated-state migration.

**Deletions** (greenfield — no shims, no compat flags):

- The Node-side preview runtime the cutover retires on node1:
  `apps/job-worker/src/microvm-runtime.ts` retained-registry + gateway
  composition, `apps/job-worker/src/preview-listener.ts`,
  `apps/job-worker/src/preview-control-transport.ts`, and the
  `deploy/preview/local-preview-gateway.mjs` /
  `local-preview-control.mjs` / `local-preview-delivery.mjs` Node listeners
  as serving surfaces (their tests either move with the surviving contract
  tests or go with them — keep the exact contract tests that still bind
  `packages/contracts`, delete the Node-socket qualification harnesses).
- `apps/job-worker/src/adapters/microvm.ts`'s `makeMicrovm` handle adapter:
  replace with `makeAdminClient`/`makeSandboxScopedClient` + ingress usage.
  The v0.2.0 handle API (`handle.http()`, `SandboxBindingError` rollback
  semantics) no longer exists.
- Job-worker env keys that die with the Node gateway:
  `PREVIEW_LISTEN_HOST`, `PREVIEW_LISTEN_PORT` (loopback listener) — the
  Worker/DO serves instead; keep `PREVIEW_PUBLIC_ORIGIN` and the control
  secret; add the Cloudflare-side config (§11).

**Keeps** (do not touch in this cutover): the durable authority chain
(`sandbox_lifetimes`, `sandbox_candidates`,
`funded_preview_selections`, `funded_preview_revoke_commands`,
`funded_preview_owner_bindings`, `funded_preview_revoke_receipts`,
`sandbox_preview_install_receipts`, `private_preview_issue_intents`,
`private_preview_access_generations`), `repository-core.ts` and the preview
repository facets, `pg-boss` and the `generation.execute.v2` job, the model
stage (`durable-provider.ts`), OpenNext/Queue qualification fixtures
(`apps/backend/wrangler.jsonc`, `apps/job-worker/src/cloudflare.ts`,
`adapters/cloudflare-queues.ts` — dormant structural adapters, not
deployed), and every dated evidence doc.

## 8. P0 throwaway spikes first — binary gate matrix

Run these as **throwaway scripts** (not repo code, not tests) against a
disposable account/route before any permanent change. Exact behavior
sources and URLs: microvm
[docs/research/workers-vpc-durable-object-qualification.md](../research/workers-vpc-durable-object-qualification.md).
A spike is **PASS** only on the observed behavior; anything else is **NO**
and blocks the cutover.

| # | Gate | Setup | PASS = observed |
| --- | --- | --- | --- |
| P0-1 | **DO→VPC-Service binding** | Worker+DO on disposable domain; named `vpc_services` binding to the canary node's VPC Service | DO `fetch` through the binding reaches `https://<node-host>/http/v1/vms/<vmId>/` and daemon `info` RPC; `verify_full` rejects a wrong-host cert |
| P0-2 | **workerd client compatibility** | same spike, `microvm/workerd` constructors over the binding fetch; real DO storage write/read of one versioned record | `makeAdminClient` probes `info`, version check passes, one create + destroy round-trips inside DO/request lifecycle |
| P0-3 | **Streaming response bodies** | preview request with a >1 MiB body | response streams incrementally through Worker→WebView; no 413/timeout from the platform; daemon admission quotas hold |
| P0-4 | **WebSocket upgrade** | preview request with `Upgrade: websocket` | **Expected fail-closed**: workerd fetch cannot upgrade; record the observed refusal and the product decision (no WS in preview; current gateway already rejects upgrades) |
| P0-5 | **Ambiguous create fence** | kill the Worker mid-create (artificially) | DO record shows `create-sent` with no retry on the next request; route refuses; orphan expires at daemon TTL |

NO on P0-1, P0-2, or P0-5 ⇒ **no permanent Free Vibecode cutover**; keep
Node↔node1. NO on P0-4 ⇒ HTTP-only preview stands (it is the current
contract); record the decision in your ADR.

## 9. Phased implementation

Each step lists its completion criterion and the commands that prove it.
Run `pnpm check` after every step (Free Vibecode's working agreement);
never weaken a gate to pass a step.

1. **P0 spikes** (§8). *Criterion*: matrix rows green or explicitly
   fail-closed with a decision note. *Command*: throwaway scripts only.
2. **Contracts + migration 0033**. *Criterion*: Effect schemas decode a
   synthetic session record; the backend `migrate` script applies 0033 on a
   disposable database and `migration-files.ts` accepts the sequence.
   *Command*: backend `pnpm migrate` (or root `pnpm db:migrate`) against
   disposable Postgres.
3. **DO class + Worker router** behind the existing effect services (no
   provider-shaped APIs in domain code): route record, fence, ingress
   proxy, control bearer. *Criterion*: workerd fixtures (reuse
   `apps/job-worker/test/workerd/` Miniflare harness) prove fence → create
   → install → access → revoke with the record transitions above, all
   locally, no cloud. *Command*: `scripts/cloudflare-qualification.mjs`
   pattern extended for the DO, then `pnpm check`.
4. **Backend routeId issuance + persistence** wired into the existing
   `previewAccess`/`sandbox` facets. *Criterion*: one routeId per lifetime,
   persisted before the first DO call, immutable after; tests in
   `apps/backend` cover the race (two concurrent turns cannot mint two
   routeIds for one lifetime). *Command*: `pnpm check`.
5. **Node-side deletions** (§7) land in the same change-set that flips
   serving to the DO. *Criterion*: `pnpm check` passes with no reference to
   deleted modules; no env key remains required that the Worker path does
   not consume. *Command*: `pnpm check`.
6. **Private qualification against node2** (new pair only): deploy
   microvm's artifact on node2 per microvm's issue #1 runbook; set-admission
   closed → open after health; run the existing phone journey against
   node2's preview origin with the real daemon. *Criterion*: the same
   end-to-end proof recorded in execution-focus (authenticated phone → one
   Turn → one create → materialize/build/serve → WebView preview → revoke),
   now over Worker+DO↔node2, with `AdmissionClosed` observed before
   admission opens. *Commands*: microvm's `scripts/deploy-host.sh
   --validate-only` then the real path; `microvm info --json` / `microvm
   set-admission --yes --json`; one bounded `create/exec/status/destroy`
   lifecycle smoke.
7. **Drain node1** (microvm's rollout order; you only trigger the product
   side): stop creating on node1, let lifetimes expire, verify zero
   previews served through the Node gateway, then allow microvm's drain.
   *Criterion*: no funded lifetime points at node1; rollback matrix
   executed once in rehearsal.

## 10. Cutover / rollback pair matrix

| Phase | node1 (old pair) | node2 (new pair) | Rollback action | Cost |
| --- | --- | --- | --- | --- |
| 0–5 (build) | serving, unchanged | not routed | n/a | none |
| 6 (qualify) | serving new lifetimes | private new-pair previews only | stop routing test lifetimes to node2; node2 stays admission-closed | test previews lost |
| 7 (drain) | no new lifetimes; existing expire | serving new lifetimes | **destructive**: reopen node1 only if its old daemon+runtime still run and no incompatible mix; otherwise keep drained | previews on node2 lost at rollback; node1 previews resume only for lifetimes recorded on node1 |
| 8 (upgrade node1) | — | new pair serves | destructive; accept preview loss | as above |

- There is **no mixed incompatible pair**: never serve one lifetime's
  control through the DO and its preview through the Node gateway.
- Rollback never retries an ambiguous create and never fabricates a VM;
  missing previews are reported honestly (`revoke`/`denied` receipts), never
  papered over.

## 11. Unresolved values — prerequisites, not placeholders

Do not invent any of these; obtain them, then record the exact value where
named:

- **Release artifact**: the non-production release workflow publishes BOTH
  `microvm-0.3.0-<source_sha>.tgz` (the npm-consumable SDK package with
  `.sha256`, `.inventory.txt`, and `.provenance.json` sidecars — pin this
  exact URL + SHA-256 in `apps/job-worker/package.json`) and the separate
  `microvm-host-linux-x86_64-0.3.0-<source_sha>.tar.gz` host artifact for
  microvm's own deployment runbook. Verify the GitHub-reported asset digest
  against the recorded SHA-256 before trusting the download. (Currently
  `v0.2.0` is the last published release; it lacks this contract.)
- **Release version/tag inputs**: the `vX.Y.Z` tag matching microvm's
  `package.json` and the `source_sha` chosen at release time.
- **Cloudflare account bindings**: the Worker's two VPC Service bindings —
  exact Wrangler key is `vpc_services` (each entry: `binding`, `service_id`,
  optional `remote: true`); **`vpc_networks` is prohibited on the approved
  path**; plus the DO class name + `migrations` entry,
  queue namespace if used, custom domain for the preview origin,
  `MICROVM_ADMIN_TOKEN`, `PREVIEW_CONTROL_SECRET` values (approved secret
  managers only), and the `MICROVM_IMAGE_NAME`/`MICROVM_IMAGE_DIGEST` of
  the qualified image.
- **Host identities**: the TLS certificate chain for
  `node1.internal.dylans.link` / `node2.internal.dylans.link`,
  tunnel connector counts/placement per node, and the daemon
  `advertisedUrl` per node.

## 12. Source-of-truth pointers (do not duplicate schemas here)

- microvm wire contracts: microvm `src/protocol.ts` + `docs/protocol.md`
  (guest exec/HTTP/service v1, ingress data-plane rules, request bounds).
- Client/ingress API: microvm `src/client-core.ts` (runtime-neutral core),
  `src/client.ts` (Node root, `microvm/client`, scoped-only),
  `src/client-workerd.ts` (`microvm/workerd` edge root: scoped constructors
  + `makeSandboxHttpIngress` with required binding fetch), and
  `src/http-ingress.ts` (the shared adapter; construct explicitly, no
  auto-created ingress).
- Architecture + decision: microvm `docs/architecture.md`,
  [ADR 0001](../adr/0001-in-memory-daemon-and-cloudflare-cutover.md).
- Cloudflare behavior/gates: microvm
  [docs/research/workers-vpc-durable-object-qualification.md](../research/workers-vpc-durable-object-qualification.md).
- Product sequencing: Free Vibecode
  [docs/product/execution-focus.md](https://github.com/dymoo/free-vibecode/blob/main/docs/product/execution-focus.md)
  (Current microVM Preview cutover) — this handoff supersedes its Node
  gateway shape; its financial-authority and cleanup contracts stand.
- Gateway/cookie/bootstrap behavioral contract you are re-implementing on
  the DO: Free Vibecode `deploy/preview/local-preview-gateway.mjs` +
  `packages/contracts/src/preview-control.ts` (cookie/bootstrap names and
  receipt semantics are reused verbatim).
