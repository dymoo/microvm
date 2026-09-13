import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http"
import { connect, type Socket } from "node:net"
import { describe, expect, it } from "vitest"
import { guestProtocolService } from "../scripts/http-preview-fixture.mjs"

const CONTRACT_DEADLINE_MS = 2_000
const WEBSOCKET_KEY = "MDEyMzQ1Njc4OWFiY2RlZg=="

// This integration contract exercises a real child process and TCP framing, so
// fake time cannot replace its short outer deadline.
const settleWithin = async <Value>(work: Promise<Value>, label: string): Promise<Value> => {
  const timedOut = Promise.withResolvers<never>()
  const deadline: NodeJS.Timeout = setTimeout(
    () => timedOut.reject(new Error(`${label} exceeded ${CONTRACT_DEADLINE_MS}ms`)),
    CONTRACT_DEADLINE_MS
  )
  try {
    return await Promise.race([work, timedOut.promise])
  } finally {
    clearTimeout(deadline)
  }
}

const reservePort = async (): Promise<number> => {
  const server = createServer()
  const listening = Promise.withResolvers<void>()
  server.once("error", listening.reject)
  server.listen(0, "127.0.0.1", listening.resolve)
  await settleWithin(listening.promise, "port reservation")
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("port reservation has no TCP port")
  const closed = Promise.withResolvers<void>()
  server.close((error) => {
    if (error === undefined) closed.resolve()
    else closed.reject(error)
  })
  await settleWithin(closed.promise, "port reservation close")
  return address.port
}

const connectToFixture = async (port: number): Promise<Socket> => {
  const deadline = Date.now() + CONTRACT_DEADLINE_MS
  while (Date.now() < deadline) {
    const socket = connect({ host: "127.0.0.1", port })
    try {
      await once(socket, "connect")
      return socket
    } catch {
      socket.destroy()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  throw new Error("fixture did not accept a connection")
}

const readThrough = (stream: NodeJS.ReadableStream, marker: Buffer): Promise<Buffer> => {
  const result = Promise.withResolvers<Buffer>()
  let bytes = Buffer.alloc(0)
  const cleanup = () => {
    stream.off("data", onData)
    stream.off("error", onError)
    stream.off("end", onEnd)
  }
  const finish = (error?: Error) => {
    cleanup()
    if (error === undefined) result.resolve(bytes)
    else result.reject(error)
  }
  const onData = (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk])
    if (bytes.includes(marker)) finish()
  }
  const onError = (error: Error) => finish(error)
  const onEnd = () => finish(new Error("fixture stream ended before delimiter"))
  stream.on("data", onData)
  stream.once("error", onError)
  stream.once("end", onEnd)
  return result.promise
}

const stopFixture = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGTERM")
  await settleWithin(exited, "fixture process exit")
}

describe("HTTP preview guest fixture", () => {
  it("emits a valid CRLF WebSocket 101 and newline-framed SSE event", async () => {
    const port = await reservePort()
    const child = spawn(process.execPath, ["-e", guestProtocolService], {
      env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: String(port) },
      stdio: ["pipe", "pipe", "pipe"]
    })
    let websocket: Socket | undefined
    let sseRequest: ClientRequest | undefined
    let sseResponse: IncomingMessage | undefined

    try {
      websocket = await connectToFixture(port)
      websocket.write(
        "GET /ws HTTP/1.1\r\n" +
        "Host: fixture.invalid\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        `Sec-WebSocket-Key: ${WEBSOCKET_KEY}\r\n\r\n`
      )
      const header = await settleWithin(
        readThrough(websocket, Buffer.from("\r\n\r\n")),
        "fixture WebSocket response"
      )
      const lines = header.subarray(0, header.indexOf("\r\n\r\n")).toString("ascii").split("\r\n")
      const expectedAccept = createHash("sha1")
        .update(`${WEBSOCKET_KEY}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64")
      expect(lines[0]).toBe("HTTP/1.1 101 Switching Protocols")
      expect(lines.map((line) => line.toLowerCase())).toContain(`sec-websocket-accept: ${expectedAccept}`.toLowerCase())

      const responseReady = Promise.withResolvers<IncomingMessage>()
      sseRequest = httpRequest({ host: "127.0.0.1", port, path: "/sse", agent: false }, responseReady.resolve)
      sseRequest.once("error", responseReady.reject)
      sseRequest.end()
      sseResponse = await settleWithin(responseReady.promise, "fixture SSE response")
      expect(sseResponse.statusCode).toBe(200)
      const firstEvent = await settleWithin(
        readThrough(sseResponse, Buffer.from("\n\n")),
        "fixture SSE first event"
      )
      expect(firstEvent.toString("utf8")).toBe("data: ready\n\n")
    } finally {
      websocket?.destroy()
      sseResponse?.destroy()
      sseRequest?.destroy()
      await stopFixture(child)
    }
  })
})
