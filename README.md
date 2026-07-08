# CutSheet MVP

Client and project billing hub for freelance video editors. Real backend — data persists across restarts, login-gated, invoice math runs server-side.

## What this is (and isn't)

This is a working MVP, not a finished commercial product: single shared editor login (not multi-user/multi-tenant), one demo editor's book of business (not multiple freelancer accounts), and invoices are tracked to draft/sent/paid but nothing actually sends an email or processes a payment. That's a deliberate scope cut, not an oversight — the hard part worth proving here is the billing logic (hourly vs. flat-fee line items, unbilled-work tracking, invoice status transitions, guard rails against double-billing or deleting billed work), not email delivery or payment processing. Turning this into a sellable product would mean adding: multi-tenancy (one account per editor), real email delivery (invoice-sent notifications, reminders), a payment link (Stripe Checkout or similar) instead of a manual "mark as paid" button, and PDF export of invoices.

## Requirements

- Node.js 18 or newer.
- A Postgres database. Locally this can be any Postgres instance; in production it's a free [Neon](https://neon.tech) project (see Deploying, below).

## Run it locally

Easiest path — no separate Postgres install needed:

```bash
cd cutsheet-mvp
npm install
npm run demo
```

This spins up a local Postgres instance for you (stored in `.pgdata/`, gitignored) and starts the server against it. Data persists between runs — stop it with Ctrl+C and `npm run demo` again picks up where you left off.

If you already have your own Postgres running:

```bash
cd cutsheet-mvp
npm install
DATABASE_URL="postgresql://user:password@localhost:5432/cutsheet" npm start
```

Either way, then open **http://localhost:3000** in a browser. You'll be redirected to a login page.

- **Password:** `editor2026` (default — change it by setting the `CUTSHEET_PASSWORD` environment variable before starting the server, e.g. `CUTSHEET_PASSWORD=yourpassword npm start`)

Tables are created automatically on first run and seeded with 3 clients, 4 projects (a mix of hourly and flat-fee), 7 logged line items, and 2 invoices (one sent, one paid). Use the **Reset demo data** button in the app to wipe and reseed at any time — useful before a live demo.

## How billing works

- **Clients** are the people/companies you invoice. **Projects** belong to a client and are either **hourly** (has a $/hr rate) or **flat fee** (has a fixed price).
- **Log work** against a project to create a line item. On hourly projects you enter hours and the amount is computed server-side (hours × the project's rate at the time of entry — later rate changes don't retroactively change past line items, matching how real billing works). On flat-fee projects you enter the dollar amount directly.
- Line items start **unbilled**. **Build invoice** picks a client, shows their unbilled work, and lets you select which items go on the invoice — you don't have to bill everything at once.
- Invoices move **draft → sent → paid**. Draft invoices can be deleted (their line items go back to unbilled); sent/paid invoices can't, since by then they represent a real commitment to the client. A sent invoice past its due date shows as **overdue** on the dashboard.
- The dashboard bar (outstanding, overdue, paid, unbilled) is computed from real invoice and line-item totals, not mocked numbers.

## What's real vs. simulated

| Piece | Status |
|---|---|
| Clients, projects, line items, invoices | Real — persisted in Postgres, survives server restarts and redeploys |
| Login gate | Real — server-side session, not just a client-side check |
| Invoice math (line item amounts, invoice totals, dashboard stats) | Real, computed server-side from stored data |
| Invoice status rules (draft→sent→paid, delete guard rails) | Real, enforced server-side — not just UI-level restrictions |
| Emailing invoices, payment processing | Not built — out of scope for this MVP; "sent"/"paid" are manually marked |
| PDF export | Not built — invoice detail is viewable in-app only |
| Multi-tenancy (multiple editors using it) | Not built — this is single-editor, single-login |

## Deploying (GitHub + Neon + Render, all free) — same recipe as DispatchAI/RoastRadar/A11yScan

This one follows the exact pattern already live for the other three portfolio pieces. None of these steps can be done on your behalf — repo creation and pasting secrets into dashboards both require your own accounts and hands.

1. **Push this folder to GitHub.** The repo already exists (empty) at **https://github.com/Mehroz-Nizami/cutsheet-mvp** — Render's Blueprint import (next step) reads from GitHub, not local disk. From a terminal in this folder:
   ```bash
   git init
   git add .
   git commit -m "CutSheet MVP"
   git branch -M main
   git remote add origin https://github.com/Mehroz-Nizami/cutsheet-mvp.git
   git push -u origin main
   ```
   If `git push` prompts for credentials, use a GitHub personal access token as the password (Settings → Developer settings → Personal access tokens) rather than your account password — GitHub stopped accepting account passwords for this a while ago.
2. **Neon:** create an account, create a project (e.g. `cutsheet`), copy the connection string it gives you (starts with `postgresql://`, includes `?sslmode=require`).
3. **Render:** create an account, New → Blueprint, point it at the GitHub repo from step 1 — it reads `render.yaml` in this folder and sets up the service automatically. When prompted, paste in:
   - `DATABASE_URL` = the Neon connection string from step 2
   - `CUTSHEET_PASSWORD` = a real password (don't ship with `editor2026`)
   - `SESSION_SECRET` is auto-generated by the blueprint — nothing to do there.
4. Render sets `PORT` automatically — the app already reads `process.env.PORT`.
5. Render gives you a public `onrender.com` URL on first deploy. That's what you share with a prospect or the BD partner — and what gets added to `portfolio-hub/index.html` alongside DispatchAI, RoastRadar, and A11yScan.

One thing to know going in: Render's free tier spins the app down after 15 minutes idle, and the next request takes about a minute to wake it back up. Fine for an unscheduled demo link; hit the URL yourself a minute before a live call so it's already warm.

## Project structure

```
cutsheet-mvp/
├── server.js       — Express app, routes, session/auth, invoice business logic
├── db.js           — Postgres schema, seed data, get/all/run helpers
├── demo.js         — `npm run demo` entry point: local Postgres + server, no setup needed
├── render.yaml      — Render Blueprint (reads this automatically on New → Blueprint)
├── test/run.js      — end-to-end smoke test against a real (embedded) Postgres instance
├── public/
│   ├── login.html
│   ├── index.html
│   └── app.js       — frontend, calls the real API via fetch
└── package.json
```
