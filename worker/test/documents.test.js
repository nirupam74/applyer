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
  assert.match(text, /Sincerely,\s*\n\s*\n?\s*Jane Doe/);
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

test('isRepeat: a second press while the first task is unfinished is a repeat; a later press is not', async () => {
  const { isRepeat } = await import('../handlers.js');
  const at = (ms) => ({ toMillis: () => ms });
  const b = { id: 'b', type: 'searchJobs', payload: {}, createdAt: at(200) };
  assert.equal(isRepeat(b, [b, { id: 'a', type: 'searchJobs', payload: {}, createdAt: at(100), status: 'done', updatedAt: at(900) }]), true, 'a finished after b was queued');
  assert.equal(isRepeat(b, [b, { id: 'a', type: 'searchJobs', payload: {}, createdAt: at(100), status: 'done', updatedAt: at(150) }]), false, 'a finished before b was queued');
  assert.equal(isRepeat(b, [b, { id: 'a', type: 'searchJobs', payload: {}, createdAt: at(100), status: 'failed', updatedAt: at(900) }]), false, 'a failed');
  assert.equal(isRepeat(b, [b, { id: 'c', type: 'searchJobs', payload: {}, createdAt: at(300), status: 'queued' }]), false, 'c is newer');
  assert.equal(isRepeat(b, [b, { id: 'a', type: 'searchJobs', payload: { sources: ['linkedin'] }, createdAt: at(100), status: 'running' }]), false, 'different payload');
});

test('pickTemplate: untailored before tailored, then best ATS, only versions that fit this page limit', async () => {
  const { pickTemplate } = await import('../apply/documents.js');
  const v = (id, o) => ({ id, fits: true, pageLimit: 2, structured: {}, ...o });
  const pick = (list) => pickTemplate(list, 2)?.id;
  assert.equal(pick([v('tailored', { jobId: 'j', ats: { score: 95 } }), v('low', { ats: { score: 78 } }), v('best', { ats: { score: 80 } })]), 'best');
  assert.equal(pick([v('overflow', { fits: false, ats: { score: 99 } }), v('onepage', { pageLimit: 1 }), v('tailored', { jobId: 'j' })]), 'tailored');
  assert.equal(pick([]), undefined);
});
