# Companion Pi runtime patch

This branch requires `ctx.requestCompaction`, which stock Pi 1.0.0 does not expose. The scheduler cannot supply this capability itself. The patch here is the exact source diff used for the locally built and tested runtime, including its regression tests and API documentation.

- Upstream: https://github.com/earendil-works/pi
- Base tag: `v1.0.0`
- Base commit: `a13d35a742c6ef8462812a28fbe1d8c8b7431c32`
- Patch: `pi-1.0.0-semantic-compaction.patch`
- SHA-256: `ad4d2f6e231d82c12570f9fa7bb6bb27fc2b5ae5693165ffb8926efda36adc44`
- License: MIT; upstream notice retained in `PI-LICENSE`

## Apply to source

Use a clean checkout of the exact base. Do not apply this directly to an installed `node_modules` directory or overwrite an unrelated dirty checkout.

```bash
git clone https://github.com/earendil-works/pi.git pi-runtime
cd pi-runtime
git switch --detach v1.0.0
git apply --check /absolute/path/to/pi-context-gc/patches/pi-1.0.0-semantic-compaction.patch
git apply /absolute/path/to/pi-context-gc/patches/pi-1.0.0-semantic-compaction.patch
```

Then follow that checkout's build and packaging instructions to build/install both changed packages (`pi-agent-core` and `pi-coding-agent`) together. The runtime bundle must be rebuilt; copying TypeScript or changing only the unbundled SDK does not update the CLI/RPC runtime. This package never applies the patch or replaces a user's Pi automatically.

The local verification used `npm run build:offline` after dependency installation and model-data hydration, packed both changed packages, and checked an isolated consumer before activation. The complete runtime check still encounters an unrelated Together model-catalog fixture mismatch; see [validation](../docs/VALIDATION.md). This is an experimental source handoff, not a published upstream Pi release or a turnkey installer.

## Use the scheduler

After installing a capable runtime, use `scheduler-only.ts` from this branch with Pi's standard text compactor or a separately compatible native backend. The repository's older vendored native backend was not upgraded by this change; the newer local backend used for the paired 72-test activation is not part of this patch. See [compatibility](../docs/COMPATIBILITY.md).

Restart Pi after the runtime update. Ordinary pi-gna users do not need this patch or a second installation. `pi-semantic-compaction` was only the local worktree name, not a package or required folder.
