import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * SSRF protection for custom base URLs (docs/MODEL_PROVIDERS.md §5): https:// anywhere public, plain http:// only to
 * localhost, and never a private-network address. checkBaseUrl runs when a URL is saved; checkResolvedHost runs
 * before every request, so a public name that later resolves to a private address is still refused.
 */
const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localdomain', '.home.arpa', '.lan', '.intranet', '.corp'];

const v4 = (ip: string) => ip.split('.').map(Number);
function privateV4(ip: string) {
  const [a, b] = v4(ip);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function privateV6(ip: string) {
  const x = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x) ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
  if (mapped) {
    if (mapped.length === 2) return privateV4(mapped[1]);
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8');
}
/** True for loopback, private, link-local, carrier-grade NAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string) {
  const kind = net.isIP(ip);
  return kind === 4 ? privateV4(ip) : kind === 6 ? privateV6(ip) : true;
}

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

export function checkBaseUrl(raw: string): UrlCheck {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: 'Not a valid URL' }; }
  if (url.username || url.password) return { ok: false, reason: 'The URL must not contain a user name or password' };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol === 'http:') {
    return LOCAL_NAMES.has(host) ? { ok: true, url: url.toString().replace(/\/$/, '') } : { ok: false, reason: 'Plain http:// is allowed for localhost only; use https://' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'Only https:// URLs (or http://localhost) are allowed' };
  if (LOCAL_NAMES.has(host)) return { ok: true, url: url.toString().replace(/\/$/, '') };
  if (net.isIP(host) && isPrivateAddress(host)) return { ok: false, reason: 'Private-network addresses are not allowed' };
  if (!net.isIP(host) && (!host.includes('.') || BLOCKED_SUFFIXES.some(s => host.endsWith(s)))) return { ok: false, reason: 'Internal host names are not allowed' };
  return { ok: true, url: url.toString().replace(/\/$/, '') };
}

export type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async host => (await dns.lookup(host, { all: true, verbatim: true })).map(a => a.address);

/** Before each request: the URL must still pass, and every address its host resolves to must be public (or localhost for a local URL). */
export async function checkResolvedHost(raw: string, lookup: Lookup = systemLookup): Promise<void> {
  const check = checkBaseUrl(raw);
  if (!check.ok) throw new Error(check.reason);
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (LOCAL_NAMES.has(host)) return;
  const addresses = net.isIP(host) ? [host] : await lookup(host);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error('The model server resolves to a private-network address');
}
