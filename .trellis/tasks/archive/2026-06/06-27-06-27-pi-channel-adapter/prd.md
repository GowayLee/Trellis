# Adapt Pi provider for Trellis channel

## Goal

Research and implement Pi as a Trellis channel worker provider, validating Pi CLI JSON/stdin behavior against pi-coding-agent docs before coding.

## Requirements

- Add Pi as a supported Trellis channel worker provider.
- Use Pi's long-lived RPC mode for channel workers; do not use one-shot `pi --mode json -p` for the adapter.
- Preserve existing Claude and Codex channel behavior.
- Map Pi RPC events into Trellis channel events consistently enough for `send`, `wait`, `messages`, `run`, and worker lifecycle handling.
- Support normal prompt delivery and a conservative interrupt path.
- Update user-facing provider documentation where supported providers are listed.
- Add focused tests for the adapter event mapping and message encoding.

## Acceptance Criteria

- [ ] `trellis channel spawn ... --provider pi` is accepted and starts a Pi worker process.
- [ ] Pi worker receives channel messages through stdin RPC `prompt` commands.
- [ ] Pi assistant output is visible through `trellis channel messages` as channel `message`/`progress` events.
- [ ] Pi turn completion emits a channel `done` event so `trellis channel wait --kind done --from <worker>` works.
- [ ] Pi command/protocol failures emit channel `error` events rather than hanging waiters.
- [ ] Interrupt sends an RPC abort and routes replacement instructions safely.
- [ ] Existing Claude/Codex channel tests continue to pass.
- [ ] New Pi adapter tests cover handshake, prompt encoding, interrupt encoding, message/progress/done/error parsing.
- [ ] Channel docs/reference files mention Pi in provider lists and note the RPC-mode behavior where relevant.

## Notes

- Research details are captured in `research/pi-channel-adapter-research.md`.
- Key decision: Pi channel worker should use `pi --mode rpc`, not `pi --mode json -p`.
- Open implementation decision: whether to disable Pi extensions/skills/templates for channel workers by default to reduce recursive Trellis behavior.
