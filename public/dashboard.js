// Admin dashboard: manage venues (Locations), view all sessions, approve users.

const $ = (id) => document.getElementById(id);
function fmtDate(ts) { return ts ? new Date(ts).toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }) : '—'; }
function escape(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
async function api(p, o) {
  const r = await fetch(p, o);
  if (r.status === 401) { window.location.href = '/'; return null; }
  return r;
}

let me = null;

async function bootstrap() {
  const r = await api('/api/me'); if (!r) return;
  me = (await r.json()).user;
  if (me.role !== 'admin') { window.location.href = '/'; return; }
  ProfileDropdown.mount($('vs-profile-mount'), me);

  document.querySelectorAll('.vs-tab').forEach(btn => { btn.onclick = () => switchTab(btn.dataset.tab); });

  await Promise.all([loadLocations(), loadSessions(), loadAdminPanel()]);
}

function switchTab(name) {
  document.querySelectorAll('.vs-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $('tab-locations').classList.toggle('hidden', name !== 'locations');
  $('tab-sessions').classList.toggle('hidden', name !== 'sessions');
  $('tab-admin').classList.toggle('hidden', name !== 'admin');
}

async function loadLocations() {
  const r = await api('/api/locations'); if (!r) return;
  const { locations } = await r.json();

  const counts = { ready: 0, empty: 0 };
  for (const l of locations) {
    if (l.has_blank) counts.ready++; else counts.empty++;
  }
  $('stats').innerHTML = `
    <div class="vs-stat"><div class="vs-stat-label">Locations</div><div class="vs-stat-value">${locations.length}</div></div>
    <div class="vs-stat"><div class="vs-stat-label">Ready for Sessions</div><div class="vs-stat-value" style="color:#2E7D32">${counts.ready}</div></div>
    <div class="vs-stat"><div class="vs-stat-label">Missing Template</div><div class="vs-stat-value" style="color:#B47A0B">${counts.empty}</div></div>
    <div class="vs-stat"><div class="vs-stat-label">Total Sessions</div><div class="vs-stat-value">${locations.reduce((s,l)=>s+(l.session_count||0),0)}</div></div>
  `;

  if (locations.length === 0) {
    $('location-content').innerHTML = `
      <div class="vs-panel">
        <div class="vs-panel-body" style="text-align:center; padding: 40px;">
          <h2 style="margin:0 0 6px; color:var(--vs-navy);">No locations yet</h2>
          <div class="vs-muted" style="margin-bottom: 16px;">Create your first camp location to get started</div>
          <button class="vs-btn vs-btn-gold" id="empty-create">+ Create Location</button>
        </div>
      </div>
    `;
    $('empty-create').onclick = openNewLocationModal;
  } else {
    $('location-content').innerHTML = `
      <div class="vs-card-grid">
        ${locations.map(l => `
          <div class="vs-card" data-loc-id="${l.id}">
            <div class="vs-card-title">${escape(l.name)}</div>
            ${l.description ? `<div class="vs-muted vs-card-meta">${escape(l.description)}</div>` : ''}
            <div style="display:flex; gap:6px; flex-wrap:wrap; margin: 10px 0;">
              <span class="vs-pill ${l.has_blank ? 'ok' : 'danger'}"><span class="dot"></span>${l.has_blank ? 'Template ready' : 'No template'}</span>
              ${l.has_reference ? '<span class="vs-pill"><span class="dot"></span>Reference</span>' : ''}
              <span class="vs-pill"><span class="dot"></span>${l.floorplan_count || 0} floor plans</span>
              <span class="vs-pill"><span class="dot"></span>${l.session_count || 0} session${l.session_count === 1 ? '' : 's'}</span>
            </div>
            <div class="vs-card-footer">
              <span class="vs-muted" style="font-size:11px;">Created ${fmtDate(l.created_at)}</span>
              <a class="vs-btn vs-btn-sm vs-btn-secondary" href="/location/${l.id}">Manage</a>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }
}

function openNewLocationModal() {
  $('new-loc-name').value = '';
  $('new-loc-desc').value = '';
  $('new-loc-blank').value = '';
  $('new-loc-reference').value = '';
  $('new-loc-floorplans').value = '';
  $('new-loc-progress').innerHTML = '';
  $('modal-new-location').classList.remove('hidden');
  setTimeout(() => $('new-loc-name').focus(), 0);
}

$('new-location-btn').onclick = openNewLocationModal;
$('new-loc-cancel').onclick = () => $('modal-new-location').classList.add('hidden');
$('new-loc-create').onclick = createLocation;

async function uploadFile(locId, kind, file) {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('file', file);
  return api(`/api/locations/${locId}/files`, { method: 'POST', body: fd });
}

async function createLocation() {
  const name = $('new-loc-name').value.trim();
  const description = $('new-loc-desc').value.trim();
  const blankFile = $('new-loc-blank').files[0];
  const refFile = $('new-loc-reference').files[0];
  const floorPlanFiles = Array.from($('new-loc-floorplans').files || []);

  if (!name) { $('new-loc-progress').innerHTML = '<div class="vs-alert error">Name is required</div>'; return; }
  if (!blankFile) { $('new-loc-progress').innerHTML = '<div class="vs-alert error">Blank rooming template is required</div>'; return; }

  $('new-loc-create').disabled = true;
  $('new-loc-progress').innerHTML = '<div class="vs-alert info"><span class="vs-spinner"></span>Creating location…</div>';

  const r = await api('/api/locations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description })
  });
  if (!r) return;
  const d = await r.json();
  if (!r.ok) { $('new-loc-progress').innerHTML = `<div class="vs-alert error">${escape(d.error || 'failed')}</div>`; $('new-loc-create').disabled = false; return; }
  const locId = d.id;

  const steps = [
    { kind: 'blank', file: blankFile, label: 'blank template' },
    ...(refFile ? [{ kind: 'reference', file: refFile, label: 'reference template' }] : []),
    ...floorPlanFiles.map((f, i) => ({ kind: 'floorplan', file: f, label: `floor plan ${i+1}/${floorPlanFiles.length}` })),
  ];

  for (const step of steps) {
    $('new-loc-progress').innerHTML = `<div class="vs-alert info"><span class="vs-spinner"></span>Uploading ${escape(step.label)} (${(step.file.size/1024/1024).toFixed(1)} MB)…</div>`;
    const ur = await uploadFile(locId, step.kind, step.file);
    if (!ur || !ur.ok) {
      const ud = ur ? await ur.json() : { error: 'upload failed' };
      $('new-loc-progress').innerHTML = `<div class="vs-alert error">Failed to upload ${escape(step.label)}: ${escape(ud.error || 'unknown')}. The location was created — upload remaining files from its detail page.</div>`;
      $('new-loc-create').disabled = false;
      return;
    }
  }

  $('new-loc-progress').innerHTML = '<div class="vs-alert success">✓ Location created with all files</div>';
  setTimeout(() => {
    $('modal-new-location').classList.add('hidden');
    $('new-loc-create').disabled = false;
    loadLocations();
  }, 700);
}

async function loadSessions() {
  const r = await api('/api/sessions'); if (!r) return;
  const { sessions } = await r.json();
  if ((sessions || []).length === 0) {
    $('sessions-body').innerHTML = '<div style="padding:18px; color:var(--vs-text-mute); font-size:13px;">No sessions yet. Non-admin users will create sessions against your locations.</div>';
    return;
  }
  $('sessions-body').innerHTML = `
    <div class="vs-table-scroll">
      <table class="vs-table zebra">
        <thead><tr><th>Session</th><th>Location</th><th>Created By</th><th>Status</th><th>Last Run</th><th>Updated</th><th></th></tr></thead>
        <tbody>
          ${sessions.map(s => `
            <tr>
              <td><b>${escape(s.name || 'Untitled')}</b></td>
              <td>${escape(s.location_name || '—')}</td>
              <td>${escape(s.created_by_name || '—')}</td>
              <td>${renderSessionStatus(s)}</td>
              <td class="vs-muted">${s.last_run ? fmtDate(s.last_run) : '—'}</td>
              <td class="vs-muted">${fmtDate(s.updated_at)}</td>
              <td style="text-align:right;">
                <a class="vs-btn vs-btn-sm vs-btn-secondary" href="/session/${s.id}">View</a>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderSessionStatus(s) {
  if (s.latest_finalized_at) return '<span class="vs-pill ok"><span class="dot"></span>Finalized</span>';
  if (s.latest_is_approved) return '<span class="vs-pill warn"><span class="dot"></span>Approved</span>';
  if (s.last_run) return '<span class="vs-pill"><span class="dot"></span>Draft</span>';
  return '<span class="vs-pill"><span class="dot"></span>Not started</span>';
}

async function loadAdminPanel() {
  const r = await api('/api/admin/users'); if (!r) return;
  const { users } = await r.json();

  const pending = users.filter(u => u.status === 'pending');
  $('pending-count').textContent = pending.length;
  $('admin-badge').textContent = pending.length;
  $('admin-badge').classList.toggle('hidden', pending.length === 0);

  $('pending-body').innerHTML = pending.length === 0 ?
    '<div style="padding:18px; color:var(--vs-text-mute); font-size:13px;">No pending requests</div>' : `
    <table class="vs-table">
      <thead><tr><th>Name</th><th>Email</th><th>Requested</th><th></th></tr></thead>
      <tbody>${pending.map(u => `
        <tr>
          <td>${escape(u.name)}</td>
          <td>${escape(u.email)}</td>
          <td class="vs-muted">${fmtDate(u.created_at)}</td>
          <td style="text-align:right;">
            <button class="vs-btn vs-btn-sm vs-btn-gold" data-approve="${u.id}">Approve</button>
            <button class="vs-btn vs-btn-sm vs-btn-danger" data-reject="${u.id}">Reject</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  $('users-body').innerHTML = `
    <table class="vs-table">
      <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Role</th><th></th></tr></thead>
      <tbody>${users.map(u => `
        <tr>
          <td>${escape(u.name)}</td>
          <td>${escape(u.email)}</td>
          <td><span class="vs-status ${u.status}">${u.status}</span></td>
          <td>${u.role === 'admin' ? '<span class="vs-status admin">admin</span>' : 'user'}</td>
          <td style="text-align:right;">
            ${u.status === 'approved' && u.id !== me.id ?
              `<button class="vs-btn vs-btn-sm vs-btn-secondary" data-role="${u.id}" data-newrole="${u.role === 'admin' ? 'user' : 'admin'}">Make ${u.role === 'admin' ? 'user' : 'admin'}</button>` : ''}
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  document.querySelectorAll('button[data-approve]').forEach(b => {
    b.onclick = async () => { await api(`/api/admin/users/${b.dataset.approve}/approve`, { method: 'POST' }); loadAdminPanel(); };
  });
  document.querySelectorAll('button[data-reject]').forEach(b => {
    b.onclick = async () => { if (!confirm('Reject this user?')) return; await api(`/api/admin/users/${b.dataset.reject}/reject`, { method: 'POST' }); loadAdminPanel(); };
  });
  document.querySelectorAll('button[data-role]').forEach(b => {
    b.onclick = async () => {
      await api(`/api/admin/users/${b.dataset.role}/role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: b.dataset.newrole })
      });
      loadAdminPanel();
    };
  });
}

bootstrap();
