// One-shot end-to-end smoke test: starts embedded Postgres, boots the real server,
// exercises the API like a browser would, and asserts on the responses.
const EmbeddedPostgres = require('embedded-postgres').default;

const pg = new EmbeddedPostgres({
  databaseDir: '/tmp/cutsheet-pgdata-2',
  user: 'testuser',
  password: 'testpass',
  port: 5434,
  persistent: false,
});

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error('FAIL:', msg);
  } else {
    console.log('ok  :', msg);
  }
}

async function main() {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('cutsheet');

  process.env.DATABASE_URL = 'postgresql://testuser:testpass@localhost:5434/cutsheet';
  process.env.PORT = '3900';
  process.env.CUTSHEET_PASSWORD = 'editor2026';

  require('../server.js');
  await new Promise((r) => setTimeout(r, 1500)); // let init()/listen settle

  const base = 'http://localhost:3900';
  let cookie = '';
  async function api(path, opts = {}) {
    const res = await fetch(base + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(opts.headers || {}) },
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }

  // ---- Auth ----
  let r = await api('/api/session');
  assert(r.data.authed === false, 'unauthenticated session reports authed:false');

  r = await api('/api/clients');
  assert(r.status === 401, 'clients route blocked before login (401)');

  r = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
  assert(r.status === 401, 'wrong password rejected');

  r = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: 'editor2026' }) });
  assert(r.status === 200 && r.data.ok, 'correct password logs in');

  // ---- Seeded data sanity ----
  r = await api('/api/clients');
  assert(r.status === 200 && r.data.length === 3, `seeded 3 clients (got ${r.data.length})`);

  r = await api('/api/projects');
  assert(r.data.length === 4, `seeded 4 projects (got ${r.data.length})`);

  r = await api('/api/invoices');
  const seededInvoices = r.data;
  assert(seededInvoices.length === 2, `seeded 2 invoices (got ${seededInvoices.length})`);
  const inv1 = seededInvoices.find((i) => i.invoice_number === 'CS-1001');
  assert(inv1 && Number(inv1.total) === 850, `CS-1001 total is 510+340=850 (got ${inv1 && inv1.total})`);
  assert(inv1.status === 'sent', 'CS-1001 is sent');
  const inv2 = seededInvoices.find((i) => i.invoice_number === 'CS-1002');
  assert(inv2 && Number(inv2.total) === 900, `CS-1002 total is 900 (got ${inv2 && inv2.total})`);
  assert(inv2.status === 'paid', 'CS-1002 is paid');

  // ---- Create a new client + project ----
  r = await api('/api/clients', { method: 'POST', body: JSON.stringify({ name: 'Test Client', company: 'Test Co', email: 't@test.com' }) });
  assert(r.status === 200, 'create client succeeds');
  const newClientId = r.data.id;

  r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ client_id: newClientId, title: 'Hourly test project', billing_type: 'hourly', rate: 100 }) });
  assert(r.status === 200, 'create hourly project succeeds');
  const hourlyProjectId = r.data.id;

  r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ client_id: newClientId, title: 'Flat test project', billing_type: 'flat', rate: 500 }) });
  const flatProjectId = r.data.id;

  // ---- Log work: hourly amount should be computed server-side (hours * rate) ----
  r = await api('/api/line-items', { method: 'POST', body: JSON.stringify({ project_id: hourlyProjectId, description: '2 hours of editing', hours: 2, date: '2026-07-01' }) });
  assert(r.status === 200 && Number(r.data.amount) === 200, `hourly line item amount = 2*100 = 200 (got ${r.data.amount})`);

  r = await api('/api/line-items', { method: 'POST', body: JSON.stringify({ project_id: flatProjectId, description: 'flat fee work', amount: 500, date: '2026-07-01' }) });
  assert(r.status === 200 && Number(r.data.amount) === 500, `flat line item amount = 500 (got ${r.data.amount})`);

  r = await api('/api/line-items', { method: 'POST', body: JSON.stringify({ project_id: hourlyProjectId, description: 'missing hours', date: '2026-07-01' }) });
  assert(r.status === 400, 'hourly line item without hours is rejected');

  // ---- Build invoice from unbilled items ----
  r = await api(`/api/line-items?client_id=${newClientId}&unbilled=true`);
  assert(r.data.length === 2, `2 unbilled line items for new client (got ${r.data.length})`);
  const liIds = r.data.map((li) => li.id);

  r = await api('/api/invoices', { method: 'POST', body: JSON.stringify({ client_id: newClientId, line_item_ids: liIds }) });
  assert(r.status === 200, 'invoice creation succeeds');
  const newInvoiceId = r.data.id;
  assert(r.data.invoice_number === 'CS-1003', `next invoice number is CS-1003 (got ${r.data.invoice_number})`);

  r = await api(`/api/line-items?client_id=${newClientId}&unbilled=true`);
  assert(r.data.length === 0, 'line items no longer unbilled after invoicing');

  r = await api('/api/invoices', { method: 'POST', body: JSON.stringify({ client_id: newClientId, line_item_ids: liIds }) });
  assert(r.status === 400, 'cannot invoice already-billed line items twice');

  // ---- Status transitions ----
  r = await api(`/api/invoices/${newInvoiceId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'paid' }) });
  assert(r.status === 400, 'cannot jump draft -> paid directly');

  r = await api(`/api/invoices/${newInvoiceId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'sent' }) });
  assert(r.status === 200 && r.data.status === 'sent', 'draft -> sent transition works');

  r = await api(`/api/invoices/${newInvoiceId}`, { method: 'DELETE' });
  assert(r.status === 400, 'cannot delete a non-draft invoice');

  r = await api(`/api/invoices/${newInvoiceId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'paid' }) });
  assert(r.status === 200 && r.data.status === 'paid', 'sent -> paid transition works');

  // ---- Dashboard math check (server side totals) ----
  r = await api('/api/invoices');
  const all = r.data;
  const stillOutstanding = all.filter((i) => i.status === 'sent');
  assert(stillOutstanding.length === 1 && stillOutstanding[0].invoice_number === 'CS-1001', 'CS-1001 remains the only sent/outstanding invoice');
  const paidTotal = all.filter((i) => i.status === 'paid').reduce((s, i) => s + Number(i.total), 0);
  assert(paidTotal === 900 + 700, `paid total = 900 (seed) + 700 (new) = 1600 (got ${paidTotal})`);

  // ---- Delete guard rails ----
  r = await api(`/api/clients/${newClientId}`, { method: 'DELETE' });
  assert(r.status === 400, 'cannot delete client with projects');

  r = await api(`/api/projects/${flatProjectId}`, { method: 'DELETE' });
  assert(r.status === 400, 'cannot delete project with (now billed) line items');

  // ---- Reset restores seed state ----
  r = await api('/api/reset', { method: 'POST' });
  assert(r.status === 200, 'reset succeeds');
  r = await api('/api/clients');
  assert(r.data.length === 3, 'reset restores 3 seeded clients');
  r = await api('/api/invoices');
  assert(r.data.length === 2, 'reset restores 2 seeded invoices');

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURE(S)`);
  await pg.stop();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST SCRIPT ERROR:', e);
  process.exit(1);
});
