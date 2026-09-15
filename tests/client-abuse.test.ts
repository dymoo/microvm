/**
 * Hostile client contracts. These drive the real `makeMicrovmClient` against
 * a raw HTTP listener, so they prove what a caller can observe no matter how
 * the RPC stack is wired:
 *
 * - an ambiguous request (socket death with no answer) is sent exactly once
 *   and surfaced as a failure — never retried into a duplicate VM or a
 *   duplicate exec,
 * - credentials are never attached to a URL that is not loopback plaintext or
 *   HTTPS, and never to an origin with credentials, path, query or fragment
 *   (no authority confusion / token leakage to a wrong request target).
 */
import { createServer, type Server } from "node:http"
import { Effect, Exit } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeMicrovmClient } from "../src/client-raw.js"
import type { VmId } from "../src/protocol.js"

const createPayload = {
  image: "node",
  imageDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  cpus: undefined,
  memMib: undefined,
  ttlSeconds: undefined
} as const

const servers: Array<Server> = []

interface DroppingServer {
  readonly url: string
  readonly requests: () => number
}

/** Accepts the request, then kills the connection without any answer. */
const startDroppingServer = async (): Promise<DroppingServer> => {
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    request.resume()
    request.on("end", () => response.socket?.destroy())
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("dropping listener has no TCP port")
  return { url: `http://127.0.0.1:${address.port}`, requests: () => requests }
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe("client ambiguity handling", () => {
  it("sends an ambiguous create and exec exactly once and surfaces the failure", async () => {
    const dropping = await startDroppingServer()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeMicrovmClient({ url: dropping.url, token: "client-abuse-token" })

      const created = yield* Effect.exit(client.create(createPayload))
      expect(Exit.isFailure(created)).toBe(true)
      yield* Effect.sleep(250)
      expect(dropping.requests()).toBe(1)

      const executed = yield* Effect.exit(client.execute({
        vmId: "mvm-abc12345" as VmId,
        argv: ["/bin/true"],
        cwd: undefined,
        env: undefined,
        timeoutMs: undefined,
        maxOutputBytes: undefined
      }))
      expect(Exit.isFailure(executed)).toBe(true)
      yield* Effect.sleep(250)
      expect(dropping.requests()).toBe(2)
    })))
  })
})

describe("client credential-target policy", () => {
  it("refuses to build a client for plaintext off loopback or authority-confused URLs", async () => {
    const listener = await startDroppingServer()
    const port = new URL(listener.url).port
    const hostileUrls = [
      `http://127.0.0.1:${port}/rpc`,
      `http://127.0.0.1:${port}/other`,
      `http://user:pass@127.0.0.1:${port}`,
      `http://127.0.0.1:${port}/?token=stolen`,
      `http://127.0.0.1:${port}/#fragment`,
      "http://microvm.example.test:9443",
      "http://127.0.0.1.attacker.test:9443",
      "http://localhost.attacker.test:9443",
      "http://10.0.0.5:9443"
    ]
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      for (const url of hostileUrls) {
        const built = yield* Effect.exit(makeMicrovmClient({ url, token: "client-abuse-token" }))
        expect(Exit.isFailure(built), url).toBe(true)
      }
      const emptyToken = yield* Effect.exit(makeMicrovmClient({ url: listener.url, token: "" }))
      expect(Exit.isFailure(emptyToken)).toBe(true)
    })))
    expect(listener.requests()).toBe(0)

    // A loopback plaintext origin is still accepted, so the policy above
    // cannot be satisfied by refusing everything.
    await Effect.runPromise(Effect.scoped(
      makeMicrovmClient({ url: listener.url, token: "client-abuse-token" }).pipe(Effect.asVoid)
    ))
  })
})
