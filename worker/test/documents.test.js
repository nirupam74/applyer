import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCoverLetterDocx, resolveApplicationEmail } from '../apply/documents.js';
import { bytesToText } from '../resume/parse.js';

const personal = { name: 'Jane Doe', email: 'jane@personal.example', phone: '555-1234', location: 'Toronto, ON' };

test('buildCoverLetterDocx renders name, greeting, body, and sign-off', async () => {
  const buf = await buildCoverLetterDocx({
    personal,
    company: 'Acme Corp',
    date: 'January 1, 2026',
    paragraphs: ['First paragraph about the role.', 'Second paragraph about fit.'],
    closing: 'I look forward to hearing from you.',
  });
  assert.ok(Buffer.isBuffer(buf));
  const text = await bytesToText(
    buf,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  assert.match(text, /Jane Doe/);
  assert.match(text, /Dear Hiring Team at Acme Corp,/);
  assert.match(text, /First paragraph about the role\./);
  assert.match(text, /I look forward to hearing from you\./);
  assert.match(text, /Sincerely, Jane Doe/);
  assert.match(text, /jane@personal\.example/);
});

test('resolveApplicationEmail prefers settings/applications.email over the profile email', () => {
  const profile = { personal: { email: 'profile@example.com' } };
  assert.equal(resolveApplicationEmail(profile, { email: 'applications@example.com' }), 'applications@example.com');
});

test('resolveApplicationEmail falls back to the profile email when settings/applications is absent', () => {
  const profile = { personal: { email: 'profile@example.com' } };
  assert.equal(resolveApplicationEmail(profile, null), 'profile@example.com');
});

test('resolveApplicationEmail falls back to empty string when neither is set', () => {
  assert.equal(resolveApplicationEmail({ personal: {} }, null), '');
});
