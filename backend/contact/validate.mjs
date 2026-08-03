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
