import type { AdapterEvent, ParseResult } from "./types.js";
import type { SupervisorView } from "./index.js";

export type PiPendingLabel = "get_state" | "prompt" | "abort" | "other";

export interface PiCtx {
  /** id → command label for outbound RPC requests. */
  pending: Map<number, PiPendingLabel>;
  /** Whether get_state handshake has completed successfully. */
  ready: boolean;
  /** Monotonic outbound id allocator. */
  nextId: number;
  /** Replacement text waiting for abort acknowledgement before prompt delivery. */
  pendingInterruptText?: string;
  /** Current turn already emitted a terminal error, so agent_end must not emit done. */
  turnHadTerminalError: boolean;
  /** Suppress the expected aborted terminal events from a provider-level interrupt. */
  suppressInterruptAbortEnd: boolean;
  /** Last observed Pi session identity, if get_state exposes one. */
  sessionId?: string;
  /** Last observed Pi session file, if get_state exposes one. */
  sessionFile?: string;
  /** Last handshake/RPC failure relevant to readiness. */
  handshakeError?: string;
}

interface PiResponse {
  id?: number | string;
  type?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: unknown;
}

interface PiEvent {
  type?: string;
  message?: unknown;
  messages?: unknown;
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
    content?: string;
    toolCall?: unknown;
  };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  extensionPath?: string;
  event?: string;
  error?: unknown;
  errorMessage?: string;
  reason?: string;
}

const INTERRUPT_PREFIX =
  "[GRID INTERRUPT - drop current work and follow this new instruction]\n";

export function createPiCtx(): PiCtx {
  return {
    pending: new Map(),
    ready: false,
    nextId: 1,
    turnHadTerminalError: false,
    suppressInterruptAbortEnd: false,
  };
}

export function buildPiArgs(view: SupervisorView): string[] {
  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
  ];
  if (view.model) args.push("--model", view.model);
  if (view.systemPrompt?.trim()) {
    args.push("--append-system-prompt", view.systemPrompt);
  }
  return args;
}

export function encodePiRequest(
  ctx: PiCtx,
  type: string,
  body: Record<string, unknown> = {},
  label: PiPendingLabel = "other",
): { id: number; line: string } {
  const id = ctx.nextId++;
  ctx.pending.set(id, label);
  return {
    id,
    line: JSON.stringify({ id, type, ...body }) + "\n",
  };
}

export function encodePiUserMessage(
  ctx: PiCtx,
  text: string,
): { id: number; line: string } {
  ctx.turnHadTerminalError = false;
  return encodePiRequest(ctx, "prompt", { message: text }, "prompt");
}

export function encodePiInterruptMessage(
  ctx: PiCtx,
  text: string,
): { id: number; line: string } {
  ctx.pendingInterruptText = text;
  ctx.suppressInterruptAbortEnd = true;
  return encodePiRequest(ctx, "abort", {}, "abort");
}

export function parsePiLine(line: string, ctx: PiCtx): ParseResult {
  const trimmed = line.trim();
  if (!trimmed) return { events: [] };

  let msg: PiResponse & PiEvent;
  try {
    msg = JSON.parse(trimmed) as PiResponse & PiEvent;
  } catch {
    ctx.turnHadTerminalError = true;
    return {
      events: [
        {
          kind: "error",
          payload: {
            message: "Failed to parse Pi stdout line",
            raw_excerpt: trimmed.slice(0, 200),
          },
        },
      ],
    };
  }

  if (msg.type === "response") return handleResponse(msg, ctx);
  return handleEvent(msg, ctx);
}

function handleResponse(msg: PiResponse, ctx: PiCtx): ParseResult {
  const id = normalizeId(msg.id);
  const label = id === undefined ? undefined : ctx.pending.get(id);
  if (id !== undefined) ctx.pending.delete(id);

  const side: ParseResult["side"] =
    id === undefined
      ? undefined
      : { resolved: [{ id, result: msg.data, error: msg.error }] };

  if (msg.success === false) {
    const message = `RPC error for ${label ?? msg.command ?? "<unknown>"}${id !== undefined ? ` (id=${id})` : ""}: ${summarizeError(msg.error)}`;
    if (label === "get_state") {
      ctx.handshakeError = message;
      // The supervisor owns handshake failure reporting. Emitting an adapter
      // error here would race with the handshake catch path and duplicate the
      // terminal event for the same get_state failure.
      return { events: [], ...(side ? { side } : {}) };
    }
    ctx.turnHadTerminalError = true;
    return {
      events: [
        {
          kind: "error",
          payload: {
            message,
            provider: "pi",
            detail: { command: msg.command, id, error: msg.error },
          },
        },
      ],
      ...(side ? { side } : {}),
    };
  }

  if (label === "get_state") {
    ctx.ready = true;
    const data = isObject(msg.data) ? msg.data : {};
    const sessionId = stringField(data, "sessionId");
    const sessionFile = stringField(data, "sessionFile");
    if (sessionId) ctx.sessionId = sessionId;
    if (sessionFile) ctx.sessionFile = sessionFile;
    return {
      events: [],
      side: {
        ...(side ?? {}),
        ...(sessionId || sessionFile
          ? { persistSessionId: sessionId ?? sessionFile }
          : {}),
      },
    };
  }

  if (label === "abort" && ctx.pendingInterruptText !== undefined) {
    const text = ctx.pendingInterruptText;
    ctx.pendingInterruptText = undefined;
    ctx.turnHadTerminalError = false;
    const prompt = encodePiRequest(
      ctx,
      "prompt",
      {
        message: INTERRUPT_PREFIX + text,
        streamingBehavior: "followUp",
      },
      "prompt",
    );
    return {
      events: [],
      side: {
        ...(side ?? {}),
        reply: [prompt.line],
      },
    };
  }

  return { events: [], ...(side ? { side } : {}) };
}

function handleEvent(msg: PiEvent, ctx: PiCtx): ParseResult {
  switch (msg.type) {
    case "agent_start":
      ctx.turnHadTerminalError = false;
      // If Pi starts the replacement prompt without emitting an agent_end for
      // the aborted turn, stop suppressing so the replacement turn can finish.
      ctx.suppressInterruptAbortEnd = false;
      return { events: [] };
    case "message_update":
      return handleMessageUpdate(msg);
    case "message_end":
      return handleMessageEnd(msg, ctx);
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return handleToolEvent(msg);
    case "extension_error":
      ctx.turnHadTerminalError = true;
      return {
        events: [
          {
            kind: "error",
            payload: {
              message: `Pi extension error: ${summarizeError(msg.error)}`,
              provider: "pi",
              detail: {
                extensionPath: msg.extensionPath,
                event: msg.event,
                error: msg.error,
              },
            },
          },
        ],
      };
    case "auto_retry_start":
    case "auto_retry_end":
    case "compaction_start":
    case "compaction_end":
    case "queue_update":
      return {
        events: [
          { kind: "progress", payload: { detail: { kind: msg.type } } },
        ],
      };
    case "agent_end": {
      if (ctx.suppressInterruptAbortEnd) {
        ctx.suppressInterruptAbortEnd = false;
        return { events: [] };
      }
      const hadError = ctx.turnHadTerminalError;
      ctx.turnHadTerminalError = false;
      return hadError
        ? { events: [] }
        : { events: [{ kind: "done", payload: {} }] };
    }
    default:
      return { events: [] };
  }
}

function handleMessageUpdate(msg: PiEvent): ParseResult {
  const event = msg.assistantMessageEvent;
  const delta = event?.delta ?? event?.content;
  if (!event?.type || !delta) return { events: [] };

  const kind =
    event.type === "thinking_delta"
      ? "reasoning"
      : event.type === "text_delta"
        ? "output"
        : event.type === "toolcall_delta"
          ? "tool_call"
          : undefined;
  if (!kind) return { events: [] };

  return {
    events: [
      {
        kind: "progress",
        payload: {
          detail: {
            kind,
            text_delta: delta,
          },
        },
      },
    ],
  };
}

function handleMessageEnd(msg: PiEvent, ctx: PiCtx): ParseResult {
  const message = isObject(msg.message) ? msg.message : undefined;
  if (message?.role !== "assistant") return { events: [] };

  const stopReason = stringField(message, "stopReason") ?? msg.reason;
  const errorMessage = stringField(message, "errorMessage") ?? msg.errorMessage;
  if (stopReason === "aborted" && ctx.suppressInterruptAbortEnd) {
    // This is the expected terminal message for an interrupt we initiated.
    // Keep the replacement turn active; the deferred prompt will produce the
    // user-visible message/done events after Pi acknowledges abort.
    return { events: [] };
  }

  const events: AdapterEvent[] = [];
  const text = extractText(message.content);
  if (text) events.push({ kind: "message", payload: { text } });

  if (stopReason === "error" || stopReason === "aborted" || errorMessage) {
    ctx.turnHadTerminalError = true;
    events.push({
      kind: "error",
      payload: {
        message:
          errorMessage ??
          `Pi assistant message ended with stopReason '${stopReason ?? "error"}'`,
        provider: "pi",
        detail: { stopReason },
      },
    });
  }

  return { events };
}

function handleToolEvent(msg: PiEvent): ParseResult {
  const status =
    msg.type === "tool_execution_start"
      ? "running"
      : msg.type === "tool_execution_update"
        ? "running"
        : msg.isError
          ? "failed"
          : "completed";
  const detail: Record<string, unknown> = {
    kind: "tool",
    tool: msg.toolName ?? "tool",
    status,
  };
  if (msg.toolCallId) detail.tool_call_id = msg.toolCallId;
  if (msg.args !== undefined) detail.args_summary = summarize(msg.args);
  if (msg.partialResult !== undefined) {
    detail.partial_result_summary = summarize(msg.partialResult, 400);
  }
  if (msg.result !== undefined) detail.result_summary = summarize(msg.result, 400);
  if (msg.isError !== undefined) detail.is_error = msg.isError;

  return { events: [{ kind: "progress", payload: { detail } }] };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isObject(block)) return "";
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .join("");
}

function normalizeId(id: unknown): number | undefined {
  if (typeof id === "number" && Number.isFinite(id)) return id;
  if (typeof id === "string" && /^\d+$/.test(id)) return Number(id);
  return undefined;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function summarizeError(error: unknown): string {
  if (error === undefined || error === null) return "<no error detail>";
  if (typeof error === "string") return error;
  if (isObject(error) && typeof error.message === "string") return error.message;
  return summarize(error, 240);
}

function summarize(input: unknown, max = 120): string {
  if (input === null || input === undefined) return "";
  let s: string;
  try {
    s = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
