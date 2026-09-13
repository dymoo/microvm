# firecracker-containerd evaluation

Decision: **this repository keeps its direct Firecracker + jailer runtime.** The
question was whether [`firecracker-microvm/firecracker-containerd`](https://github.com/firecracker-microvm/firecracker-containerd)
is the better foundation for hostile Node/Python AI workloads. It is a larger,
container-shaped system with a different security contract, an unshipped
release process, and no answer for this repository's scoped-credential,
bounded-exec, no-NIC model. Adopting it would replace the product surface, not
deepen the runtime. The conditions that would reverse this decision are listed
at the end.

Scope of the evaluation: sandbox isolation posture, container model, networking,
ecosystem, overhead and images, operations, maintenance, and goal-by-goal
compatibility with this repository. Every claim is either sourced to a primary
document/repository artifact or explicitly marked `[INFERENCE]`. No benchmarks
were invented; where upstream publishes no numbers, none are given.

## Evidence base

| Source | Version / revision inspected | Date |
| --- | --- | --- |
| firecracker-containerd repository | `main` @ [`be68640a5d2237f5b427c37c1f5809ec154126c5`](https://github.com/firecracker-microvm/firecracker-containerd/commit/be68640a5d2237f5b427c37c1f5809ec154126c5) (last commit 2026-07-16), cloned locally | 2026-09-13 |
| Firecracker docs | [`v1.17.0` docs](https://github.com/firecracker-microvm/firecracker/tree/v1.17.0/docs) (`jailer.md`, `seccomp.md`, `design.md`, `network-setup.md`) | 2026-09-13 |
| containerd docs | [`v1.7.33` `runtime/v2/README.md`](https://raw.githubusercontent.com/containerd/containerd/v1.7.33/runtime/v2/README.md), [`main` `docs/PLUGINS.md`](https://raw.githubusercontent.com/containerd/containerd/main/docs/PLUGINS.md) | 2026-09-13 |

Dates and commit hashes are as observed on 2026-09-13; upstream can move.

## What firecracker-containerd is (observed)

From the repository `README.md` and `docs/architecture.md` at the revision above:

- A control plugin that is **compiled into a specialized containerd binary**
  (`firecracker-control/cmd/containerd/firecracker-containerd`), because
  out-of-tree Go plugins are hard; it implements a VM lifecycle API
  (`proto/firecracker.proto`: `CreateVM`, `StopVM`, `PauseVM`, `GetVMInfo`, …).
- A runtime shim (`containerd-shim-aws-firecracker`, runtime name
  `aws.firecracker`) implementing containerd's runtime v2 API over ttrpc.
- An agent that runs **inside the microVM as root** and creates OCI containers
  with [runc](https://runc.io) via containerd's `containerd-shim-runc-v1`
  (`agent/main.go`, `tools/image-builder/files_debootstrap/etc/systemd/system/firecracker-agent.service`
  — the unit sets no `User=`, so the agent is root in the guest).
- An image builder that produces a Debian root filesystem (squashfs base plus an
  overlay writable layer) and a block-device snapshotter (devmapper) that turns
  OCI layers into filesystem images exposed to the VM as drives.

So the unit of work is an **OCI container**, not this repository's bounded argv
exec. The unit of tenancy is an operator-chosen `vm_id` grouping.

## Security boundary and jailer/seccomp posture

| Property | This repository | firecracker-containerd |
| --- | --- | --- |
| Jailer for the VMM | Mandatory; every boot is `jailer --id … --exec-file … --uid … --gid … --chroot-base-dir … --cgroup-version 2 …` (`src/firecracker.ts`; `README.md`: "Every sandbox is a Firecracker VM started only through `jailer`; no direct-Firecracker or degraded execution path exists") | **Opt-in per `CreateVM` request**: `runtime/jailer.go` returns a `noopJailer` when `request.JailerConfig == nil` |
| Jailer implementation | Firecracker's official `jailer` binary (chroot, uid/gid drop, cgroup v2, rlimits) | A **runc-container jail** (`runtime/runc_jailer.go`, `firecracker-runc-config.json.example`): capabilities emptied, `noNewPrivileges`, rlimits, namespaces, device allowlist for `/dev/kvm` and `/dev/net/tun` |
| Guest runner privilege | Execs drop to a fixed unprivileged UID/GID in a per-exec cgroup (`docs/architecture.md`) | Agent is root in the guest and runs OCI containers whose user comes from the image spec, i.e. typically root in the guest `[INFERENCE]` |
| Seccomp | Firecracker release binary's default per-thread filters (`--no-seccomp` never passed) | Same: the repository contains no seccomp handling at all (no `seccomp` reference in its Go/JSON config), so Firecracker's default filters apply; the sample runc spec passes only `--api-sock` |
| Host daemons | One root daemon; VMM unprivileged in chroot; workloads unprivileged in guest | root containerd, one root host shim per VM, root agent per guest, runc containers |
| Multi-tenant posture | One VM per tenant plus per-VM credentials is the product contract | README (commit [`9711138`](https://github.com/firecracker-microvm/firecracker-containerd/commit/9711138), PR #858, 2026-04-01): "Please note that multi-tenant use cases are at the user's own risk." |

Firecracker upstream is explicit that jailing is expected in production
("[In production environments, Firecracker should be started only via the `jailer`
binary](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/design.md)")
and that the jailer "sets up system resources that require elevated permissions
(e.g., cgroup, chroot), drops privileges, and then exec()s into the Firecracker
binary". firecracker-containerd's README still lists jailing under roadmap:
"Our short term roadmap includes constraining or 'jailing' the Firecracker VMM
process to improve the host security posture." Its build and install targets
mirror that state — `make firecracker` produces only `bin/firecracker` and
`make install-firecracker` installs only that binary, while the runtime's jail
path executes `runc run` (`runtime/runc_jailer.go`) and never the Firecracker
`jailer` binary; the getting-started guide (`docs/getting-started.md`:95) tells
operators to place the jailer on `PATH`,
but no repository component invokes it.

Seccomp posture is the one place where the two systems are equivalent: both rely
on the Firecracker release binary's built-in filters, which upstream documents as
on by default per thread and warns `--no-seccomp` is "not recommended" for
production ([`docs/seccomp.md`](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/seccomp.md)).

## One container per VM vs multiple containers per VM

Both shapes exist in firecracker-containerd, and neither is the same thing as
this repository's "one VM per tenant, one command per connection":

- **Multiple containers per VM is the design center.** `CreateVMRequest.ContainerCount`
  pre-reserves dummy drives because Firecracker cannot hot-plug block devices
  (`docs/design-approaches.md`: "There is no hot-plug, so you have to attach all
  block devices before running the microVM (and need to know the number of
  drives to be used in advance)"). `docs/shim-design.md` fixes one host shim
  **per VM** and one guest shim **per VM** for all containers in it. The README
  says the project "currently allows you to launch a few containers colocated in
  the same microVM, and we are exploring how to raise the number."
- **Single container per VM works too** through the default path
  (`ctr run --runtime aws.firecracker` creates a VM implicitly), per
  `docs/shim-design.md` ("Case Without Pre-Created VM").

For hostile single-tenant AI work, multiple containers per VM adds attack surface
without adding isolation: the containers inside one guest share that guest's
kernel and the agent's root context. This repository's model — a dedicated VM
per tenant with bounded, cgroup-killed argv execs and no implicit shell (a
command may still deliberately invoke `/bin/sh`; the runtime never inserts one) —
is strictly narrower, and the narrowness is the product (`README.md` trust
boundaries; `docs/architecture.md`).

## Networking defaults and CNI

Primary source: [`docs/networking.md`](https://github.com/firecracker-microvm/firecracker-containerd/blob/main/docs/networking.md).

- Default: no connectivity. The project's networking doc states that "By
  default, a container started today via Firecracker-containerd will not have
  any access to networks outside the VM", and that enabling it "is currently a
  manual process that requires creation of network devices, specification of
  IPs/routes/gateways on the host, specification of IPs/routes/gateways inside
  the VM and DNS configuration in the VM". That is a statement about network
  *access*, not about whether the guest has a NIC.
- CNI is **optional and opt-in**, set either per `CreateVM` call
  (`CNIConfig`) or as a runtime-config default (`default_network_interfaces`);
  the chosen model redirects packets with TC filters between the VM tap device
  and a CNI-created veth (`tc-redirect-tap` is built by `make cni-bins`).
- `docs/scaling.md` assumes CNI bridges for large VM counts; the quickstart runs
  `make demo-network` and, in its sample `firecracker-runtime.json`, configures
  `default_network_interfaces` with `fcnet` and runs containers `--net-host`.
- Firecracker itself configures no host networking; the host must create TAP
  devices and NAT/forwarding rules ([`docs/network-setup.md`](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/network-setup.md)),
  and "Firecracker does not perform any network traffic filtering. All egress
  traffic from a guest is therefore considered untrusted, and should be filtered
  at the host-level" ([`docs/design.md`](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/design.md)).

`[INFERENCE]` a NIC-less VM also appears achievable: `CreateVMRequest.NetworkInterfaces`
is optional and the runtime only configures the interfaces supplied by the
request or by the `default_network_interfaces` config (`runtime/service.go`,
`config/config.go`), so empty lists in both places should configure no device.
Upstream documents and tests no such guarantee — its security docs speak to
lack of network *access*, not absence of a device — so this is inference, not a
supported contract. Even if it works, it discards the part of the system its
documentation and tooling are built around, and keeping the guest networkless
still leaves the containerd image-pull path on the host, which this repository
avoids entirely by allowlisting locally built images by name.

## OCI / containerd / Kubernetes ecosystem

Observed:

- The runtime is a first-class containerd runtime (`aws.firecracker`), so it
  inherits containerd's image store, namespace model, content store, snapshotters,
  and client tooling (`firecracker-ctr`, the standard containerd client).
- containerd's documented external extension points are v2 runtime shims as
  binaries on `PATH` and proxy plugins limited to `snapshot`, `content`, and
  `diff` types ([`docs/PLUGINS.md`](https://raw.githubusercontent.com/containerd/containerd/main/docs/PLUGINS.md)).
  The firecracker control API is not one of those types; it remains compiled into
  a custom daemon, which the project README confirms.
- Kubernetes is **not** available today. Issue [#88 "CRI conformance tests"](https://github.com/firecracker-microvm/firecracker-containerd/issues/88)
  has been open since 2019-02-07; a repository contributor stated on 2024-12-06 in
  [#798](https://github.com/firecracker-microvm/firecracker-containerd/issues/798):
  "firecracker-containerd is also not CRI conformant, so does not work with
  kubernetes today." The documented setup disables the CRI plugin
  (`disabled_plugins = ["io.containerd.grpc.v1.cri"]`). The README calls CRI
  conformance "longer-term roadmap".
- This repository's own ecosystem is Effect RPC, TypeScript, and Vercel AI SDK
  tools; none of that exists upstream, and none of firecracker-containerd's
  ecosystem is required by the AI workload contract (`docs/ai-tools.md`).

## Overhead and image/snapshot model

firecracker-containerd publishes no performance measurement for its stack.
Firecracker itself publishes VMM-level guarantees (one process per microVM, and
a documented mutation-rate figure for a minimal configuration in
[`docs/design.md`](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/design.md)),
but nothing that quantifies what containerd, the host shim, the in-guest agent,
or block-device root filesystems add on top. This section therefore compares
architecture, not numbers.

| Concern | This repository | firecracker-containerd |
| --- | --- | --- |
| Per-VM host processes | Daemon + jailed VMM | containerd + control plugin + host shim per VM + VMM |
| Guest boot payload | Purpose-built image; `/sbin/init` starts the Go runner; readiness probe before `create` returns | Debian rootfs with systemd (`init=/sbin/overlay-init`, custom `firecracker.target`); shim waits for the agent over vsock |
| Root disk | Private logical full-size copy per VM via reflink, ordinary-copy fallback (`src/host.ts`, `src/daemon.ts`) | Shared read-only rootfs with a per-VM overlay; container root filesystems are separate block devices |
| Image model | Operator-built, digest-verified raw disk + kernel; images allowlisted **by name**; callers never pass paths | OCI images pulled by containerd; layers materialized to filesystem images and attached to the VM as drives |
| Maximum containers per VM | Not applicable — bounded argv execs only | Multiple; drive count must be reserved at VM creation (`ContainerCount`) |
| VM snapshot/restore | None (`grep` of `src/` and `docs/` finds no snapshot path) | Not shipped: PR [#448](https://github.com/firecracker-microvm/firecracker-containerd/pull/448) ("Firecracker Snapshots Support") open since 2020-09-22, unmerged, and PR [#760](https://github.com/firecracker-microvm/firecracker-containerd/pull/760) ("Add support for firecracker snapshots") open since 2023-08-22, `mergeable_state: dirty` (re-verified 2026-09-13), last updated 2023-09-11 |
| Guest cgroup model | cgroup v2 in the guest (`cgroup.kill` teardown; `docs/architecture.md`) | Docs require "A cgroup v1 filesystem configured and mounted" ([`docs/root-filesystem.md`](https://github.com/firecracker-microvm/firecracker-containerd/blob/main/docs/root-filesystem.md)); quickstart kernel args set `systemd.unified_cgroup_hierarchy=0` |

The image-model difference is the strongest genuine advantage of
firecracker-containerd: OCI images plus layer dedup and a block-device
snapshotter are a real supply chain this repository does not have. But this
repository's threat model deliberately removes caller-chosen images, and the AI
tools operate on a fixed, operator-built Node/Python image; OCI distribution is
not a requirement to model.

## Operational complexity and root daemons

Adopting firecracker-containerd means operating: a containerd daemon customized
for firecracker-containerd (version-locked to containerd 1.7.x), the control
plugin API, the `aws.firecracker` shim binaries, a guest agent image built with
the project's image builder, a block-device snapshotter (devmapper thin pool
provisioned before first use), optional CNI plugin binaries and bridge
configuration, and the project's own `firecracker-ctr` client. The quickstart
reflects that: EC2 metal instance, Docker, submodules, `make all image
firecracker`, a dmsetup thin pool, and a `--net-host` container run.

Root surfaces in that stack: containerd, the per-VM host shim, the in-guest root
agent, the CNI plugin processes (CNI runs plugins in the runtime's networking
domain, i.e. usually the root network namespace, per the
[CNI spec](https://github.com/containernetworking/cni/blob/main/SPEC.md)), and
runc inside guests. This repository has exactly one root daemon and keeps the
VMM and every workload unprivileged; `docs/operations.md` documents the daemon's
startup checks, single-daemon lock, TTL reaper, recovery semantics, and TLS
requirements — none of which have an equivalent upstream.

Also relevant to a Proxmox deployment: firecracker-containerd's own setup check
warns `WARNING: you are running in a virtual machine. Firecracker is not well
tested under nested virtualization.` (`docs/getting-started.md`, same warning as
Firecracker's own docs). This repository's hosted acceptance proves the jailed
boot path on a KVM-capable hosted runner, which is the closest available
evidence; the Proxmox nested-KVM path itself is only proven by running the
Linux acceptance there (`docs/operations.md`).

## Project maintenance and release status

Observed at the revision above:

- **No releases and no tags at all**: `git ls-remote --tags` returns zero refs
  and the GitHub releases API returns an empty list. Adopters build from source
  at a commit.
- **Maintenance is mostly dependency bumps.** Commits between 2025-01 and
  2026-09 are dominated by dependency upgrades (`#836`, `#841`, `#873`, `#875`,
  `#880`–`#882`); the last commit on `main` is 2026-07-16.
- **Core documentation is stale.** Last commit touching each file, verified
  path-by-path against `main` with the GitHub commits API on 2026-09-13:
  `docs/networking.md` 2019-09-24 (`0249ddb`), `docs/architecture.md` 2021-02-24
  (`799eb52`), `docs/scaling.md` 2021-04-22 (`f9c33e1`), `docs/getting-started.md`
  and `docs/quickstart.md` 2025-03-17 (`9576907`, a Go version bump), and
  `README.md` 2026-04-01 (`9711138`, the multi-tenant disclaimer).
- **The VMM build is pinned to an old Firecracker.** The `_submodules/firecracker`
  gitlink is [`77cfb9ce`](https://github.com/firecracker-microvm/firecracker/commit/77cfb9ceaa6a54e22a8259f50fb621ad1e39292b),
  which is exactly the target of Firecracker's
  [`v1.1.0` tag](https://github.com/firecracker-microvm/firecracker/releases/tag/v1.1.0)
  (2022-05-06) — four years behind this repository's pinned v1.17.0.
  `[INFERENCE]` the shim/agent surface may work with newer Firecracker releases,
  but the project's own build path and integration tests are pinned to v1.1.0.
- **The containerd line is 1.7.x**: `go.mod` requires `github.com/containerd/containerd v1.7.33`,
  with open dependabot PRs to 1.7.35 ([#881](https://github.com/firecracker-microvm/firecracker-containerd/pull/881), [#882](https://github.com/firecracker-microvm/firecracker-containerd/pull/882)).
  There is no containerd 2.x support.
- **Users are asking whether it is maintained and getting no maintainer
  answer.** Issue [#853 "Project state"](https://github.com/firecracker-microvm/firecracker-containerd/issues/853)
  (2026-02-20, open) asks exactly this; as of 2026-09-13 all nine comments are
  from users with no repository association, with no maintainer reply.

## Compatibility with this repository's goals

| Goal | firecracker-containerd reality | Verdict |
| --- | --- | --- |
| No guest NIC / no egress (`README.md` trust boundaries) | Containers have no network access by default, but a NIC-less VM is not a documented guarantee (see above); docs, quickstart, and scaling guidance all assume CNI | Keep current runtime |
| One VM per tenant (per-VM credentials, quotas, TTL) | Operator maps a `vm_id` to a tenant; the design center is many containers per VM. No per-VM credential, quota, or TTL concept in the control API | Keep current runtime |
| Effect RPC control plane | No Effect/TypeScript surface; lifecycle lives in containerd's gRPC API. An Effect RPC facade would be a bridge to a foreign daemon, not a re-implementation | Keep current runtime |
| Node/Python hostile workloads | Supported, but as OCI containers in a guest agent that is root, with runc as the in-guest runtime — not as bounded argv execs | Keep current runtime |
| Vercel AI SDK tools bound to a sandbox | No equivalent; tools would have to be rebuilt on containerd's task API, and the current tools' closure over a scoped client (`src/ai.ts`) has no upstream counterpart | Keep current runtime |
| Scoped credentials (`README.md`: "AI tools close over a sandbox-scoped client and VM ID") | None. Access to the containerd socket is host-root-equivalent; `[INFERENCE]` any credential model would have to wrap containerd rather than use it | Keep current runtime |
| Bounded exec (600 s, 64 argv entries, 8 MiB/stream; `src/protocol.ts`) | containerd's `ExecProcessRequest` carries no timeout or output bounds; those guarantees would be reimplemented on top | Keep current runtime |
| Proxmox nested KVM | Same upstream dependency on `/dev/kvm`; upstream warns Firecracker is not well tested under nested virtualization, and its own build is pinned to a 2022 Firecracker | Keep current runtime |
| OCI image supply chain | Genuine strength: image pull, layer dedup, devmapper snapshotters | Not required; images are operator-built and name-allowlisted |

## Decision

**Do not adopt firecracker-containerd as the foundation for this repository.**
The runtime here is intentionally a narrow, fail-closed jailer supervisor with a
typed Effect RPC contract, per-VM credentials, bounded execs, and no guest
network. firecracker-containerd is an OCI-container runtime whose advantages
(image ecosystem, multi-container packing, CNI, containerd tooling) are either
unnecessary or contrary to this repository's requirements. Its security posture
does not satisfy the contract this runtime states: the VMM is unjailed unless
each `CreateVM` call asks otherwise, the jail it then uses is a runc-container
jail rather than Firecracker's jailer, the guest agent runs as root, and the
project itself disclaims multi-tenant use. Layering it underneath this
repository would mean operating a customized containerd, a ttrpc shim, a root
guest agent, a snapshotter, and a Go control plane for a larger stack that fails
this runtime's mandatory-jailer and default-minimality requirements — while
adding a second, larger maintenance dependency on a project with no releases, a
Firecracker pin from 2022, and unanswered maintenance questions.

## Conditions that would reverse the decision

Reverse only if at least one becomes true, and prefer the first:

1. **Product shift to OCI/Kubernetes.** If sandboxes must run arbitrary
   prebuilt OCI images or be scheduled as Kubernetes pods, firecracker-containerd's
   image path (or containerd + Kata/other CRI-conformant runtimes) becomes the
   right layer. Note the project is not CRI conformant today, so this condition
   also requires CRI conformance to land or a different runtime to be chosen.
2. **A multi-tenant density requirement that this repository cannot meet.**
   If a host must pack many tenants per guest or per VMM at a density the
   current one-VM-per-tenant model cannot reach, multi-container-per-VM becomes
   relevant. This conflicts with the README's no-network-interface posture and
   would be a security decision, not just a runtime choice.
3. **Upstream health change.** Tagged releases, containerd 2.x support, the
   Firecracker submodule updated to a supported release, and jailing required by
   default (the README's own roadmap item) would make adoption materially safer
   than it is today.
4. **CNI-based egress becomes a requirement.** If the AI workloads must reach
   the network (package installs, model APIs), the no-NIC posture is gone and
   firecracker-containerd's CNI story is the closest thing to a maintained
   solution in this space.
5. **A snapshot/restore requirement with published numbers.** If VM warm-start
   becomes load-bearing, note that neither project ships it: firecracker-containerd's
   snapshot PR has been open and conflicted since 2023, and this repository has
   no snapshot path at all.

Even then, the safer first step is to lift specific capabilities — block-device
or copy-on-write image layers, or a snapshot/restore design — into the current
runtime, rather than replacing the security contract wholesale.

## Unknowns

- Whether any AWS production service runs firecracker-containerd (no primary
  statement found either way; it is an AWS-maintained project, CODEOWNERS
  `@firecracker-microvm/aws-containers-2`).
- Whether containerd 2.x could host the firecracker control API out of tree.
  containerd's documented external mechanisms cover runtime shims and
  snapshot/content/diff proxy plugins only; the project itself has made no
  containerd 2.x move.
- Actual boot-path latency of the firecracker-containerd stack on this
  repository's hardware; the project publishes no measurement of its added
  layers, and none was measured here.
- Whether the firecracker-containerd shim and agent work against a current
  Firecracker release (v1.17.0) when built from `main`; the repository pins its
  own build to v1.1.0 and its integration tests run against that.

## Sources

- firecracker-containerd: [repository](https://github.com/firecracker-microvm/firecracker-containerd)
  (`README.md`, `docs/architecture.md`, `docs/design-approaches.md`,
  `docs/getting-started.md`, `docs/host-file-isolation.md`, `docs/networking.md`,
  `docs/quickstart.md`, `docs/root-filesystem.md`, `docs/scaling.md`,
  `docs/shim-design.md`, `docs/snapshotter.md`, `runtime/jailer.go`,
  `runtime/runc_jailer.go`, `runtime/firecracker-runc-config.json.example`,
  `config/config.go`, `proto/firecracker.proto`, `go.mod`, `Makefile`,
  `.gitmodules`), at `be68640a`, 2026-07-16.
- firecracker-containerd issues/PRs: [#88](https://github.com/firecracker-microvm/firecracker-containerd/issues/88),
  [#448](https://github.com/firecracker-microvm/firecracker-containerd/pull/448),
  [#760](https://github.com/firecracker-microvm/firecracker-containerd/pull/760),
  [#798](https://github.com/firecracker-microvm/firecracker-containerd/issues/798),
  [#853](https://github.com/firecracker-microvm/firecracker-containerd/issues/853),
  [#858](https://github.com/firecracker-microvm/firecracker-containerd/pull/858),
  [#881](https://github.com/firecracker-microvm/firecracker-containerd/pull/881),
  [#882](https://github.com/firecracker-microvm/firecracker-containerd/pull/882).
- Firecracker: [`docs/jailer.md`](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/jailer.md),
  [`docs/seccomp.md`](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/seccomp.md),
  [`docs/design.md`](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/design.md),
  [`docs/network-setup.md`](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/network-setup.md),
  [`v1.1.0` tag](https://github.com/firecracker-microvm/firecracker/releases/tag/v1.1.0).
- containerd: [`runtime/v2/README.md` @ v1.7.33](https://github.com/containerd/containerd/blob/v1.7.33/runtime/v2/README.md),
  [`docs/PLUGINS.md` @ main](https://github.com/containerd/containerd/blob/main/docs/PLUGINS.md).
- CNI: [`SPEC.md`](https://github.com/containernetworking/cni/blob/main/SPEC.md).
- This repository: `README.md`, `docs/architecture.md`,
  `docs/operations.md`, `docs/ai-tools.md`, `src/protocol.ts`, `src/firecracker.ts`,
  `src/host.ts`, `src/ai.ts`, `.github/workflows/acceptance.yml`.
