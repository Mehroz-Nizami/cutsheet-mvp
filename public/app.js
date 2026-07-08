// app.js — talks to the real CutSheet backend (fetch + JSON), no in-memory-only state.
let clients = [];
let projects = [];
let invoices = [];
let unbilledAll = [];
let editingClientId = null;
let editingProjectId = null;
let activeLineItemProject = null;
let activeInvoiceId = null;
let inFlight = 0;

function setLoading(on) {
  inFlight += on ? 1 : -1;
  document.getElementById('loadingIndicator').classList.toggle('hidden', inFlight <= 0);
  document.getElementById('loadingIndicator').classList.toggle('flex', inFlight > 0);
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  const bg = type === 'error' ? 'bg-[#EF4444]' : 'bg-[#A77DFF]';
  const fg = type === 'error' ? 'text-white' : 'text-[#0D1117]';
  el.className = `toast ${bg} ${fg} text-sm px-4 py-2 rounded-md shadow-lg font-medium`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function money(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function api(path, options = {}) {
  setLoading(true);
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (res.status === 401) {
      window.location.href = '/login.html';
      throw new Error('Not authenticated');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Request failed');
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    setLoading(false);
  }
}

async function loadAll() {
  const [clientsRes, projectsRes, invoicesRes, unbilledRes] = await Promise.all([
    api('/api/clients'),
    api('/api/projects'),
    api('/api/invoices'),
    api('/api/line-items?unbilled=true'),
  ]);
  clients = clientsRes;
  projects = projectsRes;
  invoices = invoicesRes;
  unbilledAll = unbilledRes;
  render();
}

function render() {
  renderStats();
  renderClients();
  renderProjects();
  renderInvoices();
}

function renderStats() {
  const today = new Date().toISOString().slice(0, 10);
  const outstanding = invoices.filter((i) => i.status === 'sent').reduce((s, i) => s + Number(i.total), 0);
  const overdue = invoices.filter((i) => i.status === 'sent' && i.due_date < today).reduce((s, i) => s + Number(i.total), 0);
  const paid = invoices.filter((i) => i.status === 'paid').reduce((s, i) => s + Number(i.total), 0);
  const unbilled = unbilledAll.reduce((s, li) => s + Number(li.amount), 0);
  document.getElementById('statOutstanding').textContent = money(outstanding);
  document.getElementById('statOverdue').textContent = money(overdue);
  document.getElementById('statPaid').textContent = money(paid);
  document.getElementById('statUnbilled').textContent = money(unbilled);
}

function clientLabel(c) {
  return `${c.name} — ${c.company}`;
}

function renderClients() {
  const list = document.getElementById('clientList');
  const empty = document.getElementById('emptyClients');
  list.innerHTML = '';
  if (clients.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  clients.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'row-hover flex items-center justify-between py-1.5 px-1 rounded-md hover:bg-[#242B3D]';
    row.innerHTML = `
      <div>
        <div class="text-sm font-medium text-[#E9E6F5]">${c.name}</div>
        <div class="text-xs text-[#6B6685]">${c.company} · ${c.email}</div>
      </div>
      <div class="row-actions flex items-center gap-1">
        <button data-action="edit" class="icon-btn text-[#9B96B5]" title="Edit">&#9998;</button>
        <button data-action="delete" class="icon-btn text-[#9B96B5]" title="Delete">&#128465;</button>
      </div>
    `;
    row.querySelector('[data-action="edit"]').onclick = () => openClientForm(c);
    row.querySelector('[data-action="delete"]').onclick = () => deleteClient(c);
    list.appendChild(row);
  });
}

function renderProjects() {
  const list = document.getElementById('projectList');
  const empty = document.getElementById('emptyProjects');
  list.innerHTML = '';
  if (projects.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  projects.forEach((p) => {
    const client = clients.find((c) => c.id === p.client_id);
    const rateLabel = p.billing_type === 'hourly' ? `${money(p.rate)}/hr` : `${money(p.rate)} flat`;
    const card = document.createElement('div');
    card.className = 'row-hover border border-[#262C40] rounded-lg p-3';
    card.innerHTML = `
      <div class="flex items-start justify-between mb-1">
        <div>
          <div class="text-sm font-medium text-[#E9E6F5]">${p.title}</div>
          <div class="text-xs text-[#6B6685]">${client ? client.company : 'Unknown client'} · ${rateLabel} · ${p.status}</div>
        </div>
        <div class="row-actions flex items-center gap-1">
          <button data-action="edit" class="icon-btn text-[#9B96B5]" title="Edit">&#9998;</button>
          <button data-action="delete" class="icon-btn text-[#9B96B5]" title="Delete">&#128465;</button>
        </div>
      </div>
      <button data-action="log" class="text-xs bg-[#242B3D] text-[#E9E6F5] px-3 py-1.5 rounded-md hover:bg-[#2E3650] cursor-pointer mt-1">Log work</button>
    `;
    card.querySelector('[data-action="edit"]').onclick = () => openProjectForm(p);
    card.querySelector('[data-action="delete"]').onclick = () => deleteProject(p);
    card.querySelector('[data-action="log"]').onclick = () => openLineItemForm(p);
    list.appendChild(card);
  });
}

function statusBadge(inv) {
  const today = new Date().toISOString().slice(0, 10);
  if (inv.status === 'sent' && inv.due_date < today) return '<span class="badge badge-overdue">Overdue</span>';
  if (inv.status === 'draft') return '<span class="badge badge-draft">Draft</span>';
  if (inv.status === 'sent') return '<span class="badge badge-sent">Sent</span>';
  if (inv.status === 'paid') return '<span class="badge badge-paid">Paid</span>';
  return '';
}

function renderInvoices() {
  const tbody = document.getElementById('invoiceRows');
  const empty = document.getElementById('emptyInvoices');
  tbody.innerHTML = '';
  if (invoices.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  invoices.forEach((inv) => {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-[#20263A] hover:bg-[#242B3D] cursor-pointer';
    tr.innerHTML = `
      <td class="py-2 pr-2 font-medium text-[#E9E6F5]">${inv.invoice_number}</td>
      <td class="py-2 pr-2 text-[#E9E6F5]">${inv.client_company}</td>
      <td class="py-2 pr-2 text-[#9B96B5]">${inv.issue_date}</td>
      <td class="py-2 pr-2 text-[#9B96B5]">${inv.due_date}</td>
      <td class="py-2 pr-2 text-right font-medium text-[#E9E6F5]">${money(inv.total)}</td>
      <td class="py-2 pr-2">${statusBadge(inv)}</td>
      <td class="py-2 pr-2 text-right text-xs text-[#A77DFF]">View</td>
    `;
    tr.onclick = () => openInvoiceDetail(inv.id);
    tbody.appendChild(tr);
  });
}

// ---- Client form ----
function openClientForm(client) {
  editingClientId = client ? client.id : null;
  document.getElementById('clientFormTitle').textContent = client ? 'Edit client' : 'New client';
  document.getElementById('cf_name').value = client ? client.name : '';
  document.getElementById('cf_company').value = client ? client.company : '';
  document.getElementById('cf_email').value = client ? client.email : '';
  document.getElementById('clientFormError').classList.add('hidden');
  showEl('clientFormModal');
}

async function deleteClient(client) {
  if (!confirm(`Delete ${client.name} (${client.company})?`)) return;
  try {
    await api(`/api/clients/${client.id}`, { method: 'DELETE' });
    await loadAll();
    showToast(`${client.name} deleted`);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('clientForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    name: document.getElementById('cf_name').value.trim(),
    company: document.getElementById('cf_company').value.trim(),
    email: document.getElementById('cf_email').value.trim(),
  };
  const errEl = document.getElementById('clientFormError');
  errEl.classList.add('hidden');
  try {
    if (editingClientId) {
      await api(`/api/clients/${editingClientId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      showToast('Client updated');
    } else {
      await api('/api/clients', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Client added');
    }
    hideEl('clientFormModal');
    await loadAll();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// ---- Project form ----
function populateClientSelect(selectEl, selectedId) {
  selectEl.innerHTML = clients.map((c) => `<option value="${c.id}">${clientLabel(c)}</option>`).join('');
  if (selectedId) selectEl.value = selectedId;
}

function toggleRateLabel() {
  const type = document.getElementById('pf_billing_type').value;
  document.getElementById('pf_rate_label').textContent = type === 'hourly' ? 'Hourly rate ($)' : 'Flat fee ($)';
}

function openProjectForm(project) {
  if (clients.length === 0) {
    showToast('Add a client first', 'error');
    return;
  }
  editingProjectId = project ? project.id : null;
  document.getElementById('projectFormTitle').textContent = project ? 'Edit project' : 'New project';
  populateClientSelect(document.getElementById('pf_client'), project ? project.client_id : clients[0].id);
  document.getElementById('pf_title').value = project ? project.title : '';
  document.getElementById('pf_billing_type').value = project ? project.billing_type : 'hourly';
  document.getElementById('pf_rate').value = project ? project.rate : '';
  document.getElementById('pf_status').value = project ? project.status : 'active';
  toggleRateLabel();
  document.getElementById('projectFormError').classList.add('hidden');
  showEl('projectFormModal');
}

document.getElementById('pf_billing_type').addEventListener('change', toggleRateLabel);

async function deleteProject(project) {
  if (!confirm(`Delete project "${project.title}"?`)) return;
  try {
    await api(`/api/projects/${project.id}`, { method: 'DELETE' });
    await loadAll();
    showToast('Project deleted');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('projectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    client_id: document.getElementById('pf_client').value,
    title: document.getElementById('pf_title').value.trim(),
    billing_type: document.getElementById('pf_billing_type').value,
    rate: parseFloat(document.getElementById('pf_rate').value),
    status: document.getElementById('pf_status').value,
  };
  const errEl = document.getElementById('projectFormError');
  errEl.classList.add('hidden');
  try {
    if (editingProjectId) {
      await api(`/api/projects/${editingProjectId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      showToast('Project updated');
    } else {
      await api('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Project added');
    }
    hideEl('projectFormModal');
    await loadAll();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('newClientBtn').onclick = () => openClientForm(null);
document.getElementById('newProjectBtn').onclick = () => openProjectForm(null);

// ---- Log work (line item) form ----
function openLineItemForm(project) {
  activeLineItemProject = project;
  const client = clients.find((c) => c.id === project.client_id);
  document.getElementById('lineItemProjectMeta').textContent =
    `${project.title} · ${client ? client.company : ''} · ${project.billing_type === 'hourly' ? money(project.rate) + '/hr' : money(project.rate) + ' flat'}`;
  document.getElementById('lf_description').value = '';
  document.getElementById('lf_hours').value = '';
  document.getElementById('lf_amount').value = project.billing_type === 'flat' ? project.rate : '';
  document.getElementById('lf_date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('lf_hours_wrap').classList.toggle('hidden', project.billing_type !== 'hourly');
  document.getElementById('lf_amount_wrap').classList.toggle('hidden', project.billing_type !== 'flat');
  document.getElementById('lineItemFormError').classList.add('hidden');
  showEl('lineItemFormModal');
}

document.getElementById('lineItemForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    project_id: activeLineItemProject.id,
    description: document.getElementById('lf_description').value.trim(),
    date: document.getElementById('lf_date').value,
  };
  if (activeLineItemProject.billing_type === 'hourly') {
    payload.hours = parseFloat(document.getElementById('lf_hours').value);
  } else {
    payload.amount = parseFloat(document.getElementById('lf_amount').value);
  }
  const errEl = document.getElementById('lineItemFormError');
  errEl.classList.add('hidden');
  try {
    await api('/api/line-items', { method: 'POST', body: JSON.stringify(payload) });
    hideEl('lineItemFormModal');
    await loadAll();
    showToast('Work logged');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// ---- Invoice builder ----
async function openInvoiceBuilder() {
  if (clients.length === 0) {
    showToast('Add a client first', 'error');
    return;
  }
  populateClientSelect(document.getElementById('ib_client'), clients[0].id);
  document.getElementById('invoiceBuilderError').classList.add('hidden');
  await refreshInvoiceBuilderItems();
  showEl('invoiceBuilderModal');
}

async function refreshInvoiceBuilderItems() {
  const clientId = document.getElementById('ib_client').value;
  const items = await api(`/api/line-items?client_id=${clientId}&unbilled=true`);
  const container = document.getElementById('ib_lineItems');
  const empty = document.getElementById('ib_empty');
  container.innerHTML = '';
  if (items.length === 0) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }
  items.forEach((li) => {
    const project = projects.find((p) => p.id === li.project_id);
    const row = document.createElement('label');
    row.className = 'flex items-center justify-between text-sm gap-2 py-1 cursor-pointer text-[#E9E6F5]';
    row.innerHTML = `
      <span class="flex items-center gap-2">
        <input type="checkbox" class="ib-check" value="${li.id}" data-amount="${li.amount}" checked>
        <span>${li.description} <span class="text-xs text-[#6B6685]">— ${project ? project.title : ''} · ${li.date}</span></span>
      </span>
      <span class="font-medium">${money(li.amount)}</span>
    `;
    container.appendChild(row);
  });
  container.querySelectorAll('.ib-check').forEach((cb) => cb.addEventListener('change', updateInvoiceBuilderTotal));
  updateInvoiceBuilderTotal();
}

function updateInvoiceBuilderTotal() {
  const checked = document.querySelectorAll('#ib_lineItems .ib-check:checked');
  let total = 0;
  checked.forEach((cb) => (total += parseFloat(cb.dataset.amount)));
  document.getElementById('ib_total').textContent = money(total);
}

document.getElementById('ib_client').addEventListener('change', refreshInvoiceBuilderItems);

document.getElementById('ib_create').onclick = async () => {
  const clientId = document.getElementById('ib_client').value;
  const checked = [...document.querySelectorAll('#ib_lineItems .ib-check:checked')].map((cb) => cb.value);
  const errEl = document.getElementById('invoiceBuilderError');
  errEl.classList.add('hidden');
  if (checked.length === 0) {
    errEl.textContent = 'Select at least one line item.';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    await api('/api/invoices', { method: 'POST', body: JSON.stringify({ client_id: clientId, line_item_ids: checked }) });
    hideEl('invoiceBuilderModal');
    await loadAll();
    showToast('Invoice created');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
};

document.getElementById('newInvoiceBtn').onclick = openInvoiceBuilder;

// ---- Invoice detail ----
async function openInvoiceDetail(id) {
  const inv = await api(`/api/invoices/${id}`);
  activeInvoiceId = id;
  document.getElementById('idm_number').textContent = inv.invoice_number;
  document.getElementById('idm_client').textContent = `${inv.client_name} — ${inv.client_company}`;
  document.getElementById('idm_dates').textContent = `Issued ${inv.issue_date} · Due ${inv.due_date}`;
  const list = document.getElementById('idm_lineItems');
  list.innerHTML = inv.line_items.map((li) => `
    <div class="flex items-center justify-between text-[#E9E6F5]">
      <span>${li.description} <span class="text-xs text-[#6B6685]">${li.date}</span></span>
      <span>${money(li.amount)}</span>
    </div>
  `).join('');
  const total = inv.line_items.reduce((s, li) => s + Number(li.amount), 0);
  document.getElementById('idm_total').textContent = money(total);
  document.getElementById('idm_status').outerHTML = statusBadge(inv).replace('<span', '<span id="idm_status"');
  document.getElementById('idm_markSent').classList.toggle('hidden', inv.status !== 'draft');
  document.getElementById('idm_markPaid').classList.toggle('hidden', inv.status !== 'sent');
  document.getElementById('idm_delete').classList.toggle('hidden', inv.status !== 'draft');
  showEl('invoiceDetailModal');
}

document.getElementById('idm_markSent').onclick = async () => {
  await api(`/api/invoices/${activeInvoiceId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'sent' }) });
  hideEl('invoiceDetailModal');
  await loadAll();
  showToast('Invoice marked as sent');
};

document.getElementById('idm_markPaid').onclick = async () => {
  await api(`/api/invoices/${activeInvoiceId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'paid' }) });
  hideEl('invoiceDetailModal');
  await loadAll();
  showToast('Invoice marked as paid');
};

document.getElementById('idm_delete').onclick = async () => {
  if (!confirm('Delete this draft invoice? Its line items go back to unbilled.')) return;
  await api(`/api/invoices/${activeInvoiceId}`, { method: 'DELETE' });
  hideEl('invoiceDetailModal');
  await loadAll();
  showToast('Draft invoice deleted');
};

// ---- Modal helpers ----
function showEl(id) {
  document.getElementById(id).classList.remove('hidden');
  document.getElementById(id).classList.add('flex');
}
function hideEl(id) {
  document.getElementById(id).classList.add('hidden');
  document.getElementById(id).classList.remove('flex');
}

document.getElementById('closeClientForm').onclick = () => hideEl('clientFormModal');
document.getElementById('cancelClientForm').onclick = () => hideEl('clientFormModal');
document.getElementById('clientFormModal').addEventListener('click', (e) => { if (e.target.id === 'clientFormModal') hideEl('clientFormModal'); });

document.getElementById('closeProjectForm').onclick = () => hideEl('projectFormModal');
document.getElementById('cancelProjectForm').onclick = () => hideEl('projectFormModal');
document.getElementById('projectFormModal').addEventListener('click', (e) => { if (e.target.id === 'projectFormModal') hideEl('projectFormModal'); });

document.getElementById('closeLineItemForm').onclick = () => hideEl('lineItemFormModal');
document.getElementById('cancelLineItemForm').onclick = () => hideEl('lineItemFormModal');
document.getElementById('lineItemFormModal').addEventListener('click', (e) => { if (e.target.id === 'lineItemFormModal') hideEl('lineItemFormModal'); });

document.getElementById('closeInvoiceBuilder').onclick = () => hideEl('invoiceBuilderModal');
document.getElementById('invoiceBuilderModal').addEventListener('click', (e) => { if (e.target.id === 'invoiceBuilderModal') hideEl('invoiceBuilderModal'); });

document.getElementById('closeInvoiceDetail').onclick = () => hideEl('invoiceDetailModal');
document.getElementById('closeInvoiceDetail2').onclick = () => hideEl('invoiceDetailModal');
document.getElementById('invoiceDetailModal').addEventListener('click', (e) => { if (e.target.id === 'invoiceDetailModal') hideEl('invoiceDetailModal'); });

document.getElementById('resetBtn').onclick = async () => {
  if (!confirm('Reset all data back to the seeded demo state?')) return;
  await api('/api/reset', { method: 'POST' });
  await loadAll();
  showToast('Demo data reset');
};
document.getElementById('logoutBtn').onclick = async () => {
  await api('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
};

// Auth check, then load.
api('/api/session').then((s) => {
  if (!s.authed) {
    window.location.href = '/login.html';
  } else {
    loadAll();
  }
});
