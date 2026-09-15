import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { bytesToText } from '../resume/parse.js';

test('bytesToText extracts text from a docx', async () => {
  const doc = new Document({
    sections: [
      {
        children: [new Paragraph({ children: [new TextRun('Hello from a test docx')] })],
      },
    ],
  });
  const buf = await Packer.toBuffer(doc);
  const text = await bytesToText(
    buf,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  assert.match(text, /Hello from a test docx/);
});

test('bytesToText round-trips plain text', async () => {
  const text = await bytesToText(Buffer.from('plain text content', 'utf8'), 'text/plain');
  assert.equal(text, 'plain text content');
});

test('bytesToText throws on unknown mime', async () => {
  await assert.rejects(
    () => bytesToText(Buffer.from('x'), 'application/octet-stream'),
    /Unsupported file type/
  );
});
