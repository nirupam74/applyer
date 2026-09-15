# Applyer Phase 1: Foundation + Resume Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two isolated accounts can sign in to a hosted dashboard, upload a resume, get it extracted into a structured profile, optimized with an ATS score, compared against the original, and downloaded as DOCX.

**Architecture:** React dashboard on Firebase Hosting talks only to Firestore under `users/{uid}`. A Node worker on the Mac watches `users/{uid}/tasks` and does parsing, LLM calls (`claude -p`) and DOCX generation, writing results back to Firestore. Spec: `docs/superpowers/specs/2026-09-14-applyer-design.md`.

**Tech Stack:** React 18, Vite 5, TypeScript, Tailwind 3, react-router 6, firebase 10 (web); Node 20 ESM, firebase-admin, pdf-parse, mammoth, docx, `node --test` (worker).

## Global Constraints
- Firebase project `applyer-jobs`, web app id `1:692780340256:web:4a5eddacb7e8d9f8c55845`, Firestore region northamerica-northeast2 (already provisioned).
- Web SDK config (public, fine in frontend): apiKey `REDACTED_FIREBASE_WEB_KEY`, authDomain `applyer-jobs.firebaseapp.com`, projectId `applyer-jobs`, appId above.
- Worker credentials: `~/.applyer/sa.json` (exists, chmod 600). Never copy into repo. Read via `GOOGLE_APPLICATION_CREDENTIALS` or explicit path.
- Vite 5 only (Vite 8 does not build on this machine's SSD).
- No signup UI. Accounts are created by `worker/scripts/create-users.mjs`.
- Every LLM prompt includes the truthfulness rule from the spec verbatim.
- Files stored as Firestore `Bytes`; reject uploads over 900 KB with a visible error.
- No em dashes anywhere in code, copy, or commits.
- UI direction: premium SaaS, dark/light via `prefers-color-scheme` plus a toggle persisted in localStorage, Inter via Google Fonts with system fallback, no placeholder/fake data anywhere.

## File structure
```
firebase.json  .firebaserc  firestore.rules  firestore.indexes.json
web/                         Vite app (hosting public dir = web/dist)
  src/firebase.ts            initializeApp + auth + db exports
  src/auth.tsx               <AuthProvider>, useUser(), <RequireAuth>
  src/lib/paths.ts           userCol(uid, name), userDoc(uid, name, id) helpers
  src/lib/tasks.ts           enqueueTask(uid, type, payload) -> taskId; useTask(uid, id)
  src/lib/types.ts           Profile, Resume, ResumeVersion, Task, AtsReport types (shared shape with worker)
  src/pages/Login.tsx  ForgotPassword.tsx  Shell.tsx (sidebar+topbar+theme)  Home.tsx  Resume.tsx  Profile.tsx
  src/components/ResumeUpload.tsx  VersionList.tsx  CompareView.tsx  AtsCard.tsx  ProfileEditor.tsx  TaskStatus.tsx
worker/
  index.js                   admin init, listUsers, per-user onSnapshot on tasks where status==queued, dispatch
  llm.js                     ask(prompt, schemaDescription) -> parsed JSON via `claude -p`
  resume/parse.js            bytesToText(bytes, mime) for pdf/docx/txt
  resume/extract.js          extractProfile(text) -> Profile (LLM)
  resume/optimize.js         optimizeResume(profile, originalText, section?) -> {structured, ats}
  resume/docx.js             buildDocx(structured) -> Buffer
  handlers.js                parseResume, optimizeResume task handlers
  scripts/create-users.mjs   node scripts/create-users.mjs a@x.com b@y.com
  launchd/com.applyer.worker.plist
  test/parse.test.js  test/docx.test.js  test/llm.test.js
```

## Contracts (both sides depend on these exactly)

Task document `users/{uid}/tasks/{id}`:
```ts
{ type: 'parseResume' | 'optimizeResume', payload: Record<string, unknown>,
  status: 'queued' | 'running' | 'done' | 'failed', log: string[], error?: string,
  result?: Record<string, unknown>, createdAt: Timestamp, updatedAt: Timestamp }
```
- `parseResume` payload `{ resumeId }` -> sets `resumes/{resumeId}.text`, writes `profile` doc (merge, only empty fields overwritten unless `payload.overwrite === true`), result `{ profileFields: number }`.
- `optimizeResume` payload `{ resumeId, versionId?, section? }` -> creates or updates `resumeVersions/{versionId}` with `{ resumeId, label, structured, ats, docxBytes, createdAt }`, result `{ versionId }`.

Profile (`users/{uid}/profile`):
```ts
{ personal: { name, email, phone, location, linkedin, portfolio, website, links: string[] },
  education: [{ institution, degree, program, major, minor, gpa, graduation, coursework: string[] }],
  experience: [{ company, title, employmentType, start, end, responsibilities: string[], achievements: string[], metrics: string[], technologies: string[], skills: string[], industry }],
  projects: [{ name, description, technologies: string[], link }],
  skills: { technical: string[], tools: string[], programming: string[], marketing: string[], business: string[], communication: string[], leadership: string[], creative: string[], industry: string[], certifications: string[], languages: string[] },
  preferences: { titles: string[], industries: string[], locations: string[], remote: 'remote'|'hybrid'|'onsite'|'any', employmentType: string[], salaryMin: number|null, seniority: string },
  workAuthorization: string, availability: string, updatedAt }
```
All strings may be empty, arrays may be empty, never undefined.

ResumeVersion.structured = `{ summary: string, education, experience, projects, skills }` with the same element shapes as Profile. `ats = { score: 0-100, problems: string[], recommendations: string[], improvementsMade: string[], remainingWeaknesses: string[] }`.

`llm.ask(prompt: string, shape: string): Promise<any>` runs `claude -p --model sonnet --output-format json` with cwd `worker/`, prompt = truthfulness rule + shape description + "Return only JSON" + prompt; parses `result` field, strips code fences, throws on invalid JSON after one retry.

---

### Task 1: Firebase config, rules, hosting wiring (infra, done by lead)
**Files:** `firebase.json`, `.firebaserc`, `firestore.rules`, `firestore.indexes.json`, `.gitignore`
- [ ] Rules exactly: `match /users/{uid}/{document=**} { allow read, write: if request.auth != null && request.auth.uid == uid; }`; default deny.
- [ ] `firebase deploy --only firestore:rules --project applyer-jobs` succeeds.
- [ ] Commit.

### Task 2: Worker skeleton + LLM wrapper + parser
**Files:** `worker/package.json`, `worker/index.js`, `worker/llm.js`, `worker/resume/parse.js`, `worker/test/parse.test.js`, `worker/test/llm.test.js`
- [ ] `parse.test.js`: build a tiny DOCX with the `docx` package in the test, run `bytesToText`, assert the text contains the paragraph; TXT round-trip; unknown mime throws.
- [ ] `llm.test.js`: `parseLlmJson('```json\n{"a":1}\n```')` returns `{a:1}`; export `parseLlmJson` from `llm.js`.
- [ ] `index.js`: admin init from `~/.applyer/sa.json`; `auth.listUsers()`; for each uid `onSnapshot(users/{uid}/tasks where status=='queued')`; claim with a transaction setting `running`; call handler; write `done`+result or `failed`+error; append to `log` with timestamps; also `activity/{id}` entries `{ type, message, at }`.
- [ ] `npm test` passes. Commit.

### Task 3: Extract, optimize, DOCX handlers
**Files:** `worker/resume/extract.js`, `worker/resume/optimize.js`, `worker/resume/docx.js`, `worker/handlers.js`, `worker/test/docx.test.js`
- [ ] `docx.test.js`: `buildDocx(sampleStructured)` returns a Buffer starting with `PK`; round-trip through `bytesToText` contains the person's name and a company.
- [ ] `extractProfile`: one LLM call, returns Profile per contract, all keys present (normalize with a `emptyProfile()` merge).
- [ ] `optimizeResume`: one LLM call for full structured + ats; when `section` given, only that section is regenerated and merged into the existing version. Deterministic pre-checks appended to prompt: missing email/phone, no experience bullets, summary length, bullet count per role, presence of standard headings.
- [ ] Handlers write per the contracts. `npm test` passes. Commit.

### Task 4: Create-users script + launchd
**Files:** `worker/scripts/create-users.mjs`, `worker/launchd/com.applyer.worker.plist`, `worker/README.md`
- [ ] Script: for each email arg, create Auth user with a generated 20-char password, set `users/{uid}` doc `{ email, createdAt }`, seed `profile` with `emptyProfile()`, print email + password once. Idempotent: existing user prints "exists".
- [ ] plist runs `node index.js` with KeepAlive, logs to `~/.applyer/worker.log`. README: install, load, tail log. Commit.

### Task 5: Dashboard shell + auth
**Files:** `web/*` scaffold, `src/firebase.ts`, `src/auth.tsx`, `src/pages/Login.tsx`, `ForgotPassword.tsx`, `Shell.tsx`, `Home.tsx`, `src/lib/paths.ts`, `src/lib/types.ts`
- [ ] Login: email + password, inline error copy for wrong password / unknown user / too many attempts, "Forgot password" link, persistent session (`browserLocalPersistence`). ForgotPassword calls `sendPasswordResetEmail`. Sign out in the shell's user menu.
- [ ] Shell: left sidebar (Home, Resume, Profile; Jobs/Applications/Settings shown disabled with "Phase 2" tag is NOT allowed; omit them), theme toggle, responsive collapse under 768px.
- [ ] Home: real counts only (resumes uploaded, versions, profile completeness %) computed from Firestore; empty state with a CTA to upload a resume.
- [ ] `npm run build` passes. Commit.

### Task 6: Resume upload, versions, compare, ATS, download; Profile editor
**Files:** `src/lib/tasks.ts`, `src/pages/Resume.tsx`, `src/pages/Profile.tsx`, `src/components/*`
- [ ] Upload: accept `.pdf,.docx,.txt`, size gate 900 KB, write `resumes/{id}` with `Bytes`, enqueue `parseResume`; TaskStatus shows live log lines from the task doc; on done, show "Optimize" button which enqueues `optimizeResume`.
- [ ] VersionList: all `resumeVersions` newest first with ATS score badge, label editing, "Set as default" (writes `settings/resume.defaultVersionId`), delete.
- [ ] CompareView: left = original extracted text, right = optimized rendered structured; per-section "Regenerate" enqueues `optimizeResume` with `section`; fields editable inline and saved to the version doc.
- [ ] AtsCard: score ring + the five lists from `ats`.
- [ ] Download: `docxBytes` -> Blob -> `<a download="<Name> - Resume.docx">`.
- [ ] ProfileEditor: every Profile field editable, arrays as chip inputs, saves with `setDoc(merge)`; the same editor component edits `version.structured`.
- [ ] Loading, empty and error states on every page. `npm run build` passes. Commit.

### Task 7: Deploy + end-to-end as both users (lead)
- [ ] `firebase deploy --only hosting`, worker running via launchd.
- [ ] As user A: upload real resume, parse, optimize, compare, download, edit profile. Repeat as user B.
- [ ] Isolation: signed in as A, `getDoc(doc(db,'users',<B uid>,'profile'))` in the console rejects with permission-denied.
- [ ] Commit, record memory.
