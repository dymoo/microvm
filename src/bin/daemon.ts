#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { daemonLayer, loadDaemonConfig } from "../daemon.js"
import { HostPrereqs } from "../host.js"

class DaemonUsageError extends Schema.TaggedError<DaemonUsageError>()("DaemonUsageError", {
  message: Schema.String
}) {}

const configPath = (argv: ReadonlyArray<string>): Effect.Effect<string, DaemonUsageError> =>
  Effect.gen(function*() {
    const index = argv.indexOf("--config")
    const path = index === -1 ? undefined : argv[index + 1]
    if (path === undefined || path.length === 0) {
      return yield* Effect.fail(new DaemonUsageError({ message: "usage: microvmd --config PATH" }))
    }
    return path
  })

const errorTag = (error: unknown): string =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : "DaemonError"

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    if ("reason" in error && typeof error.reason === "string") return error.reason
    if ("message" in error && typeof error.message === "string") return error.message
  }
  return String(error)
}

const main = Effect.gen(function*() {
  const path = yield* configPath(process.argv.slice(2))
  const config = yield* loadDaemonConfig(path)
  const capabilities = yield* HostPrereqs.pipe(
    Effect.flatMap((service) => service.verifyAll()),
    Effect.provide(HostPrereqs.layer(config.firecracker))
  )
  yield* Effect.logInfo("microVM daemon prerequisites verified", {
    host: config.listen.host,
    port: config.listen.port,
    tls: config.tls !== undefined,
    arch: capabilities.arch,
    maxVms: config.limits.maxVms,
    imagesDir: config.firecracker.imagesDir,
    runStateDir: config.firecracker.runStateDir
  })
  return yield* Layer.launch(daemonLayer(config))
})

NodeRuntime.runMain(main.pipe(
  Effect.catch((error) => Effect.sync(() => {
    process.stderr.write(`${errorTag(error)}: ${errorMessage(error)}\n`)
    process.exitCode = errorTag(error) === "HostPrereqFailed" ? 5 : 1
  }))
))
