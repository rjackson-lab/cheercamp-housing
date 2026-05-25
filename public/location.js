// Admin venue management page.

const $ = (id) => document.getElementById(id);
const locationId = parseInt(window.location.pathname.split('/').pop(), 10);
function fmtDate(ts) { return ts ? new Date(ts).toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }) : '—'; }
function escape(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
async function api(p, o) {
  const r = await fetch(p, o);
  if (r.status === 401) { window.location.href = '/'; return null; }
  return r;
}

let me = null;
let currentLocation = null;

async function bootstrap() {
  const r = await api('/api/me'); if (!r) return;
  me = (await r.json()).user;
  if (me.role !== 'admin') { window.location.href = '/'; return; }
  ProfileDropdown.mount($('vs-profile-mount'), me);
  await loadLocation();
  await loadSessions();
}

async function loadLocation() {
  const r = await api(`/api/locations/${locationId}`);
  if (!r) return;
  if (r.status === 404) { document.body.innerHTML = '<div style="padding:50px;text-align:center;">Location not found.</div>'; return; }
  const { location, files } = await r.json();
  currentLocation = location;

  $('header-block').innerHTML = `
    <div class="vs-flex-between vs-mb-lg">
      <div>
        <h1 style="margin:0; font-size: 24px; color: var(--vs-navy);">${escape(location.name)}</h1>
        ${location.description ? `<div class="vs-muted" style="font-size:13px; margin-top:4px;">${escape(location.description)}</div>` : ''}
        <div class="vs-muted" style="font-size:11px; margin-top:6px;">Created by ${escape(location.created_by_name || '—')} · ${fmtDate(location.created_at)}</div>
      </div>
      <div>
        <button class="vs-btn vs-btn-secondary" id="edit-loc-btn">Edit</button>
      </div>
    </div>
  `;
  $('edit-loc-btn').onclick = () => {
    $('edit-name').value = location.name;
    $('edit-desc').value = location.description || '';
    $('modal-edit-loc').classList.remove('hidden');
  };

  const grouped = { blank: [], reference: [], floorplan: [] };
  for (const f of files) if (grouped[f.kind]) grouped[f.kind].push(f);
  $('status-blank').innerHTML = grouped.blank.length ? `<strong>${escape(grouped.blank[0].filename)}</strong> <span class="vs-muted">(${(grouped.blank[0].size_bytes/1024).toFixed(1)} KB)</span>` : '<em>No file</em>';
  $('status-reference').innerHTML = grouped.reference.length ? `<strong>${escape(grouped.reference[0].filename)}</strong> <span class="vs-muted">(${(grouped.reference[0].size_bytes/1024).toFixed(1)} KB)</span>` : '<em>No file</em>';
  $('status-floorplan').innerHTML = `${grouped.floorplan.length} file(s)`;

  const allFiles = [...grouped.blank, ...grouped.reference, ...grouped.floorplan];
  $('files-table-block').innerHTML = allFiles.length ? `
    <h3 style="margin: 20px 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vs-navy);">All Files</h3>
    <div class="vs-table-scroll">
      <table class="vs-table zebra">
        <thead><tr><th>Kind</th><th>Filename</th><th>Size</th><th>Uploaded</th><th></th></tr></thead>
        <tbody>
          ${allFiles.map(f => `
            <tr>
              <td><span class="vs-status not_started">${escape(f.kind)}</span></td>
              <td>${escape(f.filename)}</td>
              <td class="vs-muted">${(f.size_bytes/1024).toFixed(1)} KB</td>
              <td class="vs-muted">${fmtDate(f.uploaded_at)}</td>
              <td style="text-align: right;">
                <a class="vs-btn vs-btn-sm vs-btn-secondary" href="/api/files/${f.id}">Download</a>
                <button class="vs-btn vs-btn-sm vs-btn-danger" data-del-file="${f.id}">Remove</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '';
  document.querySelectorAll('button[data-del-file]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Remove this file?')) return;
      await api(`/api/files/${b.dataset.delFile}`, { method: 'DELETE' });
      loadLocation();
    };
  });
}

async function uploadFile(kind, file) {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('file', file);
  $('upload-msg').innerHTML = `<div class="vs-alert info"><span class="vs-spinner"></span>Uploading ${escape(file.name)}…</div>`;
  const r = await api(`/api/locations/${locationId}/files`, { method: 'POST', body: fd });
  if (!r) return;
  const d = await r.json();
  if (!r.ok) {
    $('upload-msg').innerHTML = `<div class="vs-alert error">${escape(d.error || 'upload failed')}</div>`;
    return;
  }
  $('upload-msg').innerHTML = `<div class="vs-alert success">✓ Uploaded ${escape(file.name)}</div>`;
  setTimeout(() => { $('upload-msg').innerHTML = ''; }, 2000);
  loadLocation();
}

$('upload-blank').addEventListener('change', (e) => { if (e.target.files[0]) uploadFile('blank', e.target.files[0]); e.target.value = ''; });
$('upload-reference').addEventListener('change', (e) => { if (e.target.files[0]) uploadFile('reference', e.target.files[0]); e.target.value = ''; });
$('upload-floorplan').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  for (const f of files) await uploadFile('floorplan', f);
  e.target.value = '';
});

async function loadSessions() {
  const r = await api('/api/sessions'); if (!r) return;
  const { sessions } = await r.json();
  const here = (sessions || []).filter(s => s.location_id === locationId);
  if (here.length === 0) {
    $('sessions-block').innerHTML = '<div style="padding: 18px; color: var(--vs-text-mute); font-size: 13px;">No sessions running against this location yet.</div>';
    return;
  }
  $('sessions-block').innerHTML = `
    <table class="vs-table zebra">
      <thead><tr><th>Session</th><th>Created By</th><th>Status</th><th>Last Run</th><th></th></tr></thead>
      <tbody>
        ${here.map(s => `
          <tr>
            <td><b>${escape(s.name || 'Untitled')}</b></td>
            <td>${escape(s.created_by_name || '—')}</td>
            <td>${renderSessionStatus(s)}</td>
            <td class="vs-muted">${s.last_run ? fmtDate(s.last_run) : '—'}</td>
            <td style="text-align:right;"><a class="vs-btn vs-btn-sm vs-btn-secondary" href="/session/${s.id}">Open</a></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderSessionStatus(s) {
  if (s.latest_finalized_at) return '<span class="vs-pill ok"><span class="dot"></span>Finalized</span>';
  if (s.latest_is_approved) return '<span class="vs-pill warn"><span class="dot"></span>Approved</span>';
  if (s.last_run) return '<span class="vs-pill"><span class="dot"></span>Draft</span>';
  return '<span class="vs-pill"><span class="dot"></span>Not started</span>';
}

$('edit-cancel').onclick = () => $('modal-edit-loc').classList.add('hidden');
$('edit-save').onclick = async () => {
  const name = $('edit-name').value.trim();
  const description = $('edit-desc').value.trim();
  if (!name) return;
  const r = await api(`/api/locations/${locationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description })
  });
  if (r && r.ok) { $('modal-edit-loc').classList.add('hidden'); loadLocation(); }
};
$('delete-loc').onclick = async () => {
  if (!confirm('Delete this location and ALL sessions/files using it? This cannot be undone.')) return;
  const r = await api(`/api/locations/${locationId}`, { method: 'DELETE' });
  if (r && r.ok) window.location.href = '/';
};

bootstrap();
