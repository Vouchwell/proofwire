#!/usr/bin/env node
/**
 * The Vouchwell plugin's one entry point, for hooks and for the skill.
 *
 *   vouchwell.mjs setup     SessionStart: make sure the pinned CLI is installed
 *   vouchwell.mjs hook      every tool event: hand it to `vw hook`
 *   vouchwell.mjs mcp       the plugin's MCP server: `vw mcp` over this log
 *   vouchwell.mjs <cmd>     run a read-only `vw` command against the plugin's log
 *
 * The plugin carries no copy of Vouchwell itself. It installs the npm package
 * whose version matches the plugin's own into the plugin's data directory
 * (kept across plugin updates), so every hook runs a fixed, registry-verified
 * build rather than whatever `vw` happens to be on PATH.
 *
 * Where receipts go:
 *   - a project with its own vouchwell.config.json keeps full control: its
 *     log, its policy, its monitor setting;
 *   - anything else is recorded in one log for this user, by default
 *     ~/.vouchwell/claude-code, outside every repository, so a signing key can
 *     never be committed by accident, and outside the plugin's data
 *     directory, so uninstalling the plugin never deletes an audit trail.
 *
 * Plugin options (set in /plugin or /config) arrive as CLAUDE_PLUGIN_OPTION_*:
 *   MODE    enforce (default) | monitor | off
 *   LOG_DIR where the user-level log lives
 *   POLICY  a policy file to use instead of the bundled one
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;

/** `vw` commands the skill may run: they read the log or write a copy of it, never change it. */
export const READ_ONLY = new Set(['log', 'stats', 'verify', 'prove', 'export', 'check', 'report', 'keys', 'evidence']);

const MODES = new Set(['enforce', 'monitor', 'off']);

/** @param {NodeJS.ProcessEnv} env */
export function options(env = process.env) {
  const mode = (env.CLAUDE_PLUGIN_OPTION_MODE || 'enforce').trim().toLowerCase();
  if (!MODES.has(mode)) throw new Error(`mode "${mode}" is not one of enforce, monitor, off`);
  return {
    mode,
    logDir: path.resolve(env.CLAUDE_PLUGIN_OPTION_LOG_DIR?.trim() || path.join(os.homedir(), '.vouchwell', 'claude-code')),
    policy: path.resolve(env.CLAUDE_PLUGIN_OPTION_POLICY?.trim() || path.join(ROOT, 'policy.json')),
  };
}

/** The directory this plugin may keep installed files in. @param {string[]} argv */
function dataDir(argv, env = process.env) {
  const i = argv.indexOf('--data');
  const dir = i >= 0 ? argv[i + 1] : env.CLAUDE_PLUGIN_DATA;
  if (!dir) throw new Error('no plugin data directory: run this from a Claude Code hook, or pass --data <dir>');
  return dir;
}

/** Where the pinned CLI lives once installed. @param {string} data */
export function cliPath(data, env = process.env) {
  // For development and tests: a checkout's own CLI instead of the registry's.
  if (env.VOUCHWELL_PLUGIN_CLI) return path.resolve(env.VOUCHWELL_PLUGIN_CLI);
  return path.join(data, 'cli', VERSION, 'node_modules', 'vouchwell', 'src', 'bin.js');
}

/**
 * The CLI a hook should run: the pinned version, or, until that one is
 * installed (a plugin update that landed before the matching npm release), the
 * newest version installed earlier. Null when there is none at all.
 *
 * @param {string} data
 */
export function installedCli(data, env = process.env) {
  const pinned = cliPath(data, env);
  if (fs.existsSync(pinned)) return pinned;
  if (env.VOUCHWELL_PLUGIN_CLI) return null;
  let versions = [];
  try {
    versions = fs.readdirSync(path.join(data, 'cli')).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  } catch {
    return null;
  }
  const newest = versions.sort((a, b) => {
    const [x, y] = [a, b].map((v) => v.split('.').map(Number));
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  }).reverse().find((v) => fs.existsSync(path.join(data, 'cli', v, 'node_modules', 'vouchwell', 'src', 'bin.js')));
  return newest ? path.join(data, 'cli', newest, 'node_modules', 'vouchwell', 'src', 'bin.js') : null;
}

const LOCK_STALE_MS = 200_000; // longer than npm's timeout below

/** Block this process for `ms` without spinning. @param {number} ms */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Install vouchwell@<plugin version> into the data directory, once.
 *
 * SessionStart and the MCP server can both find the CLI missing when a session
 * starts, and two `npm install`s at once can trip over npm's shared cache. So
 * installing takes a lock (a directory: creating one is atomic everywhere);
 * whoever waits re-checks afterwards and usually finds the work done. The
 * install itself goes into a fresh folder renamed into place only when npm
 * succeeded, so one killed halfway never leaves a half-installed CLI where a
 * hook will find it.
 *
 * @param {string} data
 */
export function setup(data, env = process.env) {
  const bin = cliPath(data, env);
  if (fs.existsSync(bin)) return 0;
  if (!/^\d+\.\d+\.\d+$/.test(VERSION)) throw new Error(`plugin version "${VERSION}" is not a release`);

  const lock = path.join(data, 'cli', '.install.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // released between the two calls: try again at once
      }
      if (age > LOCK_STALE_MS) {
        fs.rmSync(lock, { recursive: true, force: true }); // its holder died
        continue;
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for another session to install the Vouchwell CLI');
      sleep(250);
    }
  }
  try {
    if (fs.existsSync(bin)) return 0; // the session we waited for installed it
    return install(data);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** The install itself, run only while holding the lock. @param {string} data */
function install(data) {
  const target = path.join(data, 'cli', VERSION);
  const staging = path.join(data, 'cli', `.installing-${process.pid}-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'package.json'), '{ "private": true }\n');
  process.stderr.write(`vouchwell: installing vouchwell@${VERSION} for the Claude Code plugin…\n`);
  const npm = spawnSync('npm', ['install', `vouchwell@${VERSION}`, '--ignore-scripts', '--no-audit', '--no-fund', '--update-notifier=false', '--loglevel=error'], {
    cwd: staging,
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
    timeout: 170_000,
  });
  if (npm.status !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(npm.error ? `could not run npm: ${npm.error.message}` : `npm install vouchwell@${VERSION} failed`);
  }
  try {
    fs.renameSync(staging, target);
  } catch {
    // Left over from an install that died after npm finished; ours is as good.
    fs.rmSync(staging, { recursive: true, force: true });
  }
  // Older versions are no longer referenced by anything.
  for (const old of fs.readdirSync(path.join(data, 'cli'))) {
    if (old !== VERSION && !old.startsWith('.')) fs.rmSync(path.join(data, 'cli', old), { recursive: true, force: true });
  }
  return 0;
}

/**
 * The `vw hook` arguments for this project, and the directory to run it in.
 *
 * @param {ReturnType<typeof options>} opts
 * @param {string} project
 */
export function hookArgs(opts, project) {
  const config = path.join(project, 'vouchwell.config.json');
  if (fs.existsSync(config)) return ['hook', '--config', config];
  const args = ['hook', '--log', opts.logDir, '--policy', opts.policy];
  if (opts.mode === 'monitor') args.push('--monitor');
  return args;
}

/** Tell Claude Code to refuse the call, with a reason the user sees. @param {string} reason */
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }) + '\n');
}

/** @param {string[]} argv */
export function main(argv, env = process.env) {
  const [cmd, ...rest] = argv.filter((a, i) => a !== '--data' && argv[i - 1] !== '--data');
  const data = () => dataDir(argv, env);

  if (cmd === 'setup') return options(env).mode === 'off' ? 0 : setup(data(), env);

  if (cmd === 'hook') {
    const input = fs.readFileSync(0, 'utf8');
    let opts;
    try {
      opts = options(env);
    } catch (e) {
      opts = null;
      process.stderr.write(`vouchwell: ${/** @type {Error} */ (e).message}\n`);
    }
    if (opts?.mode === 'off' || env.VOUCHWELL_HOOK === 'off') return 0;
    const enforcing = opts?.mode !== 'monitor';
    const bin = installedCli(data(), env);
    const preToolUse = /"hook_event_name"\s*:\s*"PreToolUse"/.test(input);
    if (!opts || !bin) {
      const why = !opts ? 'its settings are invalid' : 'the Vouchwell CLI is not installed yet (it installs when a session starts)';
      if (preToolUse && enforcing) {
        deny(`Vouchwell could not record this call, so it is refused: ${why}. ` +
          'Restart the session, or set the plugin\'s mode to monitor or off in /plugin.');
      } else {
        process.stderr.write(`vouchwell: not recording: ${why}\n`);
      }
      return 0;
    }
    const project = env.CLAUDE_PROJECT_DIR || process.cwd();
    const run = spawnSync(process.execPath, [bin, ...hookArgs(opts, project)], {
      cwd: project,
      input,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...env, NO_COLOR: '1' },
    });
    if (run.status === null && preToolUse && enforcing) {
      deny('Vouchwell could not record this call, so it is refused: the hook did not finish.');
      return 0;
    }
    return run.status ?? 0;
  }

  if (cmd === 'mcp') {
    // Claude Code may start MCP servers before SessionStart has installed the
    // CLI; install it here too. setup() takes a lock, so the two never run npm
    // at once, and it reports only on stderr, which MCP leaves free.
    if (!installedCli(data(), env)) setup(data(), env);
    const opts = options(env);
    const bin = installedCli(data(), env);
    if (!bin) throw new Error('the Vouchwell CLI could not be installed');
    const project = env.CLAUDE_PROJECT_DIR || process.cwd();
    const config = path.join(project, 'vouchwell.config.json');
    const where = fs.existsSync(config) ? ['--config', config] : ['--log', opts.logDir];
    return spawnSync(process.execPath, [bin, 'mcp', ...where], { cwd: project, stdio: 'inherit' }).status ?? 1;
  }

  if (cmd && READ_ONLY.has(cmd)) {
    const opts = options(env);
    const bin = installedCli(data(), env);
    if (!bin) throw new Error('the Vouchwell CLI is not installed yet; start a new session first');
    const project = env.CLAUDE_PROJECT_DIR || process.cwd();
    const config = path.join(project, 'vouchwell.config.json');
    // `check` reads only the bundle it is given; the rest read this project's log.
    const where = cmd === 'check' ? [] : fs.existsSync(config) ? ['--config', config] : ['--log', opts.logDir];
    // `evidence` is `vw hook evidence [dir]`; everything else is a top-level command.
    const args = cmd === 'evidence' ? ['hook', 'evidence', ...rest, ...where] : [cmd, ...rest, ...where];
    return spawnSync(process.execPath, [bin, ...args], { cwd: project, stdio: 'inherit' }).status ?? 1;
  }

  process.stderr.write(`vouchwell: unknown command "${cmd ?? ''}"; use setup, hook, mcp, or one of ${[...READ_ONLY].join(', ')}\n`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`vouchwell: ${/** @type {Error} */ (e).message}\n`);
    process.exitCode = 1;
  }
}
