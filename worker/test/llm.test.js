import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLlmJson } from '../llm.js';

test('parseLlmJson strips code fences', () => {
  const result = parseLlmJson('```json\n{"a":1}\n```');
  assert.deepEqual(result, { a: 1 });
});

test('parseLlmJson handles plain JSON with no fences', () => {
  const result = parseLlmJson('{"b":2}');
  assert.deepEqual(result, { b: 2 });
});
