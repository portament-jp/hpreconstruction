/**
 * Cloudflare Turnstile server-side verification.
 *
 * Kept out of validate.mjs on purpose: that module is pure, synchronous and
 * AWS/network-free so it can be unit-tested with plain node. This one does I/O.
 *
 * Node 22 provides a global fetch, so there is no dependency to vendor — but
 * `fetchImpl` is injectable so tests never touch the network.
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare documents tokens as up to 2048 characters. */
export const MAX_TOKEN_LENGTH = 2048;

/**
 * Cheap shape check, done before spending a network round-trip.
 * @returns {boolean}
 */
export function isTokenShapeValid(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_LENGTH;
}

/**
 * @param {string} token the cf-turnstile-response value from the browser
 * @param {object} opts
 * @param {string} opts.secret Turnstile secret key
 * @param {string} [opts.remoteIp] pass ONLY a trustworthy address — see index.mjs
 * @param {number} [opts.timeoutMs] the Lambda budget is 10s and SES still has to run
 * @param {Function} [opts.fetchImpl] injected in tests
 * @returns {Promise<{ok: true} | {ok: false, reason: 'rejected'|'unreachable', errorCodes?: string[], detail?: string}>}
 */
export async function verifyTurnstile(token, { secret, remoteIp = '', timeoutMs = 4000, fetchImpl = fetch } = {}) {
  const form = new URLSearchParams({ secret: String(secret || ''), response: String(token || '') });
  if (remoteIp) form.set('remoteip', remoteIp);

  let res;
  try {
    res = await fetchImpl(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Network failure or timeout. The caller fails closed: a genuine visitor is
    // shown the "email sales@ directly" message rather than silently dropped.
    return { ok: false, reason: 'unreachable', detail: err?.name || 'fetch_error' };
  }

  if (!res.ok) return { ok: false, reason: 'unreachable', detail: `HTTP ${res.status}` };

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: 'unreachable', detail: 'bad_json' };
  }

  if (data && data.success === true) return { ok: true };

  return {
    ok: false,
    reason: 'rejected',
    errorCodes: Array.isArray(data?.['error-codes']) ? data['error-codes'] : [],
  };
}
