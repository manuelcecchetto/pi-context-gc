export const EXTENSION_ID = "pi-context-gc";
export const TOOL_NAME = "compact_context";
export const COMMAND_NAME = "context-gc";
export const CHECKPOINT_ENTRY_TYPE = "pi-context-gc-checkpoint";
export const RESUME_MESSAGE_TYPE = "pi-context-gc-resume";

export interface ContextGcConfig {
  enabled: boolean;
  autoResume: boolean;
  resumeOnFailure: boolean;
  notify: boolean;
}

export interface LoadedConfig {
  config: ContextGcConfig;
  globalPath: string;
  projectPath: string;
  loadedSources: string[];
  warnings: string[];
}

export interface ContextGcInput {
  completed_phase: string;
  next_focus: string;
  keep: string[];
  open_loops?: string[];
  ruled_out?: string[];
  verification: string[];
}

export interface ContextCheckpoint {
  id: string;
  sessionId: string;
  toolCallId: string;
  requestedAt: number;
  input: ContextGcInput;
  tokensAtRequest?: number;
  contextWindow?: number;
}

export type RuntimePhase =
  | "idle"
  | "pending"
  | "compacting"
  | "resume-pending"
  | "failed";

export interface RuntimeState {
  phase: RuntimePhase;
  generation: number;
  checkpoint: ContextCheckpoint | undefined;
  lastError: string | undefined;
  lastCompletedCheckpointId: string | undefined;
  cancelRequest: (() => boolean) | undefined;
}

export interface CompleteToolBatch {
  assistantIndex: number;
  toolCallIds: ReadonlySet<string>;
  resultIds: ReadonlySet<string>;
}
