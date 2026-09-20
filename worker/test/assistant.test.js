import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools } from '../assistant.js';

// Just enough Firestore for the two guards under test.
function fakeDb({ liveTasks = [] } = {}) {
  const writes = [];
  const col = (name) => ({
    doc: () => ({ get: async () => ({ exists: true, data: () => ({}) }), set: async () => {}, update: async (v) => writes.push([name, v]) }),
    where: () => ({ get: async () => ({ docs: liveTasks.map((type) => ({ data: () => ({ type }) })) }) }),
    add: async (v) => { writes.push([name, v]); return { id: 't1' }; },
  });
  return { writes, collection: () => ({ doc: () => ({ collection: col }) }) };
}
const tool = (db, name) => buildTools(db, 'uid1').find((t) => t.name === name);

test('update_profile: only profile sections can be written, never updatedAt or unknown roots', async () => {
  const db = fakeDb();
  assert.match(await tool(db, 'update_profile').run({ changes: { 'settings.autoSubmit': true } }), /Not allowed/);
  assert.match(await tool(db, 'update_profile').run({ changes: { updatedAt: 0 } }), /Not allowed/);
  assert.equal(db.writes.length, 0);
  assert.match(await tool(db, 'update_profile').run({ changes: { 'personal.location': 'Brampton, Ontario' } }), /Saved/);
  assert.equal(db.writes[0][1]['personal.location'], 'Brampton, Ontario');
});

test('start_task: no second copy of a task, and one document task at a time', async () => {
  assert.match(await tool(fakeDb({ liveTasks: ['searchJobs'] }), 'start_task').run({ type: 'searchJobs' }), /already running/);
  assert.match(await tool(fakeDb({ liveTasks: ['prepareBatch'] }), 'start_task').run({ type: 'optimizeResume' }), /Another document task/);
  const db = fakeDb({ liveTasks: ['prepareBatch'] });
  assert.match(await tool(db, 'start_task').run({ type: 'searchJobs' }), /Started searchJobs/);
  assert.equal(db.writes[0][1].status, 'queued');
});
