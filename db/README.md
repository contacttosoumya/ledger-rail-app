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

## Project structure

```
rollcall-ops/
  server.js           # Express API + serves the frontend
  db/schema.sql        # PostgreSQL table definitions
  scripts/setup-db.js  # Runs schema.sql against DATABASE_URL
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