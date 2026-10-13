import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProofLog, composePolicy } from '@vouchwell/core';
import { normalizeEvent } from '../src/hook.js';

/**
 * `vw hook --client codex|cursor`: the same recording and gating as for
 * Claude Code, reached through each client's own events and answers. Payloads
 * follow Codex's published hook schemas and Cursor's documented hook fields.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../src/bin.js');

/** A project with the coding-agent and shell-safety templates as its policy. */
function project() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vouchwell-clients-'));
  fs.writeFileSync(path.join(cwd, 'vouchwell.policy.json'), JSON.stringify(composePolicy(['coding-agent', 'shell-safety'])));
  return cwd;
}

/** @param {string} cwd @param {string[]} args @param {string} [input] */
function vw(cwd, args, input) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, HOME: cwd, USERPROFILE: cwd, NO_COLOR: '1', VOUCHWELL_HOOK: '' },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const entries = (/** @type {string} */ cwd) => ProofLog.open(path.join(cwd, '.vouchwell'), { readOnly: true }).entries;

// ── Codex ──────────────────────────────────────────────────────────────

/** A Codex hook payload, as its schema requires. @param {string} name @param {object} fields */
const codex = (name, fields) => JSON.stringify({
  hook_event_name: name, session_id: 's1', turn_id: 't1', cwd: '/repo', model: 'gpt-5-codex',
  permission_mode: 'default', transcript_path: null, ...fields,
});

test('codex: an allowed call is an intent, then a linked outcome, under codex.*', () => {
  const cwd = project();
  const call = { tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command: 'ls' } };
  const pre = vw(cwd, ['hook', '--client', 'codex'], codex('PreToolUse', call));
  assert.equal(pre.code, 0, pre.stderr);
  assert.equal(pre.stdout, '', 'Codex reads empty stdout as "carry on"; anything else would be parsed');
  assert.equal(vw(cwd, ['hook', '--client', 'codex'], codex('PostToolUse', { ...call, tool_response: 'a\nb' })).code, 0);

  const [intent, outcome] = entries(cwd);
  assert.equal(intent.action.target, 'codex.Bash');
  assert.equal(intent.actor.session, 'codex_s1');
  assert.equal(intent.actor.agent, 'codex');
  assert.equal(outcome.phase, 'outcome');
  assert.equal(outcome.result.status, 'ok');
});

test('codex: a refused call is denied in the answer Codex accepts, with a reason', () => {
  const cwd = project();
  const r = vw(cwd, ['hook', '--client', 'codex'], codex('PreToolUse', { tool_name: 'apply_patch', tool_use_id: 'c2', tool_input: { file_path: '/repo/.env' } }));
  const answer = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(answer.hookEventName, 'PreToolUse');
  assert.equal(answer.permissionDecision, 'deny');
  assert.ok(answer.permissionDecisionReason.trim(), 'Codex rejects a deny without a reason');
  assert.equal(entries(cwd)[0].decision.outcome, 'deny');
});

test('codex: an escalation is refused, never "ask" (Codex rejects it), and says what a person can do', () => {
  const cwd = project();
  const r = vw(cwd, ['hook', '--client', 'codex'], codex('PreToolUse', { tool_name: 'Bash', tool_use_id: 'c3', tool_input: { command: 'git push --no-verify' } }));
  const answer = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(answer.permissionDecision, 'deny');
  assert.match(answer.permissionDecisionReason, /Codex hooks cannot ask/);
  const [receipt] = entries(cwd);
  assert.equal(receipt.decision.outcome, 'deny');
  assert.match(receipt.decision.reason, /needs a person/);
});

test('codex: in monitor mode the escalation runs and is recorded as what it would have been', () => {
  const cwd = project();
  const r = vw(cwd, ['hook', '--client', 'codex', '--monitor'], codex('PreToolUse', { tool_name: 'Bash', tool_use_id: 'c4', tool_input: { command: 'git push --no-verify' } }));
  assert.equal(r.stdout, '');
  assert.equal(entries(cwd)[0].decision.wouldBe, 'deny');
});

// ── Cursor ─────────────────────────────────────────────────────────────

/** A Cursor hook payload. @param {string} name @param {object} fields @param {string} root */
const cursor = (name, fields, root) => JSON.stringify({
  hook_event_name: name, conversation_id: 'conv1', generation_id: 'gen1', workspace_roots: [root],
  cursor_version: '2.1.0', user_email: 'dev@example.test', ...fields,
});

test('cursor: events are translated, the log is kept in the workspace, and the chain verifies', () => {
  const root = project();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'vouchwell-cursor-home-'));
  const call = { tool_name: 'Shell', tool_use_id: 'u1', tool_input: { command: 'ls' } };
  // Run from outside the project, as a user-level Cursor hook may be.
  const pre = vw(elsewhere, ['hook', '--client', 'cursor'], cursor('preToolUse', call, root));
  assert.equal(pre.code, 0, pre.stderr);
  assert.equal(pre.stdout, '');
  vw(elsewhere, ['hook', '--client', 'cursor'], cursor('postToolUse', { ...call, tool_response: { output: 'x' }, duration: 12 }, root));
  vw(elsewhere, ['hook', '--client', 'cursor'], cursor('sessionEnd', { status: 'completed' }, root));

  assert.ok(!fs.existsSync(path.join(elsewhere, '.vouchwell')), 'nothing is written where the hook happened to start');
  const [intent, outcome] = entries(root);
  assert.equal(intent.action.target, 'cursor.Shell');
  assert.equal(intent.actor.session, 'cursor_conv1');
  assert.equal(outcome.result.status, 'ok');
  const v = vw(root, ['verify']);
  assert.equal(v.code, 0, v.stdout);
});

test("cursor: refused and escalated calls get Cursor's own answer", () => {
  const root = project();
  const denied = vw(root, ['hook', '--client', 'cursor'], cursor('preToolUse', { tool_name: 'Read', tool_use_id: 'u2', tool_input: { file_path: '/repo/.env' } }, root));
  const d = JSON.parse(denied.stdout);
  assert.equal(d.permission, 'deny');
  assert.match(d.user_message, /secret files/);
  assert.equal(d.agent_message, d.user_message);

  const asked = vw(root, ['hook', '--client', 'cursor'], cursor('preToolUse', { tool_name: 'Shell', tool_use_id: 'u3', tool_input: { command: 'git push --no-verify' } }, root));
  assert.equal(JSON.parse(asked.stdout).permission, 'ask');
  // Never approved: the session end records it as declined.
  vw(root, ['hook', '--client', 'cursor'], cursor('sessionEnd', {}, root));
  const last = entries(root).at(-1);
  assert.equal(last.decision.outcome, 'deny');
  assert.equal(last.decision.declined.by, 'cursor:user');
});

test('cursor: a failed call is an error outcome; MCP arguments sent as a JSON string are read as JSON', () => {
  const root = project();
  const call = { tool_name: 'MCP:db_query', tool_use_id: 'u4', tool_input: '{"sql":"select 1"}' };
  vw(root, ['hook', '--client', 'cursor'], cursor('preToolUse', call, root));
  vw(root, ['hook', '--client', 'cursor'], cursor('postToolUseFailure', { ...call, error: 'timeout' }, root));
  const [intent, outcome] = entries(root);
  assert.equal(intent.action.target, 'cursor.MCP:db_query');
  assert.equal(outcome.result.status, 'error');
  assert.equal(outcome.result.code, 'tool_error');
});

test('cursor: Windows roots and a byte-order mark are handled', () => {
  const e = normalizeEvent({ hook_event_name: 'preToolUse', conversation_id: 'c', workspace_roots: ['/C:/Users/dev/app'] }, 'cursor');
  assert.equal(e.cwd, 'C:/Users/dev/app');
  assert.equal(e.hook_event_name, 'PreToolUse');
  assert.equal(normalizeEvent({ hook_event_name: 'beforeShellExecution' }, 'cursor').hook_event_name, undefined,
    'the shell-specific events also fire for the same call; only the generic ones are handled, so nothing is recorded twice');

  const root = project();
  const r = vw(root, ['hook', '--client', 'cursor'], '\uFEFF' + cursor('preToolUse', { tool_name: 'Shell', tool_use_id: 'u5', tool_input: { command: 'ls' } }, root));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(entries(root).length, 1);
});

// ── install ────────────────────────────────────────────────────────────

test('install: Codex gets .codex/hooks.json in its own shape; it is idempotent and uninstalls cleanly', () => {
  const cwd = project();
  assert.equal(vw(cwd, ['hook', 'install', '--client', 'codex']).code, 0);
  assert.equal(vw(cwd, ['hook', 'install', '--client', 'codex']).code, 0);
  const file = path.join(cwd, '.codex', 'hooks.json');
  const { hooks } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionEnd']);
  assert.equal(hooks.PreToolUse.length, 1, 'installing twice adds nothing');
  assert.deepEqual(hooks.PreToolUse[0], { matcher: '*', hooks: [{ type: 'command', command: 'vw hook --client codex', timeout: 30 }] });

  assert.equal(vw(cwd, ['hook', 'uninstall', '--client', 'codex']).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks, undefined);
});

test("install: Cursor gets .cursor/hooks.json, fail-closed when enforcing, beside the user's own hooks", () => {
  const cwd = project();
  fs.mkdirSync(path.join(cwd, '.cursor'));
  const mine = { command: './audit.sh' };
  fs.writeFileSync(path.join(cwd, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { preToolUse: [mine] } }));

  assert.equal(vw(cwd, ['hook', 'install', '--client', 'cursor']).code, 0);
  const file = path.join(cwd, '.cursor', 'hooks.json');
  let cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.version, 1);
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ['postToolUse', 'postToolUseFailure', 'preToolUse', 'sessionEnd']);
  assert.deepEqual(cfg.hooks.preToolUse, [mine, { command: 'vw hook --client cursor', timeout: 30, failClosed: true }]);
  assert.equal(cfg.hooks.postToolUse[0].failClosed, undefined);

  assert.equal(vw(cwd, ['hook', 'uninstall', '--client', 'cursor']).code, 0);
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(cfg.hooks, { preToolUse: [mine] }, 'only our entries are removed');

  assert.equal(vw(cwd, ['hook', 'install', '--client', 'cursor', '--monitor']).code, 0);
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(cfg.hooks.preToolUse.at(-1), { command: 'vw hook --client cursor --monitor', timeout: 30 },
    'monitor mode blocks nothing, so a crash should not either');
});

test('an unknown client is an error, and --local is only for Claude Code', () => {
  const cwd = project();
  const r = vw(cwd, ['hook', '--client', 'copilot'], '{}');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--client must be one of claude-code, codex, cursor/);
  assert.notEqual(vw(cwd, ['hook', 'install', '--client', 'codex', '--local']).code, 0);
});
