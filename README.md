# Applyer

A personal job-search assistant. It finds postings, ranks them against my profile, tailors a one-page resume and cover letter for each job, and tracks every application. I review and submit each application myself.

## What it does

- **Discovery:** Playwright scrapers pull listings from LinkedIn, ZipRecruiter and Glassdoor, then dedupe them across sources and score each one against the profile (titles, skills, location).
- **Tailoring:** Claude rewrites the resume and drafts a cover letter for a chosen job. A fit loop measures the rendered page and condenses or refills until the resume is exactly one page. Output is DOCX and PDF.
- **Tracking:** a React dashboard shows ranked jobs, resume versions with a compare view, applications and their status, and a profile editor.
- **Assistant:** a chat page that can explain a posting or update profile fields.

## How it is built

```
web/     React + TypeScript + Vite dashboard, hosted on Firebase Hosting
worker/  Node process on my Mac: scrapers, ranking, Claude calls, DOCX/PDF generation
```

The dashboard and the worker never talk directly. The dashboard writes task documents to Firestore (`users/{uid}/tasks`), and the worker picks them up, runs them and writes results back. Firestore rules keep every user's data under `users/{uid}/**`, readable only by that user. The worker never opens a port.

Stack: React 18, TypeScript, Vite, Firebase (Auth, Firestore, Hosting), Node.js, Playwright, Claude (via the `claude` CLI), `docx`, `mammoth`, `pdf-parse`.

## Running it

1. `cd web && npm install`, then create `web/.env.local` with `VITE_FIREBASE_API_KEY=<your Firebase web key>`, then `npm run dev`.
2. `cd worker && npm install`, then put a Firebase service-account key at `~/.applyer/sa.json` (chmod 600) and run `node index.js`. See `worker/README.md` for accounts and the launchd job.
3. The browser test scripts in `worker/scripts/clicktest/` read `FIREBASE_WEB_KEY`, `MEMBER1_UID` and `MEMBER2_UID` from the environment.

No keys or account IDs are committed to this repo.

## Notes

- Indeed blocks automated sessions, so it is not a source. Glassdoor listing pages are behind a bot wall, so Glassdoor jobs come without descriptions.
- An experimental auto-submit agent exists in `worker/apply/`, but it is not used: submitting is done by hand.
