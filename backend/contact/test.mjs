/**
 * Local tests: node backend/contact/test.mjs
 * No AWS calls — validate.mjs is pure.
 */
import assert from 'node:assert/strict';
import { validate, buildEmail, pickClientIp, LIMITS } from './validate.mjs';

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

test('pickClientIp takes the first X-Forwarded-For entry (the visitor)', () => {
  assert.equal(pickClientIp('203.0.113.7, 130.176.0.1', '130.176.0.1'), '203.0.113.7');
  assert.equal(pickClientIp('203.0.113.7', '130.176.0.1'), '203.0.113.7');
});

test('pickClientIp accepts IPv6', () => {
  assert.equal(pickClientIp('2001:db8::1, 130.176.0.1', '130.176.0.1'), '2001:db8::1');
});

test('pickClientIp falls back to sourceIp on junk or spoofed garbage', () => {
  assert.equal(pickClientIp('', '130.176.0.1'), '130.176.0.1');
  assert.equal(pickClientIp(undefined, '130.176.0.1'), '130.176.0.1');
  assert.equal(pickClientIp('<script>alert(1)</script>, 1.2.3.4', '130.176.0.1'), '130.176.0.1');
  assert.equal(pickClientIp('999.1.1.1, 1.2.3.4', '130.176.0.1'), '130.176.0.1');
  assert.equal(pickClientIp('not an ip', '130.176.0.1'), '130.176.0.1');
});

if (process.exitCode) {
  console.error(`\n${passed} passed, some failed`);
} else {
  console.log(`${passed} tests passed`);
}
