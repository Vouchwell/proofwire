import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { composePolicy } from '@vouchwell/core';

/**
 * The Claude Code plugin in plugins/vouchwell: its manifest and marketplace
 * entry, and its launcher driven the way Claude Code drives it, against this
 * checkout's CLI instead of one installed from npm.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PLUGIN = path.join(HERE, 'vouchwell');
const LAUNCHER = path.join(PLUGIN, 'scripts', 'vouchwell.mjs');
const CLI = path.join(ROOT, 'packages', 'cli', 'src', 'bin.js');
const json = (/** @type {string} */ file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** A fresh home, project, data folder, and the environment Claude Code gives a hook. */
function sandbox(extra = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vouchwell-plugin-'));
  const dirs = { home: path.join(base, 'home'), project: path.join(base, 'project'), data: path.join(base, 'data') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const env = {
    ...process.env,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    NO_COLOR: '1',
    VOUCHWELL_HOOK: '',
    CLAUDE_PLUGIN_ROOT: PLUGIN,
    CLAUDE_PLUGIN_DATA: dirs.data,
    CLAUDE_PROJECT_DIR: dirs.project,
    VOUCHWELL_PLUGIN_CLI: CLI,
    ...extra,
  };
  return { ...dirs, env, log: path.join(dirs.home, '.vouchwell', 'claude-code') };
}

/** @param {{ env: any, project: string }} box @param {string[]} args @param {string} [input] */
function run(box, args, input = '') {
  const res = spawnSync(process.execPath, [LAUNCHER, ...args], { cwd: box.project, env: box.env, input, encoding: 'utf8', timeout: 20000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** @param {string} name @param {object} fields */
const event = (name, fields) => JSON.stringify({ hook_event_name: name, session_id: 's1', ...fields });
const denied = (/** @type {string} */ stdout) => stdout.trim() ? JSON.parse(stdout).hookSpecificOutput?.permissionDecision === 'deny' : false;

test('the plugin installs the CLI of its own version, and the marketplace points at it', () => {
  const manifest = json(path.join(PLUGIN, '.claude-plugin', 'plugin.json'));
  assert.equal(manifest.version, json(path.join(ROOT, 'packages', 'cli', 'package.json')).version);
  const market = json(path.join(ROOT, '.claude-plugin', 'marketplace.json'));
  const entry = market.plugins.find((/** @type {any} */ p) => p.name === manifest.name);
  assert.ok(entry, 'the marketplace lists the plugin');
  assert.equal(path.resolve(ROOT, entry.source), PLUGIN);
});

test('every event `vw hook` handles is wired, plus SessionStart to install it', () => {
  const { hooks } = json(path.join(PLUGIN, 'hooks', 'hooks.json'));
  for (const name of ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'SessionEnd']) {
    const commands = (hooks[name] ?? []).flatMap((/** @type {any} */ g) => g.hooks.map((/** @type {any} */ h) => h.command));
    assert.equal(commands.length, 1, name);
    assert.match(commands[0], /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/vouchwell\.mjs" (setup|hook)$/, name);
  }
});

test('the bundled policy is exactly the coding-agent and shell-safety templates', () => {
  const bundled = json(path.join(PLUGIN, 'policy.json'));
  assert.deepEqual(bundled.rules, composePolicy(['coding-agent', 'shell-safety']).rules,
    'regenerate it: vw policy template coding-agent shell-safety --out plugins/vouchwell/policy.json');
});

test('a call is recorded in the user-level log, a secret file is refused, and the project is left untouched', () => {
  const box = sandbox();
  const ls = { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'ls' } };
  let r = run(box, ['hook'], event('PreToolUse', ls));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(denied(r.stdout), false);
  r = run(box, ['hook'], event('PostToolUse', { ...ls, tool_response: { stdout: 'a' } }));
  assert.equal(r.code, 0, r.stderr);

  r = run(box, ['hook'], event('PreToolUse', { tool_name: 'Read', tool_use_id: 't2', tool_input: { file_path: '/repo/.env' } }));
  assert.ok(denied(r.stdout), r.stdout + r.stderr);

  assert.ok(fs.existsSync(path.join(box.log, 'entries.jsonl')), 'the log is in ~/.vouchwell/claude-code');
  assert.deepEqual(fs.readdirSync(box.project), [], 'nothing is written into the project, so no key can be committed');
  const v = run(box, ['verify']);
  assert.equal(v.code, 0, v.stdout + v.stderr);
});

test('a project with its own vouchwell.config.json keeps its own log and policy', () => {
  const box = sandbox();
  fs.writeFileSync(path.join(box.project, 'vouchwell.config.json'), JSON.stringify({ log: '.audit', hook: { monitor: true } }));
  const r = run(box, ['hook'], event('PreToolUse', { tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: '/repo/.env' } }));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(denied(r.stdout), false, 'the project has no policy and says monitor');
  assert.ok(fs.existsSync(path.join(box.project, '.audit', 'entries.jsonl')));
  assert.equal(fs.existsSync(box.log), false);
});

test('monitor records what it would block; off records nothing', () => {
  const secret = event('PreToolUse', { tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: '/repo/.env' } });
  const monitor = sandbox({ CLAUDE_PLUGIN_OPTION_MODE: 'monitor' });
  assert.equal(denied(run(monitor, ['hook'], secret).stdout), false);
  assert.match(run(monitor, ['log', '--would-block']).stdout, /secret files/);

  const off = sandbox({ CLAUDE_PLUGIN_OPTION_MODE: 'off' });
  const r = run(off, ['hook'], secret);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(off.log), false);
});

test('without a CLI, enforce refuses the call and monitor lets it through', () => {
  const missing = { VOUCHWELL_PLUGIN_CLI: path.join(os.tmpdir(), 'no-such-vouchwell', 'bin.js') };
  const call = event('PreToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'ls' } });
  const enforce = run(sandbox(missing), ['hook'], call);
  assert.ok(denied(enforce.stdout));
  assert.match(JSON.parse(enforce.stdout).hookSpecificOutput.permissionDecisionReason, /not installed yet/);
  const monitor = run(sandbox({ ...missing, CLAUDE_PLUGIN_OPTION_MODE: 'monitor' }), ['hook'], call);
  assert.equal(monitor.stdout, '');
  assert.match(monitor.stderr, /not recording/);
});

test('an invalid mode fails closed when enforcing is the default', () => {
  const r = run(sandbox({ CLAUDE_PLUGIN_OPTION_MODE: 'loud' }), ['hook'],
    event('PreToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'ls' } }));
  assert.ok(denied(r.stdout));
});

test('the skill can read the log but not change it', () => {
  const box = sandbox();
  for (const cmd of ['shred', 'init', 'trust', 'push']) {
    const r = run(box, [cmd, '--before', '2100-01-01']);
    assert.equal(r.code, 2, cmd);
    assert.match(r.stderr, /unknown command/);
  }
});

test('until the pinned CLI is installed, the newest one installed earlier keeps recording', async () => {
  const { installedCli, cliPath } = await import(LAUNCHER);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'vouchwell-plugin-data-'));
  const env = { CLAUDE_PLUGIN_DATA: data };
  assert.equal(installedCli(data, env), null);
  const bin = (/** @type {string} */ v) => path.join(data, 'cli', v, 'node_modules', 'vouchwell', 'src', 'bin.js');
  for (const v of ['0.2.0', '0.10.0', '0.9.1']) {
    fs.mkdirSync(path.dirname(bin(v)), { recursive: true });
    fs.writeFileSync(bin(v), '');
  }
  fs.mkdirSync(path.join(data, 'cli', '.installing-1-2'));
  assert.equal(installedCli(data, env), bin('0.10.0'), 'compared as versions, not as text');
  fs.mkdirSync(path.dirname(cliPath(data, env)), { recursive: true });
  fs.writeFileSync(cliPath(data, env), '');
  assert.equal(installedCli(data, env), cliPath(data, env), 'the pinned one wins once present');
});
