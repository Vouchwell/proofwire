import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProofLog } from '../../packages/core/src/log.js';
import { run, expand, command, md } from '../run.mjs';

const RUN = fileURLToPath(new URL('../run.mjs', import.meta.url));

/** A workspace holding the given bundles, keyed by relative path. */
function workspace(/** @type {Record<string, unknown>} */ files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-action-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

function bundle(n = 3) {
  const log = ProofLog.create(fs.mkdtempSync(path.join(os.tmpdir(), 'vw-log-')));
  for (let i = 0; i < n; i++) {
    log.append({
      actor: { agent: 'a', runtime: 'test', session: 's', principal: 'p@x.test' },
      action: { kind: 'tool_call', target: 'crm.lookup', params: { i } },
      decision: { outcome: 'allow', policy: 'p', rules: [] },
      result: { status: 'ok', payload: { i }, latencyMs: 1 },
    });
  }
  log.checkpoint();
  return JSON.parse(JSON.stringify(log.bundle()));
}

const keyOf = (/** @type {any} */ b) => Object.entries(b.keyring).map(([k, v]) => `${k}=${v}`).join(',');

test('good bundles pass, and the summary and outputs say so', () => {
  const b = bundle();
  const root = workspace({ 'evidence/a.json': b, 'evidence/b.json': bundle(2) });
  const r = run({}, root);
  assert.equal(r.code, 0, r.log.join('\n'));
  assert.deepEqual(r.outputs, { verified: '2', failed: '0' });
  assert.match(r.summary, /✅ 2 verified/);
  // Unpinned: passes, but says what to pin.
  assert.ok(r.log.some((l) => l.startsWith('::warning') && l.includes(keyOf(b).split(',')[0])));
});

test('an edited bundle fails, with an annotation on the file', () => {
  const b = bundle();
  b.entries[1].receipt.action.target = 'crm.delete_everything';
  const r = run({}, workspace({ 'evidence/a.json': b }));
  assert.equal(r.code, 1);
  assert.deepEqual(r.outputs, { verified: '0', failed: '1' });
  assert.ok(r.log.some((l) => l.startsWith('::error file=evidence/a.json,')), r.log.join('\n'));
  assert.match(r.summary, /❌ 1 of 1 failed/);
});

test('a pinned log key turns away a well-formed bundle signed by anyone else', () => {
  const mine = bundle();
  const theirs = bundle();
  const root = workspace({ 'evidence/mine.json': mine, 'evidence/theirs.json': theirs });
  const r = run({ VW_LOG_KEY: keyOf(mine) }, root);
  assert.equal(r.code, 1);
  assert.deepEqual(r.outputs, { verified: '1', failed: '1' });
  assert.ok(r.log.some((l) => l.includes('theirs.json') && l.includes('not a log key you pinned')));
  assert.ok(!r.log.some((l) => l.startsWith('::warning')), 'no "pin your key" advice once one is pinned');
});

test('a key file kept beside the bundles is read as keys, not checked as a bundle', () => {
  const b = bundle();
  const keys = Object.entries(b.keyring).map(([kid, publicKey]) => ({ kid, publicKey }));
  const r = run({ VW_LOG_KEYS: 'evidence/log-keys.json' }, workspace({ 'evidence/a.json': b, 'evidence/log-keys.json': keys }));
  assert.equal(r.code, 0, r.log.join('\n'));
  assert.deepEqual(r.outputs, { verified: '1', failed: '0' });
});

test('nothing matching fails, unless that is declared fine', () => {
  const root = workspace({ 'other/x.txt': 'hi' });
  assert.equal(run({}, root).code, 1);
  assert.equal(run({ VW_ALLOW_EMPTY: 'true' }, root).code, 0);
});

test('bad settings fail loudly rather than weakening the check', () => {
  const root = workspace({ 'evidence/a.json': bundle() });
  assert.equal(run({ VW_WITNESSES: 'two' }, root).code, 1);
  assert.equal(run({ VW_WITNESSES: '1' }, root).code, 1, 'witnesses without trusted witness keys');
  assert.equal(run({ VW_LOG_KEY: 'no-equals-sign' }, root).code, 1);
});

test('a hostile bundle cannot issue workflow commands or inject markup', () => {
  const b = bundle();
  b.log = 'x\n::error::owned\n<img src=x onerror=alert(1)>|';
  b.entries[0].receipt.action.target = 'y\r\n::set-output name=verified::999';
  const r = run({}, workspace({ 'evidence/a.json': b }));
  for (const line of r.log) assert.ok(!/[\r\n]/.test(line), `one line per command: ${JSON.stringify(line)}`);
  assert.doesNotMatch(r.summary, /<img/);
  assert.equal(command('error', { file: 'a,b:c' }, 'm\nn%'), '::error file=a%2Cb%3Ac::m%0An%25');
  assert.equal(md('a|b<c>\n`d`'), 'a\\|b&lt;c&gt; \\`d\\`');
});

test('globs: * within a folder, ** across folders, .git and node_modules skipped', () => {
  const root = workspace({
    'evidence/a.json': '{}', 'evidence/sub/b.json': '{}', 'logs/x/y/c.json': '{}',
    '.git/d.json': '{}', 'node_modules/e.json': '{}', 'evidence/notes.md': '',
  });
  assert.deepEqual(expand(['evidence/*.json'], root), ['evidence/a.json']);
  assert.deepEqual(expand(['**/*.json'], root), ['evidence/a.json', 'evidence/sub/b.json', 'logs/x/y/c.json']);
  assert.deepEqual(expand(['evidence/*.json', 'logs/**/c.json'], root), ['evidence/a.json', 'logs/x/y/c.json']);
});

test('as GitHub runs it: exit code, step summary and outputs files', () => {
  const root = workspace({ 'evidence/a.json': bundle() });
  const summary = path.join(root, 'summary.md');
  const output = path.join(root, 'output.txt');
  const res = spawnSync(process.execPath, [RUN], {
    cwd: root,
    env: { ...process.env, VW_BUNDLES: 'evidence/*.json', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(fs.readFileSync(summary, 'utf8'), /Vouchwell verify/);
  assert.equal(fs.readFileSync(output, 'utf8'), 'verified=1\nfailed=0\n');
});
