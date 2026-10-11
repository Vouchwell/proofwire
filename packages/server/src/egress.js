import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

/**
 * Outbound requests to addresses a tenant chose.
 *
 * Several features make the hub call a URL an organisation's admin typed in:
 * its identity provider, its witnesses, the places it streams events to. On a
 * hosted hub that is a server-side request forgery surface: a tenant naming
 * `http://169.254.169.254/` would be asking the hub to read its own cloud
 * credentials. So every such request goes through `guardedRequest`, which:
 *
 *   - requires https (plain http only when private addresses are allowed);
 *   - refuses private, loopback, link-local and reserved addresses at connect
 *     time, after DNS, so a name that rebinds between a check and the
 *     connection cannot slip past;
 *   - follows no redirects, times out, and caps what it reads.
 *
 * `allowPrivate` exists for tests and for a self-hosted hub whose services
 * are on its own network. A hosted hub never sets it.
 */

const MAX_BYTES = 1024 * 1024;

/**
 * Whether an IP address is somewhere a hub must not be made to reach on a
 * tenant's say-so.
 *
 * @param {string} ip
 */
export function isPrivateAddress(ip) {
  let a = String(ip).toLowerCase();
  if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7); // IPv4-mapped IPv6, dotted
  if (net.isIPv4(a)) {
    const [b0, b1] = a.split('.').map(Number);
    return (
      b0 === 0 || b0 === 10 || b0 === 127 ||
      (b0 === 100 && b1 >= 64 && b1 <= 127) || // carrier-grade NAT
      (b0 === 169 && b1 === 254) ||            // link-local, cloud metadata
      (b0 === 172 && b1 >= 16 && b1 <= 31) ||
      (b0 === 192 && b1 === 168) ||
      (b0 === 192 && b1 === 0) ||
      (b0 === 198 && (b1 === 18 || b1 === 19)) ||
      b0 >= 224                                // multicast and reserved
    );
  }
  if (net.isIPv6(a)) {
    const h = hextets(a);
    const v4 = (/** @type {number} */ i) => `${h[i] >> 8}.${h[i] & 255}.${h[i + 1] >> 8}.${h[i + 1] & 255}`;
    const zeros = (/** @type {number} */ n) => h.slice(0, n).every((x) => x === 0);
    // Addresses that carry an IPv4 address inside them reach it: judge that.
    if (zeros(5) && h[5] === 0xffff) return isPrivateAddress(v4(6));                // ::ffff:a.b.c.d, any spelling
    if (zeros(6)) return h[6] === 0 && h[7] <= 1 ? true : isPrivateAddress(v4(6));  // ::, ::1, ::a.b.c.d
    if (h[0] === 0x64 && h[1] === 0xff9b) return isPrivateAddress(v4(6));            // NAT64 64:ff9b::/96
    if (h[0] === 0x2002) return isPrivateAddress(v4(1));                             // 6to4
    if (h[0] === 0x2001 && h[1] === 0) return true;                                  // Teredo
    return (
      (h[0] & 0xffc0) === 0xfe80 || // link-local fe80::/10
      (h[0] & 0xffc0) === 0xfec0 || // site-local fec0::/10 (deprecated)
      (h[0] & 0xfe00) === 0xfc00 || // unique local fc00::/7
      (h[0] & 0xff00) === 0xff00    // multicast
    );
  }
  return true;
}

/**
 * The eight 16-bit groups of an IPv6 address, `::` expanded and a trailing
 * dotted IPv4 part converted.
 *
 * @param {string} a  Valid IPv6, lower case.
 * @returns {number[]}
 */
function hextets(a) {
  let s = a.replace(/%.*$/, '');
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const [p, q, r, t] = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + `${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((x) => parseInt(x || '0', 16));
}

/**
 * Why a URL may not be used as a destination, or null when it may. Checked
 * when an admin saves one, so a bad URL is refused at once rather than
 * failing quietly on every later send.
 *
 * @param {string} raw
 * @param {{ allowPrivate?: boolean }} [opts]
 * @returns {string | null}
 */
export function destinationProblem(raw, opts = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return 'is not a URL';
  }
  if (u.username || u.password) return 'must not carry credentials in the URL';
  if (u.protocol !== 'https:' && !(opts.allowPrivate && u.protocol === 'http:')) return 'must be https';
  // A trailing dot names the same host ("localhost." is localhost).
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(host) && !opts.allowPrivate && isPrivateAddress(host)) return 'is a private address';
  if (!opts.allowPrivate && /^(localhost|.*\.localhost|.*\.internal|.*\.local)$/i.test(host)) return 'is a private address';
  return null;
}

/**
 * Make one request under the rules above.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {Record<string, string>} [opts.headers]
 * @param {string | Buffer} [opts.body]
 * @param {boolean} [opts.allowPrivate]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ status: number, text: string, json: any }>}  `json` is null when the body is not JSON.
 */
export function guardedRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const problem = destinationProblem(url, opts);
    if (problem) return reject(new Error(`${url} ${problem}`));
    const u = new URL(url);
    const body = opts.body === undefined ? undefined : Buffer.from(opts.body);
    const client = u.protocol === 'https:' ? https : http;
    const req = client.request(
      u,
      {
        method: opts.method ?? (body ? 'POST' : 'GET'),
        headers: {
          ...(body ? { 'content-length': String(body.length) } : {}),
          ...(opts.headers ?? {}),
        },
        timeout: opts.timeoutMs ?? 10_000,
        // Node asks for every address (`all: true`) when it races IPv4 and
        // IPv6, and for one otherwise; answering the first with the second's
        // shape failed every request to a hostname. Every address is checked
        // either way, and one private address refuses the name: a name that
        // resolves both ways is a rebinding trick, not a misconfiguration.
        lookup: (hostname, options, cb) => {
          dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
            if (err) return cb(err);
            if (!opts.allowPrivate) {
              const bad = addresses.find((x) => isPrivateAddress(x.address));
              if (bad) return cb(new Error(`${hostname} resolves to a private address`));
            }
            if (!addresses.length) return cb(new Error(`${hostname} has no address`));
            if (options.all) return cb(null, addresses);
            cb(null, addresses[0].address, addresses[0].family);
          });
        },
      },
      (res) => {
        let size = 0;
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error('response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            // Not JSON; the caller decides whether that matters.
          }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${u.origin} did not answer in time`)));
    // The socket timeout restarts with every byte, so a server dripping its
    // answer could hold a worker for hours. This one does not restart.
    const deadline = setTimeout(() => req.destroy(new Error(`${u.origin} took too long`)), (opts.timeoutMs ?? 10_000) * 3);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
