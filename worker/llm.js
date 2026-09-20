import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WORKER_DIR = path.dirname(fileURLToPath(import.meta.url));

export const TRUTHFULNESS_RULE =
  'Use only facts present in the supplied profile. Never add employers, degrees, dates, ' +
  'certifications, skills, or numbers that are not present. If information is missing, ' +
  'return null and list it under missing.';

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
