/**
 * Local tests: node backend/contact/test.mjs
 * No AWS calls — validate.mjs is pure.
 */
import assert from 'node:assert/strict';
import { validate, buildEmail, resolveClientIp, LIMITS, isMissingPage, isOriginRejected } from './validate.mjs';
import { isTokenShapeValid, verifyTurnstile, MAX_TOKEN_LENGTH } from './turnstile.mjs';

let passed = 0;
const test = (label, fn) => {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL: ${label}`);
    console.error(err.message);
    process.exitCode = 1;
  }
};

// `test` is synchronous and ignores fn's return value, so an async body's
// rejection would surface as an unhandled rejection (fatal on Node 22) instead
// of a clean FAIL line. Async cases must use this variant and be awaited.
const testAsync = async (label, fn) => {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`FAIL: ${label}`);
    console.error(err.message);
    process.exitCode = 1;
  }
};

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);

const good = {
  name: '山田 太郎',
  email: 'taro@example.co.jp',
  company: '株式会社サンプル',
  message: 'サービスについて相談したいです。',
};

test('accepts a well-formed submission', () => {
  const r = validate(good);
  assert.equal(r.ok, true);
  assert.equal(r.data.name, '山田 太郎');
});

test('trims surrounding whitespace', () => {
  const r = validate({ ...good, name: '  山田 太郎  ' });
  assert.equal(r.ok, true);
  assert.equal(r.data.name, '山田 太郎');
});

test('keeps spaces inside names (control-char guard must not over-match)', () => {
  const r = validate({ ...good, name: 'Marta Mac Donald-Smith' });
  assert.equal(r.ok, true);
  assert.equal(r.data.name, 'Marta Mac Donald-Smith');
});

test('company is optional', () => {
  const r = validate({ ...good, company: '' });
  assert.equal(r.ok, true);
  assert.equal(r.data.company, '');
});

for (const field of ['name', 'email', 'message']) {
  test(`rejects missing ${field}`, () => {
    const r = validate({ ...good, [field]: '   ' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'required');
    assert.equal(r.field, field);
  });
}

test('rejects malformed email', () => {
  for (const email of ['nope', 'a@b', 'a b@example.com', '@example.com', 'a@@example.com']) {
    const r = validate({ ...good, email });
    assert.equal(r.ok, false, `expected rejection for ${email}`);
  }
});

test('rejects header injection via CR/LF in name', () => {
  const r = validate({ ...good, name: `Taro${CR}${LF}Bcc: victim@example.com` });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid');
  assert.equal(r.field, 'name');
});

test('rejects NUL bytes in email', () => {
  const r = validate({ ...good, email: `a${NUL}b@example.com` });
  assert.equal(r.ok, false);
});

test('allows newlines in the message body', () => {
  const r = validate({ ...good, message: `line one${LF}line two` });
  assert.equal(r.ok, true);
});

test('enforces length limits', () => {
  const r = validate({ ...good, message: 'あ'.repeat(LIMITS.message + 1) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too_long');
  assert.equal(r.field, 'message');
});

test('honeypot submission is flagged as spam', () => {
  const r = validate({ ...good, website: 'http://spam.example' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'spam');
});

test('rejects non-object bodies', () => {
  for (const body of [null, 'string', 42, ['a']]) {
    const r = validate(body);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'bad_body');
  }
});

test('coerces non-string field values instead of throwing', () => {
  const r = validate({ ...good, company: 12345 });
  assert.equal(r.ok, true);
  assert.equal(r.data.company, '12345');
});

test('buildEmail escapes HTML in user input', () => {
  const { html, subject, text } = buildEmail(
    { ...good, name: '<script>alert(1)</script>', message: 'a & b < c' },
    { page: '/index.html', ip: '203.0.113.9', receivedAt: '2026-08-03T00:00:00.000Z' }
  );
  assert.ok(!html.includes('<script>'), 'raw script tag must not survive');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('a &amp; b &lt; c'));
  assert.ok(subject.includes('<script>alert(1)</script>'), 'subject is a header, not HTML');
  assert.ok(text.includes('a & b < c'));
});

test('buildEmail shows a placeholder for missing company', () => {
  const { text } = buildEmail({ ...good, company: '' }, { receivedAt: '2026-08-03T00:00:00.000Z' });
  assert.ok(text.includes('会社名: (未記入)'));
});

test('CloudFront-Viewer-Address wins and is marked trusted', () => {
  const r = resolveClientIp({
    viewerAddress: '203.0.113.5:53412',
    xff: '198.51.100.99, 203.0.113.5',
    sourceIp: '130.176.0.1',
  });
  assert.equal(r.ip, '203.0.113.5');
  assert.equal(r.trusted, true);
});

test('IPv6 viewer address strips only the trailing port', () => {
  const r = resolveClientIp({ viewerAddress: '2400:d320:2310:4018::1:53412' });
  assert.equal(r.ip, '2400:d320:2310:4018::1');
  assert.equal(r.trusted, true);
});

test('viewer address without a port is left alone', () => {
  assert.equal(resolveClientIp({ viewerAddress: '203.0.113.5' }).ip, '203.0.113.5');
});

// Kawazoe-san's finding: CloudFront APPENDS the viewer to the chain the client
// sent, so entry [0] is whatever the attacker put there. Never trust one entry.
test('spoofed X-Forwarded-For shows the whole chain, not the spoofed head', () => {
  const r = resolveClientIp({
    xff: '203.0.113.99, 2400:d320:2310:4018::1',
    sourceIp: '130.176.0.1',
  });
  assert.ok(r.ip.includes('203.0.113.99'), 'chain is shown in full');
  assert.ok(r.ip.includes('2400:d320:2310:4018::1'), 'real viewer is shown too');
  assert.notEqual(r.ip, '203.0.113.99', 'must NOT present the spoofed head as the answer');
  assert.ok(r.ip.includes('詐称可能'), 'chain is labelled as untrustworthy');
  assert.equal(r.trusted, false);
});

test('single-entry chain is shown plainly but still untrusted', () => {
  const r = resolveClientIp({ xff: '2400:d320:2310:4018::1', sourceIp: '130.176.0.1' });
  assert.equal(r.ip, '2400:d320:2310:4018::1');
  assert.equal(r.trusted, false);
});

test('junk entries are dropped from the chain', () => {
  const r = resolveClientIp({ xff: 'Bcc: victim@example.com, 203.0.113.5', sourceIp: '130.176.0.1' });
  assert.ok(!r.ip.includes('Bcc'), 'injected text must never reach the email');
  assert.equal(r.ip, '203.0.113.5');
});

test('falls back to the edge IP when nothing usable is present', () => {
  assert.equal(resolveClientIp({ sourceIp: '130.176.0.1' }).ip, '130.176.0.1');
  assert.equal(resolveClientIp({ xff: 'garbage', sourceIp: '130.176.0.1' }).ip, '130.176.0.1');
  assert.equal(resolveClientIp({ viewerAddress: 'nonsense', sourceIp: '130.176.0.1' }).ip, '130.176.0.1');
  assert.equal(resolveClientIp().ip, '');
});

test('isMissingPage flags a missing page field', () => {
  assert.equal(isMissingPage(undefined), true);
});

test('isMissingPage flags a page that does not start with "/"', () => {
  for (const page of ['https://evil.example', 'index.html', '', 'agentmaker']) {
    assert.equal(isMissingPage(page), true, `expected ${JSON.stringify(page)} to be flagged`);
  }
});

test('isMissingPage passes a well-formed path', () => {
  for (const page of ['/', '/agentmaker', '/index.html']) {
    assert.equal(isMissingPage(page), false, `expected ${JSON.stringify(page)} to pass`);
  }
});

test('isMissingPage flags non-string values', () => {
  for (const page of [123, null, {}, [], true]) {
    assert.equal(isMissingPage(page), true, `expected ${JSON.stringify(page)} to be flagged`);
  }
});

const ALLOWED_ORIGINS = ['https://portament.jp', 'https://www.portament.jp'];

test('isOriginRejected passes an allow-listed origin', () => {
  assert.equal(isOriginRejected('https://portament.jp', ALLOWED_ORIGINS), false);
  assert.equal(isOriginRejected('https://www.portament.jp', ALLOWED_ORIGINS), false);
});

test('isOriginRejected rejects an origin not on the allow-list', () => {
  assert.equal(isOriginRejected('https://evil.example', ALLOWED_ORIGINS), true);
});

test('isOriginRejected does NOT reject a missing origin (avoid false positives)', () => {
  assert.equal(isOriginRejected(undefined, ALLOWED_ORIGINS), false);
  assert.equal(isOriginRejected('', ALLOWED_ORIGINS), false);
});

/* ─────────────────────────── Cloudflare Turnstile ─────────────────────────── */

test('token shape: accepts a normal token', () => {
  assert.equal(isTokenShapeValid('0.abc-DEF_123'), true);
});

test('token shape: rejects empty, non-string and oversized', () => {
  for (const bad of ['', null, undefined, 42, {}, []]) {
    assert.equal(isTokenShapeValid(bad), false, `expected reject for ${JSON.stringify(bad)}`);
  }
  assert.equal(isTokenShapeValid('a'.repeat(MAX_TOKEN_LENGTH)), true);
  assert.equal(isTokenShapeValid('a'.repeat(MAX_TOKEN_LENGTH + 1)), false);
});

// Records what was sent so we can assert on the request Cloudflare would receive.
const stubFetch = (impl) => {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts, body: new URLSearchParams(opts.body) });
    return impl();
  };
  fn.calls = calls;
  return fn;
};
const jsonRes = (payload, ok = true, status = 200) => ({
  ok, status, json: async () => payload,
});

await testAsync('verify: success', async () => {
  const f = stubFetch(() => jsonRes({ success: true }));
  const r = await verifyTurnstile('tok', { secret: 'sek', fetchImpl: f, timeoutMs: 50 });
  assert.deepEqual(r, { ok: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.get('secret'), 'sek');
  assert.equal(f.calls[0].body.get('response'), 'tok');
});

await testAsync('verify: remoteip sent only when supplied', async () => {
  const withIp = stubFetch(() => jsonRes({ success: true }));
  await verifyTurnstile('tok', { secret: 's', remoteIp: '203.0.113.5', fetchImpl: withIp, timeoutMs: 50 });
  assert.equal(withIp.calls[0].body.get('remoteip'), '203.0.113.5');

  const noIp = stubFetch(() => jsonRes({ success: true }));
  await verifyTurnstile('tok', { secret: 's', remoteIp: '', fetchImpl: noIp, timeoutMs: 50 });
  assert.equal(noIp.calls[0].body.has('remoteip'), false, 'must omit rather than send empty');
});

await testAsync('verify: Cloudflare rejection surfaces error-codes', async () => {
  const f = stubFetch(() => jsonRes({ success: false, 'error-codes': ['invalid-input-response'] }));
  const r = await verifyTurnstile('tok', { secret: 's', fetchImpl: f, timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rejected');
  assert.deepEqual(r.errorCodes, ['invalid-input-response']);
});

await testAsync('verify: a spent token is a rejection, not an outage', async () => {
  const f = stubFetch(() => jsonRes({ success: false, 'error-codes': ['timeout-or-duplicate'] }));
  const r = await verifyTurnstile('tok', { secret: 's', fetchImpl: f, timeoutMs: 50 });
  assert.equal(r.reason, 'rejected', 'must not be reported as unreachable');
});

await testAsync('verify: network error is unreachable, not rejected', async () => {
  const f = stubFetch(() => { throw Object.assign(new Error('boom'), { name: 'TypeError' }); });
  const r = await verifyTurnstile('tok', { secret: 's', fetchImpl: f, timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unreachable');
});

await testAsync('verify: timeout is unreachable', async () => {
  const f = stubFetch(() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
  const r = await verifyTurnstile('tok', { secret: 's', fetchImpl: f, timeoutMs: 50 });
  assert.equal(r.reason, 'unreachable');
  assert.equal(r.detail, 'TimeoutError');
});

await testAsync('verify: HTTP 5xx is unreachable', async () => {
  const f = stubFetch(() => jsonRes({}, false, 503));
  const r = await verifyTurnstile('tok', { secret: 's', fetchImpl: f, timeoutMs: 50 });
  assert.equal(r.reason, 'unreachable');
  assert.equal(r.detail, 'HTTP 503');
});

await testAsync('verify: unparseable body is unreachable, never a pass', async () => {
  const f = stubFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('nope'); } }));
  const r = await verifyTurnstile('tok', { secret: 's', fetchImpl: f, timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'bad_json');
});

await testAsync('verify: a body without success:true never passes', async () => {
  for (const payload of [{}, { success: 'true' }, { success: 1 }, null]) {
    const f = stubFetch(() => jsonRes(payload));
    const r = await verifyTurnstile('tok', { secret: 's', fetchImpl: f, timeoutMs: 50 });
    assert.equal(r.ok, false, `expected failure for ${JSON.stringify(payload)}`);
  }
});

if (process.exitCode) {
  console.error(`\n${passed} passed, some failed`);
} else {
  console.log(`${passed} tests passed`);
}
