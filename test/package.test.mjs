import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

test('published entrypoints load through the real Pi extension loader', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const loaded = await loadExtensions(manifest.pi.extensions.map(p => resolve(p)), process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 2);
  assert.ok(loaded.extensions.some(extension => extension.tools.has('compact_context')));
});
