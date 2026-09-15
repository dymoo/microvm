import {
  makeSandboxHttpIngress as makeSharedHttpIngress,
  type SandboxHttpIngress,
  type SandboxHttpIngressOptions as SharedHttpIngressOptions
} from "./http-ingress.js"

export {
  SANDBOX_SYSTEM_PROMPT,
  TOOL_GUIDANCE,
  createSandboxTools
} from "./ai.js"
export type { SandboxToolLimits, SandboxToolsOptions } from "./ai.js"

export {
  ClientConfigurationError,
  decodeExecResult,
  makeAdminClient,
  makeSandboxScopedClient
} from "./client.js"
export type {
  AdminClient,
  AdminConstructionError,
  CreateOutcome,
  DecodedExecResult,
  SandboxAdmissionError,
  SandboxCreateError,
  SandboxCreateInput,
  SandboxDestroyError,
  SandboxExecuteError,
  SandboxExecuteInput,
  SandboxInfoError,
  SandboxInspectError,
  SandboxScopedClient,
  SandboxServiceOperationError,
  SandboxStartWebServiceInput
} from "./client.js"
export type { NodeMicrovmClientOptions } from "./client.js"

/** Node ingress options; only this runtime-specific root permits ambient fetch. */
export interface SandboxHttpIngressOptions extends Omit<SharedHttpIngressOptions, "fetch"> {
  readonly fetch?: typeof globalThis.fetch | undefined
}

export const makeSandboxHttpIngress = (
  options: SandboxHttpIngressOptions
): SandboxHttpIngress => {
  const { fetch: configuredFetch, ...sharedOptions } = options
  return makeSharedHttpIngress({
    ...sharedOptions,
    fetch: configuredFetch ?? globalThis.fetch
  })
}

export type { SandboxHttpIngress }

export {
  MICROVM_VERSION,
  AdmissionClosed,
  AdmissionState,
  BootFailed,
  CapacityExceeded,
  CreateResult,
  DaemonInfo,
  DestroyResult,
  DestroyUncertain,
  ExecResult,
  Forbidden,
  HostPrereqFailed,
  ImageDigest,
  ImageName,
  ImageNotAllowed,
  ListResult,
  MicrovmRpc,
  StartWebServiceRequest,
  StopWebServiceResult,
  Unauthenticated,
  VmId,
  VmInfo,
  VmNotFound,
  VmPoisoned,
  WebServiceStatus
} from "./protocol.js"
export type {
  CreateRequest,
  DestroyRequest,
  ExecuteRequest,
  InfoRequest,
  InspectRequest,
  ListRequest,
  SetAdmissionRequest,
  StartWebServiceRpcRequest,
  StopWebServiceRequest,
  WebServiceStatusRequest
} from "./protocol.js"
