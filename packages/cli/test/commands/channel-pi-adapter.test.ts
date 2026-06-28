import { describe, expect, it } from "vitest";

import { getAdapter, listProviders } from "../../src/commands/channel/adapters/index.js";
import {
  buildPiArgs,
  createPiCtx,
  encodePiInterruptMessage,
  encodePiUserMessage,
  parsePiLine,
} from "../../src/commands/channel/adapters/pi.js";

function parse(line: Record<string, unknown>, ctx = createPiCtx()) {
  return parsePiLine(JSON.stringify(line), ctx);
}

function readJsonLine(line: string): Record<string, unknown> {
  return JSON.parse(line.trim()) as Record<string, unknown>;
}

describe("Pi channel adapter", () => {
  it("registers pi as a channel provider", () => {
    expect(listProviders()).toContain("pi");
    expect(getAdapter("pi").provider).toBe("pi");
  });

  it("builds RPC-mode args with deterministic resource-disabling flags", () => {
    const args = buildPiArgs({
      cwd: "/repo",
      model: "anthropic/claude-sonnet-4:low",
      systemPrompt: "channel protocol",
    });

    expect(args).toEqual([
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-approve",
      "--model",
      "anthropic/claude-sonnet-4:low",
      "--append-system-prompt",
      "channel protocol",
    ]);
    expect(args).not.toContain("-p");
    expect(args).not.toContain("json");
  });

  it("marks get_state response ready and persists session identity", () => {
    const ctx = createPiCtx();
    ctx.pending.set(1, "get_state");

    const result = parse(
      {
        id: 1,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "pi-session-1",
          sessionFile: "/tmp/pi-session.jsonl",
        },
      },
      ctx,
    );

    expect(ctx.ready).toBe(true);
    expect(ctx.sessionId).toBe("pi-session-1");
    expect(ctx.sessionFile).toBe("/tmp/pi-session.jsonl");
    expect(result).toMatchObject({
      events: [],
      side: { persistSessionId: "pi-session-1" },
    });
  });

  it("records get_state failures for the supervisor handshake path", () => {
    const ctx = createPiCtx();
    ctx.pending.set(1, "get_state");

    const result = parse(
      {
        id: 1,
        type: "response",
        command: "get_state",
        success: false,
        error: "state unavailable",
      },
      ctx,
    );

    expect(result.events).toEqual([]);
    expect(ctx.handshakeError).toBe(
      "RPC error for get_state (id=1): state unavailable",
    );
  });

  it("encodes user prompts as Pi RPC JSONL", () => {
    const ctx = createPiCtx();
    const encoded = encodePiUserMessage(ctx, "hello pi");

    expect(encoded.id).toBe(1);
    expect(readJsonLine(encoded.line)).toEqual({
      id: 1,
      type: "prompt",
      message: "hello pi",
    });
    expect(ctx.pending.get(1)).toBe("prompt");
  });

  it("interrupts by aborting first, then emits a deferred follow-up prompt", () => {
    const ctx = createPiCtx();
    const abort = encodePiInterruptMessage(ctx, "new instruction");

    expect(readJsonLine(abort.line)).toEqual({ id: 1, type: "abort" });
    expect(ctx.pending.get(1)).toBe("abort");

    const result = parse(
      { id: 1, type: "response", command: "abort", success: true },
      ctx,
    );

    expect(result.events).toEqual([]);
    expect(result.side?.reply).toHaveLength(1);
    expect(readJsonLine(result.side?.reply?.[0] ?? "")).toEqual({
      id: 2,
      type: "prompt",
      message:
        "[GRID INTERRUPT - drop current work and follow this new instruction]\nnew instruction",
      streamingBehavior: "followUp",
    });
    expect(ctx.pending.get(2)).toBe("prompt");
  });

  it("suppresses expected aborted events while routing interrupt replacement", () => {
    const ctx = createPiCtx();
    encodePiInterruptMessage(ctx, "replacement");

    const abortedMessage = parse(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
          stopReason: "aborted",
        },
      },
      ctx,
    );
    const abortedEnd = parse({ type: "agent_end" }, ctx);
    const abortAck = parse(
      { id: 1, type: "response", command: "abort", success: true },
      ctx,
    );
    const replacementStart = parse({ type: "agent_start" }, ctx);
    const replacementDone = parse({ type: "agent_end" }, ctx);

    expect(abortedMessage.events).toEqual([]);
    expect(abortedEnd.events).toEqual([]);
    expect(readJsonLine(abortAck.side?.reply?.[0] ?? "")).toMatchObject({
      id: 2,
      type: "prompt",
      message:
        "[GRID INTERRUPT - drop current work and follow this new instruction]\nreplacement",
      streamingBehavior: "followUp",
    });
    expect(replacementStart.events).toEqual([]);
    expect(replacementDone.events).toEqual([{ kind: "done", payload: {} }]);
  });

  it("maps text and thinking message updates to progress", () => {
    const text = parse({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });
    const thinking = parse({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
    });

    expect(text.events).toEqual([
      {
        kind: "progress",
        payload: { detail: { kind: "output", text_delta: "hello" } },
      },
    ]);
    expect(thinking.events).toEqual([
      {
        kind: "progress",
        payload: { detail: { kind: "reasoning", text_delta: "hmm" } },
      },
    ]);
  });

  it("maps assistant message_end text to a channel message", () => {
    const result = parse({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "skip" },
          { type: "text", text: "final answer" },
        ],
      },
    });

    expect(result.events).toEqual([
      { kind: "message", payload: { text: "final answer" } },
    ]);
  });

  it("maps tool events to progress without making tool errors terminal", () => {
    const ctx = createPiCtx();
    const start = parse(
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "pnpm test" },
      },
      ctx,
    );
    const end = parse(
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "failed" }] },
        isError: true,
      },
      ctx,
    );
    const done = parse({ type: "agent_end" }, ctx);

    expect(start.events[0]).toMatchObject({
      kind: "progress",
      payload: {
        detail: {
          kind: "tool",
          tool: "bash",
          tool_call_id: "call-1",
          status: "running",
          args_summary: '{"command":"pnpm test"}',
        },
      },
    });
    expect(end.events[0]).toMatchObject({
      kind: "progress",
      payload: {
        detail: {
          kind: "tool",
          tool: "bash",
          tool_call_id: "call-1",
          status: "failed",
          is_error: true,
        },
      },
    });
    expect(done.events).toEqual([{ kind: "done", payload: {} }]);
  });

  it("maps agent_end to done unless the current turn already had a terminal error", () => {
    const ok = parse({ type: "agent_end" });
    expect(ok.events).toEqual([{ kind: "done", payload: {} }]);

    const ctx = createPiCtx();
    const failed = parse(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
          stopReason: "error",
          errorMessage: "model failed",
        },
      },
      ctx,
    );
    const suppressedDone = parse({ type: "agent_end" }, ctx);

    expect(failed.events).toEqual([
      { kind: "message", payload: { text: "partial" } },
      {
        kind: "error",
        payload: {
          message: "model failed",
          provider: "pi",
          detail: { stopReason: "error" },
        },
      },
    ]);
    expect(suppressedDone.events).toEqual([]);
  });

  it("maps command failures and invalid JSON to errors", () => {
    const ctx = createPiCtx();
    ctx.pending.set(7, "prompt");

    const failure = parse(
      {
        id: 7,
        type: "response",
        command: "prompt",
        success: false,
        error: "already streaming",
      },
      ctx,
    );
    const invalid = parsePiLine("{not json", createPiCtx());

    expect(failure.events[0]).toMatchObject({
      kind: "error",
      payload: {
        message: "RPC error for prompt (id=7): already streaming",
        provider: "pi",
      },
    });
    expect(invalid.events).toEqual([
      {
        kind: "error",
        payload: {
          message: "Failed to parse Pi stdout line",
          raw_excerpt: "{not json",
        },
      },
    ]);
  });
});
