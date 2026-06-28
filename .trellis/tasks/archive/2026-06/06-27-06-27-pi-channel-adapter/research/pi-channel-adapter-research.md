# Pi Channel Adapter Research

## Summary

Pi can be adapted as a Trellis channel worker provider, but the adapter should use Pi RPC mode rather than the earlier assumed JSON one-shot mode.

The previous assumption was `pi --mode json -p --no-session`. That path is appropriate for one-shot `trellis_subagent` execution because the child process reads a single prompt from stdin, emits JSONL events, and exits. Trellis channel workers are long-lived processes managed by the channel supervisor, so they need a stdin/stdout protocol that can accept multiple prompts over time. Pi's `--mode rpc` is the right fit.

## Recommended Pi worker launch

Recommended baseline:

```bash
pi --mode rpc --no-session --append-system-prompt "<channel worker system prompt>"
```

Optional flags to consider:

```bash
--model "<model>"
--no-extensions --no-skills --no-prompt-templates --no-themes --no-approve
```

Notes:

- `--mode rpc` keeps the Pi process alive and reads JSONL commands from stdin.
- `--no-session` is suitable for the first implementation because channel already persists conversation events. Session resume can be added later by using `get_state` and passing `--session` on restart.
- `--append-system-prompt` is preferable to `--system-prompt` because it preserves Pi's default coding-agent prompt and adds Trellis channel protocol information.
- Disabling extensions/skills/templates/themes can make workers more predictable and avoid recursive Trellis extension behavior. This is a product decision to confirm during implementation.

## RPC protocol shape

Pi RPC stdin accepts JSONL commands, for example:

```json
{"id":"req-1","type":"get_state"}
{"id":"req-2","type":"prompt","message":"Hello"}
{"id":"req-3","type":"abort"}
```

Useful RPC commands:

- `get_state`: handshake / state discovery.
- `prompt`: send a user prompt.
- `abort`: cancel current work.
- `abort_retry` / `abort_bash`: more targeted cancellation controls, not needed for the initial adapter.

RPC stdout contains command responses and agent events. A successful `prompt` response only means the prompt command was accepted; it is not turn completion.

## Event mapping for Trellis channel

Recommended mapping:

- `agent_end` -> Trellis `done`.
- `message_end` with assistant text -> Trellis `message`.
- `message_update` text delta -> Trellis `progress`.
- `tool_execution_start/update/end` -> Trellis `progress`.
- `response.success === false` -> Trellis `error`.
- `message_end` with `stopReason: "error" | "aborted"` or an error message -> Trellis `error` candidate.
- Invalid JSON -> Trellis `error`.

Important caution: `message_end` only means one assistant message ended. It does not necessarily mean the full agent turn ended, because Pi may continue into tool calls and additional messages. `agent_end` is the safer completion boundary.

## WorkerAdapter method plan

`buildArgs(view)`:

- Return args for `pi --mode rpc`.
- Add `--no-session` for the first implementation.
- Add `--model view.model` when present.
- Add `--append-system-prompt view.systemPrompt` when present.
- Consider deterministic resource flags such as `--no-extensions`, pending implementation decision.

`createCtx()`:

- Track `nextId`, `ready`, pending RPC requests, optional `sessionId/sessionFile`, and per-turn terminal state.

`handshake({ child, ctx })`:

- Send `get_state`.
- Mark ready once the matching successful response arrives.
- Persist session id/file if available.

`isReady(ctx)`:

- Return `ctx.ready === true`.

`parseLine(line, ctx)`:

- Parse JSONL.
- Handle command responses separately from agent events.
- Emit Trellis events and side effects such as persisted session id or follow-up stdin writes.

`encodeUserMessage(text, ctx)`:

```json
{"id":N,"type":"prompt","message":"..."}
```

`encodeInterruptMessage(text, ctx)`:

Preferred safe implementation: send `abort` first, store replacement text in ctx, then emit a follow-up `prompt` from `parseLine` after the abort response. This avoids racing prompt delivery while Pi is still streaming.

## Existing code references

Channel runtime:

- `packages/cli/src/commands/channel/adapters/index.ts`
- `packages/cli/src/commands/channel/adapters/types.ts`
- `packages/cli/src/commands/channel/adapters/claude.ts`
- `packages/cli/src/commands/channel/adapters/codex.ts`
- `packages/cli/src/commands/channel/supervisor.ts`
- `packages/cli/src/commands/channel/supervisor/stdout.ts`
- `packages/cli/src/commands/channel/supervisor/inbox.ts`
- `packages/cli/src/commands/channel/supervisor/turns.ts`
- `packages/cli/src/commands/channel/supervisor/shutdown.ts`

Pi/Trellis integration:

- `packages/cli/src/templates/pi/extensions/trellis/index.ts.txt`
- `packages/cli/src/templates/pi/index.ts`
- `packages/cli/src/templates/pi/settings.json`

Pi documentation / implementation references:

- `/home/haurynlee/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/README.md`
- `/home/haurynlee/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/json.md`
- `/home/haurynlee/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
- `/home/haurynlee/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js`
- `/home/haurynlee/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/modes/print-mode.js`

## Tests to add

Unit tests for `pi.ts` adapter:

- handshake `get_state` response marks ctx ready and persists session id.
- user prompt encoding is valid JSONL.
- interrupt first emits abort and later emits replacement prompt.
- `message_update` produces progress.
- `message_end` assistant text produces message.
- `tool_execution_start/end` produces progress.
- `agent_end` produces done.
- command failure and invalid JSON produce error.

Integration-ish test option:

- Add a fake `pi` binary/script that speaks minimal RPC JSONL and verify `channel spawn -> send -> wait done` path.

## Open questions / things to verify empirically

- Exact behavior when `abort` is followed quickly by a replacement prompt during long model output or long tool execution.
- Whether failed API calls, auth failures, rate limits, and context overflow always produce `message_end stopReason:error` and whether `agent_end` follows.
- Whether `tool_execution_end.isError` should ever become terminal; initial assumption is no, it should be progress only.
- Whether worker should default to disabling Pi extensions/skills or preserve user Pi environment.
- Whether to support Pi session resume in the first implementation or keep MVP `--no-session`.
