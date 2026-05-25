const $ = (id) => document.getElementById(id);
const locationId = parseInt(window.location.pathname.split('/').pop(), 10);
let isAdmin = false;

function fmtDate(ts) { return ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }
function escape(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
async function api(p, o) {
  const r = await fetch(p, o);
  if (r.status === 401) { window.location.href = '/'; return null; }
  return r;
}

async function loadMe() {
  const r = await api('/api/me'); if (!r) return;
  const data = await r.json();
  $('user-name').textContent = data.user.name;
  isAdmin = data.user.role === 'admin';
  $('back-link').href = isAdmin ? '/admin' : '/app';
}

async function loadLocation() {
  const r = await api(`/api/locations/${locationId}`);
  if (!r) return;
  const { location, files, placements } = await r.json();

  $('header-block').innerHTML = `
    <div class="vs-flex-between vs-mb-lg">
      <div>
        <h1 style="margin:0; font-size:22px; color:var(--vs-navy);">${escape(location.name)}</h1>
        ${location.description ? `<div class="vs-muted" style="font-size:13px; margin-top:4px;">${escape(location.description)}</div>` : ''}
      </div>
      <span class="vs-status ${location.status}" style="font-size:11px;">${location.status.replace('_',' ')}</span>
    </div>
  `;

  // file status per kind
  const fileGroups = { raw: [], blank: [], reference: [], floorplan: [], output: [] };
  for (const f of files) fileGroups[f.kind].push(f);

  $('status-raw').innerHTML = fileGroups.raw.length ? `<strong>${escape(fileGroups.raw[0].filename)}</strong>` : '<em>No file</em>';
  $('status-blank').innerHTML = fileGroups.blank.length ? `<strong>${escape(fileGroups.blank[0].filename)}</strong>` : '<em>No file</em>';
  $('status-reference').innerHTML = fileGroups.reference.length ? `<strong>${escape(fileGroups.reference[0].filename)}</strong>` : '<em>No file</em>';
  $('status-floorplan').innerHTML = `${fileGroups.floorplan.length} file(s)`;

  // file table
  const allDataFiles = [...fileGroups.raw, ...fileGroups.blank, ...fileGroups.reference, ...fileGroups.floorplan];
  if (allDataFiles.length > 0) {
    $('files-table-block').innerHTML = `
      <div class="vs-table-scroll" style="margin-top:14px;"><table class="vs-table">
        <thead><tr><th>Kind</th><th>Filename</th><th>Size</th><th>Uploaded</th><th class="vs-actions"></th></tr></thead>
        <tbody>
          ${allDataFiles.map(f => `
            <tr>
              <td><span class="vs-status ${f.kind === 'raw' ? 'in_process' : f.kind === 'output' ? 'completed' : 'not_started'}">${f.kind}</span></td>
              <td>${escape(f.filename)}</td>
              <td class="vs-muted">${(f.size_bytes/1024).toFixed(1)} KB</td>
              <td class="vs-muted">${fmtDate(f.uploaded_at)}</td>
              <td class="vs-actions">
                <a class="vs-btn vs-btn-sm vs-btn-secondary" href="/api/files/${f.id}">Download</a>
                <button class="vs-btn vs-btn-sm vs-btn-danger" data-del-file="${f.id}">Remove</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table></div>
    `;
    document.querySelectorAll('button[data-del-file]').forEach(b => {
      b.onclick = async () => {
        if (!confirm('Remove this file?')) return;
        await api(`/api/files/${b.dataset.delFile}`, { method: 'DELETE' });
        loadLocation();
      };
    });
  } else {
    $('files-table-block').innerHTML = '';
  }

  // Run button enabled when raw + blank present
  $('run-btn').disabled = !(fileGroups.raw.length && fileGroups.blank.length);

  // Latest placement
  if (placements.length > 0) {
    await loadPlacement();
  }
}

async function loadPlacement() {
  const r = await api(`/api/locations/${locationId}/placement`);
  if (!r) return;
  const { placement } = await r.json();
  if (!placement) return;
  renderPlacement(placement);
}

function renderPlacement(p) {
  const c = p.compliance || {};
  const checks = [
    ['Occupancy', c.occupancy_violations || []],
    ['Bathroom', c.bathroom_conflicts || []],
    ['Chaperone', c.chaperone_gaps || []],
    ['Staff Sep', c.staff_separation || []],
    ['School Mix', c.room_school_mix || []],
    ['Gender Floor', c.mixed_gender_floor || []],
    ['Team Splits', c.team_splits || []]
  ];
  const blockerKeys = ['Occupancy', 'Bathroom', 'Staff Sep', 'School Mix'];

  $('run-results').innerHTML = `
    <div class="vs-stat-grid">
      <div class="vs-stat"><div class="vs-stat-label">Total Beds</div><div class="vs-stat-value">${p.total_beds}</div></div>
      <div class="vs-stat"><div class="vs-stat-label">Placed</div><div class="vs-stat-value" style="color:${p.placed === p.total_beds ? 'var(--vs-success)' : 'var(--vs-error)'}">${p.placed}</div></div>
      <div class="vs-stat"><div class="vs-stat-label">Run At</div><div style="font-size:14px; color:var(--vs-navy); font-weight:600; padding-top:6px;">${fmtDate(p.run_at)}</div></div>
    </div>

    <h3 class="vs-section-title">Compliance</h3>
    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px,1fr)); gap:8px; margin-bottom:16px;">
      ${checks.map(([label, arr]) => {
        const isBlocker = blockerKeys.includes(label);
        const isWarn = arr.length > 0 && !isBlocker;
        const bg = arr.length === 0 ? 'var(--vs-success-bg)' : (isBlocker ? 'var(--vs-error-bg)' : 'var(--vs-warn-bg)');
        const color = arr.length === 0 ? 'var(--vs-success)' : (isBlocker ? 'var(--vs-error)' : 'var(--vs-warn)');
        return `
          <div style="background:${bg}; padding:10px; border-radius:4px;">
            <div style="font-size:10px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:var(--vs-text-mute);">${label}</div>
            <div style="font-size:22px; font-weight:800; color:${color}; line-height:1.2;">${arr.length}</div>
            <div style="font-size:10px; color:var(--vs-text-mute); text-transform:uppercase; letter-spacing:0.06em;">${arr.length === 0 ? 'pass' : (isBlocker ? 'blocker' : 'info')}</div>
          </div>
        `;
      }).join('')}
    </div>

    ${checks.filter(([l,a]) => a.length > 0).map(([l, a]) => `
      <details style="margin-bottom:8px;">
        <summary style="cursor:pointer; font-size:12px; font-weight:600; color:var(--vs-navy); padding:6px 0;">${l} (${a.length})</summary>
        <ul style="font-size:12px; color:var(--vs-text-mute); margin:4px 0 8px 18px;">
          ${a.map(item => `<li>${escape(item)}</li>`).join('')}
        </ul>
      </details>
    `).join('')}

    ${(p.warnings && p.warnings.length) ? `
      <h3 class="vs-section-title vs-mt-lg">Placement Notes</h3>
      <div class="vs-alert warn">${p.warnings.map(escape).join('<br>')}</div>
    ` : ''}
  `;

  if (p.output_file_id) {
    $('download-panel').classList.remove('hidden');
    $('download-content').innerHTML = `
      <div class="vs-flex-between">
        <div>
          <div style="font-weight:600; color:var(--vs-navy);">Placeholder roster ready</div>
          <div class="vs-muted" style="font-size:12px; margin-top:4px;">Generated ${fmtDate(p.run_at)}</div>
        </div>
        <a class="vs-btn vs-btn-gold" href="/api/files/${p.output_file_id}">Download .xlsx</a>
      </div>
    `;
  }
}

// File upload handlers
document.querySelectorAll('button[data-upload]').forEach(btn => {
  btn.onclick = () => {
    document.querySelector(`input[data-kind="${btn.dataset.upload}"]`).click();
  };
});
document.querySelectorAll('input.file-input').forEach(inp => {
  inp.onchange = async () => {
    if (!inp.files || !inp.files[0]) return;
    const fd = new FormData();
    fd.append('file', inp.files[0]);
    fd.append('kind', inp.dataset.kind);
    const r = await api(`/api/locations/${locationId}/files`, { method: 'POST', body: fd });
    if (r.ok) {
      inp.value = '';
      loadLocation();
    } else {
      const d = await r.json();
      alert(d.error || 'Upload failed');
    }
  };
});

// Run button
$('run-btn').onclick = async () => {
  $('run-btn').disabled = true;
  $('run-btn').textContent = 'Running…';
  $('run-results').innerHTML = '<div class="vs-alert info">Running placement engine…</div>';
  const r = await api(`/api/locations/${locationId}/run`, { method: 'POST' });
  $('run-btn').textContent = 'Run Placement Engine';
  $('run-btn').disabled = false;
  if (!r) return;
  const data = await r.json();
  if (!data.ok) {
    $('run-results').innerHTML = `<div class="vs-alert error">Placement failed: ${escape(data.message || data.error)}</div>`;
    return;
  }
  await loadLocation();
};

loadMe();
loadLocation();
