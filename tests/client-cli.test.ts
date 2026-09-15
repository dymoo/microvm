import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createServer, type Server } from "node:http"
import { afterEach, describe, expect, it } from "vitest"

const cli = fileURLToPath(new URL("../dist/bin/client.js", import.meta.url))
const sandboxToken = `mvs_${"ab".repeat(24)}`
const vmId = "mvm-clitest01"
const servers: Array<Server> = []

interface RpcCall {
  readonly tag: string
  readonly payload: Record<string, unknown>
  readonly headers: ReadonlyArray<readonly [string, string]>
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

const startRpcMock = async () => {
  const calls: Array<RpcCall> = []
  const server = createServer((request, response) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const message = (Array.isArray(envelope) ? envelope[0] : envelope) as {
        id?: number
        tag?: string
        payload?: Record<string, unknown>
        headers?: ReadonlyArray<readonly [string, string]>
      }
      const call = {
        tag: message.tag ?? "",
        payload: message.payload ?? {},
        headers: message.headers ?? []
      }
      calls.push(call)
      const value = call.tag === "list"
        ? { vms: [] }
        : call.tag === "destroy"
        ? { vmId, destroyed: true }
        : {
            execId: "exec-cli",
            exitCode: 0,
            signal: null,
            timedOut: false,
            outputTruncated: false,
            stdoutB64: "",
            stderrB64: ""
          }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify([{
        _tag: "Exit",
        requestId: message.id ?? 0,
        exit: { _tag: "Success", value }
      }]))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("listener has no TCP port")
  return { url: `http://127.0.0.1:${address.port}`, calls }
}

const runCli = (url: string, args: ReadonlyArray<string>) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--url", url, "--token", sandboxToken, ...args], {
      env: { ...process.env, MICROVM_URL: "", MICROVM_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, stdout, stderr }))
  })

describe("microvm CLI credential and argv boundaries", () => {
  it("uses sandbox authorization for list/destroy and preserves exec argv after -- verbatim", async () => {
    const { url, calls } = await startRpcMock()

    const listed = await runCli(url, ["list", "--json"])
    expect(listed).toEqual(expect.objectContaining({ code: 0, stderr: "" }))
    expect(JSON.parse(listed.stdout)).toEqual({ vms: [] })

    const destroyed = await runCli(url, ["destroy", "--vm", vmId, "--json"])
    expect(destroyed).toEqual(expect.objectContaining({ code: 0, stderr: "" }))
    expect(JSON.parse(destroyed.stdout)).toEqual({ vmId, destroyed: true })

    const guestArgv = ["/usr/bin/python3", "", "--json", "--token", "guest-data"]
    const executed = await runCli(url, ["exec", "--vm", vmId, "--json", "--", ...guestArgv])
    expect(executed).toEqual(expect.objectContaining({ code: 0, stderr: "" }))

    expect(calls.map((call) => call.tag)).toEqual(["list", "destroy", "execute"])
    expect(calls[2]?.payload).toEqual(expect.objectContaining({ vmId, argv: guestArgv }))
    for (const call of calls) {
      expect(call.headers.filter(([name]) => name === "authorization")).toEqual([
        ["authorization", `Bearer ${sandboxToken}`]
      ])
    }
  })
})
