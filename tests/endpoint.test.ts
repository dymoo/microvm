import { describe, expect, it } from "vitest"
import { isLoopbackHost, secureOrigin } from "../src/endpoint.js"

describe("endpoint security policy", () => {
  it("accepts only exact localhost and numeric loopback addresses for plaintext", () => {
    expect(isLoopbackHost("localhost")).toBe(true)
    expect(isLoopbackHost("127.0.0.1")).toBe(true)
    expect(isLoopbackHost("127.255.3.9")).toBe(true)
    expect(isLoopbackHost("[::1]")).toBe(true)
    expect(() => secureOrigin("http://127.0.0.1:9443")).not.toThrow()
  })

  it("rejects DNS names that merely begin with a loopback-looking prefix", () => {
    expect(isLoopbackHost("127.attacker.example")).toBe(false)
    expect(() => secureOrigin("http://127.attacker.example:9443")).toThrow(/HTTPS/)
    expect(() => secureOrigin("http://localhost.attacker.example:9443")).toThrow(/HTTPS/)
  })
})
