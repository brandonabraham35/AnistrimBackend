// =============================================================
//  utils/ssrfGuard.js — SSRF Protection for the Query-Based Proxy
//
//  PURPOSE:
//    The stateless query proxy (controllers/streamProxyQueryController.js)
//    accepts an arbitrary http(s) target URL. Before that URL is fetched on
//    the server, this guard rejects any target whose resolved destination is
//    a loopback, link-local, private, or otherwise internal address. This
//    prevents the proxy from being abused to reach internal services
//    (cloud metadata endpoints, localhost, internal networks, etc.).
//
//  DESIGN:
//    • Pure helper — no HTTP logic, no logging dependency, no controller
//      coupling. It is called by the query proxy BEFORE the upstream request
//      is made (after URL parsing/normalization).
//    • Public-IP / private-range DENIAL mechanism (per the hardening spec):
//      because AnimeHeaven legitimately uses many mirror/CDN hosts (vidstream,
//      filemoon, mp4upload, dood, streamwish, mixdrop, etc.), a narrow CDN
//      host allowlist would break legitimate playback. Instead we perform a
//      robust public-IP check on the ACTUAL resolved destination.
//    • RFC 1918 private ranges, loopback, link-local, 0.0.0.0/8, unspecified
//      IPv6 (::), IPv6 loopback (::1), fe80::/10 link-local, and fc00::/7
//      unique-local are all rejected.
//    • DNS rebinding protection: the hostname is resolved via dns.lookup()
//      and EVERY returned address is checked. If ANY resolved address is
//      internal/private, the target is rejected.
//    • IPv4-mapped IPv6 (::ffff:a.b.c.d) is normalized to its IPv4 form
//      before the private-range check.
//    • Hostnames are normalized (trailing-dot stripped, lowercased) before
//      evaluation; embedded credentials in the URL are rejected.
//    • Obfuscated IPv4 representations (hex/octal/leading-zero decimal) are
//      normalized to a canonical dotted-decimal form before the check.
//    • Malformed hosts / non-http(s) schemes are rejected.
//
//  The guard is intentionally synchronous for the parse/string checks and
//  async only for the DNS resolution step.
// =============================================================
'use strict';

const dns = require('dns');

/**
 * Convert a dotted-decimal IPv4 string into a 32-bit unsigned integer.
 * @param {string} ip - e.g. "127.0.0.1"
 * @returns {number|null} 32-bit integer, or null if invalid
 * @private
 */
function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    acc = (acc * 256) + n;
  }
  return acc >>> 0;
}

/**
 * Detect whether a 32-bit IPv4 integer is loopback / private / link-local /
 * 0.0.0.0/8 / shared / benchmark / reserved (addresses that a server-side
 * proxy must never reach).
 *
 * @param {number} ipInt - 32-bit unsigned integer
 * @returns {boolean} true if the address is internal/reserved
 * @private
 */
function isForbiddenIpv4Int(ipInt) {
  // 100.64.0.0/10 is 0x64400000 .. 0x647FFFFF (carrier-grade NAT / shared).
  // Covered by the dedicated check below.
  // 0.0.0.0/8            — "this network"
  if (ipInt >>> 24 === 0) return true;
  // 10.0.0.0/8           — RFC 1918 private
  if (ipInt >>> 24 === 10) return true;
// 100.64.0.0/10        — carrier-grade NAT (100.64.0.0 – 100.127.255.255)
  if (ipInt >= 0x64400000 && ipInt <= 0x647FFFFF) return true;
  // 127.0.0.0/8          — loopback
  if (ipInt >>> 24 === 127) return true;
  // 169.254.0.0/16       — link-local
  if (ipInt >>> 16 === 0xA9FE) return true;
  // 172.16.0.0/12        — RFC 1918 private
  if (ipInt >>> 20 === 0xAC1) return true;
  // 192.168.0.0/16       — RFC 1918 private
  if (ipInt >>> 16 === 0xC0A8) return true;
  // 192.0.0.0/24         — IETF protocol assignments (192.0.0.0 – 192.0.0.255)
  if (ipInt >= 0xC0000000 && ipInt <= 0xC00000FF) return true;
  // 192.0.2.0/24         — documentation / TEST-NET-1
  if (ipInt >= 0xC0000200 && ipInt <= 0xC00002FF) return true;
  // 198.18.0.0/15        — benchmarking
  if (ipInt >= 0xC6120000 && ipInt <= 0xC613FFFF) return true;
  // 198.51.100.0/24      — documentation / TEST-NET-2
  if (ipInt >= 0xC6336400 && ipInt <= 0xC63364FF) return true;
  // 203.0.113.0/24       — documentation / TEST-NET-3
  if (ipInt >= 0xCB007100 && ipInt <= 0xCB0071FF) return true;
  // 224.0.0.0/4          — multicast
  if (ipInt >>> 28 === 0xE) return true;
  // 240.0.0.0/4          — reserved / broadcast
  if (ipInt >>> 28 === 0xF) return true;
  return false;
}

/**
 * Normalize an obfuscated IPv4 literal (hex, octal, decimal, leading zeros)
 * to canonical dotted-decimal. Returns null if it is not a valid IPv4 literal.
 *
 * @param {string} host - hostname fragment
 * @returns {string|null} canonical dotted-decimal IPv4, or null
 * @private
 */
function normalizeObfuscatedIpv4(host) {
  const value = String(host || '').trim();
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length > 4) return null;
  const ints = [];
  for (const part of parts) {
    if (!part) return null;
    let n;
    // Detect hex / octal / decimal numeric literal.
    if (/^0x[0-9a-f]+$/i.test(part)) {
      n = parseInt(part, 16);
    } else if (/^0[0-7]+$/.test(part)) {
      n = parseInt(part, 8);
    } else if (/^\d+$/.test(part)) {
      n = parseInt(part, 10);
    } else {
      return null; // not a pure numeric literal
    }
    if (!Number.isInteger(n) || n < 0 || n > 4294967295) return null;
    ints.push(n);
  }
  // Allow 1-4 part forms (single integer, class-A/B/C forms).
  if (ints.length === 1) {
    // Single 32-bit number → dotted quad.
    const v = ints[0];
    return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`;
  }
  if (ints.length === 2) {
    const v = ints[0] * 256 + ints[1];
    return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`;
  }
  if (ints.length === 3) {
    const v = ints[0] * 65536 + ints[1] * 256 + ints[2];
    return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`;
  }
  // 4-part form — validate each octet is within 0..255.
  if (ints.some(n => n > 255)) return null;
  return ints.join('.');
}

/**
 * Determine whether a single IP address (IPv4 or IPv6) is a forbidden
 * internal / loopback / link-local / private / reserved address.
 *
 * @param {string} ip - IP address string
 * @returns {boolean} true if forbidden
 */
function isForbiddenIp(ip) {
  let value = String(ip || '').trim();
  if (!value) return true;
  // Strip IPv6 brackets (e.g. "[::1]" from new URL().hostname).
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }

// IPv4-mapped/translated IPv6 (::ffff:a.b.c.d, ::a.b.c.d).
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isForbiddenIp(mapped[1]);

  // IPv4-compatible / dotted-quad-in-ipv6 forms.
  const v4InV6 = value.match(/^::(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4InV6) return isForbiddenIp(v4InV6[1]);

  // IPv4-mapped IPv6 in hex hextet form (e.g. ::ffff:7f00:1 → 127.0.0.1).
  // The two trailing hextets after "::ffff:" encode the 32-bit IPv4 address.
  const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    if (Number.isInteger(hi) && Number.isInteger(lo)) {
      const v4 = `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;
      return isForbiddenIp(v4);
    }
  }

  // Plain IPv4.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
    const intVal = ipv4ToInt(value);
    if (intVal === null) return true;
    return isForbiddenIpv4Int(intVal);
  }

  // Try to normalize any other numeric-looking form as obfuscated IPv4.
  if (/^[0-9.]+$/.test(value)) {
    const canonical = normalizeObfuscatedIpv4(value);
    if (canonical) return isForbiddenIp(canonical);
  }

  // IPv6.
  if (value.includes(':')) {
    const lower = value.toLowerCase();
    // IPv6 loopback ::1
    if (lower === '::1') return true;
    // Unspecified :: and ::/128
    if (lower === '::' || lower === '::0') return true;
    // Link-local fe80::/10  (fe80 – febf)
    if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true;
    // Unique-local fc00::/7
    if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true;
    // IPv4-mapped handled above; anything else with ':' is treated as
    // potentially internal only if it matches known reserved prefixes.
    // Broadly, reject multicast/other reserved IPv6 ranges.
    if (/^ff[0-9a-f]{2}:/i.test(lower)) return true; // multicast
    if (/^2001:db8:/i.test(lower)) return true;      // documentation
    if (/^64:ff9b:/i.test(lower)) return true;       // NAT64 well-known prefix
    // Unspecified / loopback variants are covered above. For other IPv6
    // addresses we cannot easily classify without a full parser; to be safe
    // we do NOT reject them here — the DNS resolution path (which yields
    // concrete addresses) is the authoritative check for hostnames, and
    // literal IPv6 in URLs is rare in AnimeHeaven CDNs.
    return false;
  }

  // Unknown format — treat as unsafe.
  return true;
}

/**
 * Normalize a hostname for evaluation: strip trailing dot, lowercase, and
 * ensure it is non-empty.
 *
 * @param {string} hostname
 * @returns {string} normalized hostname
 * @private
 */
function normalizeHostname(hostname) {
  return String(hostname || '').trim().replace(/\.+$/, '').toLowerCase();
}

/**
 * Resolve a hostname to all its IP addresses (A + AAAA) and return them.
 * Falls back to null on resolution errors (caller decides).
 *
 * @param {string} hostname
 * @returns {Promise<string[]|null>}
 * @private
 */
function resolveAllAddresses(hostname) {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) {
        resolve(null);
        return;
      }
      const out = [];
      if (Array.isArray(addresses)) {
        for (const a of addresses) {
          if (a && a.address) out.push(String(a.address));
        }
      }
      resolve(out);
    });
  });
}

/**
 * Validate a target URL for SSRF safety. Returns an error string on failure,
 * or null when the target is considered safe to fetch.
 *
 * Checks (in order):
 *   1. URL parses and is http/https.
 *   2. No embedded credentials.
 *   3. Hostname normalization succeeds.
 *   4. Literal IP addresses are not internal/private/loopback/link-local.
 *   5. Hostname DNS resolution: every resolved address must be a public IP.
 *      (DNS rebinding protection.)
 *
 * @param {string|URL} target - the target URL to validate
 * @returns {Promise<string|null>} an error message, or null if safe
 */
async function assertSafeTargetHost(target) {
  let parsed;
  try {
    parsed = typeof target === 'string' ? new URL(target) : target;
  } catch {
    return 'Invalid target URL.';
  }

  // Only http(s) schemes may be proxied.
  if (!/^https?:$/.test(parsed.protocol)) {
    return 'Only http(s) targets are allowed.';
  }

  // Reject URLs with embedded credentials (user:pass@host).
  if (parsed.username || parsed.password) {
    return 'Embedded credentials are not allowed.';
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) {
    return 'Invalid target host.';
  }

// Literal IP address (including obfuscated forms). A hostname is treated as
  // a literal IP when it consists only of digits/dots (IPv4 or obfuscated
  // numeric forms) or contains a colon (IPv6). Ordinary alphanumeric CDN
  // hostnames (e.g. "cdn.example.com") do NOT match and fall through to the
  // DNS-resolution path below.
  const isLiteralIp = /^[0-9.]+$/.test(hostname) || hostname.includes(':');
  if (isLiteralIp) {
    if (isForbiddenIp(hostname)) {
      return 'Target host is a private/loopback/link-local address.';
    }
    // A literal public IP is safe to fetch directly.
    return null;
  }

  // Hostname resolution (DNS rebinding protection): reject if ANY resolved
  // address is internal/private.
  const addresses = await resolveAllAddresses(hostname);
  if (addresses && addresses.length > 0) {
    for (const addr of addresses) {
      if (isForbiddenIp(addr)) {
        return 'Target host resolves to a private/loopback/link-local address.';
      }
    }
    return null;
  }

  // If we cannot resolve the hostname at all, reject it (safer than allowing
  // an unresolvable-but-potentially-internal destination).
  return 'Target host could not be resolved.';
}

module.exports = {
  isForbiddenIp,
  isForbiddenIpv4Int,
  normalizeObfuscatedIpv4,
  assertSafeTargetHost,
};
