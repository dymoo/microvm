# Workspace persistence

Status: current lifecycle record and future design. The current daemon provides
an ephemeral private root disk. The trusted materialize/export seam and
host-side Git publisher described below are **not implemented**.

Tracking: [free-vibecode #50](https://github.com/dymoo/free-vibecode/issues/50).

## Durability rule

A Git commit created inside a guest is a coherent local checkpoint, not a
durable result. It exists on that VM's ephemeral root disk and is lost when the
root disk is reclaimed. It becomes durable only after the trusted host has:

1. quiesced workspace mutation;
2. exported the exact committed repository through a bounded transfer;
3. validated the repository, expected base, commit, tree, and transfer digest in
   an unprivileged quarantine;
4. atomically admitted it to the external project store and recorded durable
   verification.

Only after that acknowledgement may ordinary destroy reclaim a
persistence-bound VM. Any external Git push happens later in a host-side
publisher that owns the credential. The guest never receives a Git credential
or direct push capability.

## Current behavior

The current implementation already gives each VM a distinct root-disk file:

- [`ImageAllowlist`](../src/host.ts) resolves an operator allowlisted, trusted
  base image path;
- `provisionChroot` creates a per-VM chroot and calls `copyFile` with
  `COPYFILE_FICLONE`; Node falls back to an ordinary copy when a reflink is not
  supported;
- the private copy is owned by that VM's unprivileged jailer UID and attached as
  the writable `/dev/vda` root;
- the promoted base image is never attached as the guest's shared writable
  disk.

The private root lives under:

```text
<runStateDir>/vms/<vmId>/jailer/<firecracker-basename>/<vmId>/root/rootfs.raw
```

It is part of run state, not project storage. `VmHandle.stop` first terminates
the jailer/Firecracker process group and proves cgroup removal. Normal destroy
then removes the VM directory. If teardown cannot be proven, the record and
run-state directory remain held rather than being reported cleanly released.
On daemon startup, stale VM cgroups are killed and checked before their VM
directories are removed; VMs are never adopted across restart.

Consequences today:

- destroy, TTL cleanup, and daemon recovery can delete every workspace mutation;
- a local Git commit is still deleted with the root disk;
- there is no RPC for workspace materialization, checkpoint export, or external
  project-store verification;
- the bounded exec/file tools are not an artifact protocol and must not be used
  to smuggle a repository through command output;
- there is no current “unexported checkpoint blocks destroy” gate. That gate is
  required future behavior, not an existing guarantee.

The image build emits checksums, and the runtime enforces root-owned trusted
allowlist paths. The future persistence work must explicitly bind promoted
image/store artifacts to verified digests; this document does not claim the
runtime rehashes every base image on each `create`.

## Ownership model

Three classes of storage have different trust and lifecycle rules:

| Storage | Owner | Lifetime | Trust |
| --- | --- | --- | --- |
| Promoted base image and dependency-store artifact | Operator | Across VMs | Immutable input; digest/provenance verified before promotion |
| Per-VM private root disk | VM incarnation | Boot through proven teardown | Hostile and ephemeral after guest start; never reused or shared writable |
| External project store | Trusted application | Across VM incarnations | Durable only after bounded export validation and atomic admission |

Do not blur these roles. Persisting or reattaching a whole hostile root disk
would carry guest OS mutation, caches, secrets, devices, and filesystem parser
risk into a new VM. Durable state is the validated repository artifact, not the
VM.

## Future workflow

### Materialize

The trusted application resolves a project and expected base commit, creates a
bounded source artifact, and materializes it into `/workspace` for a fresh VM.
No host checkout is mounted read/write into the guest. Remote Git credentials,
credential-helper configuration, SSH agents, and host `.gitconfig` stay outside
the VM.

The materialized repository may contain enough local Git history for the agent
to make commits without network access. Remote URLs are inert data and must not
contain credentials. The host records the project identity, expected base OID,
artifact digest, and a new VM-incarnation identity before execution.

### Local checkpoint

The agent stages and commits locally. A checkpoint is eligible for export only
when it names one commit OID and the intended index/worktree is clean. The OID
and clean status are hostile claims until the host validates the exported Git
objects and tree.

A successful `git commit` message must never be presented to a user as “saved”
or “pushed”. Correct product language is “local checkpoint created; export
pending”.

### Export and verify

Checkpoint export is serialized with guest exec so no process can mutate the
repository during capture. A dedicated host-initiated vsock protocol transfers a
versioned manifest and bounded chunks from a fixed workspace root. The host does
not mount the guest's ext4 disk and does not extract an unchecked tar stream as
root.

To preserve the exact local commit, the guest may emit a bounded Git bundle or
pack plus an explicit ref/commit manifest. Treat it as hostile bytes. Receive it
into an unprivileged, disk/cgroup/rlimit-constrained quarantine and validate:

- framing, declared/actual bytes, cryptographic transfer digest, and atomic
  completion;
- Git bundle/ref shape and `git fsck --strict` in the quarantined repository;
- object count, total/inflated object bytes, tree depth, path length, and wall
  time before accepting compressed pack input;
- exactly the permitted ref/tip, with the checkpoint descending from the
  recorded expected base;
- no replace refs, alternates, hooks, unexpected refs, shallow grafts, or config
  that changes object lookup or execution;
- tree entries and policy for traversal-like names, duplicates/case collisions,
  unsafe symlinks, submodules, `.gitmodules`, LFS pointers, setuid/device-like
  metadata, and oversized files.

Inspect the tree without checking it out in a privileged host workspace. Never
run guest hooks, filters, smudge/clean commands, submodule commands, or package
scripts during validation.

After validation, atomically admit an immutable artifact to the external project
store. Durability acknowledgement requires the store's real persistence
contract—for example completed object-store write plus checksum/version, or
file data and directory metadata synced before atomic rename—not merely a
completed read from vsock. Record project, VM incarnation, base OID, checkpoint
OID, artifact digest, size/count, policy version, and verification time.

An interrupted, over-limit, corrupt, or policy-rejected transfer creates no
final artifact and no durable acknowledgement. Partial data is removed or held
only in bounded quarantine.

### Publish

A separate `RepoPublisher` module consumes only a verified project-store
artifact. It holds a short-lived repository-scoped credential outside the
sandbox and publishes only the configured repository and assigned branch, using
an expected old OID/lease. It must not accept an arbitrary remote URL or token
from the guest artifact.

Direct guest push remains prohibited even if a token-hiding proxy could be
built. Git smart HTTP push sends an attacker-controlled
`POST .../git-receive-pack` body and grants ref-update authority. A hostile guest
could attempt force updates, branch/tag deletion, oversized object upload, or
encode data in repository objects and commit messages. Hiding the credential
would not remove that authority or exfiltration path.

## Deep modules and seams

Keep hostile transfer/validation separate from credentialed publication with an
immutable artifact seam:

```ts
type VerifiedCheckpoint = {
  readonly project: ProjectId
  readonly incarnation: VmIncarnationId
  readonly baseOid: string
  readonly commitOid: string
  readonly artifact: ProjectArtifactRef
  readonly digest: string
}

interface WorkspacePersistence {
  readonly materialize: (input: {
    readonly vmId: VmId
    readonly incarnation: VmIncarnationId
    readonly project: ProjectId
    readonly baseOid: string
    readonly source: ProjectArtifactRef
  }) => Effect.Effect<MaterializedWorkspace, MaterializeError>

  readonly exportCheckpoint: (input: {
    readonly vmId: VmId
    readonly incarnation: VmIncarnationId
    readonly project: ProjectId
    readonly expectedBaseOid: string
    readonly limits: ExportLimits
  }) => Effect.Effect<VerifiedCheckpoint, ExportError>
}

interface RepoPublisher {
  readonly publish: (input: {
    readonly checkpoint: VerifiedCheckpoint
    readonly repository: RepositoryId
    readonly targetBranch: string
    readonly expectedOldOid: string
  }) => Effect.Effect<PublishedRef, PublishError>
}
```

These are future illustrative interfaces, not current exports.
`WorkspacePersistence` is a deep module: callers learn materialize and export,
while path walking, vsock framing, backpressure, Git quarantine, validation,
digests, atomic store writes, and audit remain behind the interface. The
`RepoPublisher` seam is separate because credentialed remote mutation has a
different trust domain and failure model.

Use a fake project-store adapter for interface tests and the real external-store
adapter for deployment. Transport and Git-process ports used by the module are
internal seams, not additional public methods.

## Checkpoint and destruction lifecycle

A persistence-bound VM needs explicit state, conceptually:

```text
materialized -> running -> checkpoint-pending -> export-verified -> destroyable
                         \-> export-failed/quarantined
```

The exact state machine belongs behind the VM lifecycle interface. Required
behavior:

- checkpoint acquisition takes the same per-VM serialization permit as exec;
- once a committed checkpoint is pending, normal destroy cannot delete the disk
  until that exact commit is verified durable;
- if the workspace is dirty or the commit cannot be validated, checkpoint fails
  and no durability is claimed;
- export success is recorded durably before destroy becomes eligible;
- destroy closes preview routes/streams and credentials, proves VMM/cgroup/disk
  holder teardown, then removes the private disk;
- export failure, external-store outage, TTL expiry with pending work, or
  uncertain teardown preserves the complete run state in quarantine and emits
  actionable evidence instead of silently deleting it;
- daemon recovery distinguishes ordinary stale disposable VMs from a pending or
  verified persistence state. It must not apply the current unconditional stale
  cleanup to an unexported checkpoint;
- identifiers include a non-reused incarnation so a stale token, route, export,
  process, or disk cannot attach to a replacement VM with a familiar logical
  project id;
- capacity remains reserved while safety or durability is uncertain. Operator
  recovery and any explicit data-loss override require separate policy and
  audit; neither is silently inferred from low disk space.

This future gate deliberately changes current TTL/recovery behavior. It must land
with recovery and capacity handling, not as a success flag added only to the
happy-path exporter.

## Transfer limits and audit

Export/materialize policy fixes the allowed root and bounds all of:

- manifest/header and frame size;
- file/object count, individual file/object bytes, total bytes, and tree depth;
- path/component/symlink length and entry types;
- concurrent streams, temporary disk, decompressed Git object bytes, CPU/memory,
  idle/progress time, and total wall time;
- cancellation and backpressure so the host never buffers the repository in
  memory.

Every operation records the project, VM incarnation, expected base, requested
and verified commit, policy/limit version, counts/bytes, artifact digest,
external-store acknowledgement, terminal result, and denial reason. Logs never
contain repository contents, credentials, private keys, or unbounded
attacker-controlled text.

## Non-goals

- Persist, detach, restore, migrate, or adopt whole VM root disks.
- Implement Firecracker snapshots or snapshot-based suspend/resume.
- Design a future detachable mutable data-drive module as an implicit extension
  of this interface.
- Share a writable root disk, workspace, dependency cache, or project cache
  among VMs.
- Mount the host project checkout into a guest, or mount a post-execution hostile
  guest filesystem in the privileged host.
- Give the guest network access, a Git credential, SSH agent, credential helper,
  arbitrary remote URL, `git fetch`, or `git push`.
- Treat a guest-local commit, completed vsock read, temporary host file, or
  unverified Git bundle as durable.
- Delete uncertain or unexported run state merely to reclaim capacity.
- Run guest hooks, filters, package scripts, submodules, or exported binaries on
  the host during validation.

Dependency installation follows the separate no-NIC policy in
[Dependency network policy](dependency-network-policy.md).

## Rollout

1. **Artifact contract.** Define project, source, checkpoint, and image/store
   artifact manifests, digests, incarnation identity, quotas, and external-store
   durability acknowledgement.
2. **Materialize.** Add bounded trusted source materialization into a fresh
   private VM workspace, with no credential or writable host mount in the guest.
3. **Export and validation.** Add the dedicated vsock stream, quiescing,
   quarantine, strict Git/object/tree validation, atomic project-store
   admission, and portable abuse coverage.
4. **Lifecycle gate.** Integrate pending/verified checkpoint state with destroy,
   TTL, preview streams, poison handling, capacity, quarantine, and daemon
   recovery. Do not enable a user-facing “saved” acknowledgement before this
   phase is complete.
5. **Publisher.** Add host-only repository/branch-scoped publication from a
   verified artifact with expected-old-ref semantics. Keep it outside the guest
   and outside the dependency gateway.
6. **Hosted proof.** Run the full flow on hosted real KVM and the deployed
   filesystem/store: materialize, local clean commit, export/verify, publish if
   configured, then proven teardown and private-root deletion.

## Abuse acceptance

Portable and hosted real-KVM acceptance must prove:

- two VMs receive different private root files and mutations never cross into a
  base image, store artifact, sibling, or later VM;
- reflink use is detected rather than assumed, full-copy fallback is capacity
  preflighted/accounted, and insufficient capacity fails before VM start;
- no root disk is deleted before positive VMM/process/cgroup/disk-holder
  teardown; uncertainty retains run state and allocation in quarantine;
- a local commit without verified export is reported only as pending and normal
  destroy/TTL/recovery cannot silently delete it;
- dirty worktree/index, missing/ambiguous HEAD, unexpected base, non-descendant
  commit, extra refs, replace refs, alternates, hooks, grafts, corrupt pack, and
  integrity mismatch are rejected;
- traversal, absolute/ambiguous paths, duplicate/case-colliding entries, unsafe
  symlinks/hardlinks, device/FIFO/socket, xattr/setuid, submodule/LFS policy
  violations, sparse/decompression bombs, excessive depth/count/size, and
  malformed frames are bounded and rejected;
- stalled, cancelled, disconnected, concurrent, or over-limit exports finalize
  no artifact and exert backpressure without unbounded memory/disk use;
- a stale VM id/token/route/socket/export cannot act on a replacement
  incarnation;
- daemon restart preserves/quarantines pending checkpoint state, cleans only
  after the defined decision, and never adopts a live VM or reuses uncertain
  resources;
- credentials are absent from guest env, disk, config, process view, output,
  artifact, and logs; guest network and push attempts fail;
- publisher rejects arbitrary repository/branch/old-OID changes from the
  artifact and cannot force/delete/tag outside its configured operation;
- successful export records the exact verified commit and durable artifact
  digest before destroy, and a fresh VM can materialize that artifact and
  reproduce the accepted tree.

## Primary references

- [`src/host.ts`](../src/host.ts): image allowlist, private root provisioning,
  layout, and run-state deletion
- [`src/firecracker.ts`](../src/firecracker.ts): transactional boot and teardown
- [`src/daemon.ts`](../src/daemon.ts): VM registry, TTL, quarantine, cleanup, and
  restart recovery
- [`docs/architecture.md`](architecture.md): existing module and failure model
- [Git HTTP protocol: `git-receive-pack`](https://git-scm.com/docs/http-protocol#_smart_service_git_receive_pack)
