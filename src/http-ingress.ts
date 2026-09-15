/**
 * Fetch-native HTTP ingress for one created microVM's immutable `web`
 * endpoint.
 *
 * The adapter accepts a caller-owned Web `Request` and returns the guest's
 * Web `Response`, forwarding bytes end to end without buffering. It is the
 * request-scoped replacement for the persistent Node reverse proxy: lifecycle
 * deadlines and cancellation belong to the caller's HTTP runtime, while the
 * daemon data plane (`src/daemon-http-proxy.ts`) keeps enforcing admission,
 * quotas, framing, and the ingress idle policy on its hop.
 *
 * Security posture (independently enforced — never shared, never weakened):
 * - only origin-form request targets within the preview byte bounds pass,
 * - `Upgrade` is refused (426) and `Expect`/`Trailer`/`Transfer-Encoding`
 *   are refused (400) on the caller's RAW headers, before any stripping, so
 *   non-conforming host runtimes (Cloudflare Requests carry `Upgrade` even
 *   though Node's constructor drops it) cannot smuggle them through,
 * - hop-by-hop fields, connection-nominated fields, caller forwarding
 *   headers (`forwarded`/`x-forwarded-*`), `proxy-*`, and the reserved
 *   `microvm-*` namespace are stripped or refused before anything leaves,
 * - `Proxy-Authorization: Bearer <httpIngressToken>` is injected exactly
 *   once, on the final daemon hop, overwriting anything the caller supplied,
 * - request bodies — with or without `content-length` — are bounded
 *   independently (16 MiB) and watched for upload idleness without
 *   buffering, returning 413/408 refusals that abort the daemon hop,
 * - response heads must arrive within the deadline, response header blocks
 *   are bounded and scrubbed like the request side, and reserved response
 *   names are grounds for refusal (502),
 * - the daemon origin must be HTTPS, or plaintext loopback.
 *
 * Runtime neutral: no `node:*` imports (the workerd client composes this
 * adapter); byte accounting uses `TextEncoder`.
 */
import { secureOrigin } from "./endpoint.js"
import { DAEMON_HTTP_ROUTE_PREFIX, HTTP_PREVIEW_LIMITS } from "./protocol.js"

export interface SandboxHttpIngressOptions {
  /** Daemon origin; HTTPS for any non-loopback daemon. */
  readonly url: string
  /** The one VM this adapter forwards to; never selectable per request. */
  readonly vmId: string
  /** The create-time HTTP data-plane capability for the VM's `web` endpoint. */
  readonly httpIngressToken: string
  /**
   * Fetch implementation for the final daemon hop. Runtime-specific public
   * roots decide whether a default is permitted; this shared adapter never
   * consults ambient network state.
   */
  readonly fetch: typeof globalThis.fetch
}

export interface SandboxHttpIngress {
  /** Forwards one sanitized request to the VM's ingress and returns its response. */
  readonly handle: (request: Request) => Promise<Response>
}

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

const textEncoder = new TextEncoder()
const byteLength = (value: string): number => textEncoder.encode(value).byteLength

const REFUSAL_REASONS: Readonly<Record<number, string>> = {
  400: "Bad Request",
  405: "Method Not Allowed",
  408: "Request Timeout",
  413: "Content Too Large",
  426: "Upgrade Required",
  502: "Bad Gateway",
  504: "Gateway Timeout"
}

const refusal = (status: number): Response =>
  new Response(`${status} ${REFUSAL_REASONS[status] ?? "Refused"}\n`, { status })

const connectionNominated = (values: ReadonlyArray<string>): ReadonlySet<string> =>
  new Set(
    values.flatMap((value) => value.split(",")).map((value) => value.trim().toLowerCase()).filter(Boolean)
  )

/**
 * Same origin-form rule the daemon data plane enforces on its own hop, so a
 * mistake in one is caught by the other.
 */
const targetIsOriginForm = (target: string): boolean =>
  target.length > 0 &&
  target.startsWith("/") &&
  !target.startsWith("//") &&
  byteLength(target) <= HTTP_PREVIEW_LIMITS.maxTargetBytes &&
  !target.includes("#") &&
  !target.includes("\\") &&
  !/[\u0000-\u0020\u007f]/.test(target)

const isStrippedRequestHeader = (name: string, nominated: ReadonlySet<string>): boolean =>
  name === "host" ||
  name === "content-length" ||
  HOP_BY_HOP[name] === true ||
  nominated.has(name) ||
  UNTRUSTED_FORWARDING[name] === true ||
  name.startsWith("x-forwarded-") ||
  name.startsWith("proxy-")

const isStrippedResponseHeader = (name: string, nominated: ReadonlySet<string>): boolean =>
  name === "host" ||
  name === "content-length" ||
  name === "forwarded" ||
  name === "via" ||
  HOP_BY_HOP[name] === true ||
  nominated.has(name) ||
  name.startsWith("x-forwarded-") ||
  name.startsWith("proxy-")

/**
 * Reads the caller's headers once and adjudicates them in wire order:
 * explicit framing/upgrade fields are refused before any stripping, then the
 * bounds and reserved-name checks, and only the survivors are collected into
 * the exact final-hop set.
 */
const admitHeaders = (
  request: Request
): { readonly headers: Record<string, string>; readonly refused: number } => {
  const pairs = Array.from(request.headers.entries())
  if (pairs.length > HTTP_PREVIEW_LIMITS.maxHeaderFields) return { headers: {}, refused: 400 }

  const connection = request.headers.get("connection")
  const nominated = connectionNominated(connection === null ? [] : [connection])
  const lower = new Map<string, string>()
  for (const [name, value] of pairs) {
    const key = name.toLowerCase()
    const existing = lower.get(key)
    lower.set(key, existing === undefined ? value : `${existing}, ${value}`)
  }

  // Explicit framing/upgrade fields are adjudicated on the caller's original
  // set, before anything is stripped: non-conforming host runtimes can carry
  // fields Node's Request constructor would drop.
  if (lower.has("upgrade") || nominated.has("upgrade")) return { headers: {}, refused: 426 }
  if (lower.has("expect") || lower.has("trailer") || lower.has("transfer-encoding")) {
    return { headers: {}, refused: 400 }
  }
  const declared = lower.get("content-length")
  if (declared !== undefined) {
    if (declared.split(",").length > 1 || !/^(?:0|[1-9][0-9]*)$/.test(declared.trim())) {
      return { headers: {}, refused: 400 }
    }
    const length = Number(declared.trim())
    if (!Number.isSafeInteger(length) || length > HTTP_PREVIEW_LIMITS.maxRequestBodyBytes) {
      return { headers: {}, refused: 413 }
    }
  }

  let bytes = 0
  const headers: Record<string, string> = {}
  for (const [name, value] of pairs) {
    const key = name.toLowerCase()
    bytes += byteLength(name) + byteLength(value) + 4
    if (bytes > HTTP_PREVIEW_LIMITS.maxHeaderBytes) return { headers: {}, refused: 400 }
    if (key.startsWith("microvm-")) return { headers: {}, refused: 400 }
    if (isStrippedRequestHeader(key, nominated)) continue
    headers[key] = headers[key] === undefined ? value : `${headers[key]}, ${value}`
  }
  return { headers, refused: 0 }
}

const declareBodySize = (request: Request): number | undefined => {
  const declared = request.headers.get("content-length")
  if (declared !== null) return Number(declared)
  const body = request.body
  if (body === null) return 0
  return undefined
}

/**
 * Wraps the caller's body stream so every byte is counted on the fly and the
 * daemon hop is aborted with the correct bounded refusal the moment the
 * independent cap or the upload-idle window trips — nothing is buffered.
 *
 * A custom ReadableStream over the source reader (not a TransformStream):
 * the idle window is armed immediately, before the first byte, so a body
 * stalled up front is bounded like any other; each delivered byte re-arms
 * the window; and EOF, error, and cancellation all disarm it, so a completed
 * upload can never abort a later, long-running response. Every trip (idle,
 * over-limit) and every consumer cancellation releases the underlying source
 * with an explicit `reader.cancel`, so a stalled source is never left
 * locked, and a closed stream never re-arms the window.
 */
const boundedBodyStream = (
  body: ReadableStream,
  trip: (status: number) => void
): ReadableStream<Uint8Array> => {
  const reader = body.getReader()
  let bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let outputController: ReadableStreamDefaultController<Uint8Array> | undefined
  const disarm = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  /** Releases the underlying source so a stalled stream is never left locked. */
  const releaseSource = (reason?: unknown): void => {
    if (closed) return
    closed = true
    disarm()
    void reader.cancel(reason).catch(() => {})
  }
  const arm = (): void => {
    if (closed) return
    disarm()
    timer = setTimeout(() => {
      if (closed) return
      trip(408)
      releaseSource()
      // Unblock a consumer waiting on the wrapped stream, if any.
      try {
        outputController?.error(new Error("request upload exceeded the idle window"))
      } catch {
        // The consumer already errored or closed; the hop abort carries the refusal.
      }
    }, HTTP_PREVIEW_LIMITS.uploadIdleMs)
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      ;(timer as { unref: () => void }).unref()
    }
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      outputController = controller
      // Armed before the first byte: an up-front stall is bounded too.
      arm()
    },
    async pull(controller) {
      // The window stays armed across the pending read: a source that
      // stalls mid-read (or before byte 1) trips it exactly like a stall
      // between reads.
      if (closed) {
        controller.close()
        return
      }
      let next: { done: boolean; value?: Uint8Array }
      try {
        next = await reader.read()
      } catch (cause) {
        disarm()
        controller.error(cause)
        return
      }
      if (next.done || next.value === undefined) {
        disarm()
        closed = true
        controller.close()
        return
      }
      const chunk = next.value
      bytes += chunk.byteLength
      if (bytes > HTTP_PREVIEW_LIMITS.maxRequestBodyBytes) {
        disarm()
        trip(413)
        releaseSource()
        controller.error(new Error("request body exceeded the preview bound"))
        return
      }
      // Arm before enqueue: once the consumer cancels, the closed flag
      // keeps this stream from re-arming the idle window.
      arm()
      controller.enqueue(chunk)
    },
    cancel: (reason) => {
      releaseSource(reason instanceof Error ? reason : undefined)
    }
  })
}
/**
 * Response hygiene mirrors the daemon's guest-response filtering: header
 * count and byte bounds are enforced before the response is released, any
 * reserved name is grounds for refusal (502), everything untrusted is
 * dropped, and the body is passed through untouched.
 */
const sanitizedResponse = (upstream: Response): Response | number => {
  const pairs = Array.from(upstream.headers.entries())
  if (pairs.length > HTTP_PREVIEW_LIMITS.maxHeaderFields) return 502
  const nominated = connectionNominated(
    upstream.headers.get("connection") === null ? [] : [upstream.headers.get("connection")!]
  )
  const headers = new Headers()
  let bytes = 0
  for (const [name, value] of pairs) {
    const key = name.toLowerCase()
    if (key.startsWith("microvm-")) return 502
    bytes += byteLength(name) + byteLength(value) + 4
    if (bytes > HTTP_PREVIEW_LIMITS.maxHeaderBytes) return 502
    if (isStrippedResponseHeader(key, nominated)) continue
    headers.append(name, value)
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  })
}

export const makeSandboxHttpIngress = (options: SandboxHttpIngressOptions): SandboxHttpIngress => {
  const origin = secureOrigin(options.url)
  const upstreamFetch = options.fetch
  if (typeof upstreamFetch !== "function") {
    throw new TypeError("fetch is required by the runtime-neutral HTTP ingress adapter")
  }
  const prefix = `${origin.origin}${DAEMON_HTTP_ROUTE_PREFIX}${encodeURIComponent(options.vmId)}`

  const handle = async (request: Request): Promise<Response> => {
    if (request.method === "CONNECT" || request.method === "TRACE") return refusal(405)
    const targetUrl = new URL(request.url)
    const target = `${targetUrl.pathname}${targetUrl.search}`
    if (!targetIsOriginForm(target)) return refusal(400)
    const admitted = admitHeaders(request)
    if (admitted.refused !== 0) return refusal(admitted.refused)

    const headers = new Headers(admitted.headers)
    // The one credential injection of the final daemon hop.
    headers.set("proxy-authorization", `Bearer ${options.httpIngressToken}`)

    // One controller owns every abort this adapter performs: body-bound and
    // idle trips kill the daemon hop; the response-head deadline aborts only
    // until the head arrives; the caller's own signal always applies.
    const controller = new AbortController()
    let settledStatus = 0
    const trip = (status: number): void => {
      if (settledStatus !== 0) return
      settledStatus = status
      controller.abort()
    }

    const declaredSize = declareBodySize(request)
    if (declaredSize !== undefined && declaredSize > HTTP_PREVIEW_LIMITS.maxRequestBodyBytes) {
      return refusal(413)
    }
    if (
      (request.body === null && declaredSize !== undefined && declaredSize > 0) ||
      (request.body !== null && declaredSize === 0)
    ) {
      return refusal(400)
    }
    const body = request.body === null
      ? undefined
      : boundedBodyStream(request.body as ReadableStream<Uint8Array>, trip)

    const signal = AbortSignal.any([request.signal, controller.signal])
    const headTimer = setTimeout(
      () => {
        if (!settledStatus) settledStatus = 504
        controller.abort()
      },
      HTTP_PREVIEW_LIMITS.responseHeadMs
    )
    if (typeof headTimer === "object" && headTimer !== null && "unref" in headTimer) {
      ;(headTimer as { unref: () => void }).unref()
    }

    let upstream: Response
    try {
      upstream = await upstreamFetch(prefix + target, {
        method: request.method,
        headers,
        redirect: "manual",
        signal,
        ...(body === undefined ? {} : { body, duplex: "half" })
      } as RequestInit)
    } catch {
      clearTimeout(headTimer)
      return refusal(settledStatus === 0 ? 502 : settledStatus)
    }
    clearTimeout(headTimer)
    if (settledStatus !== 0) {
      void upstream.body?.cancel()
      return refusal(settledStatus)
    }
    const filtered = sanitizedResponse(upstream)
    if (typeof filtered === "number") {
      void upstream.body?.cancel()
      return refusal(filtered)
    }
    return filtered
  }

  return { handle }
}
