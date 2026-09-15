import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
import { existsSync, readdirSync } from 'node:fs';

function caskroomSoffice() {
  const base = '/opt/homebrew/Caskroom/libreoffice';
  try {
    return readdirSync(base).map((v) => `${base}/${v}/LibreOffice.app/Contents/MacOS/soffice`);
  } catch {
    return [];
  }
}

const SOFFICE_CANDIDATES = [
  process.env.APPLYER_SOFFICE,
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ...caskroomSoffice(),
].filter(Boolean);
const SOFFICE = SOFFICE_CANDIDATES.find((p) => existsSync(p)) || SOFFICE_CANDIDATES[SOFFICE_CANDIDATES.length - 1];
const PDFINFO = process.env.APPLYER_PDFINFO || '/opt/homebrew/bin/pdfinfo';
const PDFTOTEXT = process.env.APPLYER_PDFTOTEXT || '/opt/homebrew/bin/pdftotext';

// docxToPdf(docxBuffer) -> { pdf: Buffer, pages: number, linesPerPage: number[] }
// Renders through LibreOffice headless so the page count is the real paginated count.
export async function docxToPdf(docxBuffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'applyer-pdf-'));
  try {
    const docxPath = path.join(dir, 'resume.docx');
    await fs.writeFile(docxPath, docxBuffer);
    const profileDir = path.join(os.homedir(), '.applyer', 'lo-profile');
    try {
      await run(SOFFICE, [`-env:UserInstallation=file://${profileDir}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, docxPath], {
        timeout: 120_000,
        env: { ...process.env, HOME: process.env.HOME || os.homedir() },
      });
    } catch (err) {
      throw new Error(`soffice failed (code ${err.code}, signal ${err.signal}): ${err.message}\nstdout: ${err.stdout}\nstderr: ${err.stderr}`);
    }
    const pdf = await fs.readFile(path.join(dir, 'resume.pdf'));
    const { stdout } = await run(PDFINFO, [path.join(dir, 'resume.pdf')]);
    const m = /Pages:\s+(\d+)/.exec(stdout);
    const text = (await run(PDFTOTEXT, ['-layout', path.join(dir, 'resume.pdf'), '-'])).stdout;
    const linesPerPage = text.split('\f').map((pg) => pg.split('\n').filter((l) => l.trim()).length).filter((n, i, arr) => n > 0 || i < arr.length - 1);
    return { pdf, pages: m ? Number(m[1]) : 0, linesPerPage };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
