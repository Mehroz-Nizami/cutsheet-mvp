const express = require('express');
const session = require('express-session');
const path = require('path');
const { db, reseed, init } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const CUTSHEET_PASSWORD = process.env.CUTSHEET_PASSWORD || 'editor2026';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';

app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 },
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// Wraps async route handlers so rejected promises reach Express's error handler.
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function newId(prefix) {
  return prefix + Date.now() + Math.floor(Math.random() * 1000);
}

// ---- Auth routes ----
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password === CUTSHEET_PASSWORD) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Incorrect password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ authed: !!(req.session && req.session.authed) });
});

// ---- Client routes ----
app.get('/api/clients', requireAuth, ah(async (req, res) => {
  res.json(await db.all('SELECT * FROM clients ORDER BY name'));
}));

app.post('/api/clients', requireAuth, ah(async (req, res) => {
  const { name, company, email } = req.body || {};
  if (!name || !company || !email) {
    return res.status(400).json({ error: 'name, company, and email are required' });
  }
  const id = newId('c');
  await db.run('INSERT INTO clients (id, name, company, email) VALUES (?, ?, ?, ?)', [id, name, company, email]);
  res.json(await db.get('SELECT * FROM clients WHERE id = ?', [id]));
}));

app.patch('/api/clients/:id', requireAuth, ah(async (req, res) => {
  const client = await db.get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { name, company, email } = req.body || {};
  await db.run('UPDATE clients SET name = ?, company = ?, email = ? WHERE id = ?', [
    name ?? client.name,
    company ?? client.company,
    email ?? client.email,
    req.params.id,
  ]);
  res.json(await db.get('SELECT * FROM clients WHERE id = ?', [req.params.id]));
}));

app.delete('/api/clients/:id', requireAuth, ah(async (req, res) => {
  const client = await db.get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { c: projectCount } = await db.get('SELECT COUNT(*)::int AS c FROM projects WHERE client_id = ?', [req.params.id]);
  if (projectCount > 0) {
    return res.status(400).json({ error: `Remove ${projectCount} project(s) for ${client.name} before deleting this client.` });
  }
  await db.run('DELETE FROM clients WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ---- Project routes ----
app.get('/api/projects', requireAuth, ah(async (req, res) => {
  if (req.query.client_id) {
    return res.json(await db.all('SELECT * FROM projects WHERE client_id = ? ORDER BY created_at DESC', [req.query.client_id]));
  }
  res.json(await db.all('SELECT * FROM projects ORDER BY created_at DESC'));
}));

app.post('/api/projects', requireAuth, ah(async (req, res) => {
  const { client_id, title, billing_type, rate, status } = req.body || {};
  if (!client_id || !title || !billing_type || rate === undefined || rate === null || rate === '') {
    return res.status(400).json({ error: 'client_id, title, billing_type, and rate are required' });
  }
  if (!['hourly', 'flat'].includes(billing_type)) {
    return res.status(400).json({ error: 'billing_type must be "hourly" or "flat"' });
  }
  const client = await db.get('SELECT * FROM clients WHERE id = ?', [client_id]);
  if (!client) return res.status(400).json({ error: 'Unknown client' });
  const id = newId('p');
  await db.run(
    'INSERT INTO projects (id, client_id, title, billing_type, rate, status) VALUES (?, ?, ?, ?, ?, ?)',
    [id, client_id, title, billing_type, rate, status || 'active']
  );
  res.json(await db.get('SELECT * FROM projects WHERE id = ?', [id]));
}));

app.patch('/api/projects/:id', requireAuth, ah(async (req, res) => {
  const project = await db.get('SELECT * FROM projects WHERE id = ?', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const { title, billing_type, rate, status } = req.body || {};
  if (billing_type && !['hourly', 'flat'].includes(billing_type)) {
    return res.status(400).json({ error: 'billing_type must be "hourly" or "flat"' });
  }
  await db.run('UPDATE projects SET title = ?, billing_type = ?, rate = ?, status = ? WHERE id = ?', [
    title ?? project.title,
    billing_type ?? project.billing_type,
    rate ?? project.rate,
    status ?? project.status,
    req.params.id,
  ]);
  res.json(await db.get('SELECT * FROM projects WHERE id = ?', [req.params.id]));
}));

app.delete('/api/projects/:id', requireAuth, ah(async (req, res) => {
  const project = await db.get('SELECT * FROM projects WHERE id = ?', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const { c: lineItemCount } = await db.get('SELECT COUNT(*)::int AS c FROM line_items WHERE project_id = ?', [req.params.id]);
  if (lineItemCount > 0) {
    return res.status(400).json({ error: `Remove ${lineItemCount} line item(s) on this project before deleting it.` });
  }
  await db.run('DELETE FROM projects WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ---- Line item routes ----
// Billable work logged against a project. Unbilled = not yet attached to an invoice.
app.get('/api/line-items', requireAuth, ah(async (req, res) => {
  let sql = 'SELECT * FROM line_items';
  const params = [];
  const clauses = [];
  if (req.query.project_id) {
    clauses.push('project_id = ?');
    params.push(req.query.project_id);
  }
  if (req.query.client_id) {
    clauses.push('project_id IN (SELECT id FROM projects WHERE client_id = ?)');
    params.push(req.query.client_id);
  }
  if (req.query.unbilled === 'true') {
    clauses.push('invoice_id IS NULL');
  }
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY date DESC';
  res.json(await db.all(sql, params));
}));

app.post('/api/line-items', requireAuth, ah(async (req, res) => {
  const { project_id, description, hours, amount, date } = req.body || {};
  if (!project_id || !description || !date) {
    return res.status(400).json({ error: 'project_id, description, and date are required' });
  }
  const project = await db.get('SELECT * FROM projects WHERE id = ?', [project_id]);
  if (!project) return res.status(400).json({ error: 'Unknown project' });

  let finalAmount = amount;
  let finalHours = hours || null;
  if (project.billing_type === 'hourly') {
    if (!hours || hours <= 0) return res.status(400).json({ error: 'hours is required for hourly projects' });
    finalAmount = Math.round(hours * project.rate * 100) / 100;
  } else {
    if (!amount || amount <= 0) return res.status(400).json({ error: 'amount is required for flat-fee projects' });
    finalHours = null;
  }

  const id = newId('li');
  await db.run(
    'INSERT INTO line_items (id, project_id, description, hours, amount, date) VALUES (?, ?, ?, ?, ?, ?)',
    [id, project_id, description, finalHours, finalAmount, date]
  );
  res.json(await db.get('SELECT * FROM line_items WHERE id = ?', [id]));
}));

app.delete('/api/line-items/:id', requireAuth, ah(async (req, res) => {
  const li = await db.get('SELECT * FROM line_items WHERE id = ?', [req.params.id]);
  if (!li) return res.status(404).json({ error: 'Line item not found' });
  if (li.invoice_id) return res.status(400).json({ error: 'Cannot delete a line item that has already been invoiced.' });
  await db.run('DELETE FROM line_items WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ---- Invoice routes ----
app.get('/api/invoices', requireAuth, ah(async (req, res) => {
  const invoices = await db.all(`
    SELECT i.*, c.name AS client_name, c.company AS client_company,
           COALESCE(SUM(li.amount), 0) AS total
    FROM invoices i
    JOIN clients c ON c.id = i.client_id
    LEFT JOIN line_items li ON li.invoice_id = i.id
    GROUP BY i.id, c.name, c.company
    ORDER BY i.issue_date DESC
  `);
  res.json(invoices);
}));

app.get('/api/invoices/:id', requireAuth, ah(async (req, res) => {
  const invoice = await db.get(`
    SELECT i.*, c.name AS client_name, c.company AS client_company, c.email AS client_email
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.id = ?
  `, [req.params.id]);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const lineItems = await db.all('SELECT * FROM line_items WHERE invoice_id = ? ORDER BY date', [req.params.id]);
  res.json({ ...invoice, line_items: lineItems });
}));

app.post('/api/invoices', requireAuth, ah(async (req, res) => {
  const { client_id, line_item_ids } = req.body || {};
  if (!client_id || !Array.isArray(line_item_ids) || line_item_ids.length === 0) {
    return res.status(400).json({ error: 'client_id and at least one line_item_id are required' });
  }
  const client = await db.get('SELECT * FROM clients WHERE id = ?', [client_id]);
  if (!client) return res.status(400).json({ error: 'Unknown client' });

  // Every line item must be unbilled and belong to a project owned by this client.
  for (const liId of line_item_ids) {
    const li = await db.get(`
      SELECT li.* FROM line_items li JOIN projects p ON p.id = li.project_id
      WHERE li.id = ? AND p.client_id = ?
    `, [liId, client_id]);
    if (!li) return res.status(400).json({ error: `Line item ${liId} doesn't belong to this client.` });
    if (li.invoice_id) return res.status(400).json({ error: `Line item ${liId} is already on another invoice.` });
  }

  const { c: invoiceCount } = await db.get('SELECT COUNT(*)::int AS c FROM invoices');
  const invoiceNumber = `CS-${1001 + invoiceCount}`;
  const issueDate = new Date();
  const dueDate = new Date(issueDate.getTime() + 14 * 24 * 60 * 60 * 1000);
  const id = newId('inv');

  await db.run(
    'INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date) VALUES (?, ?, ?, ?, ?, ?)',
    [id, client_id, invoiceNumber, 'draft', issueDate.toISOString().slice(0, 10), dueDate.toISOString().slice(0, 10)]
  );
  for (const liId of line_item_ids) {
    await db.run('UPDATE line_items SET invoice_id = ? WHERE id = ?', [id, liId]);
  }
  res.json(await db.get('SELECT * FROM invoices WHERE id = ?', [id]));
}));

app.patch('/api/invoices/:id/status', requireAuth, ah(async (req, res) => {
  const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const { status } = req.body || {};
  const validTransitions = { draft: ['sent'], sent: ['paid', 'draft'], paid: [] };
  if (!validTransitions[invoice.status]?.includes(status)) {
    return res.status(400).json({ error: `Cannot move invoice from "${invoice.status}" to "${status}".` });
  }
  await db.run('UPDATE invoices SET status = ? WHERE id = ?', [status, req.params.id]);
  res.json(await db.get('SELECT * FROM invoices WHERE id = ?', [req.params.id]));
}));

app.delete('/api/invoices/:id', requireAuth, ah(async (req, res) => {
  const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status !== 'draft') return res.status(400).json({ error: 'Only draft invoices can be deleted.' });
  await db.run('UPDATE line_items SET invoice_id = NULL WHERE invoice_id = ?', [req.params.id]);
  await db.run('DELETE FROM invoices WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/reset', requireAuth, ah(async (req, res) => {
  await reseed();
  res.json({ ok: true });
}));

// ---- Static frontend ----
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  if (!(req.session && req.session.authed)) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Error handler ----
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  await init();
  app.listen(PORT, () => {
    console.log(`CutSheet MVP running at http://localhost:${PORT}`);
    console.log(`Login password: ${CUTSHEET_PASSWORD} (set CUTSHEET_PASSWORD env var to change)`);
  });
}

start().catch((err) => {
  console.error('Failed to start (check DATABASE_URL):', err);
  process.exit(1);
});
