import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCode, isFromToday } from '../apply/mail.js';

test('extractCode ignores dates and phone numbers, prefers the code near the word code', () => {
  assert.equal(extractCode('Security code for your application to Kensington 7/20/2026 Your code is 483920'), '483920');
  assert.equal(extractCode('Call 416-555-0199. Verification code: 7731'), '7731');
  assert.equal(extractCode('Sent 2026-09-15, nothing else'), null);
});

test('isFromToday accepts a time-only stamp and rejects dated rows', () => {
  assert.equal(isFromToday('Greenhouse Security code 3:42 PM'), true);
  assert.equal(isFromToday('Greenhouse Security code 7/20/2026'), false);
});
