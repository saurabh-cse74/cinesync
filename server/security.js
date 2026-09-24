const dns = require('dns').promises;
const net = require('net');

const ALLOWED_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
// Magic-byte signatures; never trust the client-supplied extension or MIME.
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('latin1');
    if (/qt/.test(brand)) return 'video/quicktime';
    return 'video/mp4';
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  return null;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
           (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
           (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

// SSRF guard: HTTPS only, public addresses only, no metadata endpoints.
async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Not a valid URL.'); }
  if (u.protocol !== 'https:') throw new Error('Only HTTPS video URLs are allowed.');
  if (/^(localhost|metadata\.google\.internal)$/i.test(u.hostname)) throw new Error('Blocked host.');
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error('Host could not be resolved.');
  if (addrs.some(a => isPrivateIp(a.address))) throw new Error('Blocked: private network address.');
  return u;
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { ALLOWED_MIME, sniff, assertSafeUrl, isPrivateIp, escapeHtml };
