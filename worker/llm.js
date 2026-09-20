import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKER_DIR = path.dirname(fileURLToPath(import.meta.url));

export const TRUTHFULNESS_RULE =
  'Use only facts present in the supplied profile. Never add employers, degrees, dates, ' +
  'certifications, skills, or numbers that are not present. If information is missing, ' +
  'return null and list it under missing.';

// One shared Anthropic API key serves every member. It lives beside the other worker secrets
// (~/.applyer/anthropic.key, chmod 600) or in ANTHROPIC_API_KEY, and is read on every call so
// dropping the file in needs no restart. With no key the worker falls back to the claude CLI
// (the owner's own login), which is how it ran before.
const KEY_FILE = path.join(os.homedir(), '.applyer', 'anthropic.key');
export const MODEL = process.env.APPLYER_MODEL || 'claude-sonnet-5'; // the CLI path always ran "sonnet"

export function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; }
}

async function runApi(prompt, key) {
  const client = new Anthropic({ apiKey: key });
  try {
    // Streamed: a full resume is a long answer and must not trip the HTTP timeout.
    const message = await client.messages.stream({ model: MODEL, max_tokens: 32000, messages: [{ role: 'user', content: prompt }] }).finalMessage();
    if (message.stop_reason === 'refusal') throw new Error(`Claude API declined the request (${message.stop_details?.category || 'no category'})`);
    if (message.stop_reason === 'max_tokens') throw new Error('Claude API answer was cut off at max_tokens');
    return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Claude API key was rejected: check ~/.applyer/anthropic.key');
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error(`Claude API key lacks access to ${MODEL}: ${err.message}`);
    if (err instanceof Anthropic.RateLimitError) throw new Error('Claude API rate limit hit (the SDK already retried twice)');
    if (err instanceof Anthropic.BadRequestError) throw new Error(`Claude API refused the request: ${err.message}`); // includes "credit balance is too low"
    if (err instanceof Anthropic.APIError) throw new Error(`Claude API error ${err.status ?? ''}: ${err.message}`);
    throw err;
  }
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      [
        '-p',
        '--model',
        'sonnet',
        '--output-format',
        'json',
        '--tools',
        '',
        '--strict-mcp-config',
        '--setting-sources',
        '',
      ],
      { cwd: WORKER_DIR, maxBuffer: 20 * 1024 * 1024, timeout: 240_000 },
      (err, stdout, stderr) => {
        if (err) {
          // execFile's message is only the command line; say why it died (timeout kill, signal, exit code).
          const why = err.killed ? 'timed out after 240 s' : err.signal ? `killed by ${err.signal}` : `exit code ${err.code}`;
          reject(new Error(`claude CLI failed (${why}): ${(stderr || stdout || '').slice(0, 500)}`));
          return;
        }
        resolve(stdout);
      }
    );
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Extracts the first JSON value from text, stripping ```json fences if present.
export function parseLlmJson(text) {
  let cleaned = text.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) cleaned = fenced[1].trim();
  return JSON.parse(cleaned);
}

async function callOnce(prompt) {
  const key = apiKey();
  if (key) return parseLlmJson(await runApi(prompt, key));
  const stdout = await runClaude(prompt);
  const outer = JSON.parse(stdout);
  const result = outer.result;
  if (typeof result !== 'string') {
    throw new Error('claude CLI output missing string result field');
  }
  return parseLlmJson(result);
}

// ask(prompt, shape): shape is a plain-text description of the expected JSON shape.
// Every call is prefixed with the truthfulness rule and an instruction to return only JSON.
export async function ask(prompt, shape) {
  const fullPrompt =
    `${TRUTHFULNESS_RULE}\n\nExpected JSON shape:\n${shape}\n\nReturn only JSON, no prose.\n\n${prompt}`;
  try {
    return await callOnce(fullPrompt);
  } catch (err) {
    // Retry once with a stronger instruction.
    return await callOnce(`${fullPrompt}\n\nReturn only valid JSON.`);
  }
}
