import { Effect, Result, Schema, Scope } from "effect"
import { RpcClientError } from "effect/unstable/rpc"
import { makeMicrovmClient, type MicrovmClient } from "./client.js"
import { secureOrigin } from "./endpoint.js"
import {
  BootFailed,
  CapacityExceeded,
  DestroyUncertain,
  Forbidden,
  GuestExecError,
  HostPrereqFailed,
  ImageNotAllowed,
  Unauthenticated,
  VmNotFound,
  VmPoisoned,
  type DestroyResult,
  type ExecResult,
  type VmId,
  type VmInfo,
  type CreateRequest,
  type ExecuteRequest,
} from "./protocol.js"

export interface ClusterEndpoint {
  /** Operator-configured daemon origin. Response metadata never replaces it. */
  readonly url: string
  readonly token: string
  readonly ca?: string | undefined
}

export interface MicrovmClusterOptions {
  readonly endpoints: ReadonlyArray<ClusterEndpoint>
  /** Per-endpoint budget for read-only health/list probes (default 2000ms). */
  readonly healthTimeoutMs?: number | undefined
}

export class ClusterRoutingError extends Schema.TaggedError<ClusterRoutingError>()("ClusterRoutingError", {
  reason: Schema.String
}) {}

export class ClusterEndpointUnavailable extends Schema.TaggedError<ClusterEndpointUnavailable>()(
  "ClusterEndpointUnavailable",
  { endpoint: Schema.String, reason: Schema.String }
) {}

interface EndpointRuntime {
  readonly origin: string
  readonly client: MicrovmClient
}

export type ClusterCreateError =
  | BootFailed | CapacityExceeded | Forbidden | HostPrereqFailed | ImageNotAllowed
  | Unauthenticated | RpcClientError.RpcClientError | ClusterRoutingError | ClusterEndpointUnavailable
export type ClusterInspectError =
  Forbidden | Unauthenticated | VmNotFound | RpcClientError.RpcClientError
  | ClusterRoutingError | ClusterEndpointUnavailable
export type ClusterExecuteError =
  Forbidden | GuestExecError | Unauthenticated | VmNotFound | VmPoisoned | CapacityExceeded
  | RpcClientError.RpcClientError | ClusterRoutingError | ClusterEndpointUnavailable
export type ClusterDestroyError =
  DestroyUncertain | Forbidden | Unauthenticated | VmNotFound
  | RpcClientError.RpcClientError | ClusterRoutingError | ClusterEndpointUnavailable
export type ClusterListError =
  Forbidden | Unauthenticated | RpcClientError.RpcClientError | ClusterRoutingError | ClusterEndpointUnavailable

export interface SandboxHandle {
  readonly vm: VmInfo
  /** Sandbox-scoped client closed over the selected configured daemon. */
  readonly client: MicrovmClient
  readonly execute: (request: Omit<ExecuteRequest, "vmId">) => Effect.Effect<ExecResult, ClusterExecuteError>
  readonly inspect: () => Effect.Effect<VmInfo, ClusterInspectError>
  readonly destroy: () => Effect.Effect<DestroyResult, ClusterDestroyError>
}

export interface MicrovmCluster {
  readonly create: (request: CreateRequest) => Effect.Effect<SandboxHandle, ClusterCreateError | ClusterListError>
  readonly inspect: (vmId: VmId) => Effect.Effect<VmInfo, ClusterInspectError | ClusterListError>
  readonly execute: (request: ExecuteRequest) => Effect.Effect<ExecResult, ClusterExecuteError | ClusterListError>
  readonly destroy: (vmId: VmId) => Effect.Effect<DestroyResult, ClusterDestroyError | ClusterListError>
  readonly list: () => Effect.Effect<ReadonlyArray<VmInfo>, ClusterListError>
}

const isCapacityExceeded = (error: unknown): error is CapacityExceeded =>
  error instanceof CapacityExceeded

/**
 * Acquires a client for a static daemon set. Placement health checks are safe
 * reads. A create is retried only after an explicit CapacityExceeded response;
 * transport and boot failures are ambiguous and are returned immediately.
 */
export const makeMicrovmCluster = (
  options: MicrovmClusterOptions
): Effect.Effect<MicrovmCluster, ClusterRoutingError, Scope.Scope> =>
  Effect.gen(function*() {
    const clusterScope = yield* Scope.Scope
    if (options.endpoints.length === 0) {
      return yield* Effect.fail(new ClusterRoutingError({ reason: "at least one cluster endpoint is required" }))
    }
    const healthTimeoutMs = options.healthTimeoutMs ?? 2_000
    if (!Number.isSafeInteger(healthTimeoutMs) || healthTimeoutMs < 1 || healthTimeoutMs > 10_000) {
      return yield* Effect.fail(new ClusterRoutingError({
        reason: "healthTimeoutMs must be an integer from 1 to 10000"
      }))
    }
    const seen = new Set<string>()
    const runtimes: Array<EndpointRuntime> = []
    for (let index = 0; index < options.endpoints.length; index++) {
      const endpoint = options.endpoints[index]!
      let origin: string
      try {
        origin = secureOrigin(endpoint.url).origin
      } catch {
        return yield* Effect.fail(new ClusterRoutingError({ reason: `cluster endpoint ${index} is invalid` }))
      }
      if (seen.has(origin)) {
        return yield* Effect.fail(new ClusterRoutingError({ reason: `duplicate cluster endpoint: ${origin}` }))
      }
      seen.add(origin)
      const client = yield* makeMicrovmClient({ url: origin, token: endpoint.token, ca: endpoint.ca }).pipe(
        Effect.mapError((error) => new ClusterRoutingError({ reason: error.reason }))
      )
      runtimes.push({ origin, client })
    }

    const owners = new Map<string, EndpointRuntime>()
    let placementCursor = 0

    const poll = () => Effect.forEach(runtimes, (endpoint, index) =>
      Effect.result(endpoint.client.list({}).pipe(
        Effect.timeoutOrElse({
          duration: { milliseconds: healthTimeoutMs },
          orElse: () => Effect.fail(new ClusterEndpointUnavailable({
            endpoint: endpoint.origin,
            reason: `health probe exceeded ${healthTimeoutMs}ms`
          }))
        })
      )).pipe(
        Effect.map((result) => ({ endpoint, index, result }))
      ), { concurrency: "unbounded" })

    const resolveOwner = (
      vmId: VmId
    ): Effect.Effect<EndpointRuntime, ClusterListError | VmNotFound> =>
      Effect.gen(function*() {
        const cached = owners.get(vmId)
        if (cached !== undefined) return cached
        const results = yield* poll()
        const matches: Array<EndpointRuntime> = []
        let failure: ClusterListError | undefined
        for (const entry of results) {
          if (Result.isFailure(entry.result)) {
            failure ??= entry.result.failure
            continue
          }
          if (entry.result.success.vms.some((vm) => vm.vmId === vmId)) matches.push(entry.endpoint)
        }
        if (matches.length > 1) {
          return yield* Effect.fail(new ClusterRoutingError({ reason: `VM id ${vmId} is reported by multiple endpoints` }))
        }
        const owner = matches[0]
        if (owner !== undefined) {
          owners.set(vmId, owner)
          return owner
        }
        if (failure !== undefined) return yield* Effect.fail(failure)
        return yield* Effect.fail(new VmNotFound({ vmId }))
      })

    const create = (
      request: CreateRequest
    ): Effect.Effect<SandboxHandle, ClusterCreateError | ClusterListError> =>
      Effect.gen(function*() {
        const health = yield* poll()
        const available = health.filter((entry) => Result.isSuccess(entry.result))
        if (available.length === 0) {
          const first = health[0]
          if (first !== undefined && Result.isFailure(first.result)) return yield* Effect.fail(first.result.failure)
          return yield* Effect.fail(new ClusterRoutingError({ reason: "no cluster endpoint is available" }))
        }
        available.sort((left, right) => {
          const leftCount = Result.isSuccess(left.result) ? left.result.success.vms.length : Number.MAX_SAFE_INTEGER
          const rightCount = Result.isSuccess(right.result) ? right.result.success.vms.length : Number.MAX_SAFE_INTEGER
          if (leftCount !== rightCount) return leftCount - rightCount
          const leftTurn = (left.index - placementCursor + runtimes.length) % runtimes.length
          const rightTurn = (right.index - placementCursor + runtimes.length) % runtimes.length
          return leftTurn - rightTurn
        })
        let capacityFailure: CapacityExceeded | undefined
        for (const candidate of available) {
          const result = yield* Effect.result(candidate.endpoint.client.create(request))
          if (Result.isFailure(result)) {
            if (isCapacityExceeded(result.failure)) {
              capacityFailure = result.failure
              continue
            }
            return yield* Effect.fail(result.failure)
          }
          placementCursor = (candidate.index + 1) % runtimes.length
          const vmId = result.success.vm.vmId
          owners.set(vmId, candidate.endpoint)
          const sandboxClientResult = yield* Effect.result(makeMicrovmClient({
            url: candidate.endpoint.origin,
            token: result.success.sandboxToken,
            ca: options.endpoints[candidate.index]?.ca
          }).pipe(Effect.provideService(Scope.Scope, clusterScope)))
          if (Result.isFailure(sandboxClientResult)) {
            const rollback = yield* Effect.result(candidate.endpoint.client.destroy({ vmId }))
            owners.delete(vmId)
            const rollbackDetail = Result.isFailure(rollback)
              ? `; rollback failed with ${rollback.failure._tag}`
              : ""
            return yield* Effect.fail(new ClusterRoutingError({
              reason: `created VM could not be bound to a sandbox client${rollbackDetail}`
            }))
          }
          const sandboxClient = sandboxClientResult.success
          return {
            vm: result.success.vm,
            client: sandboxClient,
            execute: (input) => sandboxClient.execute({ ...input, vmId }),
            inspect: () => sandboxClient.inspect({ vmId }),
            destroy: () => sandboxClient.destroy({ vmId })
          }
        }
        if (capacityFailure !== undefined) return yield* Effect.fail(capacityFailure)
        return yield* Effect.fail(new ClusterRoutingError({ reason: "no cluster endpoint accepted create" }))
      })

    const inspect = (
      vmId: VmId
    ): Effect.Effect<VmInfo, ClusterInspectError | ClusterListError> =>
      resolveOwner(vmId).pipe(Effect.flatMap((owner) => owner.client.inspect({ vmId })))

    const execute = (
      request: ExecuteRequest
    ): Effect.Effect<ExecResult, ClusterExecuteError | ClusterListError> =>
      resolveOwner(request.vmId).pipe(Effect.flatMap((owner) => owner.client.execute(request)))

    const destroy = (
      vmId: VmId
    ): Effect.Effect<DestroyResult, ClusterDestroyError | ClusterListError> =>
      resolveOwner(vmId).pipe(
        Effect.flatMap((owner) => owner.client.destroy({ vmId })),
        Effect.tap((result) => Effect.sync(() => {
          if (result.destroyed) owners.delete(vmId)
        }))
      )

    const list = (): Effect.Effect<ReadonlyArray<VmInfo>, ClusterListError> => Effect.gen(function*() {
      const results = yield* poll()
      const vms: Array<VmInfo> = []
      for (const entry of results) {
        if (Result.isFailure(entry.result)) return yield* Effect.fail(entry.result.failure)
        for (const vm of entry.result.success.vms) {
          const existing = owners.get(vm.vmId)
          if (existing !== undefined && existing !== entry.endpoint) {
            return yield* Effect.fail(new ClusterRoutingError({ reason: `VM id ${vm.vmId} is reported by multiple endpoints` }))
          }
          owners.set(vm.vmId, entry.endpoint)
          vms.push(vm)
        }
      }
      return vms.sort((left, right) => left.vmId.localeCompare(right.vmId))
    })

    return { create, inspect, execute, destroy, list }
  })
