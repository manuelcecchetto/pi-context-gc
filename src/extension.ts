import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { loadConfig } from "./config.ts";
import {
  cancelPending,
  createRuntimeState,
  formatRuntimeStatus,
  invalidateRuntime,
  maybeStartAtContextBoundary,
  resetRuntime,
  resumeCheckpoint,
  scheduleCheckpoint,
  startCompaction,
} from "./runtime.ts";
import {
  COMMAND_NAME,
  EXTENSION_ID,
  TOOL_NAME,
  type LoadedConfig,
} from "./types.ts";

const CompactContextParameters = Type.Object(
  {
    completed_phase: Type.String({
      minLength: 1,
      maxLength: 2000,
      description: "The coherent phase that is now complete, including its outcome.",
    }),
    next_focus: Type.String({
      minLength: 1,
      maxLength: 2000,
      description: "The exact next subtask or working set to continue after compaction.",
    }),
    keep: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 1,
      maxItems: 16,
      description: "Durable decisions, invariants, changed files, identifiers, constraints, and facts the next phase needs.",
    }),
    open_loops: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 12 }),
    ),
    ruled_out: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
        maxItems: 12,
        description: "Investigated paths that should not be repeated without new evidence.",
      }),
    ),
    verification: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 1,
      maxItems: 12,
      description: "Concrete evidence that the completed phase is done: tests, checks, acceptance criteria, or validated conclusions. Put remaining failures in open_loops.",
    }),
  },
  { additionalProperties: false },
);

type CompactContextInput = Static<typeof CompactContextParameters>;

interface ContextGcToolDetails {
  accepted: boolean;
  reason?: string;
  checkpointId?: string;
  tokensAtRequest?: number;
}

function notifyDiagnostics(ctx: ExtensionContext, loaded: LoadedConfig): void {
  if (!ctx.hasUI) return;
  for (const warning of loaded.warnings) {
    ctx.ui.notify(`${EXTENSION_ID}: ${warning}`, "warning");
  }
}

function registerCommand(
  pi: ExtensionAPI,
  runtime: ReturnType<typeof createRuntimeState>,
  getLoaded: (ctx: ExtensionContext) => LoadedConfig,
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Inspect or recover semantic context GC (status | retry | resume | cancel)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const loaded = getLoaded(ctx);
      const action = args.trim().toLowerCase() || "status";

      if (action === "status") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            [
              formatRuntimeStatus(runtime, loaded.config),
              `global config: ${loaded.globalPath}`,
              `project config: ${loaded.projectPath}`,
              `loaded config: ${loaded.loadedSources.join(", ") || "none"}`,
            ].join("\n"),
            "info",
          );
        }
        return;
      }

      if (action === "retry") {
        if (runtime.phase !== "failed" || !runtime.checkpoint) {
          if (ctx.hasUI) ctx.ui.notify(`${EXTENSION_ID}: there is no failed checkpoint to retry.`, "warning");
          return;
        }
        startCompaction(pi, ctx, runtime, loaded.config);
        return;
      }

      if (action === "resume") {
        if (!resumeCheckpoint(pi, ctx, runtime, loaded.config, "user requested /context-gc resume")) {
          if (ctx.hasUI) ctx.ui.notify(`${EXTENSION_ID}: there is no pending or failed checkpoint.`, "warning");
        }
        return;
      }

      if (action === "cancel") {
        if (!cancelPending(pi, ctx, runtime, loaded.config, "user requested /context-gc cancel")) {
          if (ctx.hasUI) ctx.ui.notify(`${EXTENSION_ID}: there is no pending or failed checkpoint.`, "warning");
        }
        return;
      }

      if (ctx.hasUI) {
        ctx.ui.notify(`${EXTENSION_ID}: usage: /context-gc status | retry | resume | cancel`, "warning");
      }
    },
  });
}

export function createContextGcExtension(): (pi: ExtensionAPI) => void {
  return function contextGcExtension(pi: ExtensionAPI): void {
    const runtime = createRuntimeState();
    let loadedConfig: LoadedConfig | undefined;

    const getLoaded = (ctx: ExtensionContext): LoadedConfig => {
      loadedConfig ??= loadConfig(ctx);
      return loadedConfig;
    };

    pi.on("session_start", (_event, ctx) => {
      resetRuntime(runtime);
      loadedConfig = loadConfig(ctx);
      notifyDiagnostics(ctx, loadedConfig);
    });

    pi.registerTool({
      name: TOOL_NAME,
      label: "Compact Context",
      description:
        "Request semantic context garbage collection at a real phase boundary. Use only after a coherent phase is complete and the next phase no longer needs its raw reads, logs, test output, or superseded snapshots. This tool records a task/search checkpoint; the harness waits for the entire tool-result batch, runs Pi's standard compaction pipeline, and resumes automatically. Do not call merely because context is large, while hypotheses are unresolved, or immediately before the final answer. Call it alone when possible.",
      promptSnippet: "Checkpoint completed task state and compact obsolete context before a substantially different phase",
      promptGuidelines: [
        "Use compact_context after a coherent phase is complete and the next phase has a materially different working set; do not wait for context pressure when the old raw context is dead.",
        "Call compact_context only when completed_phase, next_focus, durable state, open loops, ruled-out paths, and verification status can be stated accurately.",
        "Do not use compact_context as a generic progress update, while debugging unresolved competing hypotheses, alongside avoidable sibling tools, or just before returning the final answer.",
        "After calling compact_context, stop issuing further work in that turn; the harness will compact after the complete tool batch and resume from next_focus.",
      ],
      parameters: CompactContextParameters,
      executionMode: "sequential",
      async execute(
        toolCallId,
        params: CompactContextInput,
        signal,
        _onUpdate,
        ctx,
      ): Promise<AgentToolResult<ContextGcToolDetails>> {
        const loaded = getLoaded(ctx);
        if (!loaded.config.enabled) {
          return {
            content: [{ type: "text", text: "Context GC is disabled by configuration." }],
            details: { accepted: false, reason: "disabled" },
          };
        }
        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Context GC request was aborted." }],
            details: { accepted: false, reason: "aborted" },
          };
        }

        const result = scheduleCheckpoint(pi, ctx, runtime, toolCallId, params);
        if (!result.ok) {
          return {
            content: [{ type: "text", text: `Context GC was not scheduled: ${result.reason}.` }],
            details: { accepted: false, reason: result.reason },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: "Semantic checkpoint recorded. Stop this phase now. The harness will compact only after this complete tool-result batch is persisted, then resume from next_focus.",
            },
          ],
          details: {
            accepted: true,
            checkpointId: result.checkpoint.id,
            ...(result.checkpoint.tokensAtRequest !== undefined
              ? { tokensAtRequest: result.checkpoint.tokensAtRequest }
              : {}),
          },
        };
      },
    });

    pi.on("context", (event, ctx) => {
      const loaded = getLoaded(ctx);
      maybeStartAtContextBoundary(pi, ctx, runtime, loaded.config, event.messages);
    });

    // Fallback safe point: a tool call should normally create another context
    // event, but if another extension terminates the run first, compact from idle.
    pi.on("agent_settled", (_event, ctx) => {
      const loaded = getLoaded(ctx);
      if (runtime.phase !== "pending" || !ctx.isIdle()) return;

      // Never bypass the complete-batch invariant, even on the idle fallback.
      // Session context is authoritative here because all message_end persistence
      // has completed before agent_settled is emitted.
      try {
        const messages = ctx.sessionManager
          .buildContextEntries()
          .flatMap((entry) => entry.type === "message" ? [entry.message] : []);
        maybeStartAtContextBoundary(pi, ctx, runtime, loaded.config, messages);
      } catch {
        // Leave the checkpoint pending rather than compacting an unverified tail.
      }
    });

    // A real user steer changes the dependency graph. Do not compact against a
    // checkpoint produced before that instruction.
    pi.on("input", (event, ctx) => {
      if (runtime.phase !== "pending" || event.source === "extension") return;
      const loaded = getLoaded(ctx);
      cancelPending(pi, ctx, runtime, loaded.config, "new user input arrived before compaction");
    });

    pi.on("session_shutdown", (_event, ctx) => {
      invalidateRuntime(runtime);
      if (ctx.hasUI) {
        try {
          ctx.ui.setStatus(EXTENSION_ID, undefined);
        } catch {
          // Best-effort cleanup.
        }
      }
    });

    registerCommand(pi, runtime, getLoaded);
  };
}

export default createContextGcExtension();
