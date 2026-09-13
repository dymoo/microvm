# Runtime artifact pins for Linux/KVM acceptance

Research status: 2026-09-12; acceptance status: 2026-09-13. This note records provenance, configuration evidence, and the current successful hosted Linux/KVM acceptance run for the exact pinned inputs below. Runtime compatibility evidence does not change an artifact's provenance label.

## Trust labels

- **Upstream-published digest**: a digest published independently by the project that owns the artifact.
- **Local HTTPS observation (TOFU)**: a digest computed after one HTTPS download. It detects later drift only after an operator reviews and promotes it; it is not an upstream-published checksum.
- **Config verified**: the required settings were found in the exact config bound to the binary.
- **Hosted acceptance verified**: the exact pinned inputs completed the Linux/KVM scope recorded below. This is compatibility evidence, not an upgrade to artifact provenance.

## Hosted acceptance evidence

[`hosted-linux-acceptance` run 34769481224](https://github.com/dymoo/microvm/actions/runs/34769481224) completed successfully on commit [`b6afe4fff591763e178a29bb98e51aed635b5fed`](https://github.com/dymoo/microvm/commit/b6afe4fff591763e178a29bb98e51aed635b5fed). The uploaded [`hosted-acceptance-evidence` artifact (ID 10321372494)](https://github.com/dymoo/microvm/actions/runs/34769481224#artifacts) has digest `sha256:2003ce71bbd744bd1c5492c11125bf7f3fa16b47b040830990696e05b59b4146`.

The run observed:

- 154/154 Linux Vitest tests with zero skipped or failed, all guest Go race packages passing, and the real `CID_LOCAL` rejection gate passing.
- A 2,048 MiB image and the jailed CID 2 guest protocol acceptance, including the idle request-header deadline.
- Two-VM daemon/client acceptance covering Node.js and Python execution, authorization, and VM isolation; 52/52 hostile jailed-VM checks; and native teardown with no run-state or cgroup leftovers.
- The HTTP-only guest preview acceptance: trusted-proxy service control, capability and credential separation, rejection of `CONNECT`, `TRACE`, absolute-form targets, and `Expect: 100-continue`, WebSocket echo, SSE pressure with slow-reader cancellation, and stream closure and revocation on destroy.

The exact TOFU kernel digest `d8ced68bd61e27b6813e2c993cc53a4029c59e13210672180591c84109684fe4` booted and passed this scope. The result proves compatibility for this exact digest; it does not upgrade the digest's provenance or make the demonstration-only prebuilt kernel production-recommended.

| GitHub-hosted Azure observation | Time |
| --- | ---: |
| Daemon cold start to listening | 649 ms |
| First jailed VM create and readiness | 9,104 ms |
| Guest protocol acceptance | 18,478 ms |
| HTTP-only preview acceptance | 29,961 ms |
| Two-VM acceptance | 25,013 ms |
| Hostile jailed-VM abuse | 49,635 ms |

These timings are one GitHub-hosted Azure observation, not a Proxmox latency or capacity benchmark.

Residual scope is deliberate: disk pressure is bounded to 32 MiB, and the suite does not attempt full disk exhaustion, OOM or CPU starvation, kernel fuzzing or guest breakout, private-network, metadata, or host-vsock probing, or Proxmox qualification. None of those scenarios is claimed.

## Firecracker and jailer: use v1.17.0

The official [`releases/latest` API](https://api.github.com/repos/firecracker-microvm/firecracker/releases/latest) identifies non-prerelease **v1.17.0**, published 2026-09-10, as current stable. Its release commit is [`95f868c8e345b1cc8faccd1a3c910b4989dc3f58`](https://github.com/firecracker-microvm/firecracker/commit/95f868c8e345b1cc8faccd1a3c910b4989dc3f58).

| Input | Pinned value |
| --- | --- |
| x86_64 archive | `https://github.com/firecracker-microvm/firecracker/releases/download/v1.17.0/firecracker-v1.17.0-x86_64.tgz` |
| SHA-256 | `06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558` |
| Firecracker member | `release-v1.17.0-x86_64/firecracker-v1.17.0-x86_64` |
| jailer member | `release-v1.17.0-x86_64/jailer-v1.17.0-x86_64` |

The archive SHA-256 is **upstream-published twice**: in the release API asset's `digest` field and in the separate official [`firecracker-v1.17.0-x86_64.tgz.sha256.txt`](https://github.com/firecracker-microvm/firecracker/releases/download/v1.17.0/firecracker-v1.17.0-x86_64.tgz.sha256.txt) asset. A local SHA-256 calculation over the downloaded archive matched it.

Before extraction, the archive was listed and programmatically checked: all 24 entries are regular files beneath the single `release-v1.17.0-x86_64/` prefix; none is absolute or contains a `..` path component. No Linux binary was executed on Darwin. The archive's upstream `SHA256SUMS` and independent local hashes agree:

| Binary | SHA-256 | Static inspection |
| --- | --- | --- |
| Firecracker | `99ad0f5cd0514a88aad0e9ae8cfdb3cc3b4ab9d190e1194602406c786b5de7a5` | x86-64 static PIE ELF |
| jailer | `65ef226e96f0ceda55ba643f445801ef2cc0ea667ef67cad8ac4f406c9c8434f` | x86-64 static PIE ELF |

The archive digest is the download trust boundary; the per-binary digests are a useful second integrity check after extraction.

## Guest kernel

### Supported series and current LTS

Firecracker v1.17.0's [kernel policy](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/kernel-policy.md) supports 4K-page **6.18 guest kernels** through at least 2028-06-01. Kernel.org's official [`releases.json`](https://www.kernel.org/releases.json) identifies **6.18.51** as the current 6.18 longterm release on 2026-09-11.

The repository boots an ext4 root block device at `/dev/vda`, mounts cgroup v2 plus `proc`, `sysfs`, `devtmpfs`, `devpts`, and `tmpfs`, opens `/dev/console`, listens on `AF_VSOCK`, and atomically starts workloads with `CLONE_INTO_CGROUP`. The build script also requires native x86_64 Linux, root, Go 1.25 (from `guest/go.mod`), `mmdebstrap`, and a pre-existing kernel whose operator-provided SHA-256 matches; none of these checks should be weakened.

### First-party CI prebuilt: exact binary/config, but no upstream SHA-256

Firecracker's [getting-started guide](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/getting-started.md#getting-a-rootfs-and-guest-kernel-image) downloads kernels from the project's public `spec.ccfc.min` CI bucket, while explicitly warning that those resources are demonstration-only. The latest dated x86_64 CI set observed was `20260909-a8e1c3830545-0`; its abbreviated revision resolves to Firecracker commit [`a8e1c383054529a1c53ba7a0f498383a04e0c4e2`](https://github.com/firecracker-microvm/firecracker/commit/a8e1c383054529a1c53ba7a0f498383a04e0c4e2).

| Input | Pinned value |
| --- | --- |
| Kernel | `https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20260909-a8e1c3830545-0/x86_64/vmlinux-6.18.44` |
| Exact config | `https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20260909-a8e1c3830545-0/x86_64/vmlinux-6.18.44.config` |
| Kernel SHA-256 | `d8ced68bd61e27b6813e2c993cc53a4029c59e13210672180591c84109684fe4` (**local HTTPS observation / TOFU**) |
| Config SHA-256 | `9fb2be18303d2f6e8ec35b3a20ecf1209f54a4ece10114a893cb37beabee7030` (**local HTTPS observation / TOFU**) |

Static inspection identifies the kernel as an unstripped x86-64 ELF with Build ID `fbe77a2e2cf5a67551a703ef5098e62599d6d1e9`. Its embedded release string is `Linux version 6.18.44+ ... #1 SMP PREEMPT_DYNAMIC Wed Sep 9 03:29:40 UTC 2026`.

The downloaded ELF contains `CONFIG_IKCONFIG`. Extracting that gzip payload without executing the binary produced 99,233 bytes that are byte-for-byte identical to the adjacent config object and have the same config SHA-256 above. This binds the checked config to the checked binary.

The S3 listing advertises `CRC64NVME` as an algorithm but does not publish its value; anonymous `HEAD` also returns no checksum value. The multipart ETag (`0780a2063fe710dfa595658f0ae56af4-4`) is not a SHA-256. No SHA-256 sidecar was present. Therefore the kernel digest above is **not upstream-published**. Use it only if an operator explicitly promotes this exact first-party CI download as the acceptance input; otherwise use the source-build route below. The binary's config is verified, and the hosted run above proves runtime compatibility for this exact digest. Its download identity remains TOFU; that result does not upgrade its provenance or make the demonstration-only prebuilt kernel production-recommended.

### Required config, verified in the embedded config

All required items are built in (`=y`), important because the boot args include `nomodule`:

- Firecracker x86_64 block boot: `CONFIG_KVM_GUEST`, `CONFIG_ACPI`, `CONFIG_PCI`, `CONFIG_VIRTIO`, `CONFIG_VIRTIO_MMIO`, `CONFIG_VIRTIO_BLK`, `CONFIG_EXT4_FS`.
- Host/guest transport: `CONFIG_VSOCKETS`, `CONFIG_VIRTIO_VSOCKETS`, `CONFIG_VIRTIO_VSOCKETS_COMMON`.
- Guest cgroup v2 isolation: `CONFIG_CGROUPS`, `CONFIG_CGROUP_SCHED`, `CONFIG_FAIR_GROUP_SCHED`, `CONFIG_CFS_BANDWIDTH`, `CONFIG_MEMCG`, `CONFIG_CGROUP_PIDS`, `CONFIG_CGROUP_FREEZER` (plus `CONFIG_CGROUP_CPUACCT`).
- PID 1 mounts/devices: `CONFIG_DEVTMPFS`, `CONFIG_DEVTMPFS_MOUNT`, `CONFIG_PROC_FS`, `CONFIG_SYSFS`, `CONFIG_TMPFS`, `CONFIG_UNIX98_PTYS`.
- Console and userspace: `CONFIG_PRINTK`, `CONFIG_SERIAL_8250`, `CONFIG_SERIAL_8250_CONSOLE`, `CONFIG_BINFMT_ELF`.

`CONFIG_VIRTIO_MMIO_CMDLINE_DEVICES` is deliberately disabled: v1.17.0's policy recommends ACPI over the deprecated command-line MMIO discovery path. `CONFIG_ACPI` and `CONFIG_PCI` remain enabled even though the repository's boot args say `pci=off` and Firecracker itself is launched without PCI support.

`CLONE_INTO_CGROUP` has no separate Kconfig switch. Linux 6.18 defines it in the [`clone3` UAPI](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/plain/include/uapi/linux/sched.h?h=v6.18.51), and the exact kernel has cgroups enabled. The authoritative [cgroup v2 documentation](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/plain/Documentation/admin-guide/cgroup-v2.rst?h=v6.18.51) documents `CLONE_INTO_CGROUP`, `cgroup.freeze`, `cgroup.kill`, `cpu.max`, `memory.max`, and `pids.max`, matching the guest runner's operations.

### Source-proven fallback; output digest must be produced after a native build

There is no upstream-published digest for the Firecracker CI kernel binary. For a source trust boundary, pin kernel.org **6.18.51**:

| Input | Pinned value |
| --- | --- |
| Source | `https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.18.51.tar.xz` |
| Source SHA-256 | `ba2f60f858bf4d1f929101faa356c93dc8b925b17aaa9f95eabd4627758df613` |
| Signature | `https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.18.51.tar.sign` |

The SHA-256 is published in kernel.org's signed [`sha256sums.asc`](https://cdn.kernel.org/pub/linux/kernel/v6.x/sha256sums.asc). A local download matched it. The detached developer signature also verified as a good signature from Greg Kroah-Hartman with fingerprint `647F 2865 4894 E3BD 4571 99BE 38DB BDC8 6092 693E`, the fingerprint published in kernel.org's [signature guide](https://www.kernel.org/signature.html). As that guide explains, the signature covers the uncompressed tar stream:

```sh
printf '%s  %s\n' \
  ba2f60f858bf4d1f929101faa356c93dc8b925b17aaa9f95eabd4627758df613 \
  linux-6.18.51.tar.xz | sha256sum --check --strict
gpg --locate-keys gregkh@kernel.org
xz -cd linux-6.18.51.tar.xz | gpg --verify linux-6.18.51.tar.sign -
tar -tJf linux-6.18.51.tar.xz       # inspect before extraction
tar -xJf linux-6.18.51.tar.xz
```

Do **not** copy Firecracker's full CI config onto mainline blindly: Firecracker explicitly says its checked-in configs are for the Amazon Linux kernel sources it validates and are not guaranteed with upstream mainline. The exact v1.17.0 x86_64 6.18 config is pinned at Firecracker commit `95f868c8e345b1cc8faccd1a3c910b4989dc3f58` ([config](https://github.com/firecracker-microvm/firecracker/blob/95f868c8e345b1cc8faccd1a3c910b4989dc3f58/resources/guest_configs/microvm-kernel-ci-x86_64-6.18.config), Git blob `8022e6aa517513b8c399fe14d6beca0d6d71661d`; local SHA-256 `ba22401a0c7292a4c024ebcd10a562d4a1f1bfd2faed671406d3b159c0cf5215`). It is a review reference and the config input for Firecracker's supported-vendor recipe, not a guarantee for kernel.org source.

For a build following Firecracker's own supported-vendor recipe, pin its exact Amazon Linux source tag and pre-seed the source directory so the otherwise dynamic `get_tag` lookup cannot advance:

```sh
FC_COMMIT=a8e1c383054529a1c53ba7a0f498383a04e0c4e2
AL_TAG=kernel6.18-6.18.44-99.149.amzn2023
AL_COMMIT=e0ce16bb24cc05709abf05f9a7b165b42a568f22

git clone https://github.com/firecracker-microvm/firecracker.git firecracker
git -C firecracker checkout --detach "$FC_COMMIT"
git clone --filter=tree:0 --no-checkout --single-branch --branch "$AL_TAG" \
  https://github.com/amazonlinux/linux.git firecracker/resources/linux
test "$(git -C firecracker/resources/linux rev-parse "$AL_TAG^{}")" = "$AL_COMMIT"
cd firecracker
./tools/devtool build_ci_artifacts kernels 6.18
sha256sum resources/x86_64/vmlinux-6.18.44 \
  resources/x86_64/vmlinux-6.18.44.config
```

This is the exact upstream entry point documented in Firecracker's [kernel setup guide](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/rootfs-and-kernel-setup.md#use-the-provided-recipe). The pinned [`resources/rebuild.sh`](https://github.com/firecracker-microvm/firecracker/blob/a8e1c383054529a1c53ba7a0f498383a04e0c4e2/resources/rebuild.sh) concatenates the 6.18 base config, `ci.config`, and `nvme.config`, runs `make olddefconfig`, then `make -j $(nproc) vmlinux bzImage`. The source tag is annotated and contains a PGP signature, but GitHub reports `unknown_key`; the peeled commit pin above is therefore the actionable identity, not a claimed verified signature.

No output kernel SHA-256 can be supplied before that native Linux build. After building, inspect the emitted config for the required `=y` settings, hash the output, promote that digest independently, and only then pass it to `scripts/build-guest-image.sh --kernel-sha256`. A real Firecracker/jailer boot must still prove compatibility.

## Hosted-runner constraint

GitHub's [hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories) documents public `ubuntu-24.04` x64 runners as fresh VMs with 4 CPUs, 16 GB RAM, and 14 GB SSD and passwordless `sudo`. It does not make `/dev/kvm` a Firecracker compatibility guarantee. Acceptance should therefore keep the explicit KVM and cgroup-v2 preflight fail-closed, not skip when either capability is absent. Using the small verified CI prebuilt avoids spending the 14 GB workspace and job time on a kernel build while the pinned rootfs builder creates its 2 GiB ext4 image.

The hosted job installs the verified Firecracker and jailer binaries under the
dedicated `/var/lib/microvm/bin` prefix, which is root-owned and not group- or
world-writable. It does not depend on or change the runner's shared
`/usr/local` tree. The pinned
kernel and generated image remain under `/var/lib/microvm/images`.
