import { Buffer } from "node:buffer"
import { connect, type Socket } from "node:net"
import { Effect, Scope } from "effect"
import {
  GUEST_EXEC_VSOCK_PORT,
  GUEST_HTTP_VSOCK_PORT,
  GUEST_SERVICE_VSOCK_PORT
} from "./protocol.js"

/**
 * Firecracker's host-side vsock UDS protocol acknowledges a CONNECT with an
 * unsigned 32-bit decimal port. The ACK itself is deliberately tiny and is
 * bounded independently of any bytes the guest coalesces after it.
 */
const MAX_ACK_BYTES = "OK 4294967295\n".length
const ACK_PATTERN = /^OK (0|[1-9][0-9]{0,9})\n$/
const MAX_VSOCK_PORT = 0xffff_ffff

type Purpose = "exec" | "http" | "service"

const portFor = (purpose: Purpose): number => {
  switch (purpose) {
    case "exec": return GUEST_EXEC_VSOCK_PORT
    case "http": return GUEST_HTTP_VSOCK_PORT
    case "service": return GUEST_SERVICE_VSOCK_PORT
  }
}

/**
 * Opens one fixed-purpose Firecracker vsock connection. The returned socket is
 * paused. If the ACK and guest payload arrive in one UDS read, payload bytes
 * are put back before the socket is returned so the purpose-specific consumer
 * observes every byte.
 */
const open = (socketPath: string, purpose: Purpose): Effect.Effect<Socket, string, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<Socket, string>((resume, signal) => {
      const socket = connect(socketPath)
      const chunks: Array<Buffer> = []
      let bytes = 0
      let settled = false

      const detach = (): void => {
        socket.off("connect", onConnect)
        socket.off("data", onData)
        socket.off("error", onError)
        socket.off("close", onClose)
      }
      const fail = (reason: string): void => {
        if (settled) return
        settled = true
        detach()
        socket.destroy()
        resume(Effect.fail(reason))
      }
      const succeed = (remainder: Buffer): void => {
        if (settled) return
        settled = true
        socket.pause()
        detach()
        if (remainder.length > 0) socket.unshift(remainder)
        resume(Effect.succeed(socket))
      }
      const onConnect = (): void => {
        socket.write(`CONNECT ${portFor(purpose)}\n`, "utf8")
      }
      const onData = (chunk: Buffer): void => {
        const newline = chunk.indexOf(0x0a)
        if (newline === -1) {
          if (bytes + chunk.length >= MAX_ACK_BYTES) {
            fail("vsock handshake reply too long")
            return
          }
          chunks.push(chunk)
          bytes += chunk.length
          return
        }

        const ackBytes = bytes + newline + 1
        if (ackBytes > MAX_ACK_BYTES) {
          fail("vsock handshake reply too long")
          return
        }
        chunks.push(chunk.subarray(0, newline + 1))
        const ack = Buffer.concat(chunks, ackBytes).toString("utf8")
        const match = ACK_PATTERN.exec(ack)
        if (match === null) {
          fail(`unexpected vsock handshake reply: ${ack.slice(0, MAX_ACK_BYTES)}`)
          return
        }
        const acknowledgedPort = Number(match[1])
        if (!Number.isSafeInteger(acknowledgedPort) || acknowledgedPort > MAX_VSOCK_PORT) {
          fail("vsock handshake port out of range")
          return
        }
        succeed(chunk.subarray(newline + 1))
      }
      const onError = (cause: Error): void => fail(`vsock error: ${String(cause)}`)
      const onClose = (): void => fail("vsock closed during handshake")

      socket.once("connect", onConnect)
      socket.on("data", onData)
      socket.once("error", onError)
      socket.once("close", onClose)
      signal.addEventListener("abort", () => {
        if (settled) return
        settled = true
        detach()
        socket.destroy()
      }, { once: true })
    }),
    (socket) => Effect.sync(() => socket.destroy())
  )

export const openGuestExecSocket = (socketPath: string): Effect.Effect<Socket, string, Scope.Scope> =>
  open(socketPath, "exec")

export const openGuestHttpSocket = (socketPath: string): Effect.Effect<Socket, string, Scope.Scope> =>
  open(socketPath, "http")

export const openGuestServiceSocket = (socketPath: string): Effect.Effect<Socket, string, Scope.Scope> =>
  open(socketPath, "service")
