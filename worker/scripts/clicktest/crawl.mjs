// Pass 1: load every dashboard route as each member, record crashes, console errors and the controls on the page. Read-only.
import admin from 'firebase-admin';
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
const KEY = 'REDACTED_FIREBASE_WEB_KEY';
const BASE = process.env.BASE || 'https://applyer-jobs.web.app';
const OUT = process.env.OUT;
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(os.homedir() + '/.applyer/sa.json', 'utf8'))) });
const db = admin.firestore();

export async function session(browser, uid, viewport = { width: 1280, height: 900 }) {
  const custom = await admin.auth().createCustomToken(uid);
  const r = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })).json();
  if (!r.idToken) throw new Error('sign-in failed');
  const rec = await admin.auth().getUser(uid);
  const user = { uid, email: rec.email, emailVerified: rec.emailVerified, isAnonymous: false, providerData: [], stsTokenManager: { refreshToken: r.refreshToken, accessToken: r.idToken, expirationTime: Date.now() + 3500e3 }, createdAt: String(Date.parse(rec.metadata.creationTime)), lastLoginAt: String(Date.now()), apiKey: KEY, appName: '[DEFAULT]' };
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), [`firebase:authUser:${KEY}:[DEFAULT]`, JSON.stringify(user)]);
  return ctx;
}

export function watch(page, errors) {
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text().slice(0, 300)));
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));
  page.on('response', (r) => r.status() >= 400 && !/favicon/.test(r.url()) && errors.push(`http ${r.status()} ${r.url().slice(0, 100)}`));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const users = { nirupam: 'MEMBER1_UID', member2: 'MEMBER2_UID' };
  const browser = await chromium.launch();
  for (const [name, uid] of Object.entries(users)) {
    const routes = ['/home', '/jobs', '/applications', '/resume', '/profile', '/assistant', '/answers', '/nope'];
    const job = (await db.collection(`users/${uid}/jobs`).orderBy('score', 'desc').limit(1).get()).docs[0];
    if (job) routes.push(`/jobs/${job.id}`);
    routes.push('/jobs/does-not-exist');
    const app = (await db.collection(`users/${uid}/applications`).limit(1).get()).docs[0];
    if (app) routes.push(`/applications/${app.id}`);
    for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const ctx = await session(browser, uid, vp);
      for (const route of routes) {
        const page = await ctx.newPage();
        const errors = [];
        watch(page, errors);
        await page.goto(BASE + route, { waitUntil: 'load' });
        await page.waitForTimeout(3000);
        const text = (await page.locator('#root').innerText().catch(() => '')).replace(/\s*\n+\s*/g, ' | ');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        const line = `${name} ${vp.width} ${route} -> ${new URL(page.url()).pathname} | chars ${text.length} | xoverflow ${overflow} | ${errors.length ? errors.join(' ;; ') : 'no errors'}`;
        console.log(line);
        if (vp.width === 1280) {
          const controls = await page.locator('main button, main a, main select, main input, main textarea').evaluateAll((els) => els.map((e) => `${e.tagName.toLowerCase()}:${(e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('name') || '').trim().slice(0, 40)}${e.disabled ? ' (disabled)' : ''}`));
          fs.appendFileSync(OUT + '/controls.txt', `\n## ${name} ${route}\nTEXT: ${text.slice(0, 700)}\nCONTROLS(${controls.length}): ${[...new Set(controls)].slice(0, 60).join(' ¦ ')}\n`);
        }
        await page.screenshot({ path: `${OUT}/${name}-${vp.width}-${route.replace(/\W+/g, '_')}.png`, fullPage: true });
        await page.close();
      }
      await ctx.close();
    }
  }
  await browser.close();
  process.exit(0);
}
