# RollCall Ops

A restaurant accounting dashboard: daily sales, catering, events, menu costing,
and setup capital (partner contributions + loans/EMIs) — with an AI Insights
tab powered by Claude. Runs entirely on your machine, backed by PostgreSQL.

## Requirements

- Node.js 18 or later
- PostgreSQL 14+ (either installed locally, or via the included Docker Compose file)
- (Optional) An Anthropic API key, only needed for the "AI Insights" tab —
  get one at https://console.anthropic.com/settings/keys

## 1. Start PostgreSQL

**Option A — Docker (easiest):**
```bash
docker compose up -d db
```
This starts Postgres on `localhost:5432` with database `rollcall_ops`, user `postgres`, password `postgres`.

**Option B — Local PostgreSQL install:**
```bash
createdb rollcall_ops
```

## 2. Configure environment

```bash
cp .env.example .env
```
Edit `.env`:
- `DATABASE_URL` — connection string for your database (the default matches the Docker setup above)
- `ANTHROPIC_API_KEY` — only required if you want the AI Insights tab to work

## 3. Install dependencies and create the tables

```bash
npm install
npm run db:setup
```

## 4. Run it

```bash
npm start
```

Open **http://localhost:3000**

## 5. Set up daily backups (one-time)

`npm run db:backup` mirrors the primary database into a second, independent
database (by default, same server, name + `_backup`). It's a script you run —
the app itself never triggers it, on purpose: a backup that only happens
while the app is open isn't a real backup.

**Important limitation:** by default the backup lives on the *same* Postgres
server as the primary. That protects you from accidental data loss or a bad
migration, but not from that server's disk failing entirely — both databases
live on the same disk. For real disaster-recovery value, set `BACKUP_DATABASE_URL`
in `.env` to a database on a *different* host.

**Test it manually first:**
```bash
npm run db:backup
```

**Then schedule it to run every day at 3 AM** (macOS/Linux):
```bash
crontab -e
```
Add this line (adjust the path to wherever you cloned this project):
```
0 3 * * * cd /path/to/rollcall-ops && /usr/bin/npm run db:backup >> backup.log 2>&1
```
Save and exit. Confirm it's registered with `crontab -l`.

Check backup status any time under **Admin Panel → Backups** in the app —
it shows the real result of each run (success/failure, timestamp, and detail),
read directly from what the script actually did, not just whether cron itself is configured.

## 6. Syncing business data to Neon (optional)

If you're running a Neon Postgres database elsewhere (e.g. behind a Railway
deployment) and want to push your local business data up to it, **without**
disturbing whoever is already logged into that Neon-backed app:

```bash
NEON_DATABASE_URL="postgresql://...neon connection string..." CONFIRM_SYNC=yes npm run db:sync-neon
```

This is a one-way sync (local → Neon) that replaces business data (menu items,
sales, events, catalogs, etc.) on Neon with what's currently in your local
database. It deliberately **never touches** `users`, `roles`, `role_permissions`,
`user_menu_overrides`, `session`, or `activity_log` on the Neon side — existing
logins, permissions, and active sessions on Neon survive untouched.

`CONFIRM_SYNC=yes` is required on purpose, since this truncates business
tables on Neon before restoring — there's no undo once it runs. Leave it off
to see exactly what the script would do first.

## Project structure

```
rollcall-ops/
  server.js           # Express API + serves the frontend
  db/schema.sql        # PostgreSQL table definitions
  scripts/setup-db.js  # Runs schema.sql against DATABASE_URL
  scripts/backup-database.js  # Mirrors the primary DB into a second one — run via cron, see "Set up daily backups"
  scripts/sync-to-neon.js     # Pushes local business data to Neon, protecting login tables — see "Syncing business data to Neon"
  public/index.html    # Frontend (single page, no build step)
  .env.example
  docker-compose.yml    # Optional local Postgres
```

## What's in it

- **Overview** — combined revenue, cost, profit, and margin across every segment, with a chart and recent activity feed
- **Daily Sales** — per-day till entries with food/labor/overhead cost
- **Catering** — per-job tracking with client and guest count
- **Events** — per-event tracking with event type
- **Costing** — build a recipe/menu item, get cost-per-serving and a suggested price at your target food-cost %
- **Setup & Financing** — partners, their capital contributions (with an ownership-share chart), loans with auto-calculated EMI, and EMI payment tracking with a proper amortized outstanding balance
- **AI Insights** — sends your data to Claude (server-side, your API key never touches the browser) for a plain-language read on what's working, what's losing money, and what to do next; also supports free-form questions

## Notes

- All data lives in your own PostgreSQL database — nothing leaves your machine except the AI Insights requests (which go to Anthropic's API using your own key).
- This is a personal/single-user local tool: there's no authentication layer. Don't expose it to the public internet as-is.
- This isn't a replacement for a bookkeeper or accountant — treat it as your day-to-day operating dashboard.