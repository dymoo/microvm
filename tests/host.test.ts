import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ImageManifest } from "../src/host.js"

const decodeManifest = Schema.decodeUnknownResult(ImageManifest)
const baseManifest = {
  name: "node",
  file: "node.raw",
  arch: "aarch64" as const
}

describe("image HTTP endpoint manifest", () => {
  it("keeps HTTP preview optional while requiring web when endpoint metadata is present", () => {
    expect(decodeManifest(baseManifest)._tag).toBe("Success")
    expect(decodeManifest({ ...baseManifest, httpEndpoints: {} })._tag).toBe("Failure")
  })

  it("accepts only integer web ports from 1024 through 65535", () => {
    expect(decodeManifest({ ...baseManifest, httpEndpoints: { web: { port: 1024 } } })._tag).toBe("Success")
    expect(decodeManifest({ ...baseManifest, httpEndpoints: { web: { port: 3000 } } })._tag).toBe("Success")
    expect(decodeManifest({ ...baseManifest, httpEndpoints: { web: { port: 65_535 } } })._tag).toBe("Success")

    for (const port of [1023, 65_536, 3000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(decodeManifest({ ...baseManifest, httpEndpoints: { web: { port } } })._tag).toBe("Failure")
    }
  })

  it("requires a port when the web endpoint is declared", () => {
    expect(decodeManifest({ ...baseManifest, httpEndpoints: { web: {} } })._tag).toBe("Failure")
    expect(decodeManifest({ ...baseManifest, httpEndpoints: { web: { port: "3000" } } })._tag).toBe("Failure")
  })
})
