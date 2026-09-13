import { createHash } from "node:crypto"
import {
  Agent,
  request as httpRequest,
  STATUS_CODES,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type RequestListener,
  type ServerResponse
} from "node:http"
import { isIP, type Socket } from "node:net"
import { Duplex, Transform, pipeline, type TransformCallback } from "node:stream"
import { HTTP_PREVIEW_LIMITS } from "./protocol.js"

export const DAEMON_HTTP_ROUTE_PREFIX = "/http/v1/vms/"

/**
 * The one idle policy of the ingress data plane: an ordinary response, an SSE
 * stream, or an upgraded tunnel that carries no bytes in either direction for
 * this long is closed. Traffic in either direction resets it, closure is an
 * ordinary close (the VM stays healthy), and no message is buffered to police
 * it because callers touch the guard from their byte path. Only this hop guards
 * idleness, so the value lives here rather than in the shared bounds.
 */
export const INGRESS_IDLE_MS = 300_000

export interface IngressIdleGuard {
  /** Records traffic in either direction and restarts the idle window. */
  readonly touch: () => void
  /** Stops guarding; later touches are ignored. */
  readonly clear: () => void
}

/**
 * Watches one ingress exchange for idleness. The armed timer is unref'd so it
 * never holds the process open, and the deadline is a fixed window from the last
 * observed byte rather than a budget for the whole exchange.
 */
export const ingressIdleGuard = (milliseconds: number, onIdle: () => void): IngressIdleGuard => {
  let timer: NodeJS.Timeout | undefined
  let cleared = false
  const touch = (): void => {
    if (cleared) return
    clearTimeout(timer)
    timer = setTimeout(onIdle, milliseconds)
    timer.unref()
  }
  touch()
  return {
    touch,
    clear: () => {
      cleared = true
      clearTimeout(timer)
    }
  }
}

export type DaemonHttpAdmissionKind = "http" | "sse" | "websocket"

export type DaemonHttpAdmissionFailure = "not-found" | "unavailable" | "quota"

export class DaemonHttpAdmissionError extends Error {
  readonly _tag = "DaemonHttpAdmissionError"

  constructor(readonly failure: DaemonHttpAdmissionFailure) {
    super(failure)
  }
}

export interface DaemonHttpIngressBinding {
  readonly vmId: string
  readonly endpoint: "web"
}

/** A registry-owned request scope. Destroy aborts it before guest teardown. */
export interface DaemonHttpLease {
  readonly vmId: string
  readonly vsockSocket: string
  readonly signal: AbortSignal
  /** Reclassifies a response discovered to be SSE without exceeding its cap. */
  readonly promoteToSse: () => Promise<boolean>
  /** Marks the VM poisoned after a trusted guest-channel protocol failure. */
  readonly poison: () => Promise<void>
  /** Idempotent and required on every terminal path. */
  readonly release: () => Promise<void>
}

export interface OpenGuestHttpConnection {
  readonly socket: Socket
  readonly close: () => Promise<void>
}

export interface DaemonHttpProxyDependencies {
  readonly verifyHttpIngress: (token: string) => DaemonHttpIngressBinding | undefined
  readonly admit: (options: {
    readonly vmId: string
    readonly binding: DaemonHttpIngressBinding
    readonly kind: DaemonHttpAdmissionKind
  }) => Promise<DaemonHttpLease>
  readonly openGuest: (lease: DaemonHttpLease) => Promise<OpenGuestHttpConnection>
}

export interface DaemonHttpProxy {
  readonly isIngressTarget: (target: string | undefined) => boolean
  readonly handleRequest: RequestListener
  readonly handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  readonly handleConnect: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  readonly handleCheckContinue: RequestListener
}

type HeaderPairs = ReadonlyArray<readonly [string, string]>

interface ValidatedRequest {
  readonly vmId: string
  readonly target: string
  readonly token: string
  readonly headers: OutgoingHttpHeaders
  readonly contentLength: number | undefined
  readonly chunked: boolean
  readonly requestedSse: boolean
}

class PublicRequestError extends Error {
  constructor(readonly status: number) {
    super(String(status))
  }
}

const statusForAdmission = (error: unknown): number =>
  error instanceof DaemonHttpAdmissionError
    ? error.failure === "not-found"
      ? 404
      : error.failure === "quota"
        ? 429
        : 503
    : 503

const errorBody = (status: number): Buffer =>
  Buffer.from(`${STATUS_CODES[status] ?? "Request Failed"}\n`, "utf8")

const errorHeaders = (status: number): OutgoingHttpHeaders => {
  const body = errorBody(status)
  return {
    "cache-control": "no-store",
    connection: "close",
    "content-length": String(body.byteLength),
    "content-type": "text/plain; charset=utf-8"
  }
}

const sendError = (response: ServerResponse, status: number): void => {
  if (response.headersSent) {
    response.destroy()
    return
  }
  const body = errorBody(status)
  response.writeHead(status, errorHeaders(status))
  response.end(body)
}

const sendSocketError = (socket: Duplex, status: number): void => {
  if (socket.destroyed) return
  const body = errorBody(status)
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Request Failed"}`,
    "Cache-Control: no-store",
    "Connection: close",
    `Content-Length: ${body.byteLength}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    ""
  ]
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n"), "latin1"), body]))
  // A refusal must not linger half-open while it flushes: the detached socket is
  // destroyed at a fixed bound if the peer neither reads nor closes.
  const deadline = setTimeout(() => socket.destroy(), HTTP_PREVIEW_LIMITS.refusalDeadlineMs)
  deadline.unref()
  socket.once("close", () => clearTimeout(deadline))
}

const headerPairs = (request: IncomingMessage): HeaderPairs => {
  const result: Array<readonly [string, string]> = []
  const raw = request.rawHeaders
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]
    const value = raw[index + 1]
    if (name === undefined || value === undefined) throw new PublicRequestError(400)
    result.push([name, value])
  }
  return result
}

const valuesOf = (pairs: HeaderPairs, name: string): Array<string> => {
  const lower = name.toLowerCase()
  const values: Array<string> = []
  for (const [candidate, value] of pairs) {
    if (candidate.toLowerCase() === lower) values.push(value)
  }
  return values
}

const connectionTokens = (pairs: HeaderPairs): Set<string> => {
  const tokens = new Set<string>()
  for (const value of valuesOf(pairs, "connection")) {
    for (const token of value.split(",")) {
      const normalized = token.trim().toLowerCase()
      if (normalized.length === 0 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized)) {
        throw new PublicRequestError(400)
      }
      tokens.add(normalized)
    }
  }
  return tokens
}

const HOP_BY_HOP: Record<string, true> = {
  connection: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true
}

const isStrippedHeader = (name: string, nominated: ReadonlySet<string>): boolean => {
  const lower = name.toLowerCase()
  return HOP_BY_HOP[lower] === true ||
    nominated.has(lower) ||
    lower.startsWith("proxy-") ||
    lower === "forwarded" ||
    lower === "via" ||
    lower.startsWith("x-forwarded-") ||
    lower.startsWith("microvm-") ||
    lower === "host" ||
    lower === "content-length"
}

const appendHeader = (headers: OutgoingHttpHeaders, name: string, value: string): void => {
  const lower = name.toLowerCase()
  const previous = headers[lower]
  if (previous === undefined) {
    headers[lower] = value
  } else if (Array.isArray(previous)) {
    headers[lower] = [...previous, value]
  } else {
    headers[lower] = [String(previous), value]
  }
}

const validateTarget = (request: IncomingMessage): { readonly vmId: string; readonly target: string } => {
  const raw = request.url
  if (raw === undefined || Buffer.byteLength(raw, "utf8") > HTTP_PREVIEW_LIMITS.maxTargetBytes) {
    throw new PublicRequestError(400)
  }
  if (!raw.startsWith(DAEMON_HTTP_ROUTE_PREFIX) || /[\u0000-\u0020\u007f#]/.test(raw)) {
    throw new PublicRequestError(400)
  }
  for (let index = raw.indexOf("%"); index !== -1; index = raw.indexOf("%", index + 3)) {
    if (!/^[0-9a-fA-F]{2}$/.test(raw.slice(index + 1, index + 3))) throw new PublicRequestError(400)
  }
  const afterPrefix = raw.slice(DAEMON_HTTP_ROUTE_PREFIX.length)
  const separator = afterPrefix.search(/[/?]/)
  const vmId = separator === -1 ? afterPrefix : afterPrefix.slice(0, separator)
  if (!/^mvm-[0-9a-z]{8,24}$/.test(vmId)) throw new PublicRequestError(400)
  const suffix = separator === -1 ? "" : afterPrefix.slice(separator)
  if (suffix.length > 0 && suffix[0] !== "/" && suffix[0] !== "?") throw new PublicRequestError(400)
  return { vmId, target: suffix.length === 0 ? "/" : suffix[0] === "?" ? `/${suffix}` : suffix }
}

const parseBearer = (pairs: HeaderPairs): string => {
  const values = valuesOf(pairs, "proxy-authorization")
  if (values.length !== 1) throw new PublicRequestError(401)
  const match = /^Bearer ([!#$%&'*+.^_`|~0-9A-Za-z-]+)$/.exec(values[0]!)
  if (match === null || match[1]!.length === 0) throw new PublicRequestError(401)
  return match[1]!
}

const validateRawHeaders = (request: IncomingMessage, pairs: HeaderPairs): void => {
  if (pairs.length > HTTP_PREVIEW_LIMITS.maxHeaderFields) throw new PublicRequestError(400)
  let bytes = 0
  for (const [name, value] of pairs) {
    bytes += Buffer.byteLength(name, "latin1") + Buffer.byteLength(value, "latin1") + 4
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new PublicRequestError(400)
    }
    if (name.toLowerCase().startsWith("microvm-")) throw new PublicRequestError(400)
  }
  if (bytes > HTTP_PREVIEW_LIMITS.maxHeaderBytes) throw new PublicRequestError(400)
  if (request.method === undefined || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(request.method)) {
    throw new PublicRequestError(400)
  }
  if (request.method === "CONNECT" || request.method === "TRACE") throw new PublicRequestError(405)
  if (valuesOf(pairs, "host").length !== 1) throw new PublicRequestError(400)
  if (valuesOf(pairs, "expect").length > 0 || valuesOf(pairs, "trailer").length > 0) {
    throw new PublicRequestError(400)
  }
}

const canonicalHost = (host: string): string => {
  if (host.length === 0 || host.length > 255 || /[\s,/@\\]/.test(host)) throw new PublicRequestError(400)
  try {
    const parsed = new URL(`http://${host}`)
    if (parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" || parsed.search !== "") {
      throw new PublicRequestError(400)
    }
    return parsed.host.toLowerCase()
  } catch (cause) {
    if (cause instanceof PublicRequestError) throw cause
    throw new PublicRequestError(400)
  }
}

const forwardingHeaders = (request: IncomingMessage, publicHost: string): OutgoingHttpHeaders => {
  const address = request.socket.remoteAddress
  const trustedAddress = address !== undefined && isIP(address) !== 0 ? address : "unknown"
  const forwardedFor = trustedAddress.includes(":") ? `"[${trustedAddress}]"` : trustedAddress
  const proto = "encrypted" in request.socket && request.socket.encrypted === true ? "https" : "http"
  return {
    forwarded: `for=${forwardedFor};host="${publicHost.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}";proto=${proto}`,
    "x-forwarded-for": trustedAddress,
    "x-forwarded-host": publicHost,
    "x-forwarded-proto": proto
  }
}

const validateFraming = (pairs: HeaderPairs): { readonly contentLength: number | undefined; readonly chunked: boolean } => {
  const contentLengthValues = valuesOf(pairs, "content-length")
  const transferEncodingValues = valuesOf(pairs, "transfer-encoding")
  if (contentLengthValues.length > 1 || transferEncodingValues.length > 1 ||
    (contentLengthValues.length > 0 && transferEncodingValues.length > 0)) {
    throw new PublicRequestError(400)
  }
  let contentLength: number | undefined
  if (contentLengthValues.length === 1) {
    const raw = contentLengthValues[0]!
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new PublicRequestError(400)
    contentLength = Number(raw)
    if (!Number.isSafeInteger(contentLength)) throw new PublicRequestError(400)
    if (contentLength > HTTP_PREVIEW_LIMITS.maxRequestBodyBytes) throw new PublicRequestError(413)
  }
  let chunked = false
  if (transferEncodingValues.length === 1) {
    if (transferEncodingValues[0]!.trim().toLowerCase() !== "chunked") throw new PublicRequestError(400)
    chunked = true
  }
  return { contentLength, chunked }
}

const sanitizedRequestHeaders = (
  request: IncomingMessage,
  pairs: HeaderPairs,
  contentLength: number | undefined
): OutgoingHttpHeaders => {
  const nominated = connectionTokens(pairs)
  const headers: OutgoingHttpHeaders = {}
  for (const [name, value] of pairs) {
    if (!isStrippedHeader(name, nominated)) appendHeader(headers, name, value)
  }
  headers.host = "web.internal"
  if (contentLength !== undefined) headers["content-length"] = String(contentLength)
  Object.assign(headers, forwardingHeaders(request, canonicalHost(valuesOf(pairs, "host")[0]!)))
  return headers
}

const validateOrdinaryRequest = (request: IncomingMessage): ValidatedRequest => {
  const route = validateTarget(request)
  const pairs = headerPairs(request)
  validateRawHeaders(request, pairs)
  const token = parseBearer(pairs)
  const { contentLength, chunked } = validateFraming(pairs)
  const upgrade = valuesOf(pairs, "upgrade")
  if (upgrade.length > 0 || connectionTokens(pairs).has("upgrade")) throw new PublicRequestError(426)
  const accept = valuesOf(pairs, "accept").join(",").toLowerCase()
  return {
    ...route,
    token,
    headers: sanitizedRequestHeaders(request, pairs, contentLength),
    contentLength,
    chunked,
    requestedSse: accept.split(",").some((value) => value.trim().split(";", 1)[0] === "text/event-stream")
  }
}

interface ValidatedWebSocket extends ValidatedRequest {
  readonly key: string
  readonly protocols: ReadonlySet<string>
}

const validateWebSocketRequest = (request: IncomingMessage): ValidatedWebSocket => {
  const route = validateTarget(request)
  const pairs = headerPairs(request)
  validateRawHeaders(request, pairs)
  if (request.method !== "GET") throw new PublicRequestError(426)
  if (request.httpVersionMajor !== 1 || request.httpVersionMinor < 1) throw new PublicRequestError(426)
  const token = parseBearer(pairs)
  const framing = validateFraming(pairs)
  if (framing.contentLength !== undefined || framing.chunked) throw new PublicRequestError(400)
  const upgrades = valuesOf(pairs, "upgrade")
  if (upgrades.length !== 1 || upgrades[0]!.trim().toLowerCase() !== "websocket" ||
    !connectionTokens(pairs).has("upgrade")) {
    throw new PublicRequestError(426)
  }
  const versions = valuesOf(pairs, "sec-websocket-version")
  if (versions.length !== 1 || versions[0]!.trim() !== "13") throw new PublicRequestError(426)
  const keys = valuesOf(pairs, "sec-websocket-key")
  if (keys.length !== 1) throw new PublicRequestError(426)
  const key = keys[0]!.trim()
  let decoded: Buffer
  try {
    decoded = Buffer.from(key, "base64")
  } catch {
    throw new PublicRequestError(426)
  }
  if (decoded.byteLength !== 16 || decoded.toString("base64") !== key) throw new PublicRequestError(426)

  const headers = sanitizedRequestHeaders(request, pairs, undefined)
  headers.connection = "Upgrade"
  headers.upgrade = "websocket"
  headers["sec-websocket-version"] = "13"
  headers["sec-websocket-key"] = key
  delete headers["sec-websocket-extensions"]

  const protocolValues = valuesOf(pairs, "sec-websocket-protocol")
  const protocols = new Set<string>()
  for (const value of protocolValues) {
    for (const protocol of value.split(",")) {
      const item = protocol.trim()
      if (item.length === 0 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(item) || protocols.has(item)) {
        throw new PublicRequestError(426)
      }
      protocols.add(item)
    }
  }
  if (protocols.size > 0) headers["sec-websocket-protocol"] = [...protocols].join(", ")
  else delete headers["sec-websocket-protocol"]
  return { ...route, token, headers, contentLength: undefined, chunked: false, requestedSse: false, key, protocols }
}

const guestResponseHeaders = (response: IncomingMessage): OutgoingHttpHeaders => {
  const pairs = headerPairs(response)
  if (pairs.length > HTTP_PREVIEW_LIMITS.maxHeaderFields) throw new PublicRequestError(502)
  const nominated = connectionTokens(pairs)
  const headers: OutgoingHttpHeaders = {}
  for (const [name, value] of pairs) {
    if (!isStrippedHeader(name, nominated)) appendHeader(headers, name, value)
  }
  const contentLength = response.headers["content-length"]
  if (typeof contentLength === "string" && /^(0|[1-9][0-9]*)$/.test(contentLength)) {
    headers["content-length"] = String(Number(contentLength))
  }
  return headers
}

const closeQuietly = async (connection: OpenGuestHttpConnection | undefined): Promise<void> => {
  if (connection === undefined) return
  connection.socket.destroy()
  try {
    await connection.close()
  } catch {
    // Closing is idempotent best effort; the registry lease remains the authority.
  }
}

const releaseQuietly = async (lease: DaemonHttpLease | undefined): Promise<void> => {
  if (lease === undefined) return
  try {
    await lease.release()
  } catch {
    // A release failure cannot be rendered safely into an established stream.
  }
}

const writeRequestBody = (
  request: IncomingMessage,
  upstream: ClientRequest,
  onFailure: (status: number) => void
): (() => void) => {
  let bytes = 0
  let complete = false
  let timer: NodeJS.Timeout | undefined
  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const armTimer = (): void => {
    clearTimer()
    timer = setTimeout(() => fail(408), HTTP_PREVIEW_LIMITS.uploadIdleMs)
    timer.unref()
  }
  const cleanup = (): void => {
    clearTimer()
    request.off("data", onData)
    request.off("end", onEnd)
    request.off("aborted", onAborted)
    request.off("error", onError)
    upstream.off("drain", onDrain)
  }
  const fail = (status: number): void => {
    if (complete) return
    complete = true
    cleanup()
    upstream.destroy()
    onFailure(status)
  }
  const onData = (chunk: Buffer): void => {
    armTimer()
    bytes += chunk.byteLength
    if (bytes > HTTP_PREVIEW_LIMITS.maxRequestBodyBytes) {
      fail(413)
      return
    }
    if (!upstream.write(chunk)) request.pause()
  }
  const onDrain = (): void => {
    request.resume()
  }
  const onEnd = (): void => {
    if (complete) return
    complete = true
    cleanup()
    upstream.end()
  }
  const onAborted = (): void => fail(400)
  const onError = (): void => fail(400)
  request.on("data", onData)
  request.once("end", onEnd)
  request.once("aborted", onAborted)
  request.once("error", onError)
  upstream.on("drain", onDrain)
  armTimer()
  return cleanup
}

const isEventStream = (headers: IncomingHttpHeaders): boolean => {
  const raw = headers["content-type"]
  const contentType = Array.isArray(raw) ? raw[0] : raw
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream"
}

const expectedWebSocketAccept = (key: string): string =>
  createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii").digest("base64")

const validateGuestUpgrade = (
  response: IncomingMessage,
  request: ValidatedWebSocket
): HeaderPairs => {
  if (response.statusCode !== 101) throw new PublicRequestError(502)
  const pairs = headerPairs(response)
  if (pairs.length > HTTP_PREVIEW_LIMITS.maxHeaderFields) throw new PublicRequestError(502)
  if (valuesOf(pairs, "upgrade").length !== 1 ||
    valuesOf(pairs, "upgrade")[0]!.trim().toLowerCase() !== "websocket" ||
    !connectionTokens(pairs).has("upgrade")) {
    throw new PublicRequestError(502)
  }
  const accept = valuesOf(pairs, "sec-websocket-accept")
  if (accept.length !== 1 || accept[0]!.trim() !== expectedWebSocketAccept(request.key)) {
    throw new PublicRequestError(502)
  }
  if (valuesOf(pairs, "sec-websocket-extensions").length > 0) throw new PublicRequestError(502)
  const selected = valuesOf(pairs, "sec-websocket-protocol")
  if (selected.length > 1 || (selected.length === 1 && !request.protocols.has(selected[0]!.trim()))) {
    throw new PublicRequestError(502)
  }
  return pairs
}

const serializeUpgradeResponse = (pairs: HeaderPairs): Buffer => {
  const nominated = connectionTokens(pairs)
  const lines = [
    "HTTP/1.1 101 Switching Protocols",
    "Connection: Upgrade",
    "Upgrade: websocket"
  ]
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase()
    if (
      lower !== "connection" &&
      lower !== "upgrade" &&
      !isStrippedHeader(name, nominated) &&
      lower !== "sec-websocket-extensions"
    ) {
      lines.push(`${name}: ${value}`)
    }
  }
  lines.push("", "")
  return Buffer.from(lines.join("\r\n"), "latin1")
}

/** Validates and forwards frames without buffering whole messages. */
class WebSocketFrameGuard extends Transform {
  private pending = Buffer.alloc(0)
  private payloadRemaining = 0
  private fragmented = false
  private fragmentedBytes = 0

  constructor(
    private readonly requireMasked: boolean,
    private readonly onTraffic?: () => void
  ) {
    super({
      readableHighWaterMark: HTTP_PREVIEW_LIMITS.frameBufferBytes,
      writableHighWaterMark: HTTP_PREVIEW_LIMITS.frameBufferBytes
    })
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.onTraffic?.()
      let input = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
      this.pending = Buffer.alloc(0)
      while (input.length > 0) {
        if (this.payloadRemaining > 0) {
          const take = Math.min(input.length, this.payloadRemaining)
          this.push(input.subarray(0, take))
          input = input.subarray(take)
          this.payloadRemaining -= take
          continue
        }
        if (input.length < 2) {
          this.pending = Buffer.from(input)
          break
        }
        const first = input[0]!
        const second = input[1]!
        const fin = (first & 0x80) !== 0
        const rsv = first & 0x70
        const opcode = first & 0x0f
        const masked = (second & 0x80) !== 0
        const lengthMarker = second & 0x7f
        let length = lengthMarker
        const extendedBytes = lengthMarker === 126 ? 2 : lengthMarker === 127 ? 8 : 0
        const headerBytes = 2 + extendedBytes + (masked ? 4 : 0)
        if (input.length < headerBytes) {
          this.pending = Buffer.from(input)
          break
        }
        if (rsv !== 0 || masked !== this.requireMasked || ![0, 1, 2, 8, 9, 10].includes(opcode)) {
          throw new Error("invalid websocket frame")
        }
        if (extendedBytes === 2) {
          length = input.readUInt16BE(2)
          if (length < 126) throw new Error("non-minimal websocket frame length")
        }
        if (extendedBytes === 8) {
          const wide = input.readBigUInt64BE(2)
          if (wide <= 65_535n) throw new Error("non-minimal websocket frame length")
          if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("websocket frame is too large")
          length = Number(wide)
        }
        const control = opcode >= 8
        if (control && (!fin || length > 125)) throw new Error("invalid websocket control frame")
        if (!control) {
          if (opcode === 0) {
            if (!this.fragmented) throw new Error("unexpected websocket continuation")
            this.fragmentedBytes += length
            if (fin) this.fragmented = false
          } else {
            if (this.fragmented) throw new Error("interleaved websocket message")
            this.fragmentedBytes = length
            this.fragmented = !fin
          }
          if (this.fragmentedBytes > HTTP_PREVIEW_LIMITS.maxWebSocketMessageBytes) {
            throw new Error("websocket message is too large")
          }
          if (fin) this.fragmentedBytes = 0
        }
        this.push(input.subarray(0, headerBytes))
        input = input.subarray(headerBytes)
        this.payloadRemaining = length
      }
      callback()
    } catch (cause) {
      callback(cause as Error)
    }
  }

  override _flush(callback: TransformCallback): void {
    callback(this.pending.length === 0 && this.payloadRemaining === 0 ? undefined : new Error("truncated websocket frame"))
  }
}

class SingleSocketAgent extends Agent {
  constructor(private readonly connection: Socket) {
    super({ keepAlive: false, maxSockets: 1 })
  }

  override createConnection(): Socket {
    return this.connection
  }
}

export const makeDaemonHttpProxy = (dependencies: DaemonHttpProxyDependencies): DaemonHttpProxy => {
  const isIngressTarget = (target: string | undefined): boolean => {
    if (target === undefined) return false
    if (target.startsWith(DAEMON_HTTP_ROUTE_PREFIX)) return true
    if (/^https?:\/\//i.test(target)) {
      try {
        return new URL(target).pathname.startsWith(DAEMON_HTTP_ROUTE_PREFIX)
      } catch {
        return false
      }
    }
    return false
  }

  const handleRequest: RequestListener = (request, response) => {
    void (async () => {
      let lease: DaemonHttpLease | undefined
      let guest: OpenGuestHttpConnection | undefined
      let cleanupBody: (() => void) | undefined
      let settled = false
      let responseStarted = false
      let idle: IngressIdleGuard | undefined
      let upstream: ClientRequest | undefined
      let headTimer: NodeJS.Timeout | undefined
      let settleBody: (() => void) | undefined

      /** Ends the exchange once, releasing timers and the in-flight guest request. */
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(headTimer)
        idle?.clear()
        cleanupBody?.()
        upstream?.destroy()
        settleBody?.()
      }
      const fail = (status: number): void => {
        if (!responseStarted) sendError(response, status)
        else response.destroy()
        finish()
      }
      try {
        const validated = validateOrdinaryRequest(request)
        const binding = dependencies.verifyHttpIngress(validated.token)
        if (binding === undefined) throw new PublicRequestError(401)
        if (binding.vmId !== validated.vmId || binding.endpoint !== "web") throw new PublicRequestError(404)
        lease = await dependencies.admit({
          vmId: validated.vmId,
          binding,
          kind: validated.requestedSse ? "sse" : "http"
        })

        // Observe the lease before the guest channel is opened, exactly like the
        // upgrade path: an abort that lands while no listener is installed never
        // calls one, which would hold the scope past destroy's bound.
        const aborted = new Promise<undefined>((resolve) => {
          if (lease!.signal.aborted) {
            resolve(undefined)
            return
          }
          lease!.signal.addEventListener("abort", () => resolve(undefined), { once: true })
        })
        lease.signal.addEventListener("abort", () => {
          response.destroy()
          finish()
        }, { once: true })

        const opening = dependencies.openGuest(lease)
        let opened: OpenGuestHttpConnection | undefined
        try {
          opened = await Promise.race([opening, aborted])
        } catch {
          if (settled) return
          await lease.poison()
          throw new PublicRequestError(503)
        }
        if (opened === undefined) {
          void opening.then((connection) => closeQuietly(connection), () => undefined)
          return
        }
        guest = opened
        if (settled || lease.signal.aborted) return

        await new Promise<void>((resolve) => {
          settleBody = resolve
          upstream = httpRequest({
            agent: new SingleSocketAgent(guest!.socket),
            headers: validated.headers,
            host: "web.internal",
            method: request.method,
            path: validated.target,
            port: 80,
            maxHeaderSize: HTTP_PREVIEW_LIMITS.maxHeaderBytes,
            setHost: false
          })
          upstream.once("finish", () => {
            headTimer = setTimeout(() => fail(504), HTTP_PREVIEW_LIMITS.responseHeadMs)
            headTimer.unref()
          })
          upstream.once("error", () => fail(502))
          upstream.once("response", (guestResponse) => {
            clearTimeout(headTimer)
            void (async () => {
              if (isEventStream(guestResponse.headers) && !validated.requestedSse) {
                const promoted = await lease!.promoteToSse()
                if (!promoted) {
                  guestResponse.destroy()
                  fail(429)
                  return
                }
              }
              let headers: OutgoingHttpHeaders
              try {
                headers = guestResponseHeaders(guestResponse)
              } catch {
                guestResponse.destroy()
                fail(502)
                return
              }
              if (isEventStream(guestResponse.headers)) headers["x-accel-buffering"] = "no"
              responseStarted = true
              response.writeHead(guestResponse.statusCode ?? 502, headers)
              if (isEventStream(guestResponse.headers)) response.flushHeaders()
              // One idle policy for every ingress response: guest bytes reset it.
              idle = ingressIdleGuard(INGRESS_IDLE_MS, () => {
                guestResponse.destroy()
                response.destroy()
                finish()
              })
              guestResponse.on("data", () => idle?.touch())
              pipeline(guestResponse, response, () => finish())
            })().catch(() => fail(502))
          })
          upstream.once("upgrade", (_guestResponse, socket) => {
            socket.destroy()
            fail(502)
          })
          response.once("close", () => {
            if (!response.writableEnded) finish()
          })
          guest!.socket.resume()
          cleanupBody = writeRequestBody(request, upstream, fail)
        })
      } catch (cause) {
        sendError(response, cause instanceof PublicRequestError ? cause.status : statusForAdmission(cause))
      } finally {
        idle?.clear()
        cleanupBody?.()
        await closeQuietly(guest)
        await releaseQuietly(lease)
      }
    })()
  }

  const handleUpgrade = (request: IncomingMessage, publicSocket: Duplex, head: Buffer): void => {
    void (async () => {
      let lease: DaemonHttpLease | undefined
      let guest: OpenGuestHttpConnection | undefined
      let upstream: ClientRequest | undefined
      let timer: NodeJS.Timeout | undefined
      let settled = false
      let publicCommitted = false
      let idle: IngressIdleGuard | undefined
      let settleExchange: (() => void) | undefined
      let failExchange: ((cause: unknown) => void) | undefined

      /**
       * Ends the exchange without owing the caller a response: the client went
       * away, destroy aborted, or a committed tunnel finished. The public socket
       * is detached from the HTTP server, so it is destroyed here rather than
       * left half-open in the server's connection set, where it would keep
       * `server.close()` pending forever.
       */
      const terminateSilently = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        idle?.clear()
        upstream?.destroy()
        publicSocket.destroy()
        settleExchange?.()
      }

      /**
       * Ends the exchange with a refusal the caller must receive: the socket is
       * left intact so the catch below can write the documented 5xx, which is
       * then bounded by sendSocketError.
       */
      const refuse = (cause: unknown): void => {
        if (settled) return
        if (failExchange === undefined) {
          terminateSilently()
          return
        }
        settled = true
        clearTimeout(timer)
        idle?.clear()
        upstream?.destroy()
        failExchange(cause)
      }

      /** Ends the exchange because a committed tunnel finished on its own. */
      const complete = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        idle?.clear()
        upstream?.destroy()
        settleExchange?.()
      }

      try {
        const validated = validateWebSocketRequest(request)
        const binding = dependencies.verifyHttpIngress(validated.token)
        if (binding === undefined) throw new PublicRequestError(401)
        if (binding.vmId !== validated.vmId || binding.endpoint !== "web") throw new PublicRequestError(404)
        lease = await dependencies.admit({ vmId: validated.vmId, binding, kind: "websocket" })

        // Observe the lease before the guest channel is opened: destroy aborts
        // it, and an AbortSignal that fires while no listener is installed never
        // calls one, which would hold the lease until the channel gave up.
        const aborted = new Promise<undefined>((resolve) => {
          if (lease!.signal.aborted) {
            resolve(undefined)
            return
          }
          lease!.signal.addEventListener("abort", () => resolve(undefined), { once: true })
        })
        lease.signal.addEventListener("abort", () => terminateSilently(), { once: true })

        const opening = dependencies.openGuest(lease)
        let opened: OpenGuestHttpConnection | undefined
        try {
          opened = await Promise.race([opening, aborted])
        } catch {
          if (settled) return
          await lease.poison()
          throw new PublicRequestError(503)
        }
        if (opened === undefined) {
          // The exchange is already over; a channel that still arrives is closed
          // by its owner rather than leaked.
          void opening.then((connection) => closeQuietly(connection), () => undefined)
          return
        }
        guest = opened
        if (settled || lease.signal.aborted) return

        await new Promise<void>((resolve, reject) => {
          settleExchange = resolve
          failExchange = reject
          upstream = httpRequest({
            agent: new SingleSocketAgent(guest!.socket),
            headers: validated.headers,
            host: "web.internal",
            method: "GET",
            path: validated.target,
            port: 80,
            maxHeaderSize: HTTP_PREVIEW_LIMITS.maxHeaderBytes,
            setHost: false
          })
          timer = setTimeout(() => refuse(new PublicRequestError(504)), HTTP_PREVIEW_LIMITS.responseHeadMs)
          timer.unref()
          upstream.once("error", () => refuse(new PublicRequestError(502)))
          upstream.once("response", (guestResponse) => {
            guestResponse.destroy()
            refuse(new PublicRequestError(502))
          })
          upstream.once("upgrade", (guestResponse, guestSocket, guestHead) => {
            try {
              const pairs = validateGuestUpgrade(guestResponse, validated)
              clearTimeout(timer)
              publicSocket.write(serializeUpgradeResponse(pairs))
              publicCommitted = true
              // One idle policy for the tunnel too: frames in either direction
              // reset it, and an idle tunnel is closed like any other exchange.
              idle = ingressIdleGuard(INGRESS_IDLE_MS, () => terminateSilently())
              const toGuest = new WebSocketFrameGuard(true, () => idle?.touch())
              const toPublic = new WebSocketFrameGuard(false, () => idle?.touch())
              if (head.byteLength > 0) toGuest.write(head)
              if (guestHead.byteLength > 0) toPublic.write(guestHead)
              let directions = 2
              const directionDone = (cause?: Error | null): void => {
                directions--
                if (cause !== undefined && cause !== null) {
                  guestSocket.destroy()
                  publicSocket.destroy()
                }
                if (directions === 0 || cause !== undefined && cause !== null) {
                  if (cause === undefined || cause === null) complete()
                  else terminateSilently()
                }
              }
              pipeline(publicSocket, toGuest, guestSocket, directionDone)
              pipeline(guestSocket, toPublic, publicSocket, directionDone)
            } catch (cause) {
              guestSocket.destroy()
              refuse(cause)
            }
          })
          publicSocket.once("error", () => terminateSilently())
          publicSocket.once("close", () => terminateSilently())
          // A half-close before the upgrade is committed is terminal; a
          // committed tunnel keeps serving until its own close or a destroy.
          publicSocket.once("end", () => {
            if (!publicCommitted) terminateSilently()
          })
          guest!.socket.resume()
          upstream.end()
        })
      } catch (cause) {
        if (!publicCommitted) {
          sendSocketError(publicSocket, cause instanceof PublicRequestError ? cause.status : statusForAdmission(cause))
        } else {
          publicSocket.destroy()
        }
      } finally {
        await closeQuietly(guest)
        await releaseQuietly(lease)
      }
    })()
  }

  const handleConnect = (_request: IncomingMessage, socket: Duplex, _head: Buffer): void => sendSocketError(socket, 405)
  const handleCheckContinue: RequestListener = (request, response) => {
    if (isIngressTarget(request.url)) sendError(response, 400)
    else sendError(response, 417)
  }

  return { isIngressTarget, handleRequest, handleUpgrade, handleConnect, handleCheckContinue }
}
