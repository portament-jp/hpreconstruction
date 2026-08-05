/**
 * Pure validation + normalisation for contact-form submissions.
 * Kept free of AWS imports so it can be unit-tested with plain node.
 */

export const LIMITS = {
  name: 100,
  email: 254,
  company: 200,
  message: 5000,
};

// Deliberately permissive: RFC-complete validation rejects real addresses.
// The real check is the reply landing, not the regex.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Header-injection guard: CR/LF and other control chars must never reach a header. */
const hasControlChars = (s) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
};

const asString = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * @param {unknown} body parsed JSON body
 * @returns {{ok: true, data: object} | {ok: false, code: string, field?: string}}
 */
export function validate(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'bad_body' };
  }

  // Honeypot: a real browser leaves this empty because it is visually hidden
  // and marked aria-hidden/tabindex=-1. Bots fill every input they find.
  const honeypot = asString(body.website).trim();
  if (honeypot !== '') return { ok: false, code: 'spam' };

  const name = asString(body.name).trim();
  const email = asString(body.email).trim();
  const company = asString(body.company).trim();
  const message = asString(body.message).trim();

  if (!name) return { ok: false, code: 'required', field: 'name' };
  if (!email) return { ok: false, code: 'required', field: 'email' };
  if (!message) return { ok: false, code: 'required', field: 'message' };

  if (name.length > LIMITS.name) return { ok: false, code: 'too_long', field: 'name' };
  if (email.length > LIMITS.email) return { ok: false, code: 'too_long', field: 'email' };
  if (company.length > LIMITS.company) return { ok: false, code: 'too_long', field: 'company' };
  if (message.length > LIMITS.message) return { ok: false, code: 'too_long', field: 'message' };

  if (!EMAIL_RE.test(email)) return { ok: false, code: 'invalid', field: 'email' };

  // name/email/company are interpolated into Subject and Reply-To headers.
  for (const [field, value] of [['name', name], ['email', email], ['company', company]]) {
    if (hasControlChars(value)) return { ok: false, code: 'invalid', field };
  }

  return { ok: true, data: { name, email, company, message } };
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Build the notification email sent to the sales inbox.
 * @param {{name:string,email:string,company:string,message:string}} d
 * @param {{page?:string, ip?:string, userAgent?:string, receivedAt:string}} meta
 */
export function buildEmail(d, meta) {
  const company = d.company || '(未記入)';
  const subject = `【お問い合わせ】${d.name}${d.company ? ` / ${d.company}` : ''}`;

  const rows = [
    ['お名前', d.name],
    ['メールアドレス', d.email],
    ['会社名', company],
    ['送信元ページ', meta.page || '(不明)'],
    ['受信日時', meta.receivedAt],
    ['IP', meta.ip || '(不明)'],
  ];

  const text = [
    'Webサイトのお問い合わせフォームから送信がありました。',
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    '── お問い合わせ内容 ──',
    d.message,
    '',
    `※このメールに返信すると ${d.email} 宛に届きます。`,
  ].join('\n');

  const html = [
    '<div style="font-family:sans-serif;font-size:14px;line-height:1.8">',
    '<p>Webサイトのお問い合わせフォームから送信がありました。</p>',
    '<table style="border-collapse:collapse">',
    ...rows.map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#666;white-space:nowrap">${escapeHtml(k)}</td>` +
        `<td style="padding:4px 0">${escapeHtml(v)}</td></tr>`
    ),
    '</table>',
    '<p style="margin-top:16px;color:#666">── お問い合わせ内容 ──</p>',
    `<p style="white-space:pre-wrap">${escapeHtml(d.message)}</p>`,
    `<p style="margin-top:16px;color:#666">※このメールに返信すると ${escapeHtml(d.email)} 宛に届きます。</p>`,
    '</div>',
  ].join('');

  return { subject, text, html };
}

/**
 * The shared form script always sends `page: location.pathname` (verified
 * across every page that embeds the form), so a real browser submission can
 * never be missing it, non-string, or outside the site (e.g. an absolute
 * URL). Requests hitting the API directly - as bots that skip the page's JS
 * do - typically omit this field or send garbage. Treating it as spam here
 * carries no false-positive risk against legitimate traffic.
 */
export function isMissingPage(page) {
  return typeof page !== 'string' || !page.startsWith('/');
}

/**
 * Origin allow-list check for the CORS-facing guard in index.mjs.
 *
 * Only a *present* Origin that fails to match the allow-list is rejected.
 * A *missing* Origin is deliberately NOT rejected: some privacy extensions,
 * older browsers, and certain embedded/webview contexts strip the Origin
 * header even on legitimate same-origin requests. Blocking on absence would
 * risk silently dropping a real sales lead, which is far worse than letting
 * a spam submission fall through to the other guards (missing `page`,
 * honeypot, etc.).
 */
export function isOriginRejected(origin, allowedOrigins) {
  if (!origin) return false;
  return !allowedOrigins.includes(origin);
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_LOOSE_RE = /^[0-9a-fA-F:]{2,45}$/;

const isIp = (s) => {
  const m = s.match(IPV4_RE);
  if (m && m.slice(1).every((o) => Number(o) <= 255)) return true;
  return s.includes(':') && IPV6_LOOSE_RE.test(s);
};

/**
 * Strip the trailing :port from a CloudFront-Viewer-Address value.
 * IPv4 "192.0.2.1:53412" and IPv6 "2400:d320::1:53412" both put the port after
 * the LAST colon, so split there rather than on the first.
 */
function stripPort(value) {
  const i = value.lastIndexOf(':');
  if (i === -1) return value;
  const head = value.slice(0, i);
  const port = value.slice(i + 1);
  return /^\d{1,5}$/.test(port) && isIp(head) ? head : value;
}

/**
 * Work out what to show as the visitor's address.
 *
 * requestContext.http.sourceIp is the CloudFront edge, never the visitor.
 * X-Forwarded-For cannot be indexed safely either: CloudFront *appends* the
 * real viewer to whatever chain the client sent, so [0] is attacker-controlled,
 * and counting from the end is not reliable because the function URL layer may
 * append as well. So:
 *
 *   1. CloudFront-Viewer-Address — set by CloudFront, not viewer-influenceable.
 *      Requires an origin request policy that forwards it.
 *   2. Otherwise show the WHOLE X-Forwarded-For chain, clearly labelled, and
 *      let the human reading the mail judge it. Never present one entry as fact.
 *   3. Otherwise the edge IP.
 *
 * Informational only — never an input to an auth or trust decision.
 */
export function resolveClientIp({ viewerAddress, xff, sourceIp } = {}) {
  const va = String(viewerAddress || '').trim();
  if (va) {
    const ip = stripPort(va);
    if (isIp(ip)) return { ip, trusted: true };
  }

  const chain = String(xff || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && isIp(s));
  if (chain.length === 1) return { ip: chain[0], trusted: false };
  if (chain.length > 1) {
    return { ip: `${chain.join(', ')} (X-Forwarded-For 全体 / 先頭は詐称可能)`, trusted: false };
  }

  return { ip: String(sourceIp || ''), trusted: false };
}
