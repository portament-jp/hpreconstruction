/**
 * Local tests: node backend/contact/test.mjs
 * No AWS calls — validate.mjs is pure.
 */
import assert from 'node:assert/strict';
import { validate, buildEmail, resolveClientIp, LIMITS } from './validate.mjs';

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

if (process.exitCode) {
  console.error(`\n${passed} passed, some failed`);
} else {
  console.log(`${passed} tests passed`);
}
