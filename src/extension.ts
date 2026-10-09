import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { loadConfig } from "./config.ts";
import { hasBoundaryCompaction } from "./host.ts";
import {
  cancelPending,
  createRuntimeState,
  formatRuntimeStatus,
  invalidateRuntime,
  maybeStartAtTurnBoundary,
  resetRuntime,
  resumeCheckpoint,
  scheduleCheckpoint,
  startCompaction,
  supersedeCheckpoint,
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
    keep: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 16,
      description: "Durable decisions, invariants, changed files, identifiers, constraints, and facts the next phase needs.",
    }),
    open_loops: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { maxItems: 12 }),
    ),
    ruled_out: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        maxItems: 12,
        description: "Investigated paths that should not be repeated without new evidence.",
      }),
    ),
    verification: Type.Array(Type.String({ minLength: 1 }), {
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

        if (!hasBoundaryCompaction(ctx)) {
          return {
            content: [{ type: "text", text: "Context GC requires Pi's requestCompaction boundary API. This host is unsupported; no compaction was requested." }],
            details: { accepted: false, reason: "host lacks requestCompaction" },
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

    pi.on("turn_end", (event, ctx) => {
      const loaded = getLoaded(ctx);
      // turn_end runs after every message_end has persisted. Request here, not
      // in context (which is too late: the host already prepared that turn).
      maybeStartAtTurnBoundary(pi, ctx, runtime, loaded.config, [event.message, ...event.toolResults]);
    });

    // A real user steer changes the dependency graph. Do not compact against a
    // checkpoint produced before that instruction.
    pi.on("input", (event, ctx) => {
      if (event.source === "extension") return;
      const loaded = getLoaded(ctx);
      supersedeCheckpoint(pi, ctx, runtime, loaded.config);
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
