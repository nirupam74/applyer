import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDocx } from '../resume/docx.js';
import { bytesToText } from '../resume/parse.js';

const sampleStructured = {
  summary: 'Experienced engineer.',
  education: [{ institution: 'State University', degree: 'BS Computer Science', graduation: '2020' }],
  experience: [
    {
      company: 'Acme Corp',
      title: 'Software Engineer',
      start: '2020',
      end: '2023',
      responsibilities: ['Built things', 'Fixed bugs'],
      achievements: ['Shipped a major feature'],
    },
  ],
  projects: [],
  skills: { technical: ['JavaScript', 'Node.js'] },
};

const personal = { name: 'Jane Doe', email: 'jane@example.com', phone: '555-1234' };

test('buildDocx returns a Buffer starting with PK', async () => {
  const buf = await buildDocx(sampleStructured, personal);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.slice(0, 2).toString(), 'PK');
});

test('buildDocx round-trips through bytesToText with name and company', async () => {
  const buf = await buildDocx(sampleStructured, personal);
  const text = await bytesToText(
    buf,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  assert.match(text, /Jane Doe/i);
  assert.match(text, /Acme Corp/);
});
