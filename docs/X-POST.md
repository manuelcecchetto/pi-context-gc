# Suggested X thread

Attach `assets/model-compaction.png` to post 1. The image is an AI-annotated illustration; the exact call boundaries are in OBSERVATION.md.

## 1

GPT-6 Astra is so good at… deciding when to compact itself?

I built a Pi package that gives the model a `compact_context` tool: finish a phase, save what matters, compact, and keep working.

In this run: Astra called it 50 times. Terra and Luna: zero. 👇

## 2

All three had the same model-agnostic tool available. Astra used it at phase boundaries; Terra/Luna let context grow until later compactions.

One sequential task, different phases and backends—not a controlled benchmark. The contrast is still interesting.

## 3

The model chooses WHEN. Pi and the compaction backend handle HOW.

The checkpoint keeps decisions, open loops, ruled-out paths, and verification state. Normal overflow safeguards remain.

Experimental + MIT:
https://github.com/manuelcecchetto/pi-context-gc
