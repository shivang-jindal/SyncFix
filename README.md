# SyncFix

> **Monitored Data Synchronization & Repair for Small Teams**

[![CI](https://github.com/shivang-jindal/SyncFix/actions/workflows/ci.yml/badge.svg)](https://github.com/shivang-jindal/SyncFix/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61dafb)](https://react.dev/)
[![Express](https://img.shields.io/badge/Express-4-lightgrey)](https://expressjs.com/)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle-ORM-brightgreen)](https://orm.drizzle.team/)

---

## Features

- **One-Way Sync**: Source → Destination with field mapping
- **Transforms**: 17 transform types (trim, concat, hash, template, etc.)
- **Dry-Run Preview**: See changes before committing
- **Idempotent Writes**: Per-record keys, safe retries
- **Conflict Policies**: Source wins / destination wins / latest / manual
- **Checkpoint Resume**: Crash-safe, resumable runs
- **Per-Record Repair**: Retry / replay / skip / resolve
- **Schema Drift Detection**: Unknown fields surfaced as issues
- **29 Tests**: Connection, sync job, run engine, repair (all passing)

---

## Quick Start

```bash
git clone https://github.com/shivang-jindal/SyncFix.git
cd SyncFix
npm install
npm run dev
```

Configure `.env` (copy `.env.example`):
```env
PGLITE_DATA_DIR=".data/pgdata"      # or set DATABASE_URL for PostgreSQL
ENCRYPTION_KEY="64-char-hex-key"    # required before credentials can be stored
EMAIL_PROVIDER="disabled"           # disabled | log | smtp
```

### Local demo (optional)

`npm run db:seed` creates a demo workspace, one source and one destination connection, and a
paused sync job. To watch a real sync locally, run the fixture source and allow loopback in
development:

```bash
# terminal 1: API + worker + web
npm run dev

# terminal 2: the fixture source/destination on http://127.0.0.1:8080
npm run demo:source

# .env - development only; the loader refuses to start with it in production
SSRF_ALLOW_HOSTS=127.0.0.1
```

Sign in as `demo@syncfix.test` / `syncfix-demo-1234`, open **Sync jobs**, enable the seeded job,
then choose **Run now**. The fixture also exposes `/flaky` (always 503) and `/slow` (never
answers) so failure handling can be exercised on purpose.

---

## Architecture

```
SyncFix/
├── client/          # React 18 + Vite 6 + Tailwind v4
├── server/          # Express 4 + Drizzle ORM + PGlite
├── shared/          # Shared types, Zod schemas, transforms
└── scripts/         # Dev, migration, verification
```

**Stack**: React 18 · Vite 6 · TypeScript · Tailwind v4 · React Router · TanStack Query  
**Backend**: Express 4 · Zod · Drizzle ORM · PGlite (embedded PostgreSQL)  
**Auth**: Argon2id · opaque 256-bit tokens · HTTP-only cookies  
**Transforms**: 17 types (trim, concat, hash, template, JSON parse/stringify, etc.)  
**Jobs**: DB-backed queue (`FOR UPDATE SKIP LOCKED`) · separate worker

---

## Configuration

All settings via environment variables (see `.env.example`):

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | No | PostgreSQL URL (omit for PGlite) |
| `ENCRYPTION_KEY` | Yes | 64-char hex (32 bytes) |
| `SESSION_COOKIE_NAME` | No | Session cookie name (default `syncfix_session`) |
| `EMAIL_PROVIDER` | No | `smtp` \| `disabled` \| `log` |
| `FIREBASE_PROJECT_ID` | For Google sign-in | Firebase project id used to verify Google ID tokens |
| `VITE_FIREBASE_*` | For Google sign-in | Public Firebase web config read by the browser |
| `OUTBOUND_ALLOWED_PORTS` | No | Ports connectors may reach (default `80,443,8080,8443`) |
| `SSRF_ALLOW_HOSTS` | No | Development only; loopback hosts for the local fixture |

### Google sign-in

Google sign-in uses Firebase Authentication in the browser and verifies the
resulting ID token on the server against Google's published keys. No service
account or client secret is stored.

1. In the Firebase console, create a project and enable **Authentication -> Sign-in method -> Google**.
2. Add a web app, then put its public configuration in the repository `.env` (one root file, read by both the client and the server):

   ```bash
   VITE_FIREBASE_API_KEY=...
   VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your-project
   VITE_FIREBASE_APP_ID=...
   FIREBASE_PROJECT_ID=your-project
   ```

3. Add `http://localhost:5173` and your production origin to **Authentication -> Settings -> Authorized domains**.

With no Firebase values the button is rendered disabled with a clear note, and the
API refuses Google sign-in; email and password sign-in keeps working.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev servers (client + server) |
| `npm run build` | Production build |
| `npm run verify` | Typecheck + Lint + Test + Build |
| `npm test` | Unit/integration tests (29 passing, 2 skipped) |
| `npm run db:generate` | Generate Drizzle migrations |
| `npm run db:migrate` | Run migrations |
| `npm run smoke` | Smoke test against running instance |

---

## Deployment

```bash
npm run build
# Deploy server/ + client/dist/ to your platform
```

Requires: Node 20+, PostgreSQL (or PGlite for embedded).

---

## License

MIT License - see [LICENSE](LICENSE)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) • [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) • [SECURITY.md](SECURITY.md)