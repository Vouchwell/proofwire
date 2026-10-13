import fs from 'node:fs';
import path from 'node:path';
import { ProofLog, verifyBundle, findUnfinished } from '@vouchwell/core';

/**
 * `vw mcp`: a Vouchwell log, as an MCP server.
 *
 * Any agent that speaks MCP can then answer "what did you do?" and "prove it"
 * from the record itself: read its receipts, verify the log, check a bundle
 * someone sent, or write one to share. Every tool reads the log; none can
 * change it. Exporting writes a new file and never overwrites one.
 *
 * Plain JSON-RPC over stdio, one message per line, as MCP's stdio transport
 * defines it. stdout carries protocol messages only.
 */

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_ROWS = 500;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: 'log_entries',
    title: 'Recent receipts',
    description: 'The most recent receipts in the Vouchwell log: what was called, when, and whether the policy allowed, refused or escalated it. Filters narrow it to refusals, calls monitor mode would have blocked, calls that never finished, a tool, or a session.',
    inputSchema: {
      type: 'object',
      properties: {
        tail: { type: 'integer', minimum: 1, maximum: MAX_ROWS, description: 'How many of the latest matching receipts to return (default 20).' },
        target: { type: 'string', description: 'Only tools whose name contains this text.' },
        session: { type: 'string', description: 'Only this session.' },
        denied: { type: 'boolean', description: 'Only calls the policy refused or escalated.' },
        would_block: { type: 'boolean', description: 'Only calls monitor mode let through that the policy would have blocked.' },
        unfinished: { type: 'boolean', description: 'Only calls that were authorised and sent but never reported a result.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Recent receipts', ...READ_ONLY },
  },
  {
    name: 'verify_log',
    title: 'Verify the log',
    description: 'Check every signature, hash-chain link and signed checkpoint in the Vouchwell log. ok: false means the log was altered after it was written: report it as evidence of tampering, never as something to repair.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Verify the log', ...READ_ONLY },
  },
  {
    name: 'log_stats',
    title: 'Log totals',
    description: 'Totals for the Vouchwell log: receipts, allowed, refused, escalated, tool errors, what monitor mode would have stopped, and the busiest tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Log totals', ...READ_ONLY },
  },
  {
    name: 'check_bundle',
    title: 'Check an evidence bundle',
    description: 'Verify a Vouchwell evidence bundle file using nothing but the file itself. Pin the signer with log_keys (kid=publicKey, as the log owner published them) to also prove who signed it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The bundle file, relative to the working directory or absolute.' },
        log_keys: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Trusted signing keys, kid → base64url public key. Without them, the bundle is checked against the keys it carries.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { title: 'Check an evidence bundle', ...READ_ONLY },
  },
  {
    name: 'export_evidence',
    title: 'Write an evidence bundle',
    description: 'Write the log as a new evidence bundle file anyone can verify offline with `vw check`; the log itself is not changed. It holds no payloads and no salts; argument previews, if the log records them, are included. Refuses to overwrite an existing file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Where to write it, relative to the working directory (default: vouchwell-<log>-<time>.bundle.json).' },
        session: { type: 'string', description: 'Only this session\'s receipts (a filtered bundle).' },
        since: { type: 'string', description: 'Only receipts from this ISO date or time on (a filtered bundle).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Write an evidence bundle', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

/** A tool call the caller got wrong: reported to the agent, not as a protocol error. */
class ToolError extends Error {}

/** @param {string} dir */
function openLog(dir) {
  if (!fs.existsSync(path.join(dir, 'config.json'))) {
    throw new ToolError(`no Vouchwell log at ${dir} yet: nothing has been recorded`);
  }
  return ProofLog.open(dir, { readOnly: true });
}

/** One receipt, as an agent needs to read it. @param {any} r */
function row(r) {
  return {
    seq: r.seq,
    ts: r.ts,
    phase: r.phase,
    tool: r.action.target,
    outcome: r.decision.outcome,
    ...(r.decision.wouldBe ? { would_be: r.decision.wouldBe } : {}),
    ...(r.decision.outcome !== 'allow' || r.decision.wouldBe ? { reason: r.decision.reason, rules: r.decision.rules } : {}),
    ...(r.result ? { status: r.result.status, ...(r.result.latencyMs !== undefined ? { latency_ms: r.result.latencyMs } : {}) } : {}),
    session: r.actor.session,
    principal: r.actor.principal,
  };
}

/**
 * Run one tool. Exported for tests.
 *
 * @param {string} name
 * @param {any} input
 * @param {{ dir: string, cwd: string }} ctx
 */
export function callTool(name, input = {}, ctx) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ToolError('arguments must be an object');

  if (name === 'log_entries') {
    const tail = input.tail ?? 20;
    if (!Number.isInteger(tail) || tail < 1 || tail > MAX_ROWS) throw new ToolError(`tail must be a whole number from 1 to ${MAX_ROWS}`);
    const log = openLog(ctx.dir);
    let entries = log.entries;
    if (typeof input.target === 'string') entries = entries.filter((r) => r.action.target.includes(input.target));
    if (typeof input.session === 'string') entries = entries.filter((r) => r.actor.session === input.session);
    if (input.denied === true) entries = entries.filter((r) => r.decision.outcome !== 'allow');
    if (input.would_block === true) entries = entries.filter((r) => r.decision.wouldBe && r.phase !== 'outcome');
    if (input.unfinished === true) {
      const found = findUnfinished(log.entries);
      const open = new Set([...found.unfinished, ...found.abandoned].map((u) => u.seq));
      entries = entries.filter((r) => open.has(r.seq));
    }
    return { log: log.logId, matching: entries.length, shown: Math.min(tail, entries.length), receipts: entries.slice(-tail).map(row) };
  }

  if (name === 'verify_log') {
    const log = openLog(ctx.dir);
    const res = log.audit();
    const found = findUnfinished(log.entries);
    return {
      log: log.logId,
      ok: res.ok,
      entries: res.size,
      root: res.root,
      checkpoints: log.checkpoints().length,
      issues: res.issues.map((/** @type {any} */ i) => ({ kind: i.kind, ...(i.seq !== undefined ? { seq: i.seq } : {}), message: i.message })),
      unfinished: found.unfinished.length + found.abandoned.length,
      ...(res.ok ? {} : { note: 'The log was altered after it was written. Treat this as evidence of tampering, not a corrupted file to repair.' }),
    };
  }

  if (name === 'log_stats') {
    const log = openLog(ctx.dir);
    const outcomes = { allow: 0, deny: 0, escalate: 0 };
    /** @type {Record<string, number>} */ const tools = {};
    /** @type {Record<string, number>} */ const wouldBlock = {};
    let errors = 0;
    for (const r of log.entries) {
      outcomes[r.decision.outcome] = (outcomes[r.decision.outcome] ?? 0) + 1;
      tools[r.action.target] = (tools[r.action.target] ?? 0) + 1;
      if (r.result?.status === 'error') errors++;
      if (r.phase !== 'outcome' && r.decision.wouldBe) {
        for (const rule of r.decision.rules.length ? r.decision.rules : ['(default)']) wouldBlock[rule] = (wouldBlock[rule] ?? 0) + 1;
      }
    }
    return {
      log: log.logId,
      receipts: log.entries.length,
      allowed: outcomes.allow,
      refused: outcomes.deny,
      escalated: outcomes.escalate,
      tool_errors: errors,
      would_block: wouldBlock,
      busiest_tools: Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tool, calls]) => ({ tool, calls })),
    };
  }

  if (name === 'check_bundle') {
    if (typeof input.path !== 'string' || !input.path) throw new ToolError('path is required');
    const file = path.resolve(ctx.cwd, input.path);
    let bundle;
    try {
      bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new ToolError(`cannot read ${input.path}: ${/** @type {Error} */ (e).message}`);
    }
    /** @type {Record<string, string>|undefined} */
    let trustedLogKeys;
    if (input.log_keys !== undefined) {
      if (typeof input.log_keys !== 'object' || input.log_keys === null || Array.isArray(input.log_keys) ||
        !Object.values(input.log_keys).every((v) => typeof v === 'string')) {
        throw new ToolError('log_keys must map each kid to a public key string');
      }
      trustedLogKeys = { ...input.log_keys };
    }
    const res = verifyBundle(bundle, trustedLogKeys ? { trustedLogKeys } : {});
    return {
      file: input.path,
      ok: res.ok,
      log: typeof bundle?.log === 'string' ? bundle.log : null,
      entries: res.checked,
      partial: bundle?.partial === true,
      signer_pinned: Boolean(trustedLogKeys),
      issues: res.issues,
      ...(res.ok && !trustedLogKeys ? { note: 'Intact, but nothing outside the bundle says whose key signed it. Pin the owner\'s published key with log_keys.' } : {}),
      ...(res.ok && bundle?.partial ? { note_partial: 'A filtered export: each entry is genuine, but it cannot prove nothing was left out.' } : {}),
    };
  }

  if (name === 'export_evidence') {
    const log = openLog(ctx.dir);
    const rel = input.path ?? `vouchwell-${log.logId}-${Date.now()}.bundle.json`;
    if (typeof rel !== 'string' || !rel) throw new ToolError('path must be a file name');
    const file = path.resolve(ctx.cwd, rel);
    const inside = path.relative(ctx.cwd, file);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new ToolError('path must be inside the working directory');
    if (path.resolve(file).startsWith(path.resolve(ctx.dir) + path.sep)) throw new ToolError('the bundle cannot be written inside the log itself');

    /** @type {((r: any) => boolean)|undefined} */
    let filter;
    if (input.since !== undefined) {
      const t = new Date(input.since);
      if (typeof input.since !== 'string' || Number.isNaN(t.getTime())) throw new ToolError('since must be an ISO date or time');
      const since = t.toISOString();
      filter = (r) => r.ts >= since;
    }
    if (input.session !== undefined) {
      if (typeof input.session !== 'string') throw new ToolError('session must be a string');
      const prev = filter;
      filter = (r) => r.actor.session === input.session && (!prev || prev(r));
    }
    const bundle = log.bundle(filter ? { filter } : {});
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx' });
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'EEXIST') throw new ToolError(`${rel} already exists; choose another path`);
      throw e;
    }
    return {
      file: inside.split(path.sep).join('/'),
      log: log.logId,
      entries: bundle.entries.length,
      partial: Boolean(bundle.partial),
      root: bundle.root,
      verify_with: `vw check ${inside.split(path.sep).join('/')}`,
    };
  }

  throw new ToolError(`no tool named ${JSON.stringify(name)}`);
}

/**
 * Answer one JSON-RPC message; null for a notification. Exported for tests.
 *
 * @param {any} msg
 * @param {{ dir: string, cwd: string, version: string }} ctx
 */
export function handle(msg, ctx) {
  const reply = (/** @type {any} */ result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (/** @type {number} */ code, /** @type {string} */ message) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } });

  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'invalid request');
  const isRequest = 'id' in msg;
  if (!isRequest) return null;

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'vouchwell', title: 'Vouchwell', version: ctx.version },
        instructions: 'Read-only access to a Vouchwell log: tamper-evident receipts of what an AI agent did. ' +
          'Use log_entries to answer what was done, verify_log to prove the record is intact, and export_evidence for a bundle to share. ' +
          'A failed verification is evidence of tampering: report it, never try to repair the log.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      try {
        const data = callTool(name, msg.params?.arguments ?? {}, ctx);
        return reply({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data });
      } catch (e) {
        if (e instanceof ToolError) return reply({ content: [{ type: 'text', text: e.message }], isError: true });
        return reply({ content: [{ type: 'text', text: `vouchwell: ${/** @type {Error} */ (e).message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

/**
 * @param {any} args
 * @param {{ loadConfig: (args: any) => { dir: string, config: any }, version: string }} deps
 */
export function cmdMcp(args, deps) {
  const { dir } = deps.loadConfig(args);
  const ctx = { dir, cwd: process.cwd(), version: deps.version };
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let answer;
      try {
        answer = handle(JSON.parse(line), ctx);
      } catch {
        answer = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
      }
      if (answer) process.stdout.write(JSON.stringify(answer) + '\n');
    }
  });
  return new Promise((resolve) => process.stdin.on('end', () => resolve(0)));
}
