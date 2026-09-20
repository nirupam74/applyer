import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postingMatches, isPageFurniture } from '../apply/agent.js';

const intern = { title: 'Digital Marketing Intern', company: 'RBC' };

test('postingMatches: same posting, reworded heading', () => {
  assert.equal(postingMatches(intern, ['RBC Careers', 'Intern, Digital Marketing (Fall 2026)'], 'jobs.rbc.com rbc careers'), true);
  assert.equal(postingMatches({ title: 'Marketing Co-op - 4 months', company: 'Klick Inc.' }, ['Marketing Coop'], 'klick health'), true);
  assert.equal(postingMatches({ title: 'Digital Marketing Internship', company: 'DULCEDO' }, ['DULCEDO - Digital Marketing Intern'], 'jobs.lever.co/dulcedo'), true);
});

test('postingMatches: the RBC failure, right company but a senior role', () => {
  assert.equal(postingMatches(intern, ['Senior Director, Digital Marketing'], 'rbc royal bank'), false);
  assert.equal(postingMatches({ title: 'Marketing Intern', company: 'RBC' }, ['Sr. Manager, Marketing'], 'rbc'), false);
});

test('postingMatches: company name alone, or body text alone, is not enough', () => {
  assert.equal(postingMatches(intern, ['Careers at RBC', 'Search jobs'], 'rbc digital marketing intern listed somewhere in the body'), false);
});

test('postingMatches: right title at an unrelated employer (sponsored redirect)', () => {
  assert.equal(postingMatches({ title: 'Marketing Intern', company: 'Proax Technologies' }, ['Marketing Intern'], 'hellofresh.com careers hellofresh'), false);
});

test('postingMatches: "intern" does not match "international", empty title never matches', () => {
  assert.equal(postingMatches({ title: 'Intern', company: '' }, ['International Sales'], ''), false);
  assert.equal(postingMatches({ title: '', company: 'RBC' }, ['Anything'], 'rbc'), false);
});

// Minimal stand-in for the DOM node isPageFurniture inspects in the browser.
function node({ type = 'text', attrs = {}, labels = [], inside = '', form = null }) {
  return {
    type,
    labels: labels.map((innerText) => ({ innerText })),
    getAttribute: (a) => attrs[a] ?? null,
    closest: (sel) => (sel === 'form' ? form && { getAttribute: (a) => form[a] ?? null } : inside && sel.includes(inside) ? {} : null),
  };
}

test('isPageFurniture: job alerts, newsletter, site search and sidebars are skipped', () => {
  assert.equal(isPageFurniture(node({ type: 'email', labels: ['Email me job alerts'] })), true);
  assert.equal(isPageFurniture(node({ attrs: { name: 'newsletter_email' } })), true);
  assert.equal(isPageFurniture(node({ type: 'search' })), true);
  assert.equal(isPageFurniture(node({ inside: 'aside' })), true);
  assert.equal(isPageFurniture(node({ form: { class: 'job-alert-signup' } })), true);
  assert.equal(isPageFurniture(node({ form: { action: '/search' } })), true);
});

test('isPageFurniture: real application fields are kept, including Workday "Search" typeaheads', () => {
  assert.equal(isPageFurniture(node({ type: 'email', labels: ['Email'], form: { id: 'application-form', action: '/apply' } })), false);
  assert.equal(isPageFurniture(node({ attrs: { placeholder: 'Search', 'data-automation-id': 'searchBox' } })), false);
});
