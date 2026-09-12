import { isIP } from "node:net"

/** True only for the localhost name or a numeric address in 127/8 or ::1. */
export const isLoopbackHost = (hostname: string): boolean => {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname
  if (unbracketed === "localhost" || unbracketed === "::1") return true
  if (isIP(unbracketed) !== 4) return false
  const firstOctet = Number(unbracketed.slice(0, unbracketed.indexOf(".")))
  return firstOctet === 127
}

/** Parses an origin and rejects authority confusion or plaintext off loopback. */
export const secureOrigin = (input: string): URL => {
  const origin = new URL(input)
  if (origin.username.length > 0 || origin.password.length > 0 ||
    (origin.pathname !== "" && origin.pathname !== "/") ||
    origin.search.length > 0 || origin.hash.length > 0) {
    throw new Error("URL must be an origin without credentials, path, query, or fragment")
  }
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && isLoopbackHost(origin.hostname))) {
    throw new Error("URL must use HTTPS unless it targets loopback")
  }
  return origin
}
