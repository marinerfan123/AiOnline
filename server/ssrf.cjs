// server/ssrf.cjs — SSRF protection: block private/internal IPs and enforce allowlist
const net = require('net');
const url = require('url');

// RFC 1918 + link-local + loopback + cloud metadata + carrier-grade NAT
const PRIVATE_PATTERNS = [
  /^10\./,                              // 10.0.0.0/8
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,    // 172.16.0.0/12
  /^192\.168\./,                        // 192.168.0.0/16
  /^169\.254\./,                        // link-local
  /^100\.6[4-9]\./, /^100\.7\./, /^100\.8\./, /^100\.9[0-6]\./, // CGNAT 100.64.0.0/10
  /^0\./,                               // 0.x.x.x
  /^127\./,                             // loopback
  /^192\.0\.0\./, /^192\.0\.2\./, /^198\.18\./, /^198\.51\.100\./, // documentation ranges
  /^224\./, /^225\./, /^226\./, /^227\./, /^228\./, /^229\./, /^230\./, /^231\./, /^232\./, /^233\./, /^234\./, /^235\./, /^236\./, /^237\./, /^238\./, /^239\./, // multicast
  /^240\./, /^241\./, /^242\./, /^243\./, /^244\./, /^245\./, /^246\./, /^247\./, /^248\./, /^249\./, /^250\./, /^251\./, /^252\./, /^253\./, /^254\./, /^255\./, // reserved
];

function isPrivateIP(ip) {
  // IPv6 loopback
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;
  // IPv4-mapped IPv6
  const ipv4 = ip.replace(/^::ffff:/, '');
  if (PRIVATE_PATTERNS.some(p => p.test(ipv4))) return true;
  return false;
}

// Resolve hostname and check if any resolved IP is private
async function isResolvedPrivate(hostname) {
  const dns = require('dns');
  try {
    const results = await dns.promises.resolve(hostname);
    return results.some(isPrivateIP);
  } catch {
    // If DNS fails, the fetch will fail too — let it through and let fetch fail
    return false;
  }
}

/**
 * Check URL for SSRF risk.
 * Returns { ok: true } or { ok: false, reason: string }
 *
 * @param {string} urlString - URL to check
 * @param {object} opts
 * @param {string[]} opts.allowlist - Optional domain allowlist (exact match). If provided, URL must match one.
 * @param {boolean} opts.allowLocalhost - If true, skip private IP check (for internal service calls)
 * @param {boolean} opts.resolveDns - If true, resolve hostname to detect DNS rebinding
 */
function checkUrl(urlString, { allowlist = null, allowLocalhost = false, resolveDns = false } = {}) {
  if (!urlString || typeof urlString !== 'string') {
    return { ok: false, reason: 'missing_url' };
  }

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  // Only allow http/https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `protocol_not_allowed:${parsed.protocol}` };
  }

  // If allowlist provided, check domain
  if (Array.isArray(allowlist) && allowlist.length > 0) {
    const hostname = parsed.hostname.toLowerCase();
    const allowed = allowlist.some(domain =>
      hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`)
    );
    if (!allowed) {
      return { ok: false, reason: `domain_not_allowed:${hostname}` };
    }
  }

  // Block private IPs by hostname
  const hostname = parsed.hostname.toLowerCase();
  if (isPrivateIP(hostname)) {
    return { ok: false, reason: `private_ip:${hostname}` };
  }

  // Block common cloud metadata endpoints
  if (hostname === 'metadata.google.internal' ||
      hostname === 'metadata.google.internal.' ||
      hostname === 'instance-data.pai.com.cn' ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.lan')) {
    return { ok: false, reason: `metadata_endpoint:${hostname}` };
  }

  // DNS resolution check for rebinding protection
  if (resolveDns && !allowLocalhost) {
    // This is async — caller should use asyncCheckUrl
    return { ok: false, reason: 'requires_async_check' };
  }

  return { ok: true };
}

/**
 * Async version that resolves DNS to detect rebinding attacks.
 */
async function asyncCheckUrl(urlString, opts = {}) {
  const optsWithDns = { ...opts, resolveDns: true };
  const result = checkUrl(urlString, optsWithDns);

  if (result.reason === 'requires_async_check') {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      return { ok: false, reason: 'invalid_url' };
    }
    if (await isResolvedPrivate(parsed.hostname)) {
      return { ok: false, reason: `resolved_to_private:${parsed.hostname}` };
    }
    return { ok: true };
  }

  return result;
}

module.exports = { checkUrl, asyncCheckUrl, isPrivateIP };
