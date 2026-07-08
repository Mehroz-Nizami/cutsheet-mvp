// db.js — Postgres persistence layer (Neon-compatible) using node-postgres (`pg`).
// Same shape as DispatchAI/RoastRadar's db.js: SQLite-style `?` placeholders translated
// to Postgres `$1, $2, ...`, so the app itself holds no state and runs on any free host.
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set. Set it to your Neon connection string.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
      ? { rejectUnauthorized: false }
      : false,
});

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const db = {
  async all(sql, params = []) {
    const { rows } = await pool.query(toPg(sql), params);
    return rows;
  },
  async get(sql, params = []) {
    const { rows } = await pool.query(toPg(sql), params);
    return rows[0];
  },
  async run(sql, params = []) {
    const res = await pool.query(toPg(sql), params);
    return { rowCount: res.rowCount, rows: res.rows };
  },
};

// ---- Seed data: a freelance video editor's demo book of business ----
const SEED_CLIENTS = [
  { id: 'c1', name: 'Priya Anand', company: 'Northlight Films', email: 'priya@northlightfilms.com' },
  { id: 'c2', name: 'Jordan Meyer', company: 'Meyer & Co. Marketing', email: 'jordan@meyerco.com' },
  { id: 'c3', name: 'Sasha Okafor', company: 'Okafor Studio', email: 'sasha@okaforstudio.com' },
];

const SEED_PROJECTS = [
  { id: 'p1', client_id: 'c1', title: 'Documentary rough cut — "Riverline"', billing_type: 'hourly', rate: 85, status: 'active' },
  { id: 'p2', client_id: 'c1', title: 'Trailer edit', billing_type: 'flat', rate: 1200, status: 'completed' },
  { id: 'p3', client_id: 'c2', title: 'Q3 brand campaign — social cutdowns', billing_type: 'hourly', rate: 75, status: 'active' },
  { id: 'p4', client_id: 'c3', title: 'Wedding highlight reel', billing_type: 'flat', rate: 900, status: 'completed' },
];

// Line items: some already attached to an invoice (billed), some still unbilled.
// invoice_id is filled in after invoices are created below.
const SEED_LINE_ITEMS = [
  { id: 'li1', project_id: 'p1', description: 'Assembly edit, reels 1-4', hours: 6, amount: 510, date: '2026-06-02' },
  { id: 'li2', project_id: 'p1', description: 'Color pass, act 1', hours: 4, amount: 340, date: '2026-06-05' },
  { id: 'li3', project_id: 'p1', description: 'Sound mix, act 1', hours: 3, amount: 255, date: '2026-06-09' },
  { id: 'li4', project_id: 'p2', description: 'Trailer edit — flat fee', hours: null, amount: 1200, date: '2026-05-20' },
  { id: 'li5', project_id: 'p3', description: 'Instagram cutdowns (x6)', hours: 5, amount: 375, date: '2026-06-15' },
  { id: 'li6', project_id: 'p3', description: 'Revisions round 1', hours: 2, amount: 150, date: '2026-06-20' },
  { id: 'li7', project_id: 'p4', description: 'Wedding highlight reel — flat fee', hours: null, amount: 900, date: '2026-06-01' },
];

async function reseed() {
  await db.run('DELETE FROM line_items');
  await db.run('DELETE FROM invoices');
  await db.run('DELETE FROM projects');
  await db.run('DELETE FROM clients');

  for (const c of SEED_CLIENTS) {
    await db.run('INSERT INTO clients (id, name, company, email) VALUES (?, ?, ?, ?)', [
      c.id, c.name, c.company, c.email,
    ]);
  }
  for (const p of SEED_PROJECTS) {
    await db.run(
      'INSERT INTO projects (id, client_id, title, billing_type, rate, status) VALUES (?, ?, ?, ?, ?, ?)',
      [p.id, p.client_id, p.title, p.billing_type, p.rate, p.status]
    );
  }
  for (const li of SEED_LINE_ITEMS) {
    await db.run(
      'INSERT INTO line_items (id, project_id, description, hours, amount, date) VALUES (?, ?, ?, ?, ?, ?)',
      [li.id, li.project_id, li.description, li.hours, li.amount, li.date]
    );
  }

  // One invoice already sent (Northlight, li1+li2), one already paid (Okafor, li7).
  await db.run(
    `INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date) VALUES (?, ?, ?, ?, ?, ?)`,
    ['inv1', 'c1', 'CS-1001', 'sent', '2026-06-10', '2026-06-24']
  );
  await db.run('UPDATE line_items SET invoice_id = ? WHERE id IN (?, ?)', ['inv1', 'li1', 'li2']);

  await db.run(
    `INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date) VALUES (?, ?, ?, ?, ?, ?)`,
    ['inv2', 'c3', 'CS-1002', 'paid', '2026-06-03', '2026-06-17']
  );
  await db.run('UPDATE line_items SET invoice_id = ? WHERE id = ?', ['inv2', 'li7']);
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id),
      title TEXT NOT NULL,
      billing_type TEXT NOT NULL DEFAULT 'hourly', -- hourly | flat
      rate NUMERIC NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', -- active | completed
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id),
      invoice_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', -- draft | sent | paid
      issue_date DATE NOT NULL,
      due_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS line_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      description TEXT NOT NULL,
      hours NUMERIC, -- null for flat-fee entries
      amount NUMERIC NOT NULL,
      date DATE NOT NULL,
      invoice_id TEXT REFERENCES invoices(id), -- null = unbilled
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const { c } = await db.get('SELECT COUNT(*)::int AS c FROM clients');
  if (c === 0) await reseed();
}

module.exports = { db, reseed, init };
