import { createHash } from "node:crypto"
import {
  STATUS_CODES,
  request as httpRequest,
  validateHeaderName,
  validateHeaderValue,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type RequestListener,
  type ServerResponse
} from "node:http"
import { request as httpsRequest } from "node:https"
import { Transform, type Duplex, type TransformCallback } from "node:stream"
import { HTTP_PREVIEW_LIMITS } from "./protocol.js"

/** A coalesced upgrade `head` larger than one framed stream buffer is refused. */
const MAX_UPGRADE_HEAD_BYTES = HTTP_PREVIEW_LIMITS.frameBufferBytes
/** Inbound bytes one refusal absorbs before it stops reading the socket. */
const REFUSAL_DRAIN_BYTES = 64 * 1024
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const HOP_BY_HOP: Readonly<Record<string, true>> = {
  connection: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  "proxy-connection": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true
}

const UNTRUSTED_FORWARDING: Readonly<Record<string, true>> = {
  forwarded: true,
  "x-forwarded-for": true,
  "x-forwarded-host": true,
  "x-forwarded-port": true,
  "x-forwarded-proto": true
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const WEBSOCKET_KEY = /^[A-Za-z0-9+/]{22}==$/

class WebSocketFrameValidator extends Transform {
  readonly #expectMasked: boolean
  readonly #header = Buffer.allocUnsafe(14)
  #headerBytes = 0
  #requiredHeaderBytes = 2
  #payloadBytesRemaining = 0
  #fragmentedMessageBytes: number | undefined
  #sawClose = false

  constructor(expectMasked: boolean) {
    super({
      readableHighWaterMark: HTTP_PREVIEW_LIMITS.frameBufferBytes,
      writableHighWaterMark: HTTP_PREVIEW_LIMITS.frameBufferBytes
    })
    this.#expectMasked = expectMasked
  }

  #admitFrame(opcode: number, final: boolean, payloadBytes: number): void {
    if (this.#sawClose) throw new Error("WebSocket frame followed close")
    switch (opcode) {
      case 0: {
        if (this.#fragmentedMessageBytes === undefined) {
          throw new Error("WebSocket continuation without fragmented message")
        }
        const aggregate = this.#fragmentedMessageBytes + payloadBytes
        if (aggregate > HTTP_PREVIEW_LIMITS.maxWebSocketMessageBytes) throw new Error("WebSocket message exceeds limit")
        this.#fragmentedMessageBytes = final ? undefined : aggregate
        return
      }
      case 1:
      case 2:
        if (this.#fragmentedMessageBytes !== undefined) {
          throw new Error("WebSocket data frame interrupted fragmented message")
        }
        if (payloadBytes > HTTP_PREVIEW_LIMITS.maxWebSocketMessageBytes) throw new Error("WebSocket message exceeds limit")
        if (!final) this.#fragmentedMessageBytes = payloadBytes
        return
      case 8:
      case 9:
      case 10:
        if (!final || payloadBytes > 125 || (opcode === 8 && payloadBytes === 1)) {
          throw new Error("invalid WebSocket control frame")
        }
        if (opcode === 8) this.#sawClose = true
        return
      default:
        throw new Error("reserved WebSocket opcode")
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    let offset = 0
    try {
      while (offset < chunk.byteLength) {
        if (this.#payloadBytesRemaining > 0) {
          const available = Math.min(this.#payloadBytesRemaining, chunk.byteLength - offset)
          this.push(chunk.subarray(offset, offset + available))
          this.#payloadBytesRemaining -= available
          offset += available
          continue
        }

        const headerBytes = Math.min(this.#requiredHeaderBytes - this.#headerBytes, chunk.byteLength - offset)
        chunk.copy(this.#header, this.#headerBytes, offset, offset + headerBytes)
        this.#headerBytes += headerBytes
        offset += headerBytes
        if (this.#headerBytes < this.#requiredHeaderBytes) continue

        if (this.#requiredHeaderBytes === 2) {
          const first = this.#header[0]!
          const second = this.#header[1]!
          if ((first & 0x70) !== 0) throw new Error("WebSocket RSV bits are unsupported")
          if (((second & 0x80) !== 0) !== this.#expectMasked) {
            throw new Error("invalid WebSocket masking direction")
          }
          const lengthMarker = second & 0x7f
          const extendedLengthBytes = lengthMarker === 126 ? 2 : lengthMarker === 127 ? 8 : 0
          this.#requiredHeaderBytes = 2 + extendedLengthBytes + (this.#expectMasked ? 4 : 0)
          if (this.#headerBytes < this.#requiredHeaderBytes) continue
        }

        const first = this.#header[0]!
        const lengthMarker = this.#header[1]! & 0x7f
        let payloadBytes: number
        if (lengthMarker < 126) {
          payloadBytes = lengthMarker
        } else if (lengthMarker === 126) {
          payloadBytes = this.#header.readUInt16BE(2)
          if (payloadBytes < 126) throw new Error("non-canonical WebSocket payload length")
        } else {
          const extended = this.#header.readBigUInt64BE(2)
          if (extended <= 65_535n || extended > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error("invalid WebSocket payload length")
          }
          payloadBytes = Number(extended)
        }

        this.#admitFrame(first & 0x0f, (first & 0x80) !== 0, payloadBytes)
        this.push(Buffer.from(this.#header.subarray(0, this.#requiredHeaderBytes)))
        this.#headerBytes = 0
        this.#requiredHeaderBytes = 2
        this.#payloadBytesRemaining = payloadBytes
      }
      callback()
    } catch (cause) {
      callback(cause instanceof Error ? cause : new Error("invalid WebSocket frame"))
    }
  }

  override _flush(callback: TransformCallback): void {
    callback(this.#headerBytes === 0 && this.#payloadBytesRemaining === 0
      ? undefined
      : new Error("truncated WebSocket frame"))
  }
}

export interface SandboxHttpProxy {
  /** Proxies one ordinary HTTP request. The handler owns the response through completion. */
  readonly handleRequest: RequestListener
  /** Proxies a validated WebSocket upgrade without exposing either upstream socket. */
  readonly handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  /**
   * Refuses a CONNECT tunnel with one bounded HTTP response, then closes the
   * socket. Node routes CONNECT to the server's `connect` event and never to
   * `request`, and with no `connect` listener it closes the socket without any
   * response at all, so a host MUST wire this:
   * `server.on("connect", proxy.handleConnect)`. No tunnel is opened and no
   * caller ever receives a guest socket.
   */
  readonly handleConnect: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  /**
   * Refuses `Expect: 100-continue` through the same admission as
   * {@link handleRequest}, without ever writing an interim `100 Continue`. Node
   * answers an unwired expectation itself — it writes the interim response and
   * then emits `request` — which invites a body this adapter refuses, so a host
   * MUST wire this: `server.on("checkContinue", proxy.handleCheckContinue)`.
   */
  readonly handleCheckContinue: RequestListener
}

interface SandboxHttpProxyBinding {
  readonly daemonOrigin: URL
  readonly vmId: string
  readonly httpIngressToken: string
  readonly ca?: string | undefined
}

interface HeaderBag {
  readonly values: ReadonlyMap<string, ReadonlyArray<string>>
  readonly connectionTokens: ReadonlySet<string>
}

interface RequestAdmission {
  readonly target: string
  readonly headers: OutgoingHttpHeaders
  readonly hasBody: boolean
}

const headerValues = (headers: HeaderBag, name: string): ReadonlyArray<string> =>
  headers.values.get(name) ?? []

const parseTokens = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  values.flatMap((value) => value.split(",")).map((value) => value.trim().toLowerCase()).filter(Boolean)

const collectHeaders = (rawHeaders: ReadonlyArray<string>): HeaderBag | undefined => {
  if (rawHeaders.length % 2 !== 0 || rawHeaders.length / 2 > HTTP_PREVIEW_LIMITS.maxHeaderFields) return undefined
  let bytes = 0
  const mutable = new Map<string, Array<string>>()
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!
    const value = rawHeaders[index + 1]!
    bytes += Buffer.byteLength(name, "latin1") + Buffer.byteLength(value, "latin1") + 4
    if (bytes > HTTP_PREVIEW_LIMITS.maxHeaderBytes) return undefined
    try {
      validateHeaderName(name)
      validateHeaderValue(name, value)
    } catch {
      return undefined
    }
    const lower = name.toLowerCase()
    const existing = mutable.get(lower)
    if (existing === undefined) mutable.set(lower, [value])
    else existing.push(value)
  }
  const connectionTokens = new Set(parseTokens(mutable.get("connection") ?? []))
  return { values: mutable, connectionTokens }
}

const isStrippedHeader = (name: string, connectionTokens: ReadonlySet<string>): boolean =>
  name === "host" ||
  HOP_BY_HOP[name] === true ||
  connectionTokens.has(name) ||
  UNTRUSTED_FORWARDING[name] === true ||
  name.startsWith("x-forwarded-") ||
  name.startsWith("proxy-")

const filteredHeaders = (headers: HeaderBag): OutgoingHttpHeaders => {
  const outgoing: OutgoingHttpHeaders = {}
  for (const [name, values] of headers.values) {
    if (isStrippedHeader(name, headers.connectionTokens)) continue
    outgoing[name] = values.length === 1 ? values[0] : [...values]
  }
  return outgoing
}

const targetIsOriginForm = (target: string): boolean =>
  target.length > 0 &&
  target.startsWith("/") &&
  !target.startsWith("//") &&
  Buffer.byteLength(target, "utf8") <= HTTP_PREVIEW_LIMITS.maxTargetBytes &&
  !target.includes("#") &&
  !target.includes("\\") &&
  !/[\u0000-\u0020\u007f]/.test(target)

const contentLength = (headers: HeaderBag): number | undefined | false => {
  const values = headerValues(headers, "content-length")
  if (values.length === 0) return undefined
  if (values.length !== 1 || !/^(?:0|[1-9][0-9]*)$/.test(values[0]!)) return false
  const parsed = Number(values[0])
  return Number.isSafeInteger(parsed) ? parsed : false
}

const hasReservedHeader = (headers: HeaderBag): boolean => {
  for (const name of headers.values.keys()) {
    if (name.startsWith("microvm-")) return true
  }
  return false
}

const admitOrdinaryRequest = (request: IncomingMessage): RequestAdmission | { readonly status: number } => {
  const method = request.method?.toUpperCase()
  if (method === "CONNECT" || method === "TRACE") return { status: 405 }
  const target = request.url
  if (target === undefined || !targetIsOriginForm(target)) return { status: 400 }
  const headers = collectHeaders(request.rawHeaders)
  if (headers === undefined || hasReservedHeader(headers)) return { status: 400 }
  if (headerValues(headers, "expect").length > 0 || headerValues(headers, "trailer").length > 0) {
    return { status: 400 }
  }
  if (headerValues(headers, "upgrade").length > 0 || headers.connectionTokens.has("upgrade")) {
    return { status: 426 }
  }
  const lengths = headerValues(headers, "content-length")
  const encodings = headerValues(headers, "transfer-encoding")
  if (lengths.length > 0 && encodings.length > 0) return { status: 400 }
  if (encodings.length > 0 && (encodings.length !== 1 || parseTokens(encodings).join(",") !== "chunked")) {
    return { status: 400 }
  }
  const declaredBodyBytes = contentLength(headers)
  if (declaredBodyBytes === false) return { status: 400 }
  if (declaredBodyBytes !== undefined && declaredBodyBytes > HTTP_PREVIEW_LIMITS.maxRequestBodyBytes) return { status: 413 }
  if (headerValues(headers, "authorization").length > 1) return { status: 400 }
  return {
    target,
    headers: filteredHeaders(headers),
    hasBody: encodings.length > 0 || (declaredBodyBytes ?? 0) > 0
  }
}

const responseHeaders = (response: IncomingMessage): OutgoingHttpHeaders | undefined => {
  const collected = collectHeaders(response.rawHeaders)
  if (collected === undefined || hasReservedHeader(collected)) return undefined
  return filteredHeaders(collected)
}

/**
 * Sends one bounded error response. `close` ends the connection after it
 * flushes, which is required whenever the request body was never invited or
 * read: the connection must not be reusable for bytes nobody validated.
 */
const sendError = (response: ServerResponse, status: number, close = false): void => {
  if (response.headersSent || response.destroyed) {
    response.destroy()
    return
  }
  const body = Buffer.from(`${STATUS_CODES[status] ?? "Proxy Error"}\n`, "utf8")
  response.writeHead(status, {
    "cache-control": "no-store",
    ...(close ? { connection: "close" } : {}),
    "content-length": body.byteLength,
    "content-type": "text/plain; charset=utf-8"
  })
  response.end(body)
}

/**
 * Answers a request Node delivered on a detached raw socket (a CONNECT, or an
 * upgrade the adapter refuses) with one final status line and closes it. The
 * client's bytes after the head are drained and dropped, never read into a
 * tunnel and never forwarded; the socket still dies at a fixed bound if the
 * peer neither closes nor stops sending.
 */
const socketError = (socket: Duplex, status: number): void => {
  if (socket.destroyed) return
  const reason = STATUS_CODES[status] ?? "Proxy Error"
  const body = Buffer.from(`${reason}\n`, "utf8")
  const head = Buffer.from(
    `HTTP/1.1 ${status} ${reason}\r\n` +
    "Cache-Control: no-store\r\n" +
    "Connection: close\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${body.byteLength}\r\n\r\n`,
    "latin1"
  )
  let drained = 0
  const ignore = (chunk: Buffer): void => {
    drained += chunk.byteLength
    if (drained >= REFUSAL_DRAIN_BYTES) socket.pause()
  }
  const deadline = setTimeout(() => socket.destroy(), HTTP_PREVIEW_LIMITS.refusalDeadlineMs)
  deadline.unref()
  socket.once("close", () => {
    clearTimeout(deadline)
    socket.off("data", ignore)
  })
  socket.on("data", ignore)
  socket.end(Buffer.concat([head, body]))
}

/**
 * Refuses a request whose body is still arriving. The refusal closes the
 * connection, and the input is absorbed only up to the drain cap (or the
 * refusal deadline) before the socket is destroyed, so a rejected body can
 * never keep a trusted server's socket draining under Node's broad defaults.
 */
const refuseRequestInput = (request: IncomingMessage, response: ServerResponse, status: number): void => {
  let drained = 0
  const deadline = setTimeout(() => request.destroy(), HTTP_PREVIEW_LIMITS.refusalDeadlineMs)
  deadline.unref()
  request.once("close", () => clearTimeout(deadline))
  request.on("data", (chunk: Buffer | string) => {
    drained += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength
    if (drained >= REFUSAL_DRAIN_BYTES) request.pause()
  })
  sendError(response, status, true)
  request.resume()
}

const terminateDuplex = (socket: Duplex): void => {
  const resetAndDestroy = (socket as Duplex & { readonly resetAndDestroy?: () => void }).resetAndDestroy
  if (resetAndDestroy === undefined) {
    socket.destroy()
    return
  }
  try {
    resetAndDestroy.call(socket)
  } catch {
    socket.destroy()
  }
}

const serializedHeaders = (headers: OutgoingHttpHeaders): string => {
  let serialized = ""
  for (const [name, raw] of Object.entries(headers)) {
    if (raw === undefined) continue
    const values = Array.isArray(raw) ? raw : [raw]
    for (const value of values) serialized += `${name}: ${String(value)}\r\n`
  }
  return serialized
}

const upstreamRequest = (
  binding: SandboxHttpProxyBinding,
  method: string,
  path: string,
  headers: OutgoingHttpHeaders
): ClientRequest => {
  const request = binding.daemonOrigin.protocol === "https:" ? httpsRequest : httpRequest
  return request({
    protocol: binding.daemonOrigin.protocol,
    hostname: binding.daemonOrigin.hostname,
    port: binding.daemonOrigin.port,
    method,
    path,
    headers: {
      ...headers,
      "proxy-authorization": `Bearer ${binding.httpIngressToken}`
    },
    agent: false,
    ca: binding.ca,
    rejectUnauthorized: true,
    maxHeaderSize: HTTP_PREVIEW_LIMITS.maxHeaderBytes
  })
}

const websocketAccept = (key: string): string =>
  createHash("sha1").update(key + WEBSOCKET_GUID, "ascii").digest("base64")

interface UpgradeAdmission {
  readonly target: string
  readonly headers: OutgoingHttpHeaders
  readonly key: string
  readonly protocols: ReadonlySet<string>
}

const admitUpgrade = (
  request: IncomingMessage,
  head: Buffer
): UpgradeAdmission | { readonly status: number } => {
  const method = request.method?.toUpperCase()
  if (method === "CONNECT" || method === "TRACE") return { status: 405 }
  if (method !== "GET" || request.httpVersionMajor !== 1 || request.httpVersionMinor < 1) {
    return { status: 426 }
  }
  const target = request.url
  if (target === undefined || !targetIsOriginForm(target)) return { status: 400 }
  if (head.byteLength > MAX_UPGRADE_HEAD_BYTES) return { status: 413 }
  const headers = collectHeaders(request.rawHeaders)
  if (headers === undefined || hasReservedHeader(headers)) return { status: 400 }
  if (headerValues(headers, "expect").length > 0 || headerValues(headers, "trailer").length > 0) {
    return { status: 400 }
  }
  if (headerValues(headers, "content-length").length > 0 || headerValues(headers, "transfer-encoding").length > 0) {
    return { status: 400 }
  }
  const upgrades = headerValues(headers, "upgrade")
  const versions = headerValues(headers, "sec-websocket-version")
  const keys = headerValues(headers, "sec-websocket-key")
  if (
    upgrades.length !== 1 || upgrades[0]!.trim().toLowerCase() !== "websocket" ||
    !headers.connectionTokens.has("upgrade") ||
    versions.length !== 1 || versions[0]!.trim() !== "13" ||
    keys.length !== 1 || !WEBSOCKET_KEY.test(keys[0]!.trim())
  ) {
    return { status: 426 }
  }
  const key = keys[0]!.trim()
  if (Buffer.from(key, "base64").byteLength !== 16) return { status: 426 }
  const protocolValues = headerValues(headers, "sec-websocket-protocol")
  const protocols = new Set<string>()
  for (const protocol of protocolValues.flatMap((value) => value.split(",")).map((value) => value.trim())) {
    if (!TOKEN.test(protocol) || protocols.has(protocol)) return { status: 400 }
    protocols.add(protocol)
  }
  if (headerValues(headers, "authorization").length > 1) return { status: 400 }
  const outgoing = filteredHeaders(headers)
  outgoing.connection = "Upgrade"
  outgoing.upgrade = "websocket"
  outgoing["sec-websocket-version"] = "13"
  outgoing["sec-websocket-key"] = key
  delete outgoing["sec-websocket-extensions"]
  return { target, headers: outgoing, key, protocols }
}

const validateUpgradeResponse = (
  response: IncomingMessage,
  admission: UpgradeAdmission
): OutgoingHttpHeaders | undefined => {
  if (response.statusCode !== 101) return undefined
  const headers = collectHeaders(response.rawHeaders)
  if (headers === undefined || hasReservedHeader(headers)) return undefined
  const upgrades = headerValues(headers, "upgrade")
  const accepts = headerValues(headers, "sec-websocket-accept")
  if (
    upgrades.length !== 1 || upgrades[0]!.trim().toLowerCase() !== "websocket" ||
    !headers.connectionTokens.has("upgrade") ||
    accepts.length !== 1 || accepts[0]!.trim() !== websocketAccept(admission.key) ||
    headerValues(headers, "sec-websocket-extensions").length > 0
  ) {
    return undefined
  }
  const selected = headerValues(headers, "sec-websocket-protocol")
  if (selected.length > 1) return undefined
  if (selected.length === 1) {
    const protocol = selected[0]!.trim()
    if (!TOKEN.test(protocol) || !admission.protocols.has(protocol)) return undefined
  }
  const outgoing = filteredHeaders(headers)
  outgoing.connection = "Upgrade"
  outgoing.upgrade = "websocket"
  outgoing["sec-websocket-accept"] = accepts[0]!.trim()
  if (selected.length === 1) outgoing["sec-websocket-protocol"] = selected[0]!.trim()
  delete outgoing["sec-websocket-extensions"]
  return outgoing
}

/** @internal Constructed only after a create response binds the VM to an ingress capability. */
export const makeSandboxHttpProxy = (binding: SandboxHttpProxyBinding): SandboxHttpProxy => {
  const prefix = `/http/v1/vms/${encodeURIComponent(binding.vmId)}`

  const handleRequest: RequestListener = (request, response) => {
    const admission = admitOrdinaryRequest(request)
    if ("status" in admission) {
      refuseRequestInput(request, response, admission.status)
      return
    }

    let completed = false
    let bodyBytes = 0
    let responseHeadTimedOut = false
    const outgoing = upstreamRequest(
      binding,
      request.method ?? "GET",
      prefix + admission.target,
      admission.headers
    )
    let responseHeadReceived = false
    let headTimer: NodeJS.Timeout | undefined
    outgoing.once("finish", () => {
      if (responseHeadReceived) return
      headTimer = setTimeout(() => {
        responseHeadTimedOut = true
        outgoing.destroy(new Error("response head timeout"))
      }, HTTP_PREVIEW_LIMITS.responseHeadMs)
      headTimer.unref()
    })

    let uploadTimer: NodeJS.Timeout | undefined
    const resetUploadTimer = (): void => {
      if (!admission.hasBody) return
      clearTimeout(uploadTimer)
      uploadTimer = setTimeout(() => outgoing.destroy(new Error("upload idle timeout")), HTTP_PREVIEW_LIMITS.uploadIdleMs)
      uploadTimer.unref()
    }
    resetUploadTimer()

    request.on("data", (chunk: Buffer | string) => {
      bodyBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength
      if (bodyBytes > HTTP_PREVIEW_LIMITS.maxRequestBodyBytes) {
        clearTimeout(uploadTimer)
        completed = true
        request.unpipe(outgoing)
        outgoing.destroy()
        refuseRequestInput(request, response, 413)
        return
      }
      resetUploadTimer()
    })
    request.once("aborted", () => outgoing.destroy())
    request.once("end", () => clearTimeout(uploadTimer))
    response.once("close", () => {
      if (!response.writableEnded) outgoing.destroy()
    })

    outgoing.once("response", (upstream) => {
      responseHeadReceived = true
      clearTimeout(headTimer)
      if (completed) {
        upstream.destroy()
        return
      }
      const headers = responseHeaders(upstream)
      if (headers === undefined) {
        completed = true
        upstream.destroy()
        sendError(response, 502)
        return
      }
      response.writeHead(upstream.statusCode ?? 502, headers)
      response.flushHeaders()
      upstream.once("aborted", () => response.destroy())
      upstream.once("error", () => response.destroy())
      if (request.method === "HEAD") {
        upstream.resume()
        upstream.once("end", () => response.end())
      } else {
        upstream.pipe(response)
      }
    })
    outgoing.once("upgrade", (_upstreamResponse, upstream) => {
      responseHeadReceived = true
      clearTimeout(headTimer)
      clearTimeout(uploadTimer)
      upstream.destroy()
      if (completed) return
      completed = true
      sendError(response, 502)
    })
    outgoing.once("error", () => {
      clearTimeout(headTimer)
      clearTimeout(uploadTimer)
      if (completed) return
      completed = true
      sendError(response, responseHeadTimedOut ? 504 : 502)
    })
    request.pipe(outgoing)
  }

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const admission = admitUpgrade(request, head)
    if ("status" in admission) {
      socketError(socket, admission.status)
      return
    }

    let completed = false
    const outgoing = upstreamRequest(binding, "GET", prefix + admission.target, admission.headers)
    let responseHeadReceived = false
    let headTimer: NodeJS.Timeout | undefined
    outgoing.once("finish", () => {
      if (responseHeadReceived) return
      headTimer = setTimeout(() => {
        if (completed) return
        completed = true
        outgoing.destroy(new Error("response head timeout"))
        socketError(socket, 504)
      }, HTTP_PREVIEW_LIMITS.responseHeadMs)
      headTimer.unref()
    })

    const closeUpstream = (): void => {
      outgoing.destroy()
    }
    socket.once("close", closeUpstream)
    outgoing.once("response", (response) => {
      responseHeadReceived = true
      clearTimeout(headTimer)
      if (completed || socket.destroyed) {
        response.destroy()
        return
      }
      completed = true
      const headers = responseHeaders(response)
      if (headers === undefined) {
        response.destroy()
        socketError(socket, 502)
        return
      }
      const status = response.statusCode ?? 502
      const reason = STATUS_CODES[status] ?? "Proxy Response"
      socket.write(`HTTP/1.1 ${status} ${reason}\r\n${serializedHeaders(headers)}Connection: close\r\n\r\n`)
      response.once("error", () => socket.destroy())
      socket.once("error", () => response.destroy())
      response.pipe(socket)
    })
    outgoing.once("upgrade", (response, upstream, upstreamHead) => {
      responseHeadReceived = true
      clearTimeout(headTimer)
      if (completed || socket.destroyed) {
        upstream.destroy()
        return
      }
      const headers = validateUpgradeResponse(response, admission)
      if (headers === undefined) {
        completed = true
        upstream.destroy()
        socketError(socket, 502)
        return
      }
      completed = true
      socket.off("close", closeUpstream)
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${serializedHeaders(headers)}\r\n`)
      const clientFrames = new WebSocketFrameValidator(true)
      const serverFrames = new WebSocketFrameValidator(false)
      const closeTunnel = (): void => {
        clientFrames.destroy()
        serverFrames.destroy()
        terminateDuplex(socket)
        terminateDuplex(upstream)
      }
      clientFrames.once("error", closeTunnel)
      serverFrames.once("error", closeTunnel)
      socket.once("error", closeTunnel)
      upstream.once("error", closeTunnel)
      socket.once("close", () => {
        clientFrames.destroy()
        serverFrames.destroy()
        upstream.destroy()
      })
      upstream.once("close", () => {
        clientFrames.destroy()
        serverFrames.destroy()
        socket.destroy()
      })

      clientFrames.pipe(upstream)
      serverFrames.pipe(socket)
      if (head.byteLength > 0) clientFrames.write(head)
      if (upstreamHead.byteLength > 0) serverFrames.write(upstreamHead)
      socket.pipe(clientFrames)
      upstream.pipe(serverFrames)
    })
    outgoing.once("error", () => {
      clearTimeout(headTimer)
      if (completed) return
      completed = true
      socketError(socket, 502)
    })
    outgoing.end()
  }

  // There is no tunnel to open: the adapter exposes exactly one VM-bound HTTP
  // surface, so a CONNECT is refused rather than dropped or dialed. Node hands
  // this event a detached socket, and `head` is deliberately unread.
  const handleConnect = (_request: IncomingMessage, socket: Duplex, _head: Buffer): void =>
    socketError(socket, 405)

  // Node answers `Expect: 100-continue` on its own unless this handler is
  // wired: it writes the interim `100 Continue` and only then emits `request`,
  // so the refusal would arrive after the client was invited to send a body.
  // Admission refuses every `Expect` value, so a status is always available;
  // the fallback keeps the refusal total instead of ever continuing.
  const handleCheckContinue: RequestListener = (request, response) => {
    const admission = admitOrdinaryRequest(request)
    refuseRequestInput(request, response, "status" in admission ? admission.status : 417)
  }

  return { handleRequest, handleUpgrade, handleConnect, handleCheckContinue }
}
