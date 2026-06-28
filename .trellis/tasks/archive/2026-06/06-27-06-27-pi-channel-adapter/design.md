# Design: Pi provider for Trellis channel

## Decision

Add Pi as a channel worker provider by implementing a dedicated `WorkerAdapter` backed by Pi RPC mode.

The adapter must not use `pi --mode json -p`. That mode is one-shot and waits for a single initial prompt before exiting, which matches `trellis_subagent` but not channel workers. Channel workers are long-lived supervisor-managed processes and need stdin commands for multiple turns.

## Launch model

Initial implementation launches:

```bash
pi --mode rpc --no-session --append-system-prompt "<system prompt>"
```

Additional args:

- `--model <model>` when channel spawn/run passes a model.
- `--no-extensions --no-skills --no-prompt-templates --no-themes --no-approve` by default.

Rationale for disabling Pi dynamic resources: channel workers already receive Trellis context through channel spawn system prompt and context files. Loading project Pi extensions/skills can reintroduce Trellis subagent tools and session hooks inside the worker, increasing recursion and context pollution risk. Built-in model/tool execution remains Pi's responsibility.

Session resume is intentionally out of scope for the first pass. Use `--no-session`; persist `get_state` session data only if Pi provides it, but do not promise resume behavior until it is tested.

## Adapter structure

Add `packages/cli/src/commands/channel/adapters/pi.ts` with:

- `PiCtx`
  - `nextId: number`
  - `ready: boolean`
  - `pending: Map<number, "get_state" | "prompt" | "abort" | "other">`
  - `pendingInterruptText?: string`
  - `turnHadTerminalError: boolean`
  - optional `sessionId` / `sessionFile`
- `createPiCtx()`
- `buildPiArgs(view)`
- `parsePiLine(line, ctx)`
- `encodePiRequest(ctx, type, body, label)`
- `encodePiUserMessage(ctx, text)`
- `encodePiInterruptMessage(ctx, text)`

Register the adapter in `packages/cli/src/commands/channel/adapters/index.ts`.

## Handshake

Use Pi RPC `get_state` as the readiness check.

1. `handshake` sends `{"id":N,"type":"get_state"}\n`.
2. `parsePiLine` handles the matching successful response.
3. It sets `ctx.ready = true` and returns `side.persistSessionId` if Pi exposes a session id or session file.
4. `isReady(ctx)` returns `ctx.ready === true`.

Supervisor already starts the stdout pump before calling `handshake`, so the response can be observed by `parseLine`.

## Message encoding

Normal user message:

```json
{"id":N,"type":"prompt","message":"..."}
```

Interrupt:

1. `encodeInterruptMessage(text, ctx)` sends only:

```json
{"id":N,"type":"abort"}
```

2. It stores the replacement text on `ctx.pendingInterruptText`.
3. When `parsePiLine` receives the abort response, it returns `side.reply` with a follow-up prompt:

```json
{"id":N,"type":"prompt","message":"[GRID INTERRUPT - drop current work and follow this new instruction]\n...","streamingBehavior":"followUp"}
```

This avoids racing prompt delivery while Pi is still streaming.

## Event mapping

Pi RPC stdout contains command responses plus agent events.

Command responses:

- `response.success === false` -> channel `error`.
- Successful `prompt` response is ignored; it only means the command was accepted.
- Successful `get_state` response marks the adapter ready.
- Successful `abort` response may trigger the deferred replacement prompt.

Agent events:

- `message_update` text deltas -> `progress` with `detail.kind = "output"` and `detail.text_delta`.
- `message_update` thinking deltas -> `progress` with `detail.kind = "reasoning"` and `detail.text_delta`.
- `message_end` assistant text -> `message`.
- `message_end` with `stopReason: "error" | "aborted"` or `errorMessage` -> `error`, and mark current turn as terminal-error, except the expected `aborted` terminal message caused by a channel interrupt already in progress.
- `tool_execution_start/update/end` -> `progress` with summarized tool detail. Tool-level errors stay progress, not terminal turn errors.
- `extension_error` -> `error` in the first implementation, because channel waiters should not hang on provider/runtime failures.
- `agent_end` -> `done` unless the current turn already emitted a terminal error or this is the expected end of a provider-level abort before the deferred replacement prompt runs.
- Invalid JSON -> `error`.

Do not use `message_end` as the completion boundary. Pi can emit more than one assistant message inside a turn; `agent_end` is the safe turn completion signal.

## Documentation and specs

Update user-facing provider lists in:

- `packages/cli/src/commands/channel/index.ts` option descriptions.
- `packages/cli/src/templates/common/bundled-skills/trellis-channel/references/command-reference.md`.
- `packages/cli/src/templates/common/bundled-skills/trellis-channel/references/workers.md`.

Update code spec `commands-channel.md` so the provider contract includes `pi` and documents the RPC-mode distinction.

Generated `.pi/skills/` and `.agents/skills/` copies are outputs in this checkout; source of truth is `packages/cli/src/templates/common/bundled-skills/...`. Do not edit generated copies directly unless a test expects current checkout generated artifacts to be updated too.

## Tests

Add `packages/cli/test/commands/channel-pi-adapter.test.ts` for adapter-level behavior:

- build args use RPC mode and deterministic flags.
- `get_state` response marks ready and persists session id/file.
- user prompt encoding is valid JSONL.
- interrupt sends abort first and abort response emits replacement prompt through `side.reply`.
- `message_update` maps to progress.
- `message_end` maps assistant text to message.
- tool events map to progress.
- `agent_end` maps to done.
- command failure and invalid JSON map to error.

If time permits, add a fake Pi integration test around `channel spawn -> send -> wait done`; otherwise keep the first change focused on adapter unit tests plus existing channel suite.

## Risk notes

- Provider registry type changes affect CLI validation and agent frontmatter normalization.
- `done`/`error` terminal event timing must avoid duplicate terminal events; supervisor already handles this when adapter emits terminal events.
- Pi RPC exact error shape may vary; parser should be defensive and summarize unknown payloads instead of throwing.
- `--no-extensions` is conservative but user-visible. Document that Pi channel workers run in RPC mode with Trellis-managed context rather than full interactive Pi startup behavior.
