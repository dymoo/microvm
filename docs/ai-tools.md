# Vercel AI SDK tools

`createSandboxTools` binds tools to an existing `MicrovmClient`, one VM ID, and
a guest working directory. Construct it in trusted application code after
create; never let model text select those values.

```ts
import {
  generateText,
  streamText,
  stepCountIs,
  type LanguageModel
} from "ai"
import { Effect } from "effect"
import {
  makeMicrovmClient,
  createSandboxTools,
  SANDBOX_SYSTEM_PROMPT
} from "microvm"

export const runSandboxAgent = (model: LanguageModel) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const client = yield* makeMicrovmClient({
      url: process.env.MICROVM_URL!,
      token: process.env.MICROVM_SANDBOX_TOKEN!
    })
    const tools = createSandboxTools({
      client,
      vmId: process.env.MICROVM_VM_ID!,
      workdir: "/workspace"
    })

    const generated = yield* Effect.promise(() => generateText({
      model,
      system: SANDBOX_SYSTEM_PROMPT,
      prompt: "Inspect package.json and report the package name.",
      tools,
      stopWhen: stepCountIs(4)
    }))

    const streamed = yield* Effect.promise(async () => {
      const result = streamText({
        model,
        system: SANDBOX_SYSTEM_PROMPT,
        prompt: "Read the entry point and explain what it does.",
        tools,
        stopWhen: stepCountIs(4)
      })
      let text = ""
      for await (const delta of result.textStream) {
        process.stdout.write(delta)
        text += delta
      }
      return text
    })

    return { generated: generated.text, streamed }
  })))
```

The RPC client remains in scope until `generateText` has completed and the
stream has been fully consumed, including every asynchronous tool call.

The exported tools are:

- `run_command`: non-empty argv executed directly, without a shell;
- `read_file`: a relative UTF-8 path confined beneath the bound working
  directory, with bounded output;
- `write_file`: a relative path confined beneath the working directory and
  UTF-8 content written without shell interpolation.

The factory keeps those names and schemas in its return type, so application
code can derive AI SDK UI and tool-call types without redeclaring them:

```ts
import type { InferUITools, TypedToolCall } from "ai"
import { createSandboxTools } from "microvm"

type SandboxUITools =
  InferUITools<ReturnType<typeof createSandboxTools>>
type SandboxToolCall =
  TypedToolCall<ReturnType<typeof createSandboxTools>>
type RunCommandCall =
  Extract<SandboxToolCall, { toolName: "run_command" }>
```

`keyof SandboxUITools` is exactly `run_command | read_file | write_file`;
`RunCommandCall["input"]["argv"]` is `string[]`, and
`SandboxUITools["run_command"]["output"]["exitCode"]` is `number`.

Tool schemas expose no URL, token, VM ID, host path, image name, kernel option,
or network setting. The closure's sandbox credential is accepted only for its
own VM by RPC authorization. Path confinement is checked in the guest command,
and the VM has no network interface.

Use `SANDBOX_SYSTEM_PROMPT` (or preserve all of its guarantees when adding your
own instructions): commands are argv arrays, paths are relative to the
workspace, failures must be reported rather than retried blindly, and the model
must not claim network or host access. An aborted AI tool call interrupts the
RPC; the daemon destroys the VM when execution cancellation leaves its state in
doubt.

Tool output is untrusted model input. Do not interpret it as credentials,
configuration, or a destination for later RPCs. Destroy the VM when the agent
session ends and do not reuse its token.
