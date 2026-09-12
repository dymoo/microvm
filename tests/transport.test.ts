/**
 * Guest exec v1 transport tests: the host side of the protocol is exercised
 * against an in-test UDS peer speaking the guest-runner side of
 * docs/protocol.md. This proves the transport implementation is portable
 * (pure JS over AF_UNIX) without needing Firecracker or Linux.
 */
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { Effect } from "effect"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type Server, type Socket } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { GuestExecChannel, GuestExecChannelLive, GuestTransportFault, type GuestExecSuccess } from "../src/firecracker.js"

interface FakeGuest {
  readonly path: string
  readonly cleanup: () => Promise<void>
}

const started = (server: Server): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  server.once("listening", resolve)
  return promise
}

const closed = (server: Server): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  server.once("close", resolve)
  return promise
}

const startFakeGuest = (
  behavior: (socket: Socket, request: unknown) => void
): Promise<FakeGuest> => {
  const dir = mkdtempSync(join(tmpdir(), "mvm-test-"))
  const path = join(dir, "v.sock")
  const server: Server = createServer((socket) => {
    let buffer = ""
    let acked = false
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      if (!acked) {
        const index = buffer.indexOf("\n")
        if (index === -1) return
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line !== "CONNECT 1024") {
          socket.destroy()
          return
        }
        socket.write("OK 1073741824\n")
        acked = true
      }
      const index = buffer.indexOf("\n")
      if (index === -1) return
      behavior(socket, JSON.parse(buffer.slice(0, index)))
    })
  })
  server.listen(path)
  return started(server).then(() => ({
    path,
    cleanup: async () => {
      server.close()
      await closed(server)
      await rm(dir, { recursive: true, force: true })
    }
  }))
}

const runExec = (path: string, overrides: Record<string, unknown> = {}) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const channel = yield* GuestExecChannel
      return yield* channel.exec({
        vmId: "mvm-test0001",
        vsockSocket: path,
        execId: "exec-1",
        argv: ["/usr/bin/node", "--version"],
        limits: { timeoutMs: 5_000, maxOutputBytesPerStream: 1_048_576 },
        ...overrides
      })
    }).pipe(Effect.provide(GuestExecChannelLive))
  )

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64")
const frame = (payload: Record<string, unknown>): string => `${JSON.stringify({ version: 1, id: "exec-1", ...payload })}\n`

describe("guest exec v1 channel", () => {
  const cleanupFns: Array<() => Promise<void>> = []
  const track = (guest: FakeGuest): FakeGuest => {
    cleanupFns.push(guest.cleanup)
    return guest
  }

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      await cleanupFns.pop()?.()
    }
  })

  it("completes a happy-path exec: handshake, request, framed output, terminal exit", async () => {
    const guest = track(await startFakeGuest((socket, request) => {
      expect(request).toMatchObject({
        version: 1,
        id: "exec-1",
        argv: ["/usr/bin/node", "--version"],
        timeoutMs: 5000
      })
      socket.write(frame({ seq: 0, type: "stdout", data: b64("v22.1.0\n") }))
      socket.write(frame({ seq: 0, type: "stderr", data: b64("warn") }))
      socket.write(frame({ seq: 1, type: "stdout", data: b64("more") }))
      socket.end(frame({ type: "exit", code: 0, signal: null, timedOut: false, outputTruncated: false }))
    }))
    const result = await runExec(guest.path) as Extract<GuestExecSuccess, { _tag: "Exit" }>
    expect(result.frame.code).toBe(0)
    expect(result.frame.stdout.toString("utf8")).toBe("v22.1.0\nmore")
    expect(result.frame.stderr.toString("utf8")).toBe("warn")
    expect(result.frame.timedOut).toBe(false)
    expect(result.frame.outputTruncated).toBe(false)
  })

  it("reports guest error frames for pre-exec rejections", async () => {
    const guest = track(await startFakeGuest((socket) => {
      socket.end(frame({ type: "error", code: "INVALID_REQUEST", message: "cwd not absolute" }))
    }))
    const result = await runExec(guest.path)
    expect(result).toMatchObject({ _tag: "GuestError", code: "INVALID_REQUEST" })
  })

  it("marks timeout kills from the guest as timed-out exits", async () => {
    const guest = track(await startFakeGuest((socket) => {
      socket.end(frame({ type: "exit", code: 137, signal: "SIGKILL", timedOut: true, outputTruncated: false }))
    }))
    const result = await runExec(guest.path) as Extract<GuestExecSuccess, { _tag: "Exit" }>
    expect(result.frame.timedOut).toBe(true)
    expect(result.frame.code).toBe(137)
    expect(result.frame.signal).toBe("SIGKILL")
  })

  it("faults with a transport error on EOF before a terminal frame", async () => {
    const guest = track(await startFakeGuest((socket) => {
      socket.write(frame({ seq: 0, type: "stdout", data: b64("partial") }))
      socket.end()
    }))
    await expect(runExec(guest.path)).rejects.toBeInstanceOf(GuestTransportFault)
  })

  it("faults on out-of-order seq", async () => {
    const guest = track(await startFakeGuest((socket) => {
      socket.write(frame({ seq: 1, type: "stdout", data: b64("skipped") }))
    }))
    await expect(runExec(guest.path)).rejects.toBeInstanceOf(GuestTransportFault)
  })

  it("faults on non-strict base64 payloads", async () => {
    const guest = track(await startFakeGuest((socket) => {
      socket.write(frame({ seq: 0, type: "stdout", data: "not!valid@base64" }))
    }))
    await expect(runExec(guest.path)).rejects.toBeInstanceOf(GuestTransportFault)
  })

  it("faults when the guest exceeds the negotiated per-stream cap", async () => {
    const guest = track(await startFakeGuest((socket, request) => {
      const cap = (request as { maxOutputBytes: number }).maxOutputBytes
      const payload = Buffer.alloc(cap + 1, 97).toString("base64")
      socket.write(frame({ seq: 0, type: "stdout", data: payload }))
    }))
    await expect(
      runExec(guest.path, { limits: { timeoutMs: 5_000, maxOutputBytesPerStream: 1024 } })
    ).rejects.toBeInstanceOf(GuestTransportFault)
  })

  it("faults on malformed JSON lines", async () => {
    const guest = track(await startFakeGuest((socket) => {
      socket.write("this is not json\n")
    }))
    await expect(runExec(guest.path)).rejects.toBeInstanceOf(GuestTransportFault)
  })

  it("faults on frames with a mismatched exec id", async () => {
    const guest = track(await startFakeGuest((socket) => {
      socket.write(`${JSON.stringify({ version: 1, id: "other-exec", seq: 0, type: "stdout", data: b64("x") })}\n`)
    }))
    await expect(runExec(guest.path)).rejects.toBeInstanceOf(GuestTransportFault)
  })

  it("faults on a bad CONNECT handshake", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mvm-test-"))
    const path = join(dir, "v.sock")
    const server = createServer((socket) => {
      socket.once("data", () => socket.end("ERR nope\n"))
    })
    server.listen(path)
    await started(server)
    const guest: FakeGuest = track({
      path,
      cleanup: async () => {
        server.close()
        await closed(server)
        await rm(dir, { recursive: true, force: true })
      }
    })
    await expect(runExec(guest.path)).rejects.toBeInstanceOf(GuestTransportFault)
  })
})
