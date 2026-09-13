import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { Effect, Layer } from "effect"
import { generateText, simulateReadableStream, stepCountIs, streamText } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { describe, expect, it } from "vitest"
import { createSandboxTools, SANDBOX_SYSTEM_PROMPT, TOOL_GUIDANCE } from "../src/ai.js"
import { makeMicrovmClient } from "../src/client.js"
import { DaemonConfig, daemonLayer } from "../src/daemon.js"
import {
  Firecracker,
  GuestExecChannel,
  GuestTransportFault,
  type GuestExecSuccess
} from "../src/firecracker.js"
import { HostPrereqs } from "../src/host.js"

const adminToken = "admin-token-for-ai-integration"
const fixtureImageBytes = "test"
const fixtureImageDigest = `sha256:${createHash("sha256").update(fixtureImageBytes).digest("hex")}`
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined }
} as const

const requiredGuidance = [
  "/workspace",
  "absolute guest executable",
  "no NIC",
  "package downloads",
  "/usr/local/bin/microvm-next-init",
  "/usr/bin/git",
  "127.0.0.1:3000",
  "trusted HTTP-only",
  "arbitrary TCP/UDP",
  "caller-selected destinations",
  "direct daemon access",
  "private guest root is ephemeral",
  "one coherent local commit",
  "require clean status",
  "record its SHA",
  "not durable",
  "cannot push",
  "export or materialize and verify",
  "owns any external push",
  "unexported checkpoint",
  "orchestrator prerequisites",
  "not evidence that a command did not start"
] as const

const configFor = (root: string) => new DaemonConfig({
  listen: { host: "127.0.0.1", port: 0 },
  advertisedUrl: "http://127.0.0.1:1",
  tls: undefined,
  auth: { adminTokens: [adminToken] },
  firecracker: {
    firecrackerBinary: "/usr/bin/false",
    flockBinary: undefined,
    jailerBinary: "/usr/bin/false",
    kernelImage: join(root, "vmlinux"),
    imagesDir: join(root, "images"),
    runStateDir: join(root, "run"),
    jailerUidRange: [22_000, 22_099],
    jailerGidRange: [22_000, 22_099],
    jailerParentCgroup: undefined,
    guestCidRange: [7_000, 7_099],
    kernelArgs: "console=ttyS0 reboot=k panic=1 pci=off",
    bootTimeoutMs: 1_000,
    guestReadinessTimeoutMs: 1_000,
    vmmOverheadMib: 16,
    maxPidsPerVm: 64,
    jailerFsizeBytes: 1_048_576,
    jailerNoFileLimit: 128
  },
  limits: {
    maxVms: 2,
    defaultCpus: 1,
    maxCpus: 2,
    defaultMemMib: 128,
    maxMemMib: 256,
    maxTtlSeconds: 60
  }
})

const waitForListener = (server: ReturnType<typeof createServer>) => Effect.gen(function*() {
  while (!server.listening) yield* Effect.sleep(5)
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("test listener has no TCP port")
  return address.port
})

const runLocalGuest = (
  workspace: string,
  seenArgv: Array<ReadonlyArray<string>>,
  request: Parameters<GuestExecChannel["Service"]["exec"]>[0]
): Effect.Effect<GuestExecSuccess, GuestTransportFault> =>
  Effect.callback((resume, signal) => {
    seenArgv.push(request.argv)
    const executable = request.argv[0] === "/usr/bin/node" ? process.execPath : request.argv[0]!
    const args = request.argv.slice(1).map((arg) => arg === "/workspace" ? workspace : arg)
    const child = spawn(executable, args, {
      cwd: request.cwd === "/workspace" || request.cwd === undefined ? workspace : request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ["ignore", "pipe", "pipe"]
    })
    const stdout: Array<Buffer> = []
    const stderr: Array<Buffer> = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.once("error", (cause) => resume(Effect.fail(new GuestTransportFault({
      vmId: request.vmId,
      reason: `portable guest spawn failed: ${cause.message}`
    }))))
    child.once("close", (code, childSignal) => resume(Effect.succeed({
      _tag: "Exit",
      frame: {
        code: code ?? 128,
        signal: childSignal,
        timedOut: false,
        outputTruncated: false,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr)
      }
    })))
    signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true })
  })

describe("Vercel AI SDK sandbox tools", () => {
  it("presents the operating contract and bounded tools to the model", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [{
        content: [{ type: "text", text: "ready" }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: []
      }]
    })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeMicrovmClient({
        url: "http://127.0.0.1:1",
        token: "unused-guidance-smoke-token"
      })
      const tools = createSandboxTools({ client, vmId: "mvm-guidance" })
      yield* Effect.promise(() => generateText({
        model,
        system: `${SANDBOX_SYSTEM_PROMPT}\n\n${TOOL_GUIDANCE}`,
        prompt: "Prepare the sandbox safely.",
        tools
      }))
    })))

    const visible = JSON.stringify(model.doGenerateCalls)
    for (const toolName of ["run_command", "read_file", "write_file"]) {
      expect(visible, toolName).toContain(toolName)
    }
    for (const guidance of requiredGuidance) {
      expect(visible, guidance).toContain(guidance)
    }
    expect(visible).not.toContain("unused-guidance-smoke-token")
    expect(visible).not.toContain("mvm-guidance")
  })

  it("executes generateText and streamText tool calls through authenticated RPC without exposing credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "microvm-ai-"))
    const workspace = join(root, "workspace")
    await mkdir(join(root, "images"), { recursive: true })
    await mkdir(join(root, "run"), { recursive: true })
    await mkdir(workspace)
    await writeFile(join(root, "vmlinux"), "test")
    await writeFile(join(root, "images", "node.raw"), fixtureImageBytes)
    await writeFile(join(root, "images", "node.json"), JSON.stringify({
      name: "node",
      file: "node.raw",
      arch: process.arch === "arm64" ? "aarch64" : "x86_64",
      sizeBytes: 4,
      rootDevice: "/dev/vda",
      imageDigest: fixtureImageDigest
    }))
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const seenArgv: Array<ReadonlyArray<string>> = []
        const firecracker = Layer.succeed(Firecracker, Firecracker.of({
          boot: (spec) => Effect.promise(async () => {
            await mkdir(spec.layout.vmDir, { recursive: true })
            return { pid: 49, imageDigest: fixtureImageDigest, stop: () => Effect.void, exited: Effect.never }
          })
        }))
        const guest = Layer.succeed(GuestExecChannel, GuestExecChannel.of({
          exec: (request) => runLocalGuest(workspace, seenArgv, request)
        }))
        const prereqs = Layer.succeed(HostPrereqs, HostPrereqs.of({
          verifyAll: () => Effect.succeed({
            kvmDeviceAccess: true,
            cgroupV2: true,
            arch: process.arch === "arm64" ? "aarch64" : "x86_64"
          })
        }))
        const server = createServer()
        yield* daemonLayer(configFor(root), {
          firecracker, guestExec: guest, prereqs, server, unsafeSkipKernelLockForTests: true
        }).pipe(
          Layer.launch,
          Effect.forkScoped
        )
        const url = `http://127.0.0.1:${yield* waitForListener(server)}`
        const admin = yield* makeMicrovmClient({ url, token: adminToken })
        const created = yield* admin.create({ image: "node", imageDigest: fixtureImageDigest, cpus: undefined, memMib: undefined, ttlSeconds: undefined })
        const sandbox = yield* makeMicrovmClient({ url, token: created.sandboxToken })
        const tools = createSandboxTools({ client: sandbox, vmId: created.vm.vmId, workdir: "/workspace" })

        const generatedModel = new MockLanguageModelV4({
          doGenerate: [
            {
              content: [{
                type: "tool-call",
                toolCallId: "write-1",
                toolName: "write_file",
                input: JSON.stringify({ path: "note.txt", content: "héllo" })
              }],
              finishReason: { unified: "tool-calls", raw: undefined },
              usage,
              warnings: []
            },
            {
              content: [{ type: "text", text: "written" }],
              finishReason: { unified: "stop", raw: undefined },
              usage,
              warnings: []
            }
          ]
        })
        const generated = yield* Effect.promise(() => generateText({
          model: generatedModel,
          system: `${SANDBOX_SYSTEM_PROMPT}\n\n${TOOL_GUIDANCE}`,
          prompt: "Write the note.",
          tools,
          stopWhen: stepCountIs(2)
        }))
        expect(generated.text).toBe("written")
        expect(yield* Effect.promise(() => readFile(join(workspace, "note.txt"), "utf8"))).toBe("héllo")
        const visibleGenerate = JSON.stringify(generatedModel.doGenerateCalls)
        expect(visibleGenerate).not.toContain(adminToken)
        expect(visibleGenerate).not.toContain(created.sandboxToken)
        expect(visibleGenerate).not.toContain(created.vm.vmId)
        for (const guidance of requiredGuidance) {
          expect(visibleGenerate, guidance).toContain(guidance)
        }

        const streamedModel = new MockLanguageModelV4({
          doStream: [
            {
              stream: simulateReadableStream({ chunks: [
                {
                  type: "tool-call",
                  toolCallId: "read-1",
                  toolName: "read_file",
                  input: JSON.stringify({ path: "note.txt", maxBytes: 3 })
                },
                {
                  type: "tool-call",
                  toolCallId: "run-1",
                  toolName: "run_command",
                  input: JSON.stringify({ argv: ["/usr/bin/node", "-e", "process.stdout.write('node-ok')"] })
                },
                { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage }
              ] })
            },
            {
              stream: simulateReadableStream({ chunks: [
                { type: "text-start", id: "text-1" },
                { type: "text-delta", id: "text-1", delta: "done" },
                { type: "text-end", id: "text-1" },
                { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }
              ] })
            }
          ]
        })
        const streamed = streamText({
          model: streamedModel,
          prompt: "Read the note and run Node.",
          tools,
          stopWhen: stepCountIs(2)
        })
        expect(yield* Effect.promise(() => streamed.text)).toBe("done")
        const steps = yield* Effect.promise(() => streamed.steps)
        const outputs = steps.flatMap((step) => step.toolResults.map((result) => result.output))
        expect(outputs).toContainEqual({ path: "note.txt", content: "hé", truncated: true })
        expect(outputs).toContainEqual(expect.objectContaining({ stdout: "node-ok", exitCode: 0 }))
        expect(seenArgv.some((argv) => argv[0] === "/usr/bin/python3")).toBe(true)
        expect(seenArgv.some((argv) => argv[0] === "/usr/bin/node")).toBe(true)
      })))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
