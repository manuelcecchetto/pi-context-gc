# Compatibility and local changes

The publication review found two details that a plain copy of the original manifest would hide.

## Native backend

The local installation modified `@lll9p/pi-better-compaction` 0.2.1 inside `node_modules`. Installing the published npm dependency would lose that change. This repository therefore vendors its MIT-licensed source under `vendor/pi-better-compaction`, retaining its license and upstream metadata. Pi loads that entrypoint before the scheduler; no postinstall script patches the user's machine.

The only change from the npm 0.2.1 source is in `src/compact-client.ts`: when the standalone endpoint returns 404 for `openai-codex-responses`, it tries a streaming Responses request ending with `compaction_trigger` and extracts one opaque compaction item. This is an experimental service-dependent fallback, not a public API compatibility guarantee. Failed native handling can fall back to Pi's text summary. The upstream project is https://github.com/lll9p/pi-better-compaction.

## Forced preparation

The scheduler passes `force: true` as a host compatibility hint. The stock Pi 0.84.2 dependency does not implement this field; a TypeScript cast does not add runtime support. On stock hosts, compaction still uses Pi's normal preparation and may fail when too little eligible context exists. Failure pauses and remains available through `/context-gc resume`, `/context-gc retry`, or `/context-gc cancel`.

No host patch is included or silently installed. Early semantic compaction works when the host's ordinary eligibility requirements are satisfied. Do not interpret the hint as a guarantee that every request at any context size will compact.

## Privacy

The package ships no credentials, sessions, or runtime configuration. The backend uses the host's configured provider credentials. Native compaction sends conversation content to that provider. Optional debug logging may write conversation content locally; secret redaction is best-effort. Do not publish session/debug files. The aggregate chart is the only task evidence included here.
