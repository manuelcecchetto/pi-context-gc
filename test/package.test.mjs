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


test('distribution includes the explicit runtime prerequisite and its upstream license', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.files.includes('patches'));
  const patch = await readFile(new URL('../patches/pi-1.0.0-semantic-compaction.patch', import.meta.url), 'utf8');
  assert.match(patch, /requestCompaction/);
  assert.match(patch, /agent-session-boundaries\.test\.ts/);
  const license = await readFile(new URL('../patches/PI-LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Copyright \(c\) 2025 Mario Zechner/);
});
