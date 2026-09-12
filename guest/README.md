# Firecracker guest runtime

This module builds the only privileged software in the guest image. `microvm-init` runs as PID 1, mounts `proc`, `sysfs`, `devtmpfs`, `devpts`, `tmpfs`, and cgroup v2, then starts `microvm-guest`. It does not configure a network interface or start an init suite or unrelated daemon.

The runner listens on Linux `AF_VSOCK` port **1024**. It remains root only to create cgroups and launch commands atomically into them. Every requested command runs as the fixed `agent` identity (UID/GID 1000), with `/workspace` as its home and default working directory. The runner invokes an argv array with `execve`; it never invokes a shell or interpolates arguments.

## Host transport

The Firecracker API UDS and the configured vsock UDS are different sockets:

1. The host configures the vsock device through the Firecracker API with `guest_cid` and `uds_path`.
2. The host opens the **vsock `uds_path`**, writes exactly `CONNECT 1024\n`, and reads `OK <numeric-host-port>\n`.
3. The same UDS connection is now the guest data stream. The number in `OK` is not a path and the host must not reconnect.

This is the host-initiated flow specified by Firecracker's [virtio-vsock documentation](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/vsock.md#host-initiated-connections).

## Execution protocol v1

A connection carries exactly one newline-terminated JSON request:

```json
{"version":1,"id":"exec-1","argv":["/usr/bin/node","--version"],"cwd":"/workspace","env":{"NAME":"value"},"timeoutMs":30000,"maxOutputBytes":1048576}
```

`cwd`, `env`, `timeoutMs`, and `maxOutputBytes` are optional. `cwd` defaults to `/workspace` and cannot leave it. The timeout defaults to 30 seconds and cannot exceed 600 seconds. The output limit defaults to 1 MiB and cannot exceed 8 MiB; it applies independently to stdout and stderr. Requests and response JSONL lines are bounded at 8 MiB.

Output frames preserve the stream and bytes (base64), with a sequence starting at zero independently for each stream:

```json
{"version":1,"id":"exec-1","type":"stdout","seq":0,"data":"djE4LjIwLjQK"}
```

Exactly one terminal frame follows:

```json
{"version":1,"id":"exec-1","type":"exit","code":0,"signal":null,"timedOut":false,"outputTruncated":false}
```

A request rejected before execution ends with an error frame whose code is `INVALID_REQUEST`, `EXEC_FAILED`, or `INTERNAL`. Timeout kills report exit 137, signal `SIGKILL`, and `timedOut:true`. Hitting either output cap kills the workload and sets `outputTruncated:true`. EOF from the host cancels execution and requires no response frame.

## Workload containment

Each connection gets a distinct child cgroup under `/sys/fs/cgroup/microvm-exec`. The runner enables the CPU, memory, and PID controllers on both the root and execution subtree, applies fixed defense-in-depth ceilings, and uses Go's `UseCgroupFD` support (`CLONE_INTO_CGROUP`) so the child is born in its cgroup before credentials are dropped. This closes the fork-before-move race.

Cancellation freezes that one cgroup, writes `cgroup.kill`, waits for `cgroup.events` to report `populated 0`, thaws, and removes it. A process cannot escape by calling `setsid` or double-forking, and concurrent commands use different cgroups. The runner fails closed when cgroup v2 or any required controller is unavailable; it never falls back to process-group-only isolation. The host daemon must poison and destroy a VM whenever a transport failure prevents it from receiving a terminal frame.

The per-command cgroup limits do not replace the daemon's VM-wide vCPU, memory, TTL, output, and teardown limits.

## Image and kernel inputs

Run `scripts/build-guest-image.sh --help` on a native Linux builder. The script refuses macOS, non-root execution, implicit foreign-architecture chroots, a missing kernel, and a kernel whose operator-provided SHA-256 does not match. It supports x86_64 and aarch64 explicitly; the deployment architecture is never inferred from a developer workstation.

The userspace archive is pinned to Debian 13 (Trixie) snapshots [`20260911T202741Z`](https://snapshot.debian.org/archive/debian/20260911T202741Z/) and Debian Security [`20260911T204307Z`](https://snapshot.debian.org/archive/debian-security/20260911T204307Z/). Debian identifies Trixie as its current stable release, and the image uses its maintained Python 3.13 runtime. Debian 13's Node.js 20 package is upstream end-of-life, so the builder instead installs Node.js **24.21.0 LTS** from the [official release archive](https://nodejs.org/dist/v24.21.0/) and verifies the architecture-specific SHA-256 published in Node.js's [`SHASUMS256.txt`](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt). `SOURCE_DATE_EPOCH`, filesystem UUID, lazy initialization, file mtimes, and Go build IDs are fixed. The guest has no network configuration.

The kernel is an explicit operator prerequisite rather than an unverified download. Firecracker's [kernel policy](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/kernel-policy.md) supports 6.18 guest kernels and lists the required virtio, block, vsock, and architecture features. Firecracker's pinned v1.17.0 [x86_64](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/resources/guest_configs/microvm-kernel-ci-x86_64-6.18.config) and [aarch64](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/resources/guest_configs/microvm-kernel-ci-aarch64-6.18.config) configs also enable ext4, devtmpfs, cgroup CPU/memory/PID controllers, and the cgroup freezer used here. Firecracker documents its kernel build recipe in [rootfs-and-kernel-setup.md](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/rootfs-and-kernel-setup.md). Record and review the resulting kernel's SHA-256, then pass that exact digest to the image builder.

Debian documents snapshot-based reproducibility and `SOURCE_DATE_EPOCH` behavior in the [mmdebstrap manual](https://manpages.debian.org/bookworm/mmdebstrap/mmdebstrap.1.en.html#SOURCE_DATE_EPOCH). Snapshot pinning fixes package inputs; the emitted checksum remains the artifact identity operators must promote.

## Verification

Portable protocol tests use real subprocesses and cover separate stdout/stderr, exit status, timeout, per-stream truncation, a descendant retaining output pipes, and host backpressure. On macOS:

```sh
cd guest
go test ./internal/runner
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./cmd/microvm-guest ./cmd/microvm-init
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build ./cmd/microvm-guest ./cmd/microvm-init
```

A real VM smoke test is unavailable on macOS because Firecracker requires Linux KVM. Nothing in the portable tests claims KVM success. On a Linux KVM host, boot a VM through the real daemon (the jailer is mandatory; no direct-Firecracker path exists anywhere in this repository), then exercise the protocol against that already-booted jailed VM's vsock:

```sh
id=$(MICROVM_URL=... MICROVM_TOKEN=... microvm create --image node --cpus 1 --mem-mib 512 --ttl-s 900 --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["vmId"])')
sock="/var/lib/microvm/run/vms/$id/jailer/firecracker/$id/root/v.sock"
scripts/accept-guest-linux.sh --vsock-uds "$sock"
MICROVM_URL=... MICROVM_TOKEN=... microvm destroy --vm "$id" --json   # cleanup stays with the caller
```

The socket path is the daemon's documented per-VM jailer layout (`vmLayout` in
`src/host.ts`:
`<runStateDir>/vms/<vmId>/jailer/<firecracker-basename>/<vmId>/root/v.sock`).
The script validates Node.js, Python, timeout, truncation, unprivileged
access, no external network, `setsid` descendant cleanup, and concurrent
cgroup isolation through the real vsock protocol; it boots nothing itself.

For full daemon/client acceptance on the Linux host, set `MICROVM_URL`, an
admin `MICROVM_TOKEN`, `MICROVM_IMAGE`, the local `MICROVM_RUN_STATE_DIR`, and
`MICROVM_CGROUP_ROOT` to the daemon's jailer cgroup parent directory (below
`/sys/fs/cgroup`), then run `scripts/accept-linux.sh`. It uses the real client
and daemon, checks sandbox authorization and process identity, and confirms
destroy removes both VM state and the cgroup.
