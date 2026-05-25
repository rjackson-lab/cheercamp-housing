const $ = (id) => document.getElementById(id);
let currentUser = null;

function fmtDate(ts) { return ts ? new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
function escape(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
async function api(p, o) {
  const r = await fetch(p, o);
  if (r.status === 401) { window.location.href = '/'; return null; }
  return r;
}

async function loadMe() {
  const r = await api('/api/me'); if (!r) return;
  const data = await r.json();
  currentUser = data.user;
  $('user-name').textContent = currentUser.name;
  if (currentUser.role === 'admin') {
    $('role-pill').classList.remove('hidden');
    $('tab-nav').classList.remove('hidden');
    $('locations-subtitle').textContent = 'All locations across the organization, grouped by status';
  }
}

// ===== Tabs =====
document.querySelectorAll('.vs-tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.vs-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('section[id^="tab-"]').forEach(s => s.classList.add('hidden'));
    $(`tab-${btn.dataset.tab}`).classList.remove('hidden');
  };
});

// ===== Locations =====
async function loadLocations() {
  const r = await api('/api/locations');
  const { locations } = await r.json();

  const groups = { completed: [], in_process: [], errors: [], not_started: [] };
  for (const l of locations) (groups[l.status] || groups.not_started).push(l);

  $('stats').innerHTML = `
    <div class="vs-stat"><div class="vs-stat-label">Locations</div><div class="vs-stat-value">${locations.length}</div></div>
    <div class="vs-stat"><div class="vs-stat-label">Completed</div><div class="vs-stat-value" style="color:var(--vs-success)">${groups.completed.length}</div></div>
    <div class="vs-stat"><div class="vs-stat-label">In Process</div><div class="vs-stat-value" style="color:var(--vs-warn)">${groups.in_process.length}</div></div>
    <div class="vs-stat"><div class="vs-stat-label">Errors / Not Started</div><div class="vs-stat-value" style="color:var(--vs-error)">${groups.errors.length + groups.not_started.length}</div></div>
  `;

  const content = $('location-content');
  if (locations.length === 0) {
    content.innerHTML = `
      <div class="vs-panel"><div class="vs-panel-body" style="text-align:center; padding:48px 20px;">
        <div style="font-size:18px; font-weight:700; color:var(--vs-navy); margin-bottom:8px;">No locations yet</div>
        <div class="vs-muted" style="margin-bottom:18px;">Create your first camp location to get started</div>
        <button class="vs-btn" onclick="document.getElementById('new-location-btn').click()">+ Create Location</button>
      </div></div>
    `;
    return;
  }

  if (currentUser.role === 'admin') {
    // Admin sees grouped status panels for oversight
    content.innerHTML = `
      ${renderGroup('Completed', 'completed', groups.completed)}
      ${renderGroup('In Process', 'in_process', groups.in_process)}
      ${renderGroup('Errors / Not Completed', 'errors', [...groups.errors, ...groups.not_started])}
    `;
  } else {
    // Users see a single flat grid
    content.innerHTML = `<div class="vs-card-grid">${locations.map(locCard).join('')}</div>`;
  }
  document.querySelectorAll('.vs-card').forEach(c => c.onclick = () => window.location.href = `/location/${c.dataset.id}`);
}

function renderGroup(title, cls, list) {
  return `
    <div class="vs-panel">
      <div class="vs-panel-header">
        <span>${title} <span class="vs-status ${cls}" style="margin-left:8px;">${list.length}</span></span>
      </div>
      <div class="vs-panel-body">
        ${list.length === 0
          ? `<div class="vs-muted" style="font-size:13px;">None.</div>`
          : `<div class="vs-card-grid">${list.map(locCard).join('')}</div>`}
      </div>
    </div>
  `;
}

function locCard(l) {
  const filesReady = [];
  if (l.has_raw) filesReady.push('Raw');
  if (l.has_blank) filesReady.push('Blank');
  if (l.has_reference) filesReady.push('Reference');
  if (l.floorplan_count) filesReady.push(`${l.floorplan_count} Floor Plans`);
  return `
    <div class="vs-card" data-id="${l.id}">
      <div class="vs-card-title">${escape(l.name)}</div>
      <div class="vs-card-meta">Created by ${escape(l.created_by_name || '—')} · ${fmtDate(l.created_at)}</div>
      ${l.description ? `<div style="font-size:12px; color:var(--vs-text-mute); margin-bottom:10px;">${escape(l.description)}</div>` : ''}
      <div style="font-size:11px; color:var(--vs-text-mute); margin-bottom:10px;">
        ${filesReady.length ? filesReady.join(' · ') : '<em>No files yet</em>'}
      </div>
      <div class="vs-card-footer">
        <span class="vs-status ${l.status}">${l.status.replace('_',' ')}</span>
        <span style="font-size:11px; color:var(--vs-text-mute);">${l.last_run ? 'Last run ' + fmtDate(l.last_run) : 'Not yet run'}</span>
      </div>
    </div>
  `;
}

// ===== Admin: pending + users =====
async function loadAdmin() {
  if (currentUser.role !== 'admin') return;
  const r = await api('/api/admin/users');
  const { users } = await r.json();
  const pending = users.filter(u => u.status === 'pending');
  const others = users.filter(u => u.status !== 'pending');

  // Pending count badge in tab
  $('pending-count').textContent = pending.length;
  const badge = $('admin-badge');
  if (pending.length > 0) { badge.textContent = pending.length; badge.classList.remove('hidden'); }
  else { badge.classList.add('hidden'); }

  // Pending body
  const pBody = $('pending-body');
  if (pending.length === 0) {
    pBody.innerHTML = '<div style="padding:18px; color:var(--vs-text-mute); font-size:13px;">No access requests waiting.</div>';
  } else {
    pBody.innerHTML = `
      <div class="vs-table-scroll"><table class="vs-table vs-table-stack">
        <thead><tr><th>Name</th><th>Email</th><th>Requested</th><th class="vs-actions"></th></tr></thead>
        <tbody>${pending.map(u => `
          <tr>
            <td><strong>${escape(u.name)}</strong></td>
            <td>${escape(u.email)}</td>
            <td>${fmtDate(u.created_at)}</td>
            <td class="vs-actions">
              <button class="vs-btn vs-btn-sm vs-btn-secondary" data-act="reject" data-id="${u.id}">Reject</button>
              <button class="vs-btn vs-btn-sm vs-btn-gold" data-act="approve" data-id="${u.id}">Approve</button>
            </td>
          </tr>`).join('')}</tbody>
      </table></div>
    `;
    pBody.querySelectorAll('button[data-act]').forEach(b => {
      b.onclick = async () => {
        await api(`/api/admin/users/${b.dataset.id}/${b.dataset.act}`, { method: 'POST' });
        loadAdmin();
      };
    });
  }

  // Users body
  const uBody = $('users-body');
  if (others.length === 0) {
    uBody.innerHTML = '<div style="padding:18px; color:var(--vs-text-mute); font-size:13px;">No approved users.</div>';
  } else {
    uBody.innerHTML = `
      <div class="vs-table-scroll"><table class="vs-table">
        <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Role</th><th>Approved</th><th class="vs-actions"></th></tr></thead>
        <tbody>${others.map(u => `
          <tr>
            <td><strong>${escape(u.name)}</strong></td>
            <td>${escape(u.email)}</td>
            <td><span class="vs-status ${u.status}">${u.status}</span></td>
            <td><span class="vs-status ${u.role === 'admin' ? 'admin' : ''}">${u.role}</span></td>
            <td>${fmtDate(u.approved_at)}</td>
            <td class="vs-actions">
              ${u.role !== 'admin' ? `<button class="vs-btn vs-btn-sm vs-btn-secondary" data-promote="${u.id}">Make admin</button>` : ''}
            </td>
          </tr>`).join('')}</tbody>
      </table></div>
    `;
    uBody.querySelectorAll('button[data-promote]').forEach(b => {
      b.onclick = async () => {
        if (!confirm('Promote this user to admin?')) return;
        await api(`/api/admin/users/${b.dataset.promote}/role`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'admin' })
        });
        loadAdmin();
      };
    });
  }
}

// ===== New location modal =====
$('new-location-btn').onclick = () => $('modal-new-location').classList.remove('hidden');
$('new-loc-cancel').onclick = () => $('modal-new-location').classList.add('hidden');
$('new-loc-create').onclick = async () => {
  const name = $('new-loc-name').value.trim();
  const description = $('new-loc-desc').value.trim();
  if (!name) { alert('Name required'); return; }
  const r = await api('/api/locations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description })
  });
  const data = await r.json();
  if (r.ok) window.location.href = `/location/${data.id}`;
  else alert(data.error || 'Failed');
};

$('logout').onclick = async (e) => {
  e.preventDefault();
  await api('/api/logout', { method: 'POST' });
  window.location.href = '/';
};

(async () => {
  await loadMe();
  await loadLocations();
  await loadAdmin();
})();
