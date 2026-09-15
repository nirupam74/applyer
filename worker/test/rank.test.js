import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupKey, heuristicScore, buildQueries, mergeJob, finalScore } from '../rank.js';

const profile = {
  personal: { location: 'Ontario, Canada' },
  preferences: {
    titles: ['Digital Marketing Intern', 'Social Media / Content Marketing Intern'],
    locations: ['Toronto, ON', 'Greater Toronto Area'],
    employmentType: ['Internship', 'Co-op'],
    seniority: 'Internship / Co-op / Junior',
    remote: 'any',
  },
  skills: { marketing: ['Social media marketing & community creation', 'SEO'] },
};

test('dedupKey ignores case, punctuation, company suffixes and location detail', () => {
  const a = dedupKey({ company: 'Acme Inc.', title: 'Digital Marketing Intern (Fall 2026)', location: 'Toronto, ON' });
  const b = dedupKey({ company: 'ACME', title: 'Digital marketing intern', location: 'Toronto, Ontario, Canada' });
  assert.equal(a, b);
  assert.notEqual(a, dedupKey({ company: 'Acme', title: 'Digital Marketing Intern', location: 'Ottawa, ON' }));
});

test('buildQueries splits slash titles and normalizes GTA', () => {
  const q = buildQueries(profile);
  assert.deepEqual(q.titles, ['Digital Marketing Intern', 'Social Media Marketing Intern', 'Content Marketing Intern']);
  assert.equal(q.location, 'Toronto, ON');
});

test('heuristicScore ranks a matching intern role above a senior role', () => {
  const now = new Date('2026-09-15');
  const intern = { title: 'Digital Marketing Intern', employmentType: 'Internship', location: 'Toronto, ON', postedAt: new Date('2026-09-14'), description: 'SEO and social media marketing' };
  const senior = { title: 'Senior Marketing Manager', employmentType: 'Full-time', location: 'Toronto, ON', postedAt: new Date('2026-09-14'), description: '' };
  const hi = heuristicScore(intern, profile, now);
  const lo = heuristicScore(senior, profile, now);
  assert.ok(hi >= 85, `expected high score, got ${hi}`);
  assert.ok(lo < 40, `expected low score, got ${lo}`);
  assert.equal(heuristicScore(intern, profile, now), hi, 'deterministic');
});

test('mergeJob unions sources and keeps the longer description', () => {
  const a = mergeJob(null, { source: 'linkedin', url: 'u1', title: 'X', company: 'C', location: 'L', description: 'short', externalId: '1' });
  const b = mergeJob(a, { source: 'indeed', url: 'u2', title: 'X', company: 'C', location: 'L', description: 'much longer text', externalId: '2' });
  assert.deepEqual(b.sources.map((s) => s.name), ['linkedin', 'indeed']);
  assert.equal(b.description, 'much longer text');
  assert.deepEqual(b.externalIds, { linkedin: '1', indeed: '2' });
});

test('finalScore blends heuristic and LLM match', () => {
  assert.equal(finalScore(80, null), 80);
  assert.equal(finalScore(80, 60), 67);
});
