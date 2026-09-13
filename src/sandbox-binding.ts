import { Effect, Schema } from "effect"
import { RpcClientError } from "effect/unstable/rpc"
import { makeSandboxHttpProxy } from "./http-proxy.js"
import {
  ClusterServiceError,
  Forbidden,
  HttpNotConfigured,
  Unauthenticated,
  VmId,
  VmNotFound,
  VmPoisoned,
  type CreateRequest,
  type CreateResult,
  type ExecuteRequest,
  type StartWebServiceRpcRequest,
  type VmId as VmIdType
} from "./protocol.js"
import type {
  ClientConfigurationError,
  MicrovmClient,
  SandboxCreateInput,
  SandboxExecuteInput,
  SandboxHandle,
  SandboxServiceOperationError,
  SandboxStartWebServiceInput,
  WebServiceHandle
} from "./client.js"

const causeSchema = Schema.Cause(Schema.Unknown, Schema.Defect())
const rollbackDestroyTimeout = { seconds: 5 } as const

/**
 * Local failure after a create reply named a VM. The id is known; rollback is
 * attempted once and never hidden when cleanup itself is uncertain.
 */
export class SandboxBindingError extends Schema.TaggedError<SandboxBindingError>()("SandboxBindingError", {
  vmId: VmId,
  failure: causeSchema,
  cleanup: Schema.UndefinedOr(causeSchema)
}) {}

interface BindSandboxArgs {
  readonly adminClient: MicrovmClient
  readonly makeSandboxClient: (token: string) => Effect.Effect<MicrovmClient, ClientConfigurationError>
  readonly created: CreateResult
  readonly origin: string
  readonly ca: string | undefined
}

export const createWireRequest = (input: SandboxCreateInput): CreateRequest => ({
  image: input.image,
  imageDigest: input.imageDigest,
  cpus: input.cpus,
  memMib: input.memMib,
  ttlSeconds: input.ttlSeconds
})

export const executeWireRequest = (input: SandboxExecuteInput, vmId: VmIdType): ExecuteRequest => ({
  vmId,
  argv: input.argv,
  cwd: input.cwd,
  env: input.env,
  timeoutMs: input.timeoutMs,
  maxOutputBytes: input.maxOutputBytes
})

const startWebServiceWireRequest = (
  input: SandboxStartWebServiceInput,
  vmId: VmIdType
): StartWebServiceRpcRequest => ({
  vmId,
  argv: input.argv,
  cwd: input.cwd,
  env: input.env
})

const serviceError = (vmId: VmIdType, error: unknown): SandboxServiceOperationError => {
  if (
    error instanceof ClusterServiceError ||
    error instanceof Forbidden ||
    error instanceof Unauthenticated ||
    error instanceof VmNotFound ||
    error instanceof VmPoisoned ||
    error instanceof RpcClientError.RpcClientError
  ) {
    return error
  }
  return new ClusterServiceError({
    vmId,
    code: "INTERNAL",
    message: "web service control request failed"
  })
}

const boundHandle = (
  args: BindSandboxArgs,
  vmId: VmIdType,
  sandboxClient: MicrovmClient
): SandboxHandle => {
  const httpProxy = args.created.httpIngressToken === undefined
    ? undefined
    : makeSandboxHttpProxy({
      daemonOrigin: new URL(args.origin),
      vmId,
      httpIngressToken: args.created.httpIngressToken,
      ca: args.ca
    })
  const webService: WebServiceHandle = {
    status: () => sandboxClient.webServiceStatus({ vmId }).pipe(
      Effect.mapError((error) => serviceError(vmId, error))
    ),
    stop: () => sandboxClient.stopWebService({ vmId }).pipe(
      Effect.mapError((error) => serviceError(vmId, error))
    )
  }
  return {
    vm: args.created.vm,
    client: sandboxClient,
    execute: (input) => sandboxClient.execute(executeWireRequest(input, vmId)),
    http: () => httpProxy === undefined
      ? Effect.fail(new HttpNotConfigured({ vmId }))
      : Effect.succeed(httpProxy),
    startWebService: (input) => sandboxClient
      .startWebService(startWebServiceWireRequest(input, vmId))
      .pipe(
        Effect.mapError((error) => serviceError(vmId, error)),
        Effect.map(() => webService)
      ),
    inspect: () => sandboxClient.inspect({ vmId }),
    destroy: () => sandboxClient.destroy({ vmId })
  }
}

/**
 * Binds a successful create to the configured origin. Never consults
 * `VmInfo.owningHost`. Interrupt or client construction failure after a known
 * vmId attempts exactly one admin destroy, bounded by a finite deadline.
 * The delivered handle is an interruptible Sync; rollback is failure-only
 * catchCause inside the uninterruptible mask.
 */
export const bindSandboxHandle = (
  args: BindSandboxArgs
): Effect.Effect<SandboxHandle, SandboxBindingError> => {
  const vmId = args.created.vm.vmId
  return Effect.uninterruptibleMask(() =>
    Effect.interruptible(Effect.suspend(() => args.makeSandboxClient(args.created.sandboxToken))).pipe(
      Effect.flatMap((sandboxClient) =>
        Effect.interruptible(Effect.sync(() => boundHandle(args, vmId, sandboxClient)))
      ),
      Effect.catchCause((failure) =>
        args.adminClient.destroy({ vmId }).pipe(
          Effect.asVoid,
          Effect.timeout(rollbackDestroyTimeout),
          Effect.uninterruptible,
          Effect.matchCauseEffect({
            onSuccess: () =>
              Effect.fail(new SandboxBindingError({
                vmId,
                failure,
                cleanup: undefined
              })),
            onFailure: (cleanup) =>
              Effect.fail(new SandboxBindingError({
                vmId,
                failure,
                cleanup
              }))
          })
        )
      )
    )
  )
}
