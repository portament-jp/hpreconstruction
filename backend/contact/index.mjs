import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { validate, buildEmail, resolveClientIp, isMissingPage, isOriginRejected } from './validate.mjs';

const ses = new SESv2Client({});

const RECIPIENT = process.env.RECIPIENT_EMAIL;
const SENDER = process.env.SENDER_EMAIL;
const ORIGIN_SECRET = process.env.ORIGIN_SECRET || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const json = (statusCode, payload, origin) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
  },
  body: JSON.stringify(payload),
});

/** Constant-time-ish compare so the secret can't be probed by timing. */
function secretMatches(supplied) {
  if (!ORIGIN_SECRET) return true; // not configured -> check disabled
  const a = String(supplied || '');
  if (a.length !== ORIGIN_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ ORIGIN_SECRET.charCodeAt(i);
  return diff === 0;
}

export async function handler(event) {
  const http = event?.requestContext?.http || {};
  const method = (http.method || '').toUpperCase();
  const headers = event?.headers || {};
  const client = resolveClientIp({
    viewerAddress: headers['cloudfront-viewer-address'],
    xff: headers['x-forwarded-for'],
    sourceIp: http.sourceIp,
  });
  const clientIp = client.ip;
  const origin = headers.origin || headers.Origin || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';

  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...(corsOrigin ? { 'access-control-allow-origin': corsOrigin, vary: 'Origin' } : {}),
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      },
    };
  }

  if (method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' }, corsOrigin);

  // Requests that did not come through our CloudFront distribution are rejected,
  // so the raw *.lambda-url.on.aws hostname is not a usable open relay.
  if (!secretMatches(headers['x-portament-origin'])) {
    console.warn(JSON.stringify({ event: 'origin_rejected', ip: clientIp }));
    return json(403, { ok: false, error: 'forbidden' }, corsOrigin);
  }

  // Origin allow-list guard: only reject when Origin is present and unrecognised.
  // A missing Origin is intentionally let through here (see isOriginRejected doc)
  // and is instead caught downstream by the page-field guard, if it is spam.
  if (isOriginRejected(origin, ALLOWED_ORIGINS)) {
    console.warn(JSON.stringify({ event: 'bad_origin', ip: clientIp }));
    return json(403, { ok: false, error: 'forbidden' }, corsOrigin);
  }

  if (!RECIPIENT || !SENDER) {
    console.error(JSON.stringify({ event: 'misconfigured', RECIPIENT: !!RECIPIENT, SENDER: !!SENDER }));
    return json(500, { ok: false, error: 'server_error' }, corsOrigin);
  }

  let body;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
    body = JSON.parse(raw || '{}');
  } catch {
    return json(400, { ok: false, error: 'bad_body' }, corsOrigin);
  }

  // Every legitimate submission carries page: location.pathname (set by the
  // shared form script on every page). Direct POSTs to this endpoint - the
  // pattern seen in the spam wave - omit it, so treat it the same as the
  // honeypot: answer 200 with no signal that anything was detected.
  if (isMissingPage(body.page)) {
    console.warn(JSON.stringify({ event: 'missing_page', ip: clientIp }));
    return json(200, { ok: true }, corsOrigin);
  }

  const result = validate(body);
  if (!result.ok) {
    // Spam is answered with 200 so bots get no signal that they were caught.
    if (result.code === 'spam') {
      console.warn(JSON.stringify({ event: 'honeypot', ip: clientIp }));
      return json(200, { ok: true }, corsOrigin);
    }
    return json(400, { ok: false, error: result.code, field: result.field }, corsOrigin);
  }

  const { subject, text, html } = buildEmail(result.data, {
    page: typeof body.page === 'string' ? body.page.slice(0, 300) : '',
    ip: clientIp,
    userAgent: headers['user-agent'],
    receivedAt: new Date().toISOString(),
  });

  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: SENDER,
        Destination: { ToAddresses: [RECIPIENT] },
        ReplyToAddresses: [result.data.email],
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: text, Charset: 'UTF-8' },
              Html: { Data: html, Charset: 'UTF-8' },
            },
          },
        },
      })
    );
  } catch (err) {
    console.error(JSON.stringify({ event: 'ses_failed', name: err?.name, message: err?.message }));
    return json(502, { ok: false, error: 'send_failed' }, corsOrigin);
  }

  // ipTrusted tells us from the logs whether CloudFront-Viewer-Address is
  // actually reaching the function, i.e. whether the origin request policy is on.
  console.log(JSON.stringify({ event: 'sent', page: body.page, ip: clientIp, ipTrusted: client.trusted }));
  return json(200, { ok: true }, corsOrigin);
}
