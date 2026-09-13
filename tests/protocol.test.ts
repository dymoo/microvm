/**
 * Protocol contracts: request bounding before any guest I/O, wire-pattern
 * schemas, the RPC surface shape, and daemon-side limit clamping.
 */
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  CreateResult,
  DestroyUncertain,
  ExecId,
  GUEST_EXEC_VSOCK_PORT,
  GUEST_HTTP_VSOCK_PORT,
  GUEST_SERVICE_VSOCK_PORT,
  ImageName,
  MAX_ARGV_ENTRIES,
  StartWebServiceRequest,
  VmId,
  execRejection,
  webServiceStartRejection
} from "../src/protocol.js"

const isValid = Schema.is

describe("wire patterns", () => {
  it("accepts well-formed vm ids and rejects everything else", () => {
    const isVmId = isValid(VmId)
    expect(isVmId("mvm-abc12345")).toBe(true)
    expect(isVmId("mvm-0123456789abcdef012345")).toBe(true)
    expect(isVmId("MVM-abc12345")).toBe(false)
    expect(isVmId("mvm-")).toBe(false)
    expect(isVmId("mvm-abc")).toBe(false)
    expect(isVmId("mvm-abc12345/../../etc")).toBe(false)
    expect(isVmId("")).toBe(false)
  })

  it("enforces exec id charset", () => {
    const isExecId = isValid(ExecId)
    expect(isExecId("exec-1")).toBe(true)
    expect(isExecId("a".repeat(128))).toBe(true)
    expect(isExecId("a".repeat(129))).toBe(false)
    expect(isExecId("bad id")).toBe(false)
    expect(isExecId("")).toBe(false)
  })

  it("enforces image name charset", () => {
    const isImage = isValid(ImageName)
    expect(isImage("node22-python312")).toBe(true)
    expect(isImage("../etc/passwd")).toBe(false)
    expect(isImage("")).toBe(false)
    expect(isImage("-leading-dash")).toBe(false)
  })
})
describe("fixed guest channels", () => {
  it("reserves one non-selectable port per protocol purpose", () => {
    expect(GUEST_EXEC_VSOCK_PORT).toBe(1024)
    expect(GUEST_HTTP_VSOCK_PORT).toBe(1025)
    expect(GUEST_SERVICE_VSOCK_PORT).toBe(1026)
  })
})

describe("destroy uncertainty", () => {
  it("names active ingress-scope proof failures as HTTP rather than cgroup teardown", () => {
    expect(Schema.decodeUnknownResult(DestroyUncertain)({
      _tag: "DestroyUncertain",
      vmId: "mvm-abc12345",
      phase: "http",
      reason: "HTTP connection scopes remained active after VM teardown"
    })._tag).toBe("Success")
  })
})

describe("durable web-service wire schemas", () => {
  const decodeStartRequest = Schema.decodeUnknownResult(StartWebServiceRequest)

  it("accepts bounded start requests without exposing host or port selection", () => {
    expect(decodeStartRequest({
      argv: ["/usr/bin/npm", "run", "dev"],
      cwd: "/workspace",
      env: { NODE_ENV: "development" }
    })._tag).toBe("Success")
    expect(decodeStartRequest({ argv: ["/bin/true"] })._tag).toBe("Success")
  })

  it("rejects empty, excessive, or oversized request fields at schema admission", () => {
    expect(decodeStartRequest({ argv: [], cwd: undefined, env: undefined })._tag).toBe("Failure")
    expect(decodeStartRequest({
      argv: Array.from({ length: MAX_ARGV_ENTRIES + 1 }, () => "/bin/true"),
      cwd: undefined,
      env: undefined
    })._tag).toBe("Failure")
    expect(decodeStartRequest({
      argv: ["/bin/echo", "x".repeat(4097)],
      cwd: undefined,
      env: undefined
    })._tag).toBe("Failure")
  })

  it("enforces byte-total bounds and protects manifest-owned service environment", () => {
    expect(webServiceStartRejection(["/bin/true"], undefined, { PORT: "4000" })).toBeDefined()
    expect(webServiceStartRejection(["/bin/true"], undefined, { HOSTNAME: "0.0.0.0" })).toBeDefined()
    expect(webServiceStartRejection(["/bin/echo", "€".repeat(1400)], undefined, undefined)).toBeDefined()
    expect(webServiceStartRejection(
      ["/usr/bin/npm", "run", "dev"],
      "/workspace",
      { NODE_ENV: "development" }
    )).toBeUndefined()
    expect(webServiceStartRejection(
      ["/usr/bin/node", ...Array.from({ length: 16 }, () => "x".repeat(4_000))],
      undefined,
      { BIG: "y".repeat(8_192) }
    )).toBeUndefined()
  })

  it("rejects an uninspectable service request instead of throwing", () => {
    const env = new Proxy<Record<string, string>>({}, {
      ownKeys: () => {
        throw new Error("hostile property enumeration")
      }
    })
    expect(webServiceStartRejection(["/bin/true"], undefined, env)).toBeDefined()
  })

  it("represents the create ingress capability only when configured", () => {
    const baseVm = {
      vmId: "mvm-abc12345",
      owningHost: "local",
      state: "running" as const,
      image: "node",
      cpus: 1,
      memMib: 512,
      createdAtEpochMs: 1,
      expiresAtEpochMs: undefined
    }
    const decodeCreateResult = Schema.decodeUnknownResult(CreateResult)
    expect(decodeCreateResult({
      vm: baseVm,
      sandboxToken: "mvs_control",
      httpIngressToken: "mvi_ingress"
    })._tag).toBe("Success")
    expect(decodeCreateResult({
      vm: baseVm,
      sandboxToken: "mvs_control",
      httpIngressToken: undefined
    })._tag).toBe("Success")
  })
})

describe("exec request bounding (enforced before any guest I/O)", () => {
  const ok = { argv: ["/usr/bin/node", "-e", "console.log(1)"], cwd: "/workspace", env: { FOO: "bar" } }

  it("accepts an in-bounds request", () => {
    expect(execRejection(ok.argv, ok.cwd, ok.env)).toBeUndefined()
  })

  // Rejection boundary behavior is observable as "rejected vs accepted";
  // message wording is intentionally not pinned.
  const rejected = (
    argv: ReadonlyArray<string>,
    cwd?: string,
    env?: Record<string, string>
  ): boolean => execRejection(argv, cwd, env) !== undefined

  it("requires a non-empty argv", () => {
    expect(rejected([], undefined, undefined)).toBe(true)
  })

  it("requires an absolute argv[0] (no shell, no relative resolution)", () => {
    expect(rejected(["node", "--version"], undefined, undefined)).toBe(true)
    expect(execRejection(["/usr/bin/node", "--version"], undefined, undefined)).toBeUndefined()
  })

  it("bounds argv entry count", () => {
    const many = Array.from({ length: MAX_ARGV_ENTRIES + 1 }, () => "/bin/true")
    expect(rejected(many)).toBe(true)
    expect(rejected(Array.from({ length: MAX_ARGV_ENTRIES }, () => "/bin/true"))).toBe(false)
  })

  it("bounds per-argument and total argv bytes", () => {
    expect(rejected(["/bin/echo", "x".repeat(5000)])).toBe(true)
    const halves = Array.from({ length: 32 }, () => "/x".repeat(2000))
    expect(rejected(["/bin/echo", ...halves])).toBe(true)
  })

  it("requires an absolute cwd within the byte bound", () => {
    expect(rejected(["/bin/true"], "workspace")).toBe(true)
    expect(rejected(["/bin/true"], "/" + "x".repeat(5000))).toBe(true)
    expect(rejected(["/bin/true"], "/workspace")).toBe(false)
  })

  it("validates env key names and bounds", () => {
    expect(rejected(["/bin/true"], undefined, { "bad key": "v" })).toBe(true)
    expect(rejected(["/bin/true"], undefined, { OK: "x".repeat(9000) })).toBe(true)
    const tooMany: Record<string, string> = {}
    for (let i = 0; i < 65; i++) tooMany[`K${i}`] = "v"
    expect(rejected(["/bin/true"], undefined, tooMany)).toBe(true)
    expect(rejected(["/bin/true"], undefined, { OK: "v" })).toBe(false)
  })
})

