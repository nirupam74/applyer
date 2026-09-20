import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorkAuth, yearsOfExperience, applyRules, fullUrl, canadianPostal } from '../apply/answers.js';

test('classifyWorkAuth: citizen needs no sponsorship and is authorized', () => {
  const c = classifyWorkAuth('Canadian citizen, no sponsorship required');
  assert.equal(c.needsSponsorship, false);
  assert.equal(c.authorized, true);
});

test('classifyWorkAuth: will require a visa', () => {
  const c = classifyWorkAuth('International student, will require visa sponsorship');
  assert.equal(c.needsSponsorship, true);
});

test('classifyWorkAuth: empty profile field is unknown, not guessed', () => {
  const c = classifyWorkAuth('');
  assert.equal(c.authorized, null);
  assert.equal(c.needsSponsorship, null);
});

test('applyRules: "eligible to work without sponsorship" resolves Yes (the apply.py bug)', () => {
  const profile = { workAuthorization: 'Canadian citizen, no sponsorship required' };
  assert.equal(applyRules(profile, {}, 'Are you legally eligible to work in Canada without sponsorship?'), 'Yes');
});

test('applyRules: sponsorship question resolves No for a citizen', () => {
  const profile = { workAuthorization: 'Canadian citizen, no sponsorship required' };
  assert.equal(applyRules(profile, {}, 'Do you require sponsorship to work in Canada?'), 'No');
});

test('applyRules: sponsorship question resolves Yes when the profile needs a visa', () => {
  const profile = { workAuthorization: 'Will require visa sponsorship' };
  assert.equal(applyRules(profile, {}, 'Will you now or in the future require sponsorship?'), 'Yes');
});

test('applyRules: email prefers settings override over profile email', () => {
  const profile = { personal: { email: 'profile@example.com' } };
  const settings = { email: 'override@example.com' };
  assert.equal(applyRules(profile, settings, 'Email address'), 'override@example.com');
});

test('applyRules: email falls back to profile when no override is set', () => {
  const profile = { personal: { email: 'profile@example.com' } };
  assert.equal(applyRules(profile, {}, 'Email'), 'profile@example.com');
});

test('fullUrl: bare resume-style links gain a scheme, everything else is left alone', () => {
  assert.equal(fullUrl('linkedin.com/in/nirupam-gupta'), 'https://www.linkedin.com/in/nirupam-gupta');
  assert.equal(fullUrl('https://linkedin.com/in/nirupam-gupta'), 'https://www.linkedin.com/in/nirupam-gupta');
  assert.equal(fullUrl('www.nirupamgupta.com'), 'https://www.nirupamgupta.com');
  assert.equal(fullUrl('https://www.nirupamgupta.com'), 'https://www.nirupamgupta.com');
  assert.equal(fullUrl('nirupam.gupta@mail.utoronto.ca'), 'nirupam.gupta@mail.utoronto.ca');
  assert.equal(fullUrl('Brampton'), 'Brampton');
});

test('canadianPostal: the spaced form every validator accepts; other values untouched', () => {
  assert.equal(canadianPostal('L6Y3K7'), 'L6Y 3K7');
  assert.equal(canadianPostal('l6y-3k7'), 'L6Y 3K7');
  assert.equal(canadianPostal('L6Y 3K7'), 'L6Y 3K7');
  assert.equal(canadianPostal('90210'), '90210');
  assert.equal(canadianPostal('Brampton'), 'Brampton');
});

test('applyRules: "age of majority" is not the major rule; "legally entitled to work" is work authorization', () => {
  const p = { education: [{ major: 'Digital Enterprise Management' }], workAuthorization: 'Canadian citizen' };
  assert.equal(applyRules(p, {}, 'A requirement of this position is to have reached the federal age of majority, which is 18 years old. Do you meet this requirement?'), null);
  assert.equal(applyRules(p, {}, 'Are you legally entitled to work in Canada?'), 'Yes');
  assert.equal(applyRules(p, {}, 'Major'), 'Digital Enterprise Management');
});

test('applyRules: unmatched question returns null (never invents an answer)', () => {
  assert.equal(applyRules({}, {}, 'Why do you want to work here?'), null);
});

test('yearsOfExperience: sums start/end years across roles, "Present" counts to now', () => {
  const profile = {
    experience: [
      { start: '2019', end: '2021' },
      { start: '2021', end: 'Present' },
    ],
  };
  const y = yearsOfExperience(profile);
  assert.equal(typeof y, 'number');
  assert.ok(y >= 6, `expected at least ~6 years, got ${y}`);
});

test('yearsOfExperience: no experience entries returns null', () => {
  assert.equal(yearsOfExperience({ experience: [] }), null);
});
