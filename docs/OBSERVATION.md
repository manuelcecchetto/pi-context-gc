# One sequential task: observed model behavior

Snapshot: September 12–15, 2026, ending September 15 at 17:57 Europe/Rome.

| Active model | Recorded metered tool calls | Explicit compact_context invocations |
| --- | --- | --- |
| GPT-6 Astra | 1–2,224 | 50 |
| GPT-5.6 Terra | 2,225–2,730 | 0 |
| GPT-5.6 Luna | 2,731–5,977 | 0 |

The scheduler has no model-specific tool restriction. Its instruction is to compact after a coherent phase is complete and the next phase needs a materially different working set, without waiting for context pressure. Historical full prompts were not captured byte-for-byte for comparison.

The context line measures input tokens for the request producing each recorded top-level tool call. Batched tools share the same request measurement, and the request cost is counted once. The cumulative cost also includes text-only responses. Calls without reliable usage are omitted from the plotted axis. Explicit invocation counts and completed compaction counts differ: a request need not complete a compaction.

The dashed line is an estimated Standard API equivalent, not a bill or subscription-credit measurement. It uses fresh/cached/output rates per million of 10/1/50 for Astra, 2/0.2/12 for Terra, and 0.2/0.02/1.2 for Luna, with a 2x input and 1.5x output multiplier above 272k input tokens. Missing compaction usage and unsaved worker usage are not included. Pricing reference used in the local audit: https://developers.openai.com/api/docs/pricing.

This is a sequential task, not a randomized or matched-work benchmark: the models performed different phases, and compaction backends differed (mostly native for Astra, text for Terra/Luna). The record supports a difference in observed tool use, not a general ranking of model quality, causality, or a percentage savings claim.

The included image was annotated using image generation. Model ranges above come from the underlying logs; the image is illustrative and is not a pixel-exact data export. Raw task transcripts are intentionally excluded.
