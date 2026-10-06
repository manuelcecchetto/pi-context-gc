import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Explicit unreleased host contract. Capability detection is mandatory; stock
// hosts must not fall back to the aborting manual ctx.compact() API.
type CompactOptions = NonNullable<Parameters<ExtensionContext["compact"]>[0]>;
export interface BoundaryCompactionOptions {
  customInstructions?: string;
  force?: boolean;
  continuation: { customType: string; content: string; display?: boolean; details?: unknown };
  autoResume?: boolean;
  resumeOnFailure?: boolean;
  onComplete?: CompactOptions["onComplete"];
  /** Cancellation reports AbortError and never enables failure auto-resume. */
  onError?: CompactOptions["onError"];
}

export interface BoundaryCompactionRequest {
  accepted: boolean;
  cancel(): boolean;
}

export interface BoundaryCompactionHost {
  requestCompaction(options: BoundaryCompactionOptions): BoundaryCompactionRequest;
}

export function hasBoundaryCompaction(
  ctx: ExtensionContext,
): ctx is ExtensionContext & BoundaryCompactionHost {
  return "requestCompaction" in ctx && typeof ctx.requestCompaction === "function";
}
