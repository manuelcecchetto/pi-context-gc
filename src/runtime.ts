import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildCompactionInstructions, buildResumeMessage } from "./instructions.ts";
import { hasBoundaryCompaction } from "./host.ts";
import { getTrailingCompleteToolResultBatch } from "./tool-batches.ts";
import {
  CHECKPOINT_ENTRY_TYPE,
  EXTENSION_ID,
  RESUME_MESSAGE_TYPE,
  type ContextCheckpoint,
  type ContextGcConfig,
  type ContextGcInput,
  type RuntimeState,
} from "./types.ts";

export function createRuntimeState(): RuntimeState {
  return {
    phase: "idle",
    generation: 0,
    checkpoint: undefined,
    lastError: undefined,
    lastCompletedCheckpointId: undefined,
    cancelRequest: undefined,
  };
}

export function resetRuntime(runtime: RuntimeState): void {
  runtime.generation += 1;
  runtime.cancelRequest?.();
  runtime.cancelRequest = undefined;
  runtime.phase = "idle";
  runtime.checkpoint = undefined;
  runtime.lastError = undefined;
  runtime.lastCompletedCheckpointId = undefined;
}

export function invalidateRuntime(runtime: RuntimeState): void {
  resetRuntime(runtime);
}

export function safeSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

function sameSession(ctx: ExtensionContext, sessionId: string): boolean {
  return safeSessionId(ctx) === sessionId;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(
  ctx: ExtensionContext,
  config: ContextGcConfig,
  message: string,
  type: "info" | "warning" | "error",
  force = false,
): void {
  if (!ctx.hasUI || (!config.notify && !force)) return;
  try {
    ctx.ui.notify(`${EXTENSION_ID}: ${message}`, type);
  } catch {
    // UI is best-effort and must not affect context control flow.
  }
}

function setStatus(
  ctx: ExtensionContext,
  config: ContextGcConfig,
  text: string | undefined,
): void {
  if (!ctx.hasUI || !config.notify) return;
  try {
    ctx.ui.setStatus(EXTENSION_ID, text);
  } catch {
    // Best-effort only.
  }
}

function appendCheckpointEntry(
  pi: ExtensionAPI,
  checkpoint: ContextCheckpoint,
  status:
    | "requested"
    | "completed"
    | "failed"
    | "cancelled"
    | "resumed"
    | "continued-by-existing-turn",
  extra: Record<string, unknown> = {},
): void {
  try {
    pi.appendEntry(CHECKPOINT_ENTRY_TYPE, {
      version: 1,
      status,
      checkpoint,
      timestamp: Date.now(),
      ...extra,
    });
  } catch {
    // Persistence is diagnostic; the session compaction path remains authoritative.
  }
}

export function scheduleCheckpoint(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  toolCallId: string,
  input: ContextGcInput,
): { ok: true; checkpoint: ContextCheckpoint } | { ok: false; reason: string } {
  if (runtime.phase !== "idle") {
    return { ok: false, reason: `context GC is already ${runtime.phase}` };
  }

  const sessionId = safeSessionId(ctx);
  if (!sessionId) return { ok: false, reason: "unable to identify the active session" };

  let usage: ReturnType<ExtensionContext["getContextUsage"]>;
  try {
    usage = ctx.getContextUsage();
  } catch {
    usage = undefined;
  }

  const checkpoint: ContextCheckpoint = {
    id: randomUUID(),
    sessionId,
    toolCallId,
    requestedAt: Date.now(),
    input,
    ...(usage?.tokens !== null && usage?.tokens !== undefined
      ? { tokensAtRequest: usage.tokens }
      : {}),
    ...(usage ? { contextWindow: usage.contextWindow } : {}),
  };

  runtime.phase = "pending";
  runtime.checkpoint = checkpoint;
  runtime.lastError = undefined;
  appendCheckpointEntry(pi, checkpoint, "requested");
  return { ok: true, checkpoint };
}

function settleFailure(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
  checkpoint: ContextCheckpoint,
  message: string,
): void {
  runtime.phase = "failed";
  runtime.lastError = message;
  setStatus(ctx, config, "failed");
  appendCheckpointEntry(pi, checkpoint, "failed", { error: message });
  notify(
    ctx,
    config,
    `compaction failed: ${message}. No automatic continuation was requested. Use /context-gc retry or /context-gc resume.`,
    "error",
    true,
  );
}

function dispatchCheckpointResume(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
  checkpoint: ContextCheckpoint,
  reason: string,
): boolean {
  if (!sameSession(ctx, checkpoint.sessionId)) return false;

  try {
    pi.sendMessage(
      {
        customType: RESUME_MESSAGE_TYPE,
        content: [buildResumeMessage(checkpoint, runtime.lastCompletedCheckpointId === checkpoint.id), "", `Continuation reason: ${reason}`].join("\n"),
        display: false,
        details: {
          checkpointId: checkpoint.id,
          nextFocus: checkpoint.input.next_focus,
          reason,
        },
      },
      { triggerTurn: true },
    );
  } catch (error) {
    runtime.phase = "failed";
    runtime.checkpoint = checkpoint;
    runtime.lastError = `unable to dispatch continuation: ${errorText(error)}`;
    setStatus(ctx, config, "failed");
    notify(ctx, config, runtime.lastError, "error", true);
    return false;
  }

  appendCheckpointEntry(pi, checkpoint, "resumed", { reason });
  runtime.generation += 1;
  runtime.phase = "idle";
  runtime.checkpoint = undefined;
  runtime.lastError = undefined;
  setStatus(ctx, config, undefined);
  return true;
}

/**
 * Request Pi-owned compaction at the next pre-provider boundary. The host owns
 * atomic history/ledger installation and continuation; this never aborts the
 * parent or starts a competing resume turn.
 */
export function startCompaction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
): boolean {
  const checkpoint = runtime.checkpoint;
  if (!checkpoint) return false;
  if (runtime.phase !== "pending" && runtime.phase !== "failed") return false;
  if (!sameSession(ctx, checkpoint.sessionId)) {
    runtime.phase = "failed";
    runtime.lastError = "active session changed before compaction";
    return false;
  }

  if (!hasBoundaryCompaction(ctx)) {
    settleFailure(pi, ctx, runtime, config, checkpoint, "host requires requestCompaction boundary API");
    return false;
  }

  runtime.phase = "compacting";
  runtime.generation += 1;
  runtime.lastError = undefined;
  const generation = runtime.generation;
  setStatus(ctx, config, "compacting");
  notify(
    ctx,
    config,
    `semantic checkpoint requested${checkpoint.tokensAtRequest !== undefined ? ` at ${checkpoint.tokensAtRequest.toLocaleString()} tokens` : ""}; starting Pi compaction.`,
    "info",
  );

  let callbackSettled = false;
  const claim = (): boolean => {
    if (callbackSettled) return false;
    callbackSettled = true;
    return (
      runtime.generation === generation &&
      runtime.phase === "compacting" &&
      runtime.checkpoint?.id === checkpoint.id &&
      sameSession(ctx, checkpoint.sessionId)
    );
  };

  try {
    const request = ctx.requestCompaction({
      force: true,
      customInstructions: buildCompactionInstructions(checkpoint),
      continuation: {
        customType: RESUME_MESSAGE_TYPE,
        content: buildResumeMessage(checkpoint),
        display: false,
        details: { checkpointId: checkpoint.id, nextFocus: checkpoint.input.next_focus },
      },
      autoResume: config.autoResume,
      resumeOnFailure: config.resumeOnFailure,
      onComplete: (result) => {
        if (!claim()) return;
        runtime.phase = "resume-pending";
        runtime.lastCompletedCheckpointId = checkpoint.id;
        runtime.lastError = undefined;
        setStatus(ctx, config, "resume pending");
        appendCheckpointEntry(pi, checkpoint, "completed", {
          result: {
            tokensBefore: result.tokensBefore,
            estimatedTokensAfter: result.estimatedTokensAfter,
          },
        });

        runtime.cancelRequest = undefined;
        if (config.autoResume) {
          appendCheckpointEntry(pi, checkpoint, "continued-by-existing-turn");
          runtime.phase = "idle";
          runtime.checkpoint = undefined;
          setStatus(ctx, config, undefined);
        } else {
          notify(ctx, config, "compaction completed; use /context-gc resume when ready.", "info");
        }
      },
      onError: (error) => {
        if (!claim()) return;
        runtime.cancelRequest = undefined;
        if (config.resumeOnFailure && error.name !== "AbortError") {
          appendCheckpointEntry(pi, checkpoint, "failed", { error: errorText(error) });
          runtime.phase = "idle";
          runtime.checkpoint = undefined;
          runtime.lastError = errorText(error);
          setStatus(ctx, config, undefined);
          notify(ctx, config, `compaction failed: ${errorText(error)}; host continuing with the checkpoint.`, "warning", true);
        } else {
          settleFailure(pi, ctx, runtime, config, checkpoint, errorText(error));
        }
      },
    });
    if (!request.accepted) {
      if (claim()) settleFailure(pi, ctx, runtime, config, checkpoint, "host declined boundary compaction request");
      return false;
    }
    if (!callbackSettled) runtime.cancelRequest = () => request.cancel();
  } catch (error) {
    if (!callbackSettled) callbackSettled = true;
    if (runtime.generation === generation && sameSession(ctx, checkpoint.sessionId)) {
      settleFailure(pi, ctx, runtime, config, checkpoint, errorText(error));
    }
    return false;
  }

  return true;
}

/** Trigger only when the checkpoint tool result belongs to a complete trailing batch. */
export function maybeStartAtTurnBoundary(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
  messages: readonly unknown[],
): boolean {
  if (!config.enabled || runtime.phase !== "pending" || !runtime.checkpoint) return false;
  const batch = getTrailingCompleteToolResultBatch(messages);
  if (!batch || !batch.toolCallIds.has(runtime.checkpoint.toolCallId)) return false;
  return startCompaction(pi, ctx, runtime, config);
}

/** New user intent supersedes checkpoint state even if compaction is already in flight. */
export function supersedeCheckpoint(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
): void {
  const checkpoint = runtime.checkpoint;
  if (!checkpoint) return;
  // Invalidate first: cancel may synchronously notify observers. A false return
  // means the host already owns the work, not that the old task is still current.
  resetRuntime(runtime);
  appendCheckpointEntry(pi, checkpoint, "cancelled", { reason: "superseded by new user input" });
  setStatus(ctx, config, undefined);
}

export function cancelPending(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
  reason: string,
): boolean {
  const checkpoint = runtime.checkpoint;
  if (!checkpoint) return false;
  if (runtime.phase === "compacting" && !runtime.cancelRequest?.()) return false;
  appendCheckpointEntry(pi, checkpoint, "cancelled", { reason });
  runtime.cancelRequest = undefined;
  runtime.generation += 1;
  runtime.phase = "idle";
  runtime.checkpoint = undefined;
  runtime.lastError = undefined;
  setStatus(ctx, config, undefined);
  notify(ctx, config, `checkpoint cancelled: ${reason}`, "warning");
  return true;
}

export function resumeCheckpoint(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
  reason: string,
): boolean {
  const checkpoint = runtime.checkpoint;
  if (!checkpoint || !["pending", "failed", "resume-pending"].includes(runtime.phase)) return false;
  if (!sameSession(ctx, checkpoint.sessionId)) return false;

  return dispatchCheckpointResume(pi, ctx, runtime, config, checkpoint, reason);
}

/** @deprecated Use resumeCheckpoint; retained for API compatibility with early builds. */
export const resumeWithoutCompaction = resumeCheckpoint;

export function formatRuntimeStatus(runtime: RuntimeState, config: ContextGcConfig): string {
  const lines = [
    `phase: ${runtime.phase}`,
    `enabled: ${config.enabled}`,
    `auto resume: ${config.autoResume}`,
    `resume on failure: ${config.resumeOnFailure}`,
  ];
  if (runtime.checkpoint) {
    lines.push(`checkpoint: ${runtime.checkpoint.id}`);
    lines.push(`completed phase: ${runtime.checkpoint.input.completed_phase}`);
    lines.push(`next focus: ${runtime.checkpoint.input.next_focus}`);
    if (runtime.checkpoint.tokensAtRequest !== undefined) {
      lines.push(`tokens at request: ${runtime.checkpoint.tokensAtRequest.toLocaleString()}`);
    }
  }
  if (runtime.lastError) lines.push(`last error: ${runtime.lastError}`);
  if (runtime.lastCompletedCheckpointId) {
    lines.push(`last completed checkpoint: ${runtime.lastCompletedCheckpointId}`);
  }
  return lines.join("\n");
}
