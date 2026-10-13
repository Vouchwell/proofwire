import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { composePolicy } from '@vouchwell/core';
import { callTool, handle, TOOLS } from '../src/mcp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../src/bin.js');

/** A project whose log holds an allowed call (intent + outcome) and a refused one. */
function recorded() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vouchwell-mcp-'));
  fs.writeFileSync(path.join(cwd, 'vouchwell.policy.json'), JSON.stringify(composePolicy(['coding-agent'])));
  const hook = (/** @type {object} */ e) => {
    const r = spawnSync(process.execPath, [BIN, 'hook'], {
      cwd, input: JSON.stringify({ session_id: 's1', ...e }), encoding: 'utf8',
      env: { ...process.env, HOME: cwd, USERPROFILE: cwd, NO_COLOR: '1', VOUCHWELL_HOOK: '' },
    });
    assert.equal(r.status, 0, r.stderr);
  };
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'ls' } });
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'ls' }, tool_response: { stdout: '' } });
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't2', tool_input: { file_path: '/repo/.env' } });
  return { cwd, ctx: { dir: path.join(cwd, '.vouchwell'), cwd, version: 'test' } };
}

/** Talk to `vw mcp` over stdio, one line per message, and collect the replies. @param {string} cwd @param {object[]} messages */
function session(cwd, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'mcp'], { cwd, env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    let errText = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { errText += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({ code, replies: out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)), stderr: errText });
      } catch (e) {
        reject(new Error(`stdout is not one JSON message per line: ${out}`));
      }
    });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    child.stdin.end();
  });
}

test('an MCP client can initialize, list the tools, and read, verify and count the log', async () => {
  const { cwd } = recorded();
  const { code, replies } = /** @type {any} */ (await session(cwd, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'log_entries', arguments: { denied: true } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'verify_log', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'log_stats', arguments: {} } },
  ]));
  assert.equal(code, 0);
  assert.deepEqual(replies.map((/** @type {any} */ r) => r.id), [1, 2, 3, 4, 5], 'a notification gets no reply');
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  assert.equal(replies[0].result.serverInfo.name, 'vouchwell');
  assert.deepEqual(replies[1].result.tools.map((/** @type {any} */ t) => t.name), TOOLS.map((t) => t.name));

  const denied = replies[2].result.structuredContent;
  assert.equal(denied.matching, 1);
  assert.equal(denied.receipts[0].tool, 'claude-code.Read');
  assert.equal(denied.receipts[0].outcome, 'deny');
  assert.match(denied.receipts[0].reason, /secret files/);
  assert.deepEqual(JSON.parse(replies[2].result.content[0].text), denied, 'text and structured content agree');

  assert.equal(replies[3].result.structuredContent.ok, true);
  assert.equal(replies[3].result.structuredContent.entries, 3);
  assert.equal(replies[4].result.structuredContent.refused, 1);
});

test('every tool but export says it is read-only', () => {
  for (const t of TOOLS) {
    assert.equal(t.annotations.readOnlyHint, t.name !== 'export_evidence', t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
  }
});

test('an edited log fails verification, and says it is evidence, not damage', () => {
  const { ctx } = recorded();
  const file = path.join(ctx.dir, 'entries.jsonl');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"claude-code.Read"', '"claude-code.Glob"'));
  const res = callTool('verify_log', {}, ctx);
  assert.equal(res.ok, false);
  assert.ok(res.issues.length > 0);
  assert.match(res.note, /tampering/);
});

test('export writes a bundle check_bundle verifies, and refuses to overwrite or escape', () => {
  const { ctx } = recorded();
  const out = callTool('export_evidence', { path: 'evidence/run.json' }, ctx);
  assert.equal(out.entries, 3);
  assert.equal(out.file, 'evidence/run.json');
  assert.equal(callTool('check_bundle', { path: 'evidence/run.json' }, ctx).ok, true);

  const keys = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'keyring.json'), 'utf8'));
  const pinned = callTool('check_bundle', { path: 'evidence/run.json', log_keys: keys }, ctx);
  assert.equal(pinned.ok, true);
  assert.equal(pinned.signer_pinned, true);
  const wrong = callTool('check_bundle', { path: 'evidence/run.json', log_keys: { someone: 'AAAA' } }, ctx);
  assert.equal(wrong.ok, false, 'a bundle signed by a key other than the pinned one is refused');

  assert.throws(() => callTool('export_evidence', { path: 'evidence/run.json' }, ctx), /already exists/);
  assert.throws(() => callTool('export_evidence', { path: '../outside.json' }, ctx), /inside the working directory/);
  assert.throws(() => callTool('export_evidence', { path: '.vouchwell/x.json' }, ctx), /inside the log/);
  assert.throws(() => callTool('export_evidence', { since: 'yesterday-ish' }, ctx), /ISO date/);
});

test('bad calls come back as tool errors the agent can read, not crashes', () => {
  const { ctx } = recorded();
  const call = (/** @type {string} */ name, /** @type {any} */ args) =>
    handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, ctx).result;
  assert.equal(call('log_entries', { tail: 0 }).isError, true);
  assert.equal(call('log_entries', { tail: 10_000 }).isError, true);
  assert.equal(call('check_bundle', {}).isError, true);
  assert.equal(call('check_bundle', { path: 'missing.json' }).isError, true);
  assert.equal(call('shred', {}).isError, true);
  assert.equal(call('log_entries', 'not an object').isError, true);

  const empty = { ...ctx, dir: path.join(ctx.cwd, 'nothing-here') };
  const res = handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify_log' } }, empty).result;
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no Vouchwell log/);
  assert.equal(fs.existsSync(empty.dir), false, 'reading never creates a log');

  assert.equal(handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, ctx).error.code, -32601);
  assert.equal(handle({ id: 1 }, ctx).error.code, -32600);
});

test('the MCP Registry entry runs this package as `vw mcp`, under the name the package claims', () => {
  const root = path.resolve(HERE, '../../..');
  const server = JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '../package.json'), 'utf8'));
  assert.equal(server.name, pkg.mcpName, 'the registry checks the published package claims this name');
  assert.ok(server.description.length <= 100, 'the registry caps descriptions at 100 characters');
  const [npm] = server.packages;
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.deepEqual(npm.packageArguments[0], { type: 'positional', value: 'mcp' });
  assert.equal(npm.transport.type, 'stdio');
});
