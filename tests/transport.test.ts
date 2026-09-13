/**
 * Guest exec v1 transport tests: the host side of the protocol is exercised
 * against an in-test UDS peer speaking the guest-runner side of
 * docs/protocol.md. This proves the transport implementation is portable
 * (pure JS over AF_UNIX) without needing Firecracker or Linux.
 */
import { once } from "node:events"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { Effect, Result } from "effect"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type Server, type Socket } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import {
  awaitGuestReadiness,
  encodeGuestServiceStartRequest,
  GuestExecChannel,
  GuestExecChannelLive,
  GuestHttpChannel,
  GuestHttpChannelLive,
  GuestServiceChannel,
  GuestServiceChannelLive,
  GuestServiceError,
  GuestTransportFault,
  type GuestExecSuccess
} from "../src/firecracker.js"
import { MAX_SERVICE_CONTROL_LINE_BYTES } from "../src/protocol.js"

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
  behavior: (socket: Socket, request: unknown) => void,
  acknowledge: (socket: Socket) => void = (socket) => {
    socket.write("OK 1073741824\n")
  }
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
        acknowledge(socket)
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

  it("accepts a fragmented CONNECT acknowledgement", async () => {
    const guest = track(await startFakeGuest((socket) => {
      socket.end(frame({ type: "exit", code: 0, signal: null, timedOut: false, outputTruncated: false }))
    }, (socket) => {
      socket.write("OK 107")
      setImmediate(() => socket.write("3741824\n"))
    }))
    const result = await runExec(guest.path) as Extract<GuestExecSuccess, { _tag: "Exit" }>
    expect(result.frame.code).toBe(0)
  })

  it("preserves a terminal frame coalesced after the CONNECT acknowledgement", async () => {
    const terminal = frame({
      type: "exit",
      code: 23,
      signal: null,
      timedOut: false,
      outputTruncated: false
    })
    const guest = track(await startFakeGuest(() => undefined, (socket) => {
      socket.write(`OK 1073741824\n${terminal}`)
    }))
    const result = await runExec(guest.path) as Extract<GuestExecSuccess, { _tag: "Exit" }>
    expect(result.frame.code).toBe(23)
  })

  it("maps HTTP and service APIs to their fixed vsock purposes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mvm-test-"))
    const path = join(dir, "v.sock")
    const connects: Array<string> = []
    let serviceRequest: Record<string, unknown> | undefined
    const server = createServer((socket) => {
      let buffer = ""
      let connected = false
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8")
        const newline = buffer.indexOf("\n")
        if (newline === -1) return
        if (!connected) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          connects.push(line)
          connected = true
          socket.write("OK 1073741824\n")
          if (line === "CONNECT 1025") return
        }
        const requestEnd = buffer.indexOf("\n")
        if (requestEnd === -1) return
        serviceRequest = JSON.parse(buffer.slice(0, requestEnd)) as Record<string, unknown>
        socket.end(`${JSON.stringify({
          version: 1,
          id: serviceRequest["id"],
          type: "status",
          state: "exited",
          startedAtEpochMs: 42,
          exitCode: 0
        })}\n`)
      })
    })
    server.listen(path)
    await started(server)
    track({
      path,
      cleanup: async () => {
        server.close()
        await closed(server)
        await rm(dir, { recursive: true, force: true })
      }
    })

    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const http = yield* GuestHttpChannel
        yield* http.open({ vmId: "mvm-test0001", vsockSocket: path })
      })).pipe(Effect.provide(GuestHttpChannelLive))
    )
    const state = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* GuestServiceChannel
        return yield* service.status({
          vmId: "mvm-test0001",
          vsockSocket: path,
          requestId: "service-1"
        })
      }).pipe(Effect.provide(GuestServiceChannelLive))
    )

    expect(connects).toEqual(["CONNECT 1025", "CONNECT 1026"])
    expect(serviceRequest).toMatchObject({ version: 1, id: "service-1", op: "status" })
    expect(state).toEqual({ state: "exited", startedAtEpochMs: 42, exitCode: 0, signal: null })
  })

  it("requires all three fixed listeners for web-enabled boot readiness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mvm-test-"))
    const path = join(dir, "v.sock")
    const connects: Array<string> = []
    const server = createServer((socket) => {
      let buffer = ""
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8")
        const newline = buffer.indexOf("\n")
        if (newline === -1) return
        connects.push(buffer.slice(0, newline))
        socket.end("OK 1073741824\n")
      })
    })
    server.listen(path)
    await started(server)
    track({
      path,
      cleanup: async () => {
        server.close()
        await closed(server)
        await rm(dir, { recursive: true, force: true })
      }
    })

    await Effect.runPromise(awaitGuestReadiness("mvm-test0001", path, 1_000, true))
    expect(connects).toEqual(["CONNECT 1024", "CONNECT 1025", "CONNECT 1026"])
  })

  it("rejects a CONNECT acknowledgement outside the vsock port range", async () => {
    const guest = track(await startFakeGuest(() => undefined, (socket) => {
      socket.end("OK 4294967296\n")
    }))
    await expect(runExec(guest.path)).rejects.toBeInstanceOf(GuestTransportFault)
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

  it("sends a protocol-valid service start whose JSON line exceeds 64 KiB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mvm-test-"))
    const path = join(dir, "v.sock")
    let receivedBytes = 0
    const server = createServer((socket) => {
      let buffer = Buffer.alloc(0)
      let connected = false
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        const newline = buffer.indexOf(0x0a)
        if (newline === -1) return
        if (!connected) {
          expect(buffer.subarray(0, newline).toString("ascii")).toBe("CONNECT 1026")
          buffer = buffer.subarray(newline + 1)
          connected = true
          socket.write("OK 1073741824\n")
          return
        }
        const request = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as Record<string, unknown>
        receivedBytes = newline
        socket.end(`${JSON.stringify({
          version: 1,
          id: request["id"],
          type: "started",
          startedAtEpochMs: 42
        })}\n`)
      })
    })
    server.listen(path)
    await started(server)
    const guest = track({
      path,
      cleanup: async () => {
        server.close()
        await closed(server)
        await rm(dir, { recursive: true, force: true })
      }
    })

    const state = await Effect.runPromise(
      Effect.gen(function*() {
        const requestId = "large-start"
        const request = yield* encodeGuestServiceStartRequest({
          vmId: "mvm-test0001",
          requestId,
          argv: ["/usr/bin/node", ...Array.from({ length: 16 }, () => "x".repeat(4_000))],
          env: { BIG: "y".repeat(8_192) },
          webPort: 3_000
        })
        const service = yield* GuestServiceChannel
        return yield* service.start({
          vmId: "mvm-test0001",
          vsockSocket: guest.path,
          request
        })
      }).pipe(Effect.provide(GuestServiceChannelLive))
    )

    expect(receivedBytes).toBeGreaterThan(64 * 1024)
    expect(state).toEqual({ state: "running", startedAtEpochMs: 42 })
  })

  it("correlates a start response to its encoded identity without a second caller-supplied id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mvm-test-"))
    const path = join(dir, "v.sock")
    let exchanges = 0
    const server = createServer((socket) => {
      let buffer = ""
      let connected = false
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8")
        const newline = buffer.indexOf("\n")
        if (newline === -1) return
        if (!connected) {
          buffer = buffer.slice(newline + 1)
          connected = true
          socket.write("OK 1073741824\n")
          return
        }
        const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        exchanges++
        socket.end(`${JSON.stringify({
          version: 1,
          id: exchanges === 1 ? request["id"] : "different-id",
          type: "started",
          startedAtEpochMs: 42
        })}\n`)
      })
    })
    server.listen(path)
    await started(server)
    const guest = track({
      path,
      cleanup: async () => {
        server.close()
        await closed(server)
        await rm(dir, { recursive: true, force: true })
      }
    })
    const runStart = (requestId: string) =>
      Effect.gen(function*() {
        const request = yield* encodeGuestServiceStartRequest({
          vmId: "mvm-test0001",
          requestId,
          argv: ["/bin/true"],
          webPort: 3_000
        })
        const service = yield* GuestServiceChannel
        return yield* service.start({
          vmId: "mvm-test0001",
          vsockSocket: guest.path,
          request
        })
      }).pipe(Effect.provide(GuestServiceChannelLive))

    await expect(Effect.runPromise(runStart("encoded-start-id"))).resolves.toEqual({
      state: "running",
      startedAtEpochMs: 42
    })
    const mismatch = await Effect.runPromise(Effect.result(runStart("second-encoded-start-id")))
    expect(Result.isFailure(mismatch) && mismatch.failure).toMatchObject({
      _tag: "GuestTransportFault",
      reason: "guest service response id mismatch"
    })
  })

  it("preserves a well-formed guest INTERNAL response as a service failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mvm-test-"))
    const path = join(dir, "v.sock")
    const server = createServer((socket) => {
      let buffer = ""
      let connected = false
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8")
        const newline = buffer.indexOf("\n")
        if (newline === -1) return
        if (!connected) {
          buffer = buffer.slice(newline + 1)
          connected = true
          socket.write("OK 1073741824\n")
          return
        }
        const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        socket.end(`${JSON.stringify({
          version: 1,
          id: request["id"],
          type: "error",
          code: "INTERNAL",
          message: "could not stop web service"
        })}\n`)
      })
    })
    server.listen(path)
    await started(server)
    const guest = track({
      path,
      cleanup: async () => {
        server.close()
        await closed(server)
        await rm(dir, { recursive: true, force: true })
      }
    })

    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* GuestServiceChannel
        return yield* service.stop({
          vmId: "mvm-test0001",
          vsockSocket: guest.path,
          requestId: "internal-stop"
        })
      }).pipe(Effect.provide(GuestServiceChannelLive), Effect.flip)
    )

    expect(failure).toBeInstanceOf(GuestServiceError)
    expect(failure).toMatchObject({
      code: "INTERNAL",
      message: "could not stop web service"
    })
  })

  it("accepts the maximum service request line and rejects one byte over before opening a channel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mvm-test-"))
    const path = join(dir, "v.sock")
    let accepted = 0
    const server = createServer((socket) => {
      accepted++
      let buffer = Buffer.alloc(0)
      let connected = false
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        const newline = buffer.indexOf(0x0a)
        if (newline === -1) return
        if (!connected) {
          buffer = buffer.subarray(newline + 1)
          connected = true
          socket.write("OK 1073741824\n")
          return
        }
        const request = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as Record<string, unknown>
        socket.end(`${JSON.stringify({
          version: 1,
          id: request["id"],
          type: "started",
          startedAtEpochMs: 42
        })}\n`)
      })
    })
    server.listen(path)
    await started(server)
    const guest = track({
      path,
      cleanup: async () => {
        server.close()
        await closed(server)
        await rm(dir, { recursive: true, force: true })
      }
    })
    const requestId = "wire-bound"
    const baseLineBytes = Buffer.byteLength(JSON.stringify({
      version: 1,
      id: requestId,
      op: "start",
      argv: [""],
      port: 3_000
    }) + "\n")
    const maximumArgument = "x".repeat(MAX_SERVICE_CONTROL_LINE_BYTES + 1 - baseLineBytes)
    const runStart = (argument: string) =>
      Effect.gen(function*() {
        const request = yield* encodeGuestServiceStartRequest({
          vmId: "mvm-test0001",
          requestId,
          argv: [argument],
          webPort: 3_000
        })
        const service = yield* GuestServiceChannel
        return yield* service.start({
          vmId: "mvm-test0001",
          vsockSocket: guest.path,
          request
        })
      }).pipe(Effect.provide(GuestServiceChannelLive))

    expect(await Effect.runPromise(runStart(maximumArgument))).toEqual({
      state: "running",
      startedAtEpochMs: 42
    })
    const rejected = await Effect.runPromise(Effect.result(runStart(`${maximumArgument}x`)))
    expect(Result.isFailure(rejected) && rejected.failure).toBeInstanceOf(GuestServiceError)
    expect(Result.isFailure(rejected) && rejected.failure).toMatchObject({ code: "INVALID_REQUEST" })
    expect(accepted).toBe(1)
  })

  it("accepts the maximum guest service response line and faults one byte over", async () => {
    const requestId = "reply-bound"
    const baseResponse = {
      version: 1,
      id: requestId,
      type: "error",
      code: "INTERNAL",
      message: ""
    }
    const baseResponseBytes = Buffer.byteLength(JSON.stringify(baseResponse))
    const maximumMessage = "x".repeat(MAX_SERVICE_CONTROL_LINE_BYTES - baseResponseBytes)
    const maximumResponse = `${JSON.stringify({ ...baseResponse, message: maximumMessage })}\n`
    const oversizedResponse = `${JSON.stringify({ ...baseResponse, message: `${maximumMessage}x` })}\n`
    expect(Buffer.byteLength(maximumResponse)).toBe(MAX_SERVICE_CONTROL_LINE_BYTES + 1)
    expect(Buffer.byteLength(oversizedResponse)).toBe(MAX_SERVICE_CONTROL_LINE_BYTES + 2)

    const dir = mkdtempSync(join(tmpdir(), "mvm-test-"))
    const path = join(dir, "v.sock")
    let accepted = 0
    const server = createServer((socket) => {
      accepted++
      let buffer = ""
      let connected = false
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8")
        const newline = buffer.indexOf("\n")
        if (newline === -1) return
        if (!connected) {
          buffer = buffer.slice(newline + 1)
          connected = true
          socket.write("OK 1073741824\n")
          return
        }
        socket.end(accepted === 1 ? maximumResponse : oversizedResponse)
      })
    })
    server.listen(path)
    await started(server)
    const guest = track({
      path,
      cleanup: async () => {
        server.close()
        await closed(server)
        await rm(dir, { recursive: true, force: true })
      }
    })
    const runStatus = Effect.gen(function*() {
      const service = yield* GuestServiceChannel
      return yield* service.status({
        vmId: "mvm-test0001",
        vsockSocket: guest.path,
        requestId
      })
    }).pipe(Effect.provide(GuestServiceChannelLive))

    const maximum = await Effect.runPromise(Effect.result(runStatus))
    expect(Result.isFailure(maximum) && maximum.failure).toMatchObject({
      _tag: "GuestServiceError",
      code: "INTERNAL"
    })
    const oversized = await Effect.runPromise(Effect.result(runStatus))
    expect(Result.isFailure(oversized) && oversized.failure).toMatchObject({
      _tag: "GuestTransportFault",
      reason: "guest service response exceeded maximum line size"
    })
  })

  it("returns a typed rejection when a service request cannot be JSON-encoded", async () => {
    const env = new Proxy<Record<string, string>>({}, {
      ownKeys: () => {
        throw new Error("hostile property enumeration")
      }
    })
    const rejected = await Effect.runPromise(
      Effect.gen(function*() {
        const requestId = "unencodable"
        const request = yield* encodeGuestServiceStartRequest({
          vmId: "mvm-test0001",
          requestId,
          argv: ["/bin/true"],
          env,
          webPort: 3_000
        })
        const service = yield* GuestServiceChannel
        return yield* service.start({
          vmId: "mvm-test0001",
          vsockSocket: join(tmpdir(), "service-must-not-open.sock"),
          request
        })
      }).pipe(Effect.provide(GuestServiceChannelLive), Effect.flip)
    )

    expect(rejected).toMatchObject({
      _tag: "GuestServiceError",
      code: "INVALID_REQUEST"
    })
  })
})

/**
 * Every channel opens before the protocol above it can bound anything, so a
 * guest that accepts a connection and then stops answering must fault the
 * caller instead of suspending it. These drive the real UDS seam.
 */
describe("bounded fixed-purpose opens", () => {
  const cleanupFns: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      await cleanupFns.pop()?.()
    }
  })

  const startSilentGuest = async (acknowledge: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "mvm-test-"))
    const path = join(dir, "v.sock")
    const accepted = Promise.withResolvers<Socket>()
    const connections: Array<Socket> = []
    const server = createServer((socket) => {
      connections.push(socket)
      accepted.resolve(socket)
      socket.on("error", () => undefined)
      // Read so the peer's teardown is observable as a close on this side.
      socket.resume()
      if (acknowledge) socket.write("OK 1073741824\n")
    })
    server.listen(path)
    await started(server)
    cleanupFns.push(async () => {
      for (const connection of connections) connection.destroy()
      server.close()
      await closed(server)
      await rm(dir, { recursive: true, force: true })
    })
    return { path, accepted: accepted.promise }
  }

  it("interrupts a pending CONNECT handshake, settles, and destroys the connection", async () => {
    const guest = await startSilentGuest(false)
    const opening = Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const channel = yield* GuestHttpChannel
        return yield* channel.open({ vmId: "mvm-test0001", vsockSocket: guest.path })
      })).pipe(
        Effect.provide(GuestHttpChannelLive),
        Effect.timeout({ milliseconds: 250 }),
        Effect.exit
      )
    )
    const connection = await guest.accepted
    const connectionClosed = once(connection, "close")
    // The red loop for this fix: while the handshake suspended inside an
    // uninterruptible acquisition, this interrupt never settled at all.
    expect((await opening)._tag).toBe("Failure")
    await connectionClosed
    expect(connection.destroyed).toBe(true)
  })

  it("fails a silent CONNECT handshake with the bounded handshake deadline", async () => {
    // The deadline is armed against the platform clock inside the opener, and
    // the peer is a real socket, so fake timers cannot drive this.
    const guest = await startSilentGuest(false)
    const startedAt = Date.now()
    const fault = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const channel = yield* GuestHttpChannel
        return yield* channel.open({ vmId: "mvm-test0001", vsockSocket: guest.path })
      })).pipe(Effect.provide(GuestHttpChannelLive), Effect.flip)
    )
    const elapsed = Date.now() - startedAt
    expect(fault._tag).toBe("GuestTransportFault")
    expect(fault.reason).toContain("vsock handshake acknowledgement deadline exceeded")
    expect(elapsed).toBeGreaterThanOrEqual(4_500)
    expect(elapsed).toBeLessThan(10_000)
  }, 20_000)

  it("fails an acknowledged but silent service-control reply with the caller deadline", async () => {
    const guest = await startSilentGuest(true)
    const fault = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* GuestServiceChannel
        return yield* service.status({
          vmId: "mvm-test0001",
          vsockSocket: guest.path,
          requestId: "deadline-1",
          deadlineMs: 250
        })
      }).pipe(Effect.provide(GuestServiceChannelLive), Effect.flip)
    )
    expect(fault._tag).toBe("GuestTransportFault")
    expect(fault.reason).toBe("guest service response deadline exceeded")
  }, 15_000)
})
