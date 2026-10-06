# Compatibility and local changes

The publication review found two details that a plain copy of the original manifest would hide.

## Native backend

The local installation modified `@lll9p/pi-better-compaction` 0.2.1 inside `node_modules`. Installing the published npm dependency would lose that change. This repository therefore vendors its MIT-licensed source under `vendor/pi-better-compaction`, retaining its license and upstream metadata. Pi loads that entrypoint before the scheduler; no postinstall script patches the user's machine.

The only change from the npm 0.2.1 source is in `src/compact-client.ts`: when the standalone endpoint returns 404 for `openai-codex-responses`, it tries a streaming Responses request ending with `compaction_trigger` and extracts one opaque compaction item. This is an experimental service-dependent fallback, not a public API compatibility guarantee. Failed native handling can fall back to Pi's text summary. The upstream project is https://github.com/lll9p/pi-better-compaction.

### Existing local installations

The 2026-10-06 activation preserved a newer, separately maintained native backend (`0.7.2-pi1.0.1`) already present in the local installation and applied a scheduler-only overlay. This repository's older backend was not copied over it. Compare installed vendor provenance before syncing whole directories; reconcile the native backend separately before producing a unified release. The paired installed package passed 72 offline tests.

## Required runtime capability (unreleased)

The new scheduler requires `ctx.requestCompaction(options)`. Stock Pi 1.0.0 and older versions do not provide it. This is an explicit capability gate: the tool returns `accepted:false` with a useful reason on unsupported hosts. There is no silent fallback to `ctx.compact`, no postinstall patch and no runtime monkeypatch.

The source-backed host change is developed against Pi v1.0.0 on branch `fix/semantic-boundary-compaction`. It runs standard compaction at the pre-provider boundary without aborting/settling the parent, persists the supplied custom checkpoint, and owns continuation/pause semantics. `force:true` requests explicit semantic preparation; it does not alter automatic or overflow retention settings.

The exact source patch, base commit, license and application instructions are published under [`patches/`](../patches/README.md). This is a source patch, not a second Pi application or an automatic installer.

Update the runtime and scheduler together, then start a new Pi process. `/reload` alone cannot update a running core. Until this host API is published, the npm peer version range is necessary but insufficient; capability detection remains authoritative. The package does not install a host fork automatically.

## Privacy

The package ships no credentials, sessions, or runtime configuration. The backend uses the host's configured provider credentials. Native compaction sends conversation content to that provider. Optional debug logging may write conversation content locally; secret redaction is best-effort. Do not publish session/debug files. The aggregate chart is the only task evidence included here.
