# Implementation Plan: Pi provider for Trellis channel

## Pre-code checks

1. Read task artifacts: `prd.md`, `design.md`, research note.
2. Read relevant specs:
   - `.trellis/spec/cli/backend/commands-channel.md`
   - `.trellis/spec/cli/backend/error-handling.md`
   - `.trellis/spec/cli/backend/logging-guidelines.md`
   - `.trellis/spec/cli/backend/platform-integration.md`
   - `.trellis/spec/cli/unit-test/conventions.md`
   - `.trellis/spec/cli/unit-test/mock-strategies.md`
   - `.trellis/spec/cli/unit-test/integration-patterns.md`
   - shared thinking guides for code reuse, cross-layer contracts, and cross-platform assumptions.
3. Run GitNexus impact analysis before editing these symbols:
   - `REGISTRY` / `Provider` in channel adapter registry.
   - `loadAgent` / `normalizeProvider` if Pi agent frontmatter should be accepted.
   - `parseLine` / new adapter parser functions once created before revising them.

## Step 1 — Add Pi adapter module

Create `packages/cli/src/commands/channel/adapters/pi.ts`.

Implement:

- `PiCtx`
- `createPiCtx`
- `buildPiArgs`
- `encodePiRequest`
- `encodePiUserMessage`
- `encodePiInterruptMessage`
- `parsePiLine`

Keep helpers small and local unless repeated patterns emerge.

## Step 2 — Register provider

Update `packages/cli/src/commands/channel/adapters/index.ts`:

- import Pi adapter helpers.
- define `piAdapter`.
- add `pi` to `REGISTRY`.

Update `packages/cli/src/commands/channel/agent-loader.ts` if needed so agent frontmatter `provider: pi` is accepted.

## Step 3 — Update CLI help/docs/spec

Update CLI provider descriptions in `packages/cli/src/commands/channel/index.ts`.

Update source bundled skill docs:

- `packages/cli/src/templates/common/bundled-skills/trellis-channel/references/command-reference.md`
- `packages/cli/src/templates/common/bundled-skills/trellis-channel/references/workers.md`

Update code spec:

- `.trellis/spec/cli/backend/commands-channel.md`

## Step 4 — Tests

Add `packages/cli/test/commands/channel-pi-adapter.test.ts`.

Target adapter unit coverage:

- build args.
- ready state from handshake response.
- prompt encoding.
- interrupt abort + deferred prompt reply.
- progress/message/done/error parsing.
- invalid JSON error.

Run focused tests:

```bash
pnpm test packages/cli/test/commands/channel-pi-adapter.test.ts
pnpm test packages/cli/test/commands/channel-codex-adapter.test.ts
pnpm test packages/cli/test/commands/channel.test.ts
```

Then run broader validation as time allows:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

## Step 5 — Final verification

- Run `git diff --name-only` and verify the changed files match the task scope.
- Run GitNexus `detect_changes()` / CLI equivalent before commit.
- Check acceptance criteria in `prd.md`.
- If implementation exposes a new durable convention, update `.trellis/spec/cli/backend/commands-channel.md` before finishing.
