// The "Vouchwell verify" GitHub Action (action.yml): check every matching
// evidence bundle, annotate the failures, write a job summary.
//
// Everything read from a bundle is attacker-controlled. It reaches the log
// only through `command()` and the summary only through `md()`, which escape
// it, so a bundle cannot issue workflow commands or inject markup.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 11)) {
  console.log(`::error title=Vouchwell verify::needs Node 20.11 or later, found ${process.versions.node}. Add actions/setup-node before this step.`);
  process.exit(1);
}

// Imported only after the version check, from this action's own checkout.
const { verifyBundle } = await import('../packages/core/src/log.js');
const { witnessKeysFrom, logKeysFrom } = await import('../packages/cli/src/witness-keys.js');

/** A workflow command, with its data and properties escaped as GitHub specifies. */
export function command(name, props, message) {
  const prop = (/** @type {string} */ v) =>
    String(v).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
  const data = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const p = Object.entries(props).map(([k, v]) => `${k}=${prop(v)}`).join(',');
  return `::${name}${p ? ` ${p}` : ''}::${data}`;
}

/** Text safe inside a Markdown table cell: no markup, no line breaks. */
export function md(s) {
  return String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}[\]()#+!|~])/g, '\\$1');
}

/**
 * Files under `root` matching any pattern: `*` and `?` within one path
 * segment, `**` across any number. Symlinked directories are not followed
 * and `.git` and `node_modules` are skipped.
 *
 * @param {string[]} patterns
 * @param {string} root
 * @returns {string[]} Paths relative to root, with `/`, sorted.
 */
export function expand(patterns, root) {
  /** @type {Set<string>} */
  const found = new Set();
  const special = /[*?]/;
  const toRegex = (/** @type {string} */ seg) =>
    new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
  const entries = (/** @type {string} */ dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  /** @param {string} rel @param {string[]} parts @param {number} i */
  const walk = (rel, parts, i) => {
    const abs = path.join(root, rel);
    if (i === parts.length) {
      try {
        if (fs.statSync(abs).isFile()) found.add(rel.split(path.sep).join('/'));
      } catch { /* gone */ }
      return;
    }
    const part = parts[i];
    if (part === '**') {
      walk(rel, parts, i + 1);
      for (const e of entries(abs)) {
        if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') walk(path.join(rel, e.name), parts, i);
      }
    } else if (!special.test(part)) {
      walk(path.join(rel, part), parts, i + 1);
    } else {
      const re = toRegex(part);
      for (const e of entries(abs)) if (re.test(e.name)) walk(path.join(rel, e.name), parts, i + 1);
    }
  };
  for (const pattern of patterns) {
    const parts = pattern.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
    if (parts.length) walk('', parts, 0);
  }
  return [...found].sort();
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} root
 * @returns {{ code: number, log: string[], summary: string, outputs: Record<string, string> }}
 */
export function run(env, root) {
  /** @type {string[]} */
  const log = [];
  const fail = (/** @type {string} */ msg) => ({
    code: 1,
    log: [command('error', { title: 'Vouchwell verify' }, msg)],
    summary: `### Vouchwell verify\n\n${md(msg)}\n`,
    outputs: { verified: '0', failed: '0' },
  });

  const minWitnesses = Number(env.VW_WITNESSES || '0');
  if (!Number.isInteger(minWitnesses) || minWitnesses < 0) return fail(`witnesses must be a whole number, got "${env.VW_WITNESSES}"`);
  /** @type {Record<string, string>|undefined} */
  let trustedLogKeys;
  /** @type {Record<string, string>|undefined} */
  let trustedWitnesses;
  try {
    const at = (/** @type {string|undefined} */ f) => (f ? path.resolve(root, f) : undefined);
    trustedLogKeys = logKeysFrom({ 'log-key': env.VW_LOG_KEY || undefined, 'log-keys': at(env.VW_LOG_KEYS) });
    trustedWitnesses = witnessKeysFrom({ 'witness-key': env.VW_WITNESS_KEY || undefined, 'witness-keys': at(env.VW_WITNESS_KEYS) });
  } catch (err) {
    return fail(/** @type {Error} */ (err).message);
  }
  if (minWitnesses > 0 && !trustedWitnesses) return fail('witnesses > 0 needs witness-key or witness-keys: a bundle cannot vouch for its own witnesses');

  const patterns = String(env.VW_BUNDLES || 'evidence/*.json').split(/\s+/).filter(Boolean);
  // Key files often sit beside the bundles (evidence/log-keys.json); they are
  // inputs to the check, not bundles to check.
  const keyFiles = new Set([env.VW_LOG_KEYS, env.VW_WITNESS_KEYS].filter(Boolean).map((f) => path.resolve(root, String(f))));
  const files = expand(patterns, root).filter((f) => !keyFiles.has(path.resolve(root, f)));
  if (files.length === 0) {
    const msg = `no file matches ${patterns.join(' ')}`;
    if (env.VW_ALLOW_EMPTY === 'true') {
      return { code: 0, log: [command('notice', { title: 'Vouchwell verify' }, msg)], summary: `### Vouchwell verify\n\n${md(msg)}\n`, outputs: { verified: '0', failed: '0' } };
    }
    return fail(`${msg}. Set allow-empty: true if that is expected.`);
  }

  const rows = [];
  let verified = 0;
  let failed = 0;
  /** @type {Map<string, string>} */
  const unpinned = new Map();
  for (const file of files) {
    let bundle;
    let res;
    try {
      bundle = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
      res = verifyBundle(bundle, { minWitnesses, trustedWitnesses, trustedLogKeys });
    } catch (err) {
      res = { ok: false, issues: [`not readable as a bundle: ${/** @type {Error} */ (err).message}`], checked: 0 };
    }
    if (res.ok) verified++;
    else failed++;
    if (!trustedLogKeys && bundle && typeof bundle.keyring === 'object' && bundle.keyring) {
      for (const e of Array.isArray(bundle.entries) ? bundle.entries : []) {
        const kid = e?.receipt?.attest?.kid;
        if (typeof kid === 'string' && typeof bundle.keyring[kid] === 'string') unpinned.set(kid, bundle.keyring[kid]);
      }
    }
    log.push(`${res.ok ? '✓' : '✗'} ${file}: ${res.ok ? `${res.checked} entries verified` : `${res.issues.length} problem(s)`}`);
    for (const issue of res.issues.slice(0, 20)) log.push(command('error', { file, title: 'Vouchwell: bundle does not verify' }, issue));
    if (res.issues.length > 20) log.push(command('error', { file }, `…and ${res.issues.length - 20} more`));
    rows.push(`| ${res.ok ? '✅' : '❌'} | \`${md(file)}\` | ${md(bundle?.log ?? '—')} | ${res.checked} | ${res.ok ? '' : md(res.issues[0] ?? '')} |`);
  }

  const notes = [];
  if (!trustedLogKeys && unpinned.size) {
    const pin = [...unpinned].map(([k, v]) => `${k}=${v}`).join(',');
    log.push(command('warning', { title: 'Vouchwell: log key not pinned' }, `These bundles prove someone signed them, not who. If this is your log's key (vw keys), pin it with log-key: ${pin}`));
    notes.push(`**Log key not pinned.** The bundles prove someone signed them, not who. If this is your log's key (\`vw keys\` prints it), add \`log-key: ${md(pin)}\`.`);
  }
  if (trustedLogKeys) notes.push(`Signed by a pinned log key${Object.keys(trustedLogKeys).length > 1 ? ' (one of ' + Object.keys(trustedLogKeys).length + ')' : ''}.`);
  if (minWitnesses > 0) notes.push(`Each bundle needs ${minWitnesses} trusted witness signature(s) on a covering checkpoint.`);

  const summary = [
    `### Vouchwell verify: ${failed ? `❌ ${failed} of ${files.length} failed` : `✅ ${verified} verified`}`,
    '',
    '| | Bundle | Log | Entries | Problem |',
    '| --- | --- | --- | ---: | --- |',
    ...rows,
    '',
    ...notes.map((n) => `- ${n}`),
    '',
  ].join('\n');
  return { code: failed ? 1 : 0, log, summary, outputs: { verified: String(verified), failed: String(failed) } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = run(process.env, process.cwd());
  for (const line of result.log) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.summary);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result.outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
  }
  process.exitCode = result.code;
}
