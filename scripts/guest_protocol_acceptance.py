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
