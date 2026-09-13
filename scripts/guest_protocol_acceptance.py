#!/usr/bin/env python3
"""Exercise the real guest runner over Firecracker's host-side vsock UDS."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import json
import re
import socket
import time
from dataclasses import dataclass
from typing import Any

PORT = 1024
MAX_LINE_BYTES = 8 << 20
IDLE_HEADER_OUTER_BOUND_SECONDS = 8


@dataclass(frozen=True)
class Result:
    stdout: bytes
    stderr: bytes
    terminal: dict[str, Any]


def execute(vsock_uds: str, request: dict[str, Any]) -> Result:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(15)
        connection.connect(vsock_uds)
        connection.sendall(f"CONNECT {PORT}\n".encode("ascii"))
        stream = connection.makefile("rwb", buffering=0)
        acknowledgement = stream.readline(128)
        if not re.fullmatch(rb"OK [0-9]+\n", acknowledgement):
            raise AssertionError(f"invalid Firecracker vsock acknowledgement: {acknowledgement!r}")
        stream.write(json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n")

        output = {"stdout": bytearray(), "stderr": bytearray()}
        sequences = {"stdout": 0, "stderr": 0}
        while True:
            line = stream.readline(MAX_LINE_BYTES + 2)
            if not line:
                raise AssertionError("guest closed before a terminal frame")
            if len(line) > MAX_LINE_BYTES + 1 or not line.endswith(b"\n"):
                raise AssertionError("guest response exceeded the JSONL line bound")
            frame = json.loads(line)
            if frame.get("version") != 1 or frame.get("id") != request["id"]:
                raise AssertionError(f"mismatched response envelope: {frame!r}")
            frame_type = frame.get("type")
            if frame_type in output:
                if frame.get("seq") != sequences[frame_type]:
                    raise AssertionError(f"non-monotonic {frame_type} sequence: {frame!r}")
                sequences[frame_type] += 1
                output[frame_type].extend(base64.b64decode(frame["data"], validate=True))
                continue
            if frame_type in {"exit", "error"}:
                return Result(bytes(output["stdout"]), bytes(output["stderr"]), frame)
            raise AssertionError(f"unknown guest frame type: {frame!r}")


def require_idle_header_deadline(vsock_uds: str) -> None:
    """An accepted host connection must not hold a guest worker forever."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(IDLE_HEADER_OUTER_BOUND_SECONDS)
        connection.connect(vsock_uds)
        connection.sendall(f"CONNECT {PORT}\n".encode("ascii"))
        stream = connection.makefile("rwb", buffering=0)
        acknowledgement = stream.readline(128)
        if not re.fullmatch(rb"OK [0-9]+\n", acknowledgement):
            raise AssertionError(f"invalid Firecracker vsock acknowledgement: {acknowledgement!r}")

        deadline = time.monotonic() + IDLE_HEADER_OUTER_BOUND_SECONDS

        def read_before_deadline(limit: int) -> bytes:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError("idle request-header connection remained open beyond the 8s outer bound")
            connection.settimeout(remaining)
            try:
                return stream.readline(limit)
            except TimeoutError as error:
                raise AssertionError(
                    "idle request-header connection remained open beyond the 8s outer bound"
                ) from error

        first = read_before_deadline(MAX_LINE_BYTES + 2)
        if not first:
            return
        if len(first) > MAX_LINE_BYTES + 1 or not first.endswith(b"\n"):
            raise AssertionError("idle request-header response exceeded the JSONL line bound")
        frame = json.loads(first)
        expected_keys = {"version", "id", "type", "code", "message"}
        if (
            not isinstance(frame, dict)
            or set(frame) != expected_keys
            or frame["version"] != 1
            or frame["id"] != ""
            or frame["type"] != "error"
            or frame["code"] != "INVALID_REQUEST"
            or not isinstance(frame["message"], str)
        ):
            raise AssertionError(f"unexpected idle request-header response: {frame!r}")
        if read_before_deadline(1):
            raise AssertionError("guest sent trailing data instead of closing the idle request-header connection")


def request(identifier: str, argv: list[str], **overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "version": 1,
        "id": identifier,
        "argv": argv,
        "timeoutMs": 15_000,
        "maxOutputBytes": 65_536,
    }
    value.update(overrides)
    return value


def require_exit(result: Result, code: int = 0) -> None:
    terminal = result.terminal
    if terminal.get("type") != "exit" or terminal.get("code") != code:
        raise AssertionError(f"unexpected terminal frame: {terminal!r}; stderr={result.stderr!r}")


def wait_for_runner(vsock_uds: str) -> None:
    deadline = time.monotonic() + 10
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            probe = execute(vsock_uds, request("ready", ["/usr/bin/true"]))
            require_exit(probe)
            return
        except (AssertionError, ConnectionError, OSError, TimeoutError) as error:
            last_error = error
            time.sleep(0.05)
    raise AssertionError(f"guest runner did not become ready: {last_error}")
def run(vsock_uds: str) -> None:
    wait_for_runner(vsock_uds)
    # The guest enforces a 5s request-header deadline. The harness holds one
    # valid Firecracker host (CID 2) connection idle, allows an optional
    # structured INVALID_REQUEST frame, and requires close before its 8s bound.
    require_idle_header_deadline(vsock_uds)

    # The idle-client rejection must not poison subsequent valid host-CID 2
    # execution.
    host_cid = execute(vsock_uds, request("valid-host-cid-2", ["/usr/bin/true"]))
    require_exit(host_cid)

    node = execute(vsock_uds, request("node", ["/usr/bin/node", "--version"]))
    require_exit(node)
    if not re.fullmatch(rb"v\d+\.\d+\.\d+\s*", node.stdout):
        raise AssertionError(f"unexpected Node.js version: {node.stdout!r}")

    python = execute(vsock_uds, request("python", ["/usr/bin/python3", "--version"]))
    require_exit(python)
    if not re.fullmatch(rb"Python 3\.\d+\.\d+\s*", python.stdout):
        raise AssertionError(f"unexpected Python version: {python.stdout!r}")
    git = execute(vsock_uds, request("git", ["/usr/bin/git", "--version"]))
    require_exit(git)
    if not re.fullmatch(rb"git version \d+\.\d+\.\d+(?:\.\d+)?\s*", git.stdout):
        raise AssertionError(f"unexpected Git version: {git.stdout!r}")

    pnpm = execute(vsock_uds, request("pnpm", ["/usr/local/bin/pnpm", "--version"]))
    require_exit(pnpm)
    if pnpm.stdout.strip() != b"11.13.1":
        raise AssertionError(f"unexpected pnpm version: {pnpm.stdout!r}")

    image_policy = execute(
        vsock_uds,
        request(
            "next-image-policy",
            [
                "/usr/bin/python3",
                "-c",
                (
                    "import os;"
                    "store_path='/var/lib/microvm/pnpm-store';"
                    "template_path='/opt/microvm/next-template';"
                    "store_paths=[store_path]+[os.path.join(root,name) "
                    "for root,dirs,files in os.walk(store_path) for name in dirs+files];"
                    "template_paths=[template_path]+[os.path.join(root,name) "
                    "for root,dirs,files in os.walk(template_path) for name in dirs+files];"
                    "assert all((os.lstat(path).st_uid,os.lstat(path).st_gid)==(1000,1000) "
                    "for path in store_paths);"
                    "assert os.access(store_path,os.W_OK);"
                    "assert all((os.lstat(path).st_uid,os.lstat(path).st_gid)==(0,0) "
                    "for path in template_paths);"
                    "assert all(os.path.islink(path) or os.lstat(path).st_mode&0o22==0 "
                    "for path in template_paths);"
                    "assert not os.access(template_path,os.W_OK);"
                    "assert open('/etc/resolv.conf','rb').read()==b''"
                ),
            ],
        ),
    )
    require_exit(image_policy)

    initialize = execute(
        vsock_uds,
        request("next-init", ["/usr/local/bin/microvm-next-init"]),
    )
    require_exit(initialize)

    offline_install = execute(
        vsock_uds,
        request(
            "next-offline-install",
            [
                "/usr/local/bin/pnpm",
                "install",
                "--offline",
                "--frozen-lockfile",
            ],
            timeoutMs=60_000,
        ),
    )
    require_exit(offline_install)

    template_typecheck = execute(
        vsock_uds,
        request(
            "next-typecheck",
            ["/usr/local/bin/pnpm", "run", "typecheck"],
            timeoutMs=60_000,
        ),
    )
    require_exit(template_typecheck)

    no_overwrite = execute(
        vsock_uds,
        request("next-no-overwrite", ["/usr/local/bin/microvm-next-init"]),
    )
    if no_overwrite.terminal.get("type") != "exit" or no_overwrite.terminal.get("code") != 1:
        raise AssertionError(f"initializer overwrote a non-empty workspace: {no_overwrite!r}")

    next_smoke_source = (
        "const {spawn}=require('node:child_process');"
        "const {readFileSync}=require('node:fs');"
        "const http=require('node:http');"
        "const child=spawn('/usr/local/bin/pnpm',['dev'],"
        "{cwd:'/workspace',stdio:'ignore'});"
        "const deadline=Date.now()+12000;"
        "let finished=false;"
        "function fail(message){if(finished)return;finished=true;"
        "console.error(message);process.exit(1)}"
        "child.on('exit',code=>fail(`next dev exited early: ${code}`));"
        "function probe(){const req=http.get("
        "{host:'127.0.0.1',port:3000,path:'/',timeout:500},res=>{"
        "res.resume();if(res.statusCode!==200)return fail(`HTTP ${res.statusCode}`);"
        "function listeners(path){return readFileSync(path,'utf8').trim().split('\\n')"
        ".slice(1).map(line=>line.trim().split(/\\s+/))"
        ".filter(fields=>fields[3]==='0A'&&fields[1].endsWith(':0BB8'))"
        ".map(fields=>fields[1])}"
        "const bound=[...listeners('/proc/net/tcp'),...listeners('/proc/net/tcp6')];"
        "if(bound.length!==1||bound[0]!=='0100007F:0BB8')"
        "return fail(`unexpected Next.js listeners: ${bound.join(',')}`);"
        "finished=true;console.log('next-ready');process.exit(0)});"
        "req.on('timeout',()=>req.destroy());"
        "req.on('error',()=>{if(Date.now()>=deadline)"
        "return fail('Next.js did not become ready');setTimeout(probe,100)})}"
        "probe();"
    )
    next_smoke = execute(
        vsock_uds,
        request(
            "next-dev",
            ["/usr/bin/node", "-e", next_smoke_source],
            timeoutMs=15_000,
        ),
    )
    require_exit(next_smoke)
    if next_smoke.stdout.strip() != b"next-ready":
        raise AssertionError(f"unexpected Next.js smoke output: {next_smoke!r}")

    git_init = execute(
        vsock_uds,
        request(
            "git-init",
            ["/usr/bin/git", "init", "--initial-branch=main"],
        ),
    )
    require_exit(git_init)
    for identifier, key, value in (
        ("git-author-name", "user.name", "MicroVM Checkpoint"),
        ("git-author-email", "user.email", "checkpoint@microvm.invalid"),
    ):
        configured = execute(
            vsock_uds,
            request(
                identifier,
                ["/usr/bin/git", "config", "--local", key, value],
            ),
        )
        require_exit(configured)

    git_add = execute(
        vsock_uds,
        request("git-add", ["/usr/bin/git", "add", "--all"]),
    )
    require_exit(git_add)
    git_commit = execute(
        vsock_uds,
        request(
            "git-commit",
            [
                "/usr/bin/git",
                "commit",
                "--quiet",
                "--no-gpg-sign",
                "--no-verify",
                "-m",
                "Checkpoint Next.js workspace",
            ],
            env={
                "GIT_AUTHOR_DATE": "2000-01-01T00:00:00Z",
                "GIT_COMMITTER_DATE": "2000-01-01T00:00:00Z",
            },
        ),
    )
    require_exit(git_commit)

    worktree_clean = execute(
        vsock_uds,
        request(
            "git-worktree-clean",
            ["/usr/bin/git", "diff", "--quiet"],
        ),
    )
    require_exit(worktree_clean)
    index_clean = execute(
        vsock_uds,
        request(
            "git-index-clean",
            ["/usr/bin/git", "diff", "--cached", "--quiet"],
        ),
    )
    require_exit(index_clean)
    status = execute(
        vsock_uds,
        request(
            "git-status",
            ["/usr/bin/git", "status", "--porcelain=v1", "--untracked-files=all"],
        ),
    )
    require_exit(status)
    if status.stdout:
        raise AssertionError(f"checkpoint did not leave a clean repository: {status.stdout!r}")

    head = execute(
        vsock_uds,
        request(
            "git-head",
            ["/usr/bin/git", "rev-parse", "--verify", "HEAD^{commit}"],
        ),
    )
    require_exit(head)
    if not re.fullmatch(rb"[0-9a-f]{40}\s*", head.stdout):
        raise AssertionError(f"unexpected checkpoint HEAD: {head.stdout!r}")

    remotes = execute(
        vsock_uds,
        request("git-remotes", ["/usr/bin/git", "remote"]),
    )
    require_exit(remotes)
    if remotes.stdout:
        raise AssertionError(f"guest checkpoint unexpectedly has a remote: {remotes.stdout!r}")
    credential_config = execute(
        vsock_uds,
        request(
            "git-no-credentials",
            [
                "/usr/bin/git",
                "config",
                "--get-regexp",
                r"^(credential\.|http\..*\.extraheader$)",
            ],
        ),
    )
    if (
        credential_config.terminal.get("type") != "exit"
        or credential_config.terminal.get("code") != 1
        or credential_config.stdout
    ):
        raise AssertionError(f"guest contains Git credential configuration: {credential_config!r}")
    push = execute(
        vsock_uds,
        request("git-push-denied", ["/usr/bin/git", "push"]),
    )
    if push.terminal.get("type") != "exit" or push.terminal.get("code") == 0:
        raise AssertionError(f"guest checkpoint unexpectedly pushed: {push!r}")

    print(f"guest checkpoint HEAD: {head.stdout.decode('ascii').strip()}")
    invalid_cwd = execute(
        vsock_uds,
        request("cwd", ["/usr/bin/true"], cwd="/etc"),
    )
    if invalid_cwd.terminal.get("type") != "error" or invalid_cwd.terminal.get("code") != "INVALID_REQUEST":
        raise AssertionError(f"unsafe cwd was accepted: {invalid_cwd.terminal!r}")

    shadow = execute(
        vsock_uds,
        request("shadow", ["/usr/bin/python3", "-c", "open('/etc/shadow').read()"]),
    )
    if shadow.terminal.get("type") != "exit" or shadow.terminal.get("code") == 0:
        raise AssertionError("unprivileged command read /etc/shadow")


    network = execute(
        vsock_uds,
        request(
            "network",
            [
                "/usr/bin/python3",
                "-c",
                "import socket; s=socket.socket(); s.settimeout(.5); s.connect(('1.1.1.1', 53))",
            ],
        ),
    )
    if network.terminal.get("type") != "exit" or network.terminal.get("code") == 0:
        raise AssertionError("guest unexpectedly reached an external network")

    timeout = execute(
        vsock_uds,
        request("timeout", ["/usr/bin/sleep", "2"], timeoutMs=50),
    )
    terminal = timeout.terminal
    if terminal.get("type") != "exit" or terminal.get("code") != 137:
        raise AssertionError(f"timeout did not report exit 137: {terminal!r}")
    if terminal.get("signal") != "SIGKILL" or terminal.get("timedOut") is not True:
        raise AssertionError(f"timeout flags are wrong: {terminal!r}")

    oversized = execute(
        vsock_uds,
        request(
            "output-limit",
            ["/usr/bin/python3", "-c", "import os; exec(\"while True: os.write(1,b'x'*4096)\")"],
            maxOutputBytes=1024,
        ),
    )
    if (
        len(oversized.stdout) != 1024
        or oversized.terminal.get("code") != 137
        or oversized.terminal.get("signal") != "SIGKILL"
        or oversized.terminal.get("timedOut") is not False
        or oversized.terminal.get("outputTruncated") is not True
    ):
        raise AssertionError(
            f"output limit was not exact: bytes={len(oversized.stdout)} terminal={oversized.terminal!r}"
        )

    started = time.monotonic()
    descendant = execute(
        vsock_uds,
        request(
            "setsid",
            [
                "/usr/bin/python3",
                "-c",
                "import subprocess,sys; subprocess.Popen(['/usr/bin/sleep','30'],start_new_session=True,stdout=sys.stdout,stderr=sys.stderr)",
            ],
        ),
    )
    require_exit(descendant)
    if time.monotonic() - started > 3:
        raise AssertionError("setsid descendant retained output pipes; cgroup cleanup did not complete")

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        killed_future = pool.submit(
            execute,
            vsock_uds,
            request("concurrent-timeout", ["/usr/bin/sleep", "2"], timeoutMs=50),
        )
        survivor_future = pool.submit(
            execute,
            vsock_uds,
            request(
                "concurrent-survivor",
                ["/usr/bin/python3", "-c", "import time; time.sleep(.2); print('survived')"],
            ),
        )
        killed = killed_future.result()
        survivor = survivor_future.result()
    if killed.terminal.get("timedOut") is not True:
        raise AssertionError(f"concurrent timeout was not killed: {killed.terminal!r}")
    require_exit(survivor)
    if survivor.stdout.strip() != b"survived":
        raise AssertionError(f"one command's cgroup kill affected another: {survivor!r}")

    print("guest protocol acceptance passed")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vsock-uds", required=True)
    arguments = parser.parse_args()
    run(arguments.vsock_uds)


if __name__ == "__main__":
    main()
