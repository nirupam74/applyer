# Applyer - design spec (2026-09-14)

Personal, two-user autonomous job-application platform for Nirupam and one other person.
Not a product. No signup, no scaling, no billing. Two allowlisted accounts.

## Decisions (user-approved 2026-09-14)
- Hosting: dashboard on Firebase Hosting, Firebase Auth email/password, Firestore. Project `applyer-jobs`.
- Worker: Node process on Nirupam's Mac (launchd). Does resume parsing, LLM calls, scraping, ranking, browser agent.
- LLM: `claude -p --output-format json` on the Max plan. No API key. One wrapper `worker/llm.js`.
- Job sources: direct Playwright scrapers of LinkedIn (public guest endpoints), Indeed, ZipRecruiter, Glassdoor.
  Adapters never bypass CAPTCHA, bot challenges, or login walls: they record `blocked` and return what they got.
  JSearch can be added later as a fifth adapter with no other changes.
- Email: deferred (phase 5).
- Files: resume bytes stored inside Firestore documents (<1 MB). Ceiling: move to Cloud Storage when Blaze is enabled.

## Architecture
```
Browser (React 18 + Vite 5 + Tailwind, Firebase Hosting)
   | Firebase Auth (email/password, 2 users)
   | Firestore client SDK, rules: users/{uid}/** readable+writable only by uid
   v
Firestore  <-- users/{uid}/tasks is the queue -->  Worker (Node, firebase-admin, this Mac)
                                                     |- llm.js        claude -p wrapper, JSON schema per call
                                                     |- resume/       parse (pdf-parse, mammoth), extract, optimize, ATS score, docx export
                                                     |- sources/      linkedin.js indeed.js ziprecruiter.js glassdoor.js (common interface)
                                                     |- rank.js       heuristic score -> LLM batch analysis (10 jobs/call) -> top 100
                                                     |- agent/        Playwright application agent, ported from JobSearch/bot/apply.py
```
The worker never opens a port. All communication is Firestore documents.

## Data model (all under users/{uid})
- `profile` (doc): personal, contact, education[], experience[], projects[], skills{category:[]}, certifications[], links, preferences (titles, industries, locations, remote, employmentType, salary, seniority), workAuthorization, availability.
- `resumes/{id}`: original upload {name, mime, bytes, text, uploadedAt}.
- `resumeVersions/{id}`: {resumeId, label, structured, atsScore, atsReport, docxBytes, jobId?, createdAt}.
- `answers/{id}`: question bank {question, answer, tags, source: user|generated, approved}.
- `jobs/{id}`: normalized job {title, company, location, workMode, salary, employmentType, description, requirements[], preferred[], benefits[], postedAt, deadline, sources[{name,url,applyUrl}], score, matchPct, analysis{strong[], missing[], advantages[], concerns[], recommendation}, discoveredAt, status: new|saved|dismissed}. Dedup key = normalized company|title|location.
- `applications/{id}`: {jobId, status (Saved..Rejected), resumeVersionId, coverLetterVersionId, answers{}, review{fields:[{name,value,confidence:green|yellow|red}]}, submittedAt, confirmation, probability{label, reasoning}, notes, tags[]}.
- `interviews/{id}`, `notifications/{id}`, `activity/{id}`, `settings/automation`, `tasks/{id}` {type, payload, status: queued|running|done|failed|paused, log[], error, result}.

Task types: parseResume, optimizeResume, tailorResume, searchJobs, analyzeJobs, prepareApplication, submitApplication.

## Security
- Firestore rules: `match /users/{uid}/{document=**} { allow read, write: if request.auth != null && request.auth.uid == uid; }`. Nothing else is readable.
- Accounts created by admin script only; no signup UI; Auth provider = email/password only.
- Worker credentials: service-account JSON on the Mac, outside the repo, chmod 600. No secrets in the frontend beyond the public Firebase config.
- Agent browser profile stored outside the repo.

## Truthfulness rule
Every LLM prompt carries: "Use only facts present in the supplied profile. Never add employers, degrees, dates, certifications, skills, or numbers that are not present. If information is missing, return null and list it under missing." Generated answers are drafts until the user approves.

## Phases (one session + one commit each)
1. Foundation + resume engine: project, auth, rules, dashboard shell (login, forgot password, dark/light), worker skeleton, upload -> extract -> profile editor -> optimize -> ATS score + compare -> DOCX download.
2. Discovery: adapters, dedup, ranking, top 100, job detail with resume-to-job analysis, filters/search, save/dismiss.
3. Applications: question bank, agent, green/yellow/red, Review Application screen, CRM table + pipeline, dedup warnings, CSV export.
4. Operations: home overview, interviews, notifications, analytics, automation center, settings, activity log, full two-account audit (spec section 35).
5. Email integration (IMAP or Gmail API, user decides then).

## Testing
Each phase ends with a real run as both accounts. Isolation test: signed in as A, attempt reads of users/B/profile and users/B/jobs; rules must reject. Worker unit checks: one `node --test` file per module covering the parser, dedup key, and heuristic score.
