# Applyer worker

Node process that watches Firestore `users/{uid}/tasks` for queued tasks and
runs resume parsing, LLM calls (via `claude -p`), and DOCX generation. Never
opens a port; all communication is Firestore documents.

## Install

```
cd worker
npm install
```

Requires the service account key at `~/.applyer/sa.json` (chmod 600), or set
`APPLYER_SA=/path/to/sa.json`. Requires the `claude` CLI on PATH and logged
in to the Max plan (no API key used).

## Create user accounts

No signup UI. Accounts are created with:

```
node scripts/create-users.mjs a@example.com b@example.com
```

Prints `email  password` once per new user (save it, it is not shown again).
An email that already has an account prints `email  exists`. Also seeds
`users/{uid}` and an empty `users/{uid}/profile/profile` doc.

## Run

For development, run directly:

```
node index.js
```

For always-on operation, load the launchd job:

```
cp launchd/com.applyer.worker.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.applyer.worker.plist
```

Unload with:

```
launchctl unload ~/Library/LaunchAgents/com.applyer.worker.plist
```

## Logs

```
tail -f ~/.applyer/worker.log
```

## Tests

```
npm test
```

Runs `node --test test/`. No jest/vitest. Tests build a real DOCX in-memory,
round-trip it through the parser, and check `parseLlmJson`. They do not call
the real `claude` CLI.
