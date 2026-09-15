/**
 * Daemon origin parsing shared by every client runtime. Deliberately runtime
 * neutral: the workerd client imports this module, so it must never depend on
 * `node:*` builtins.
 */

/** True only for the localhost name or a numeric address in 127/8 or ::1. */
export const isLoopbackHost = (hostname: string): boolean => {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname
  if (unbracketed === "localhost" || unbracketed === "::1") return true
  // Numeric dotted-quad IPv4 only; a loopback-looking prefix is not enough
  // (`127.attacker.example` must never pass). Numeric-only parsing also
  // rejects hexadecimal or octal forms that would be interpreted differently
  // by other resolvers.
  if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(unbracketed)) {
    return false
  }
  const octets = unbracketed.split(".").map(Number)
  if (octets.some((octet) => octet > 255)) return false
  return octets[0] === 127
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
