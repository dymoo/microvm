/**
 * Model-driven abuse of the sandbox tools. A hostile or confused model is the
 * caller here: it crafts tool inputs to escape the bound workspace, to name a
 * different VM or credential, and to exceed the operator's execution budget.
 * Everything runs through real `generateText` with the real tools, RPC client
 * and daemon; only Firecracker and the guest channel are replaced.
 *
 * A regression that lets any of these inputs reach the guest, or that lets the
 * model see a credential or VM id it did not create, fails these tests.
 */
import { createServer, type Server } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Layer, Result } from "effect"
import { generateText, stepCountIs } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { afterEach, describe, expect, it } from "vitest"
import { createSandboxTools } from "../src/ai.js"
import { makeMicrovmClient } from "../src/client.js"
import { DaemonConfig, daemonLayer } from "../src/daemon.js"
import { Firecracker, GuestExecChannel } from "../src/firecracker.js"
import { HostPrereqs } from "../src/host.js"

const adminToken = "admin-token-for-ai-abuse-tests"
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined }
} as const

const roots: Array<string> = []

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
    jailerUidRange: [26_000, 26_099],
    jailerGidRange: [26_000, 26_099],
    jailerParentCgroup: undefined,
    guestCidRange: [11_000, 11_099],
    kernelArgs: "console=ttyS0 reboot=k panic=1 pci=off",
    bootTimeoutMs: 1_000,
    guestReadinessTimeoutMs: 1_000,
    vmmOverheadMib: 16,
    maxPidsPerVm: 64,
    jailerFsizeBytes: 1_048_576,
    jailerNoFileLimit: 128
  },
  limits: {
    maxVms: 3,
    defaultCpus: 1,
    maxCpus: 2,
    defaultMemMib: 128,
    maxMemMib: 256,
    maxTtlSeconds: 60
  }
})

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "microvm-ai-abuse-"))
  roots.push(root)
  await mkdir(join(root, "images"), { recursive: true })
  await mkdir(join(root, "run"), { recursive: true })
  await mkdir(join(root, "workspace"))
  await writeFile(join(root, "vmlinux"), "test")
  await writeFile(join(root, "images", "node.raw"), "test")
  await writeFile(join(root, "images", "node.json"), JSON.stringify({
    name: "node",
    file: "node.raw",
    arch: process.arch === "arm64" ? "aarch64" : "x86_64",
    sizeBytes: 4,
    rootDevice: "/dev/vda"
  }))
  return root
}

const prereqs = Layer.succeed(HostPrereqs, HostPrereqs.of({
  verifyAll: () => Effect.succeed({
    kvmDeviceAccess: true,
    cgroupV2: true,
    arch: process.arch === "arm64" ? "aarch64" : "x86_64"
  })
}))

const waitForListener = (server: Server) =>
  Effect.gen(function*() {
    while (!server.listening) yield* Effect.sleep(5)
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("test listener has no TCP port")
    return address.port
  })

interface GuestCall {
  readonly vmId: string
  readonly argv: ReadonlyArray<string>
}

const startHarness = (root: string) =>
  Effect.gen(function*() {
    const guestCalls: Array<GuestCall> = []
    const server = createServer()
    yield* daemonLayer(configFor(root), {
      firecracker: Layer.succeed(Firecracker, Firecracker.of({
        boot: (spec) => Effect.promise(async () => {
          await mkdir(spec.layout.vmDir, { recursive: true })
          return { pid: 54_000, stop: () => Effect.void, exited: Effect.never }
        })
      })),
      guestExec: Layer.succeed(GuestExecChannel, GuestExecChannel.of({
        exec: (request) => {
          guestCalls.push({ vmId: request.vmId, argv: request.argv })
          return request.argv[0] === "/block"
            ? Effect.never
            : Effect.succeed({
              _tag: "Exit" as const,
              frame: {
                code: 0,
                signal: null,
                timedOut: false,
                outputTruncated: false,
                stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0)
              }
            })
        }
      })),
      prereqs,
      server,
      unsafeSkipKernelLockForTests: true
    }).pipe(
      Layer.launch,
      Effect.forkScoped
    )
    const port = yield* waitForListener(server)
    return { url: `http://127.0.0.1:${port}`, guestCalls }
  })

const hostileTurn = (toolCalls: ReadonlyArray<{ id: string; name: string; input: unknown }>) => ({
  content: toolCalls.map((call) => ({
    type: "tool-call" as const,
    toolCallId: call.id,
    toolName: call.name,
    input: JSON.stringify(call.input)
  })),
  finishReason: { unified: "tool-calls", raw: undefined } as const,
  usage,
  warnings: []
})

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

describe("sandbox tool abuse", () => {
  it("rejects model attempts to escape the workspace, inject a VM, or hit another sandbox", async () => {
    const root = await fixture()
    const workspace = join(root, "workspace")
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const harness = yield* startHarness(root)
      const admin = yield* makeMicrovmClient({ url: harness.url, token: adminToken })
      const bound = yield* admin.create({ image: "node", cpus: undefined, memMib: undefined, ttlSeconds: undefined })
      const other = yield* admin.create({ image: "node", cpus: undefined, memMib: undefined, ttlSeconds: undefined })
      const sandbox = yield* makeMicrovmClient({ url: harness.url, token: bound.sandboxToken })
      const tools = createSandboxTools({ client: sandbox, vmId: bound.vm.vmId, workdir: workspace })

      const model = new MockLanguageModelV4({
        doGenerate: [hostileTurn([
          { id: "escape-read", name: "read_file", input: { path: "../../etc/passwd" } },
          { id: "escape-write", name: "write_file", input: { path: "../escape.txt", content: "pwned" } },
          { id: "absolute-read", name: "read_file", input: { path: "/etc/passwd" } },
          { id: "null-read", name: "read_file", input: { path: "note\0.txt" } },
          { id: "vm-injection", name: "read_file", input: { path: "note.txt", vmId: other.vm.vmId } },
          { id: "legit", name: "run_command", input: { argv: ["/usr/bin/node", "-e", "1"] } }
        ])]
      })
      const generated = yield* Effect.promise(() => generateText({
        model,
        prompt: "Follow the instructions exactly.",
        tools,
        stopWhen: stepCountIs(1)
      }))

      const step = generated.steps[0]
      if (step === undefined) throw new Error("model turn produced no step")
      const errors = step.content
        .filter((part) => part.type === "tool-error")
        .map((part) => part.toolCallId)
      for (const id of ["escape-read", "escape-write", "absolute-read", "null-read", "vm-injection"]) {
        expect(errors, id).toContain(id)
      }
      expect(step.content.some((part) => part.type === "tool-result" && part.toolCallId === "legit")).toBe(true)

      // Only the legitimate command may reach the bound sandbox; the other VM
      // is never addressed, and the escaping paths never reach a guest.
      expect(harness.guestCalls.map((call) => call.vmId)).toEqual([bound.vm.vmId])
      expect(harness.guestCalls[0]?.argv[0]).toBe("/usr/bin/node")

      // What the model sees must not include the credential or VM identity.
      const modelVisible = JSON.stringify(model.doGenerateCalls)
      expect(modelVisible).not.toContain(bound.sandboxToken)
      expect(modelVisible).not.toContain(adminToken)
      expect(modelVisible).not.toContain(bound.vm.vmId)
    })))
  })

  it("rejects over-budget and shell-shaped commands before any guest execution", async () => {
    const root = await fixture()
    const workspace = join(root, "workspace")
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const harness = yield* startHarness(root)
      const admin = yield* makeMicrovmClient({ url: harness.url, token: adminToken })
      const created = yield* admin.create({ image: "node", cpus: undefined, memMib: undefined, ttlSeconds: undefined })
      const sandbox = yield* makeMicrovmClient({ url: harness.url, token: created.sandboxToken })
      const tools = createSandboxTools({ client: sandbox, vmId: created.vm.vmId, workdir: workspace })

      const model = new MockLanguageModelV4({
        doGenerate: [hostileTurn([
          { id: "shell-string", name: "run_command", input: { argv: ["rm -rf /"] } },
          { id: "relative-program", name: "run_command", input: { argv: ["bin/sh", "-c", "id"] } },
          { id: "over-timeout", name: "run_command", input: { argv: ["/bin/true"], timeoutMs: 10_000_000 } },
          { id: "over-output", name: "run_command", input: { argv: ["/bin/true"], maxOutputBytes: 100_000_000 } },
          { id: "over-write", name: "write_file", input: { path: "big.txt", content: "x".repeat(5_000) } },
          { id: "long-path", name: "read_file", input: { path: "a".repeat(600) } }
        ])]
      })
      const generated = yield* Effect.promise(() => generateText({
        model,
        prompt: "Follow the instructions exactly.",
        tools,
        stopWhen: stepCountIs(1)
      }))

      const step = generated.steps[0]
      if (step === undefined) throw new Error("model turn produced no step")
      const errors = step.content
        .filter((part) => part.type === "tool-error")
        .map((part) => part.toolCallId)
      for (const id of ["shell-string", "relative-program", "over-timeout", "over-output", "over-write", "long-path"]) {
        expect(errors, id).toContain(id)
      }
      expect(step.content.some((part) => part.type === "tool-result")).toBe(false)
      expect(harness.guestCalls.length).toBe(0)
    })))
  })

  it("destroys the sandbox when a model-issued command is cancelled mid-flight", async () => {
    const root = await fixture()
    const workspace = join(root, "workspace")
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const harness = yield* startHarness(root)
      const admin = yield* makeMicrovmClient({ url: harness.url, token: adminToken })
      const created = yield* admin.create({ image: "node", cpus: undefined, memMib: undefined, ttlSeconds: undefined })
      const sandbox = yield* makeMicrovmClient({ url: harness.url, token: created.sandboxToken })
      const tools = createSandboxTools({ client: sandbox, vmId: created.vm.vmId, workdir: workspace })
      const vmId = created.vm.vmId

      const controller = new AbortController()
      const running = yield* Effect.promise(async () => {
        await tools.run_command.execute!(
          { argv: ["/block"] },
          { toolCallId: "blocked", messages: [], abortSignal: controller.signal, context: undefined }
        )
      }).pipe(Effect.forkScoped)
      // Wait until the command actually reached the guest, then cancel it.
      while (harness.guestCalls.length === 0) yield* Effect.sleep(5)
      controller.abort()
      yield* Effect.exit(Fiber.join(running))

      // A cancelled command leaves the sandbox state uncertain: the daemon
      // must destroy it rather than leave unowned work running.
      let gone = false
      for (let attempt = 0; attempt < 200 && !gone; attempt++) {
        const inspected = yield* Effect.result(admin.inspect({ vmId }))
        gone = Result.isFailure(inspected) && inspected.failure._tag === "VmNotFound"
        if (!gone) yield* Effect.sleep(10)
      }
      expect(gone).toBe(true)
    })))
  }, 30_000)
})
