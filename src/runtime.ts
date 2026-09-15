import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildCompactionInstructions, buildResumeMessage } from "./instructions.ts";
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
  };
}

export function resetRuntime(runtime: RuntimeState): void {
  runtime.generation += 1;
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
    `compaction failed: ${message}. The interrupted run was not resumed. Use /context-gc retry or /context-gc resume.`,
    "error",
    true,
  );

  if (config.resumeOnFailure) {
    setImmediate(() => {
      if (runtime.phase !== "failed" || runtime.checkpoint?.id !== checkpoint.id) return;
      resumeCheckpoint(pi, ctx, runtime, config, "automatic failure fallback");
    });
  }
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
        content: [buildResumeMessage(checkpoint), "", `Continuation reason: ${reason}`].join("\n"),
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

function finishAndMaybeResume(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
  checkpoint: ContextCheckpoint,
  generation: number,
): void {
  if (
    runtime.generation !== generation ||
    runtime.phase !== "resume-pending" ||
    runtime.checkpoint?.id !== checkpoint.id ||
    !sameSession(ctx, checkpoint.sessionId)
  ) {
    return;
  }

  let idle = false;
  try {
    idle = ctx.isIdle();
  } catch (error) {
    settleFailure(pi, ctx, runtime, config, checkpoint, `unable to inspect continuation state: ${errorText(error)}`);
    return;
  }

  if (!config.autoResume) {
    // Keep the checkpoint live so `/context-gc resume` can materialize it later.
    setStatus(ctx, config, "resume pending");
    notify(
      ctx,
      config,
      "compaction completed; automatic resume is disabled. Use /context-gc resume when ready.",
      "info",
    );
    return;
  }

  let hasPendingMessages = false;
  try {
    hasPendingMessages = ctx.hasPendingMessages();
  } catch {
    // Older compatible hosts may not expose reliable queue inspection.
  }

  if (!idle || hasPendingMessages) {
    appendCheckpointEntry(pi, checkpoint, "continued-by-existing-turn", {
      idle,
      hasPendingMessages,
    });
    runtime.generation += 1;
    runtime.phase = "idle";
    runtime.checkpoint = undefined;
    runtime.lastError = undefined;
    setStatus(ctx, config, undefined);
    notify(
      ctx,
      config,
      "compaction completed; an existing queued turn already owns continuation.",
      "info",
    );
    return;
  }

  if (dispatchCheckpointResume(
    pi,
    ctx,
    runtime,
    config,
    checkpoint,
    "semantic phase-boundary compaction completed",
  )) {
    notify(ctx, config, "compaction completed; resumed from the task checkpoint.", "info");
  }
}

/**
 * Start one Pi-owned compaction. Pi aborts the active low-level run, then enters
 * its standard manual compaction pipeline. Any installed session_before_compact
 * backend therefore handles both this request and Pi's normal safety triggers.
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
    const compact = ctx.compact as (
      options: NonNullable<Parameters<typeof ctx.compact>[0]> & { force: boolean },
    ) => void;
    compact({
      force: true,
      customInstructions: buildCompactionInstructions(checkpoint),
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

        // Pi flushes queued input from its compaction-end handler. Defer one
        // event-loop turn so ctx.isIdle() reflects any turn already started.
        setImmediate(() => finishAndMaybeResume(pi, ctx, runtime, config, checkpoint, generation));
      },
      onError: (error) => {
        if (!claim()) return;
        settleFailure(pi, ctx, runtime, config, checkpoint, errorText(error));
      },
    });
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
export function maybeStartAtContextBoundary(
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

export function cancelPending(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
  reason: string,
): boolean {
  const checkpoint = runtime.checkpoint;
  if (!checkpoint || !["pending", "failed", "resume-pending"].includes(runtime.phase)) return false;
  appendCheckpointEntry(pi, checkpoint, "cancelled", { reason });
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
