# Operations

Running `microvm-daemon` on a Linux KVM host, sized for the dymoo homelab
Proxmox cluster. Read `README.md` (security model, limitations) first.

## Deployment shape

- A **dedicated Linux VM** on the Proxmox cluster (x86_64) with **nested
  KVM** enabled — not the Proxmox host itself. Proxmox VM CPU type must be
  `host` (or another type exposing VT-x) so `/dev/kvm` exists inside.
- The daemon listens on a **private, authenticated TLS endpoint**. It is not
  part of the public ingress path (Cloudflare → edge → Caddy) and must not
  be exposed there; admin access rides the private Wireguard network, the
  same split the cluster already uses for management APIs.
- No placement assumptions are made about which Proxmox node runs the VM.
  Size the VM from the quotas you configure (see below); remember guests add
  their `memMib` plus the configured `vmmOverheadMib` to host memory pressure.
  The example uses 256 MiB of VMM overhead; it is a required operator setting,
  not an implicit default.

## Startup checks and operator requirements

Before listening, the daemon checks and aggregates these failures in one
`HostPrereqFailed`:

1. the process runs as root, `/dev/kvm` opens read/write, and cgroup v2 is
   mounted at `/sys/fs/cgroup`;
2. configured Firecracker, jailer, and util-linux `flock` paths are executable,
   root-owned, non-world-writable, and have no symlink in the checked ancestry;
3. the kernel is readable and has the same trusted-path posture;
4. the image and run-state directories are trusted; the daemon creates the
   run-state directory with mode 0700 when absent;
5. UID/GID ranges are positive and ordered, `maxPidsPerVm` is at least 8, and
   `vmmOverheadMib` is a non-negative integer.

Configuration validation separately requires TLS on a non-loopback listener,
non-empty TLS PEM values, a secure advertised origin, an admin token of at
least 16 characters, ordered quota bounds, and allocation ranges large enough
for `maxVms`.

Operators must additionally supply a compatible Firecracker/jailer pair, a
kernel with the Firecracker-required block, ext4, vsock, and cgroup features,
and reserve the configured numeric UID/GID ranges from other host workloads.
The startup probes do not inspect binary linkage/version compatibility, kernel
`CONFIG_*` values, or host account databases. Image manifest and architecture
checks happen when an image is resolved. Guest runner/cgroup readiness is
proved separately for each VM before `create` returns.

## Configuration reference

`daemon.json` — `${ENV_VAR}` references expand from the daemon's environment;
unresolved references are a fatal config error.

```jsonc
{
  "listen": { "host": "192.0.2.10", "port": 9443 },
  "advertisedUrl": "https://192.0.2.10:9443",
  // PEM contents, not filenames. TLS is required off loopback.
  "tls": {
    "cert": "${MICROVM_TLS_CERT_PEM}",
    "key": "${MICROVM_TLS_KEY_PEM}",
    "ca": "${MICROVM_TLS_CA_PEM}"
  },
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
    "jailerParentCgroup": "microvm.slice",
    "guestCidRange": [5000, 5099],
    "kernelArgs": "console=ttyS0 reboot=k panic=-1 pci=off nomodule random.trust_cpu=on root=/dev/vda rw init=/sbin/init",
    "bootTimeoutMs": 30000,
    "guestReadinessTimeoutMs": 30000,
    "vmmOverheadMib": 256,
    "maxPidsPerVm": 1024,
    "jailerFsizeBytes": 2147483648,
    "jailerNoFileLimit": 4096
  },
  "limits": {
    "maxVms": 16,
    "defaultCpus": 2,
    "maxCpus": 4,
    "defaultMemMib": 512,
    "maxMemMib": 4096,
    "maxTtlSeconds": 3600
  }
}
```

`192.0.2.10` is a documentation-only address. Replace it with the dedicated
daemon VM's assigned private address, never a Proxmox host management address.
The example assumes the 2 GiB image produced below.

Notes:

- `kernelArgs` is operator-owned and caller-invisible. The example uses the
  same kernel arguments as the image's `/sbin/init` and as the jailed boot the
  hosted acceptance workflow dispatches; a boot on your own host remains
  unverified until you run the acceptance there.
- `memory.max` per VM = guest `memMib` + the configured `vmmOverheadMib`; do
  not drop the overhead or the OOM killer can take valid VMs.
- `jailerFsizeBytes` must be at least the largest allowed root image.
- `runStateDir` stores one private logical full-size root disk per live VM.
  Provisioning requests a copy-on-write reflink and automatically falls back
  to an ordinary private copy when unsupported. Put it on disk-backed storage
  and size for the worst case: `maxVms × image size` plus headroom, because
  fallback copies and guest writes can consume the full space.
- `create` returns only after the guest runner answers a readiness probe
  bounded by `guestReadinessTimeoutMs`.
- `maxTtlSeconds` is both the default lifetime when `create` omits a TTL and
  the hard upper bound.
- The daemon holds an advisory kernel `flock` on
  `runStateDir/daemon.lock`. It never unlinks that inode or trusts stale owner
  metadata. If the lock-helper process dies, the HTTP listener and daemon
  scope shut down.

## Credential lifecycle

- Admin tokens come from config (via env refs — never commit them; the
  cluster convention stores secrets in `.tfvars`/k8s Secrets, never in git).
- `create` mints a sandbox token (`mvs_…`) and returns it **once**. The state
  evidence contains VM metadata but no credential material.
- A daemon restart destroys every VM and invalidates its sandbox credential;
  there is no credential or VM adoption across restart.
- `destroy` drops the VM's sandbox credentials immediately.

## Recovery semantics (honest)

- The daemon is authoritative and in-memory; `runStateDir/vms/<id>/` is
  evidence, not a session store.
- **A daemon restart destroys all VMs found on disk**: orphan jailer cgroups
  are killed (`cgroup.kill`), then the VM directories are removed. There is
  no VM adoption.
- State writes are atomic (temp file + rename); a crash mid-write cannot
  produce a torn state file.

## Acceptance

Run on a native Linux KVM host. Build inputs are explicit:

```bash
export KERNEL_SHA256='<trusted 64-hex digest>'
sudo scripts/build-guest-image.sh \
  --arch x86_64 \
  --kernel /operator/microvm.kernel \
  --kernel-sha256 "$KERNEL_SHA256" \
  --output-dir /var/lib/microvm/images \
  --name node \
  --size-mib 2048

export MICROVM_URL='https://192.0.2.10:9443'
export MICROVM_TOKEN='<admin token from the secret manager>'
export MICROVM_IMAGE='node'
export MICROVM_RUN_STATE_DIR='/var/lib/microvm/run'
export MICROVM_CGROUP_ROOT='/sys/fs/cgroup/microvm.slice'
scripts/accept-linux.sh
```

### Hosted acceptance (CI)

`.github/workflows/acceptance.yml` is dispatch-only and runs the real path on
a standard public `ubuntu-24.04` runner with `contents: read` and a bounded
job timeout: a fail-closed KVM/cgroup/disk preflight (a missing capability
fails the job, it never skips), digest-verified pinned Firecracker/jailer and
kernel installs under root-owned paths (provenance and trust labels in
`docs/runtime-artifacts.md`; the kernel digest is a TOFU observation of the
first-party CI fixture, not an upstream signature), `pnpm test` with the
kernel-flock test asserted unskipped, guest `go test -race`, the pinned image
build, the guest exec v1 protocol against a jailed VM the daemon booted, and
the two-VM daemon acceptance. The daemon's admin token is generated
ephemerally, masked before any output, and passed only through the config's
`${ENV}` reference; teardown rides the daemon's native shutdown lifecycle plus
an always-step cleanup, and the uploaded evidence contains versions,
checksums, logs, and timings only — never tokens, the rootfs image, or daemon
config.

## Troubleshooting

- `HostPrereqFailed: …` — the reason lists every failed check by name; fix
  all of them (the aggregation is deliberate).
- `VmPoisoned` — the guest's state became unknowable (transport violation,
  exec deadline, or VMM death). `destroy` and create a new VM; never reuse.
- `DestroyUncertain` — teardown could not be proven complete; retry destroy.
  The VM must not be treated as released while this persists.
- CLI exit codes: 0 ok · 1 operation error · 2 auth · 3 not found ·
  4 capacity · 5 prereq/boot · 10 transport. Exec exits with the guest's
  exit code (signal death = 128+signum, so a guest timeout kill is 137).
