import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { Hub } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { guardedRequest, isPrivateAddress } from '../src/egress.js';

/**
 * Regression tests for the pre-launch security audit: each one is a finding
 * that was fixed, so it stays fixed.
 */

/** @type {Hub} */
let hub;
let base = '';
let port = 0;
const acme = { org: '', adminKey: '', owner: '', admin: '', ownerId: '', adminId: '' };

before(async () => {
  hub = new Hub({
    database: ':memory:',
    checkpointEvery: 0,
    apiRate: { capacity: 100000, refillPerSec: 100000 },
    authRate: { capacity: 100000, refillPerSec: 100000 },
  });
  base = (await hub.listen(0)).url.replace('0.0.0.0', '127.0.0.1');
  port = Number(new URL(base).port);
  const auth = new Auth(hub.store);
  const org = hub.store.createOrg({ slug: 'acme', name: 'Acme' });
  acme.org = org.id;
  acme.adminKey = auth.createKey({ orgId: org.id, name: 'admin', scopes: ['admin'] }).token;
  const owner = auth.createUser({ email: 'owner@acme.test', password: 'owner-password-long' });
  auth.addMember(org.id, owner.id, 'owner');
  acme.ownerId = owner.id;
  acme.owner = `pw_session=${auth.createSession(owner.id).token}`;
  const admin = auth.createUser({ email: 'admin@acme.test', password: 'admin-password-long' });
  auth.addMember(org.id, admin.id, 'admin');
  acme.adminId = admin.id;
  acme.admin = `pw_session=${auth.createSession(admin.id).token}`;
});

after(() => hub.close());

/**
 * @param {string} method @param {string} p
 * @param {{ token?: string, cookie?: string, body?: any }} [o]
 */
async function api(method, p, o = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      // A console request: cookie-authenticated, same-origin.
      ...(o.cookie ? { cookie: o.cookie, 'sec-fetch-site': 'same-origin' } : {}),
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}

/** One raw HTTP request, so headers fetch would refuse can be sent. @param {string} raw */
function raw(raw) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.end(raw));
    let data = '';
    s.on('data', (d) => (data += d));
    s.on('close', () => resolve(data.split('\r\n')[0]));
    s.on('error', (e) => resolve(`error ${e.code}`));
  });
}

test('a malformed Host header or request path gets an answer, and the hub stays up', async () => {
  // A Host of "a b" used to make the hub's URL parsing throw outside any
  // handler, which ended the process: one unauthenticated request, no hub.
  for (const host of ['a b', '[', 'x:99999', '%zz']) {
    assert.match(await raw(`GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 200/, host);
  }
  assert.match(await raw('GET /v1/logs/%zz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400/);
  assert.match(await raw('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 \d{3}/);
  assert.equal((await api('GET', '/health')).status, 200, 'still serving');
});

test('only an owner makes an owner, or changes one', async () => {
  for (const who of [{ token: acme.adminKey }, { cookie: acme.admin }]) {
    const invite = await api('POST', '/v1/invites', { ...who, body: { email: 'new-owner@acme.test', role: 'owner' } });
    assert.equal(invite.status, 403);
    assert.equal(invite.json.error.code, 'owner_only');
    const self = await api('POST', '/v1/members', { ...who, body: { email: 'admin@acme.test', role: 'owner' } });
    assert.equal(self.status, 403, 'an admin cannot promote themselves');
    const demote = await api('POST', '/v1/members', { ...who, body: { email: 'owner@acme.test', role: 'auditor' } });
    assert.equal(demote.status, 403, 'nor demote the owner');
    const reinvite = await api('POST', '/v1/invites', { ...who, body: { email: 'owner@acme.test', role: 'auditor' } });
    assert.equal(reinvite.status, 403, 'nor demote the owner by inviting them again');
  }
  assert.equal(new Auth(hub.store).membership(acme.org, acme.ownerId).role, 'owner');
  assert.equal(new Auth(hub.store).membership(acme.org, acme.adminId).role, 'admin');

  // Admins still manage everyone else.
  assert.equal((await api('POST', '/v1/invites', { cookie: acme.admin, body: { email: 'op@acme.test', role: 'operator' } })).status, 200);
  // And an owner may make an owner.
  assert.equal((await api('POST', '/v1/invites', { cookie: acme.owner, body: { email: 'co-owner@acme.test', role: 'owner' } })).status, 200);
});

test("nobody sets a password for someone else, so nobody can pre-claim another company's address", async () => {
  // Accounts are shared across a hub's organisations: an admin who chose a
  // password for boss@other.test would be signed in as that person the
  // moment the other company invited them.
  const res = await api('POST', '/v1/members', { cookie: acme.owner, body: { email: 'boss@other.test', role: 'auditor', password: 'attacker-knows-this' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'use_invite');
  assert.equal(new Auth(hub.store).userByEmail('boss@other.test'), null, 'no account was created');

  const added = await api('POST', '/v1/members', { cookie: acme.owner, body: { email: 'auditor@acme.test', role: 'auditor' } });
  assert.equal(added.status, 200);
  assert.equal(new Auth(hub.store).userByEmail('auditor@acme.test').password_hash, null);
});

test('outbound requests to a hostname work, and a name for a private address is refused', async () => {
  // Node asks the lookup hook for every address when it races IPv4 and IPv6;
  // the hook answered with one, and every request to a hostname failed.
  const srv = http.createServer((_q, res) => res.end('{"ok":true}'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
  const at = /** @type {import('node:net').AddressInfo} */ (srv.address()).port;
  try {
    const ok = await guardedRequest(`http://localhost:${at}/`, { allowPrivate: true });
    assert.equal(ok.status, 200);
    await assert.rejects(guardedRequest(`https://localhost:${at}/`), /private address/);
    await assert.rejects(guardedRequest(`https://localhost.:${at}/`), /private address/);
  } finally {
    srv.close();
  }
});

test('an IPv6 address that carries a private IPv4 address counts as private', () => {
  for (const ip of ['::ffff:7f00:1', '::ffff:127.0.0.1', '::127.0.0.1', '64:ff9b::a9fe:a9fe', '2002:a00:1::', '2001:0:4136:e378::1', 'fec0::1', 'fe80::1', 'fd00::1', '::', '::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::', '2606:4700::1111', '1.1.1.1']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('a key expiry that is not a date is refused, and a real one is enforced', () => {
  const auth = new Auth(hub.store);
  for (const bad of ['tomorrow', 'zzz', '2026-13-45']) {
    assert.throws(() => auth.createKey({ orgId: acme.org, name: 'x', scopes: ['logs:read'], expiresAt: bad }), /bad_expiry|must be a date/, bad);
  }
  const past = auth.createKey({ orgId: acme.org, name: 'old', scopes: ['logs:read'], expiresAt: '2000-01-01' });
  assert.equal(auth.keyForToken(past.token), null);
  const later = auth.createKey({ orgId: acme.org, name: 'new', scopes: ['logs:read'], expiresAt: '2999-01-01' });
  assert.ok(auth.keyForToken(later.token));
});

test('a key carries no scope its maker lacks, and only owners can pick the sign-in provider', async () => {
  for (const scopes of [['witness:sign'], ['receipts:write'], ['sso:write']]) {
    const viaSession = await api('POST', '/v1/keys', { cookie: acme.admin, body: { name: 'x', scopes } });
    assert.equal(viaSession.status, 403, `admin session minting ${scopes}`);
    const viaKey = await api('POST', '/v1/keys', { token: acme.adminKey, body: { name: 'x', scopes } });
    assert.equal(viaKey.status, 403, `admin key minting ${scopes}`);
  }
  const fine = await api('POST', '/v1/keys', { cookie: acme.admin, body: { name: 'reader', scopes: ['logs:read'] } });
  assert.equal(fine.status, 200);

  const sso = { issuer: 'https://idp.invalid', clientId: 'c' };
  assert.equal((await api('PUT', '/v1/integrations/oidc', { cookie: acme.admin, body: sso })).status, 403);
  assert.equal((await api('PUT', '/v1/integrations/oidc', { token: acme.adminKey, body: sso })).status, 403);

  // An owner can hand that power to a key, for automation.
  const minted = await api('POST', '/v1/keys', { cookie: acme.owner, body: { name: 'sso-admin', scopes: ['admin', 'sso:write'] } });
  assert.equal(minted.status, 200);
  const put = await api('PUT', '/v1/integrations/oidc', { token: minted.json.token, body: sso });
  assert.equal(put.json.error.code, 'bad_issuer', 'past the permission check, to the issuer check');
});
