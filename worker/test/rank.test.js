import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupKey, heuristicScore, buildQueries, mergeJob, finalScore, prefsKey } from '../rank.js';

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
  assert.equal(dedupKey({ company: 'Klick Health', title: 'Project Coordinator', location: 'Toronto, ON' }), dedupKey({ company: 'Klick', title: 'Project Coordinator', location: 'Toronto' }));
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

test('heuristicScore: a graduate profile is not offered internships, and "Internal" is not an internship', () => {
  const now = new Date('2026-09-20');
  const grad = { preferences: { titles: ['Research Associate'], locations: ['Toronto, ON'], employmentType: ['Full-time'] }, skills: {} };
  const job = (title) => ({ title, location: 'Toronto, ON', employmentType: 'Full-time', postedAt: now });
  const plain = heuristicScore(job('Research Associate'), grad, now);
  assert.equal(heuristicScore(job('Research Associate, Internal Medicine'), grad, now), plain);
  assert.equal(heuristicScore(job('Research Associate Intern'), grad, now), plain - 25);
  assert.equal(buildQueries({ preferences: {}, experience: [{ title: 'Research Associate' }], personal: { location: 'Toronto, ON' } }).titles[0], 'Research Associate');
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

test('buildQueries: levels and case collapse into one query, up to 30 queries', () => {
  const titles = ['Research technician I', 'Research technician II', 'research Technician III', 'technologist I', 'Clinical Research', ...Array.from({ length: 40 }, (_, i) => 'Role number ' + (i + 10))];
  const q = buildQueries({ preferences: { titles, locations: ['Toronto', 'Brampton'] } });
  assert.deepEqual(q.titles.slice(0, 3), ['Research technician', 'technologist', 'Clinical Research']);
  assert.equal(q.titles.length, 30);
  assert.equal(q.location, 'Toronto');
  assert.deepEqual(q.locations, ['Toronto', 'Brampton']);
  assert.deepEqual(buildQueries({ preferences: { titles: ['A'], locations: ['GTA', 'Greater Toronto Area'] } }).locations, ['Toronto, ON']);
});

test('heuristicScore: any GTA city matches a member whose cities are in the GTA', () => {
  const now = new Date('2026-09-20');
  const p = { preferences: { titles: ['Research Assistant'], locations: ['Brampton'] }, skills: {} };
  const at = (location) => heuristicScore({ title: 'Research Assistant', location, postedAt: now }, p, now);
  assert.equal(at('Markham, Ontario, Canada'), at('Brampton, ON'));
  assert.equal(at('Markham, Ontario, Canada') - at('Ottawa, Ontario, Canada'), 8);
});

test('prefsKey changes with preferences, not with the rest of the profile', () => {
  const a = { preferences: { titles: ['A'] }, personal: { name: 'x' } };
  assert.equal(prefsKey(a), prefsKey({ ...a, personal: { name: 'y' } }));
  assert.notEqual(prefsKey(a), prefsKey({ ...a, preferences: { titles: ['B'] } }));
});
