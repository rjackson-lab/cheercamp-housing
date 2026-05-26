// Non-admin operational view.
// Workflow: pick venue → create session → upload raw → run placement → review → approve → finalize → export.

const $ = (id) => document.getElementById(id);
function fmtDate(ts) { return ts ? new Date(ts).toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }) : '—'; }
function escape(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
async function api(p, o) {
  const r = await fetch(p, o);
  if (r.status === 401) { window.location.href = '/'; return null; }
  return r;
}

const state = {
  me: null,
  venues: [],
  selectedVenueId: null,
  sessionId: null,
  rawFile: null,            // staged file (not yet uploaded)
  placement: null,
};

// Determine if URL has /session/:id — if so, we resume directly
const urlMatch = window.location.pathname.match(/^\/session\/(\d+)/);
const initialSessionId = urlMatch ? parseInt(urlMatch[1], 10) : null;

// Detect if we're loaded inside the admin dashboard's "Submit a Rooming List" tab.
// When embedded, we hide the duplicate profile dropdown (the parent dashboard
// already provides one) and tag the body so CSS can compact the chrome.
const isEmbedded = new URLSearchParams(window.location.search).get('embedded') === '1';
if (isEmbedded) document.body.classList.add('vs-embedded');

/* =====================================================
   Bootstrap
   ===================================================== */
async function bootstrap() {
  // Who am I
  const meRes = await api('/api/me');
  if (!meRes) return;
  state.me = (await meRes.json()).user;
  // Only mount the profile dropdown when standalone — the parent dashboard
  // already shows one when this view is embedded.
  if (!isEmbedded) ProfileDropdown.mount($('vs-profile-mount'), state.me);

  // Load venues for the picker
  await loadVenues();

  // Load user's sessions for the resume panel
  await loadUserSessions();

  if (initialSessionId) {
    await openSession(initialSessionId);
  } else {
    syncStepNav();
  }
}

/* =====================================================
   Venues
   ===================================================== */
async function loadVenues() {
  const r = await api('/api/locations');
  if (!r) return;
  const { locations } = await r.json();
  state.venues = locations || [];
  const sel = $('location-select');
  sel.innerHTML = '<option value="">— Select a camp location —</option>';
  for (const v of state.venues) {
    if (!v.has_blank) continue; // can't pick venues without a blank template
    sel.innerHTML += `<option value="${v.id}">${escape(v.name)}${v.description ? ' — ' + escape(v.description) : ''}</option>`;
  }
  // Warn if no usable venues
  if (state.venues.length === 0) {
    $('location-warn').innerHTML = '<div class="vs-alert warn">No camp locations are available yet. Ask an admin to set one up.</div>';
  } else if (!state.venues.some(v => v.has_blank)) {
    $('location-warn').innerHTML = '<div class="vs-alert warn">Camp locations exist but none have a blank rooming template uploaded. Ask an admin to complete setup.</div>';
  }
}

$('location-select').addEventListener('change', (e) => {
  const id = parseInt(e.target.value, 10);
  state.selectedVenueId = id || null;
  renderVenueInfo();
  updateCreateSessionState();
});

function renderVenueInfo() {
  if (!state.selectedVenueId) { $('location-info').innerHTML = ''; return; }
  const v = state.venues.find(x => x.id === state.selectedVenueId);
  if (!v) return;
  $('ctx-location').textContent = v.name;
  $('location-info').innerHTML = `
    <div class="vs-meta-row">
      <div class="item"><div class="label">Location</div><div class="value">${escape(v.name)}</div></div>
      <div class="item"><div class="label">Blank Template</div><div class="value">${v.has_blank ? '✓ Ready' : '— Missing'}</div></div>
      <div class="item"><div class="label">Reference</div><div class="value">${v.has_reference ? '✓ Available' : '— Optional'}</div></div>
      <div class="item"><div class="label">Floor Plans</div><div class="value">${v.floorplan_count || 0} file${v.floorplan_count === 1 ? '' : 's'}</div></div>
    </div>
    ${v.description ? `<div style="margin-top: 10px; font-size: 13px; color: var(--vs-text-2);">${escape(v.description)}</div>` : ''}
  `;
  setStepStatus('step-location', 'status-location', 'selected', 'done');
  $('step-upload').classList.remove('disabled');
}

/* =====================================================
   User sessions panel (resume)
   ===================================================== */
async function loadUserSessions() {
  const r = await api('/api/sessions');
  if (!r) return;
  const { sessions } = await r.json();
  // Filter to current user's in-progress sessions
  const mine = (sessions || []).filter(s => s.created_by === state.me.id);
  if (mine.length === 0) { $('resume-panel').hidden = true; return; }
  $('resume-panel').hidden = false;
  $('sessions-list').innerHTML = `
    <table class="vs-table zebra">
      <thead><tr><th>Session</th><th>Location</th><th>Status</th><th>Last Run</th><th></th></tr></thead>
      <tbody>
        ${mine.map(s => `
          <tr>
            <td><b>${escape(s.name || 'Untitled')}</b></td>
            <td>${escape(s.location_name || '—')}</td>
            <td>${renderStatusPill(s)}</td>
            <td class="vs-muted">${s.last_run ? fmtDate(s.last_run) : '—'}</td>
            <td style="text-align:right;">
              <button class="vs-btn vs-btn-sm vs-btn-secondary" data-resume-session="${s.id}">Resume</button>
              <button class="vs-btn vs-btn-sm vs-btn-ghost" data-delete-session="${s.id}">Delete</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  document.querySelectorAll('button[data-resume-session]').forEach(b => {
    b.onclick = () => openSession(parseInt(b.dataset.resumeSession, 10));
  });
  document.querySelectorAll('button[data-delete-session]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Delete this session? This cannot be undone.')) return;
      const r = await api(`/api/sessions/${b.dataset.deleteSession}`, { method: 'DELETE' });
      if (r && r.ok) loadUserSessions();
    };
  });
}

function renderStatusPill(s) {
  if (s.latest_finalized_at) return '<span class="vs-pill ok"><span class="dot"></span>Finalized</span>';
  if (s.latest_is_approved) return '<span class="vs-pill warn"><span class="dot"></span>Approved (Names pending)</span>';
  if (s.last_run) return '<span class="vs-pill"><span class="dot"></span>Draft – Review</span>';
  return '<span class="vs-pill"><span class="dot"></span>Not started</span>';
}

$('new-session-btn').onclick = () => {
  // Reset to picker state
  state.sessionId = null;
  state.placement = null;
  state.rawFile = null;
  window.history.replaceState(null, '', '/');
  $('location-select').value = '';
  state.selectedVenueId = null;
  $('location-info').innerHTML = '';
  $('session-name').value = '';
  $('dropzone-default').style.display = 'block';
  $('dropzone-loaded').style.display = 'none';
  $('dropzone-loaded').innerHTML = '';
  $('upload-msg').innerHTML = '';
  $('review-body').innerHTML = '<div class="vs-alert info">Select a camp location and upload raw roster data, then click <b>Run Placement</b>.</div>';
  $('approval-actions').innerHTML = '';
  $('finalize-status').innerHTML = '';
  setStepStatus('step-location', 'status-location', 'Required', 'enable');
  setStepStatus('step-upload', 'status-upload', 'Waiting', 'enable');
  $('step-upload').classList.add('disabled');
  $('step-review').classList.add('disabled');
  $('step-finalize').classList.add('disabled');
  $('create-session-btn').disabled = true;
  $('run-btn').disabled = true;
  $('ctx-session').textContent = '—';
  $('ctx-location').textContent = '—';
  syncStepNav();
};

/* =====================================================
   Session creation + raw upload
   ===================================================== */
$('create-session-btn').onclick = createSession;

function updateCreateSessionState() {
  const btn = $('create-session-btn');
  btn.disabled = !state.selectedVenueId || !!state.sessionId;
}

async function createSession() {
  if (!state.selectedVenueId) return;
  const name = $('session-name').value.trim() || `Session ${new Date().toLocaleDateString('en-US')}`;
  const r = await api('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, location_id: state.selectedVenueId })
  });
  if (!r) return;
  const d = await r.json();
  if (!r.ok) { alert(d.error || 'Failed to create session'); return; }
  state.sessionId = d.id;
  $('ctx-session').textContent = name;
  $('create-session-btn').disabled = true;
  $('create-session-btn').textContent = '✓ Session Created';
  // If file already staged, upload it now
  if (state.rawFile) await uploadRaw(state.rawFile);
  window.history.replaceState(null, '', `/session/${state.sessionId}`);
}

$('dropzone').addEventListener('click', () => $('raw-input').click());
$('raw-input').addEventListener('change', (e) => handleFileSelect(e.target.files[0]));
$('dropzone').addEventListener('dragover', (e) => { e.preventDefault(); $('dropzone').classList.add('drag'); });
$('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('drag'));
$('dropzone').addEventListener('drop', (e) => {
  e.preventDefault();
  $('dropzone').classList.remove('drag');
  handleFileSelect(e.dataTransfer.files[0]);
});

async function handleFileSelect(file) {
  if (!file) return;
  state.rawFile = file;
  $('dropzone-default').style.display = 'none';
  $('dropzone-loaded').style.display = 'block';
  $('dropzone-loaded').innerHTML = `
    <div class="vs-file-status">
      <span class="check">✓</span>
      <span class="fname">${escape(file.name)}</span>
      <span class="fmeta">${(file.size/1024).toFixed(1)} KB · ${state.sessionId ? 'uploading…' : 'staged'}</span>
    </div>
  `;
  $('ctx-session').textContent = $('session-name').value.trim() || file.name.replace(/\.xlsx?$/i, '');
  // If session not yet created, auto-create it (require venue)
  if (!state.sessionId) {
    if (state.selectedVenueId) await createSession();
    else {
      $('upload-msg').innerHTML = '<div class="vs-alert warn">Select a camp location first, then we\'ll create the session automatically.</div>';
      return;
    }
  } else {
    await uploadRaw(file);
  }
}

async function uploadRaw(file) {
  const fd = new FormData();
  fd.append('file', file);
  $('upload-msg').innerHTML = '<div class="vs-alert info"><span class="vs-spinner"></span>Uploading roster…</div>';
  const r = await api(`/api/sessions/${state.sessionId}/raw`, { method: 'POST', body: fd });
  if (!r) return;
  const d = await r.json();
  if (!r.ok) {
    $('upload-msg').innerHTML = `<div class="vs-alert danger">Upload failed: ${escape(d.error || 'unknown')}</div>`;
    return;
  }
  $('dropzone-loaded').innerHTML = `
    <div class="vs-file-status">
      <span class="check">✓</span>
      <span class="fname">${escape(file.name)}</span>
      <span class="fmeta">${(file.size/1024).toFixed(1)} KB · uploaded</span>
    </div>
  `;
  $('upload-msg').innerHTML = '';
  setStepStatus('step-upload', 'status-upload', 'ready', 'done');
  $('step-review').classList.remove('disabled');
  $('run-btn').disabled = false;
  setStepStatus('step-review', 'status-review', 'ready to run', 'enable');
  syncStepNav();
  await runPlacement();
}

/* =====================================================
   Resume existing session
   ===================================================== */
async function openSession(id) {
  state.sessionId = id;
  window.history.replaceState(null, '', `/session/${id}`);
  const r = await api(`/api/sessions/${id}`);
  if (!r) return;
  if (r.status === 403) { alert('You do not have access to this session.'); return; }
  const { session, sessionFiles, venueFiles } = await r.json();
  // Set venue context
  state.selectedVenueId = session.location_id;
  $('ctx-session').textContent = session.name || 'Session';
  $('ctx-location').textContent = session.location_name || '—';
  $('session-name').value = session.name || '';
  // Show venue info if loaded; otherwise re-fetch
  let v = state.venues.find(x => x.id === session.location_id);
  if (!v) { await loadVenues(); v = state.venues.find(x => x.id === session.location_id); }
  if (v) {
    $('location-select').value = String(session.location_id);
    renderVenueInfo();
  }
  // Disable session creation in resume mode
  $('create-session-btn').textContent = '✓ Session Loaded';
  $('create-session-btn').disabled = true;
  // Show raw if present
  const raw = (sessionFiles || []).find(f => f.kind === 'raw');
  if (raw) {
    $('dropzone-default').style.display = 'none';
    $('dropzone-loaded').style.display = 'block';
    $('dropzone-loaded').innerHTML = `
      <div class="vs-file-status">
        <span class="check">✓</span>
        <span class="fname">${escape(raw.filename)}</span>
        <span class="fmeta">${(raw.size_bytes/1024).toFixed(1)} KB · ${fmtDate(raw.uploaded_at)}</span>
      </div>
    `;
    setStepStatus('step-upload', 'status-upload', 'ready', 'done');
    $('step-review').classList.remove('disabled');
    $('run-btn').disabled = false;
  }
  // Load latest placement
  await loadPlacement();
  syncStepNav();
}

/* =====================================================
   Run placement
   ===================================================== */
$('run-btn').onclick = runPlacement;

async function runPlacement() {
  if (!state.sessionId) return;
  $('run-btn').disabled = true; $('run-btn').textContent = 'Running…';
  setStepStatus('step-review', 'status-review', 'computing', 'enable');
  $('review-body').innerHTML = '<div class="vs-alert info"><span class="vs-spinner"></span>Running placement engine — analyzing teams, balancing pods, checking compliance…</div>';
  const r = await api(`/api/sessions/${state.sessionId}/run`, { method: 'POST' });
  if (!r) return;
  const d = await r.json();
  $('run-btn').disabled = false; $('run-btn').textContent = 'Re-run Placement';
  if (!r.ok) {
    $('review-body').innerHTML = `<div class="vs-alert danger">Placement failed: ${escape(d.error || 'unknown error')}</div>`;
    return;
  }
  await loadPlacement();
}

async function loadPlacement() {
  if (!state.sessionId) return;
  const r = await api(`/api/sessions/${state.sessionId}/placement`);
  if (!r) return;
  const { placement } = await r.json();
  state.placement = placement;
  if (!placement) return;
  renderReview(placement);
  setStepStatus('step-review', 'status-review', `${placement.placed}/${placement.total_beds} placed`,
    placement.placed === placement.total_beds ? 'done' : 'warn');
  $('step-finalize').classList.remove('disabled');
  renderApprovalActions(placement);
  syncStepNav();
}

/* =====================================================
   Review rendering
   ===================================================== */
function renderReview(p) {
  const c = p.compliance || {};
  const assignments = p.assignments || [];
  const roster = p.roster_summary || {};
  const rosterGenders = roster.gender_counts || {};
  const templateHalls = ((p.template_summary || {}).halls || []);
  const total = p.total_beds || 0;
  const placed = p.placed || 0;
  const a = assignments;
  const capacity = templateHalls.reduce((s, h) => s + (h.capacity || 0), 0);
  const capacityFree = capacity ? Math.max(0, capacity - placed) : null;

  // Stats
  const assignedFemale = a.filter(x => x.gender === 'Female').length;
  const assignedMale = a.filter(x => x.gender === 'Male').length;
  const assignedTeams = new Set(a.map(x => x.account).filter(Boolean)).size;
  const female = rosterGenders.Female ?? assignedFemale;
  const male = rosterGenders.Male ?? assignedMale;
  const teams = roster.team_count ?? assignedTeams;
  const displayAssignmentLabel = (x) => {
    const team = x.team || x.account || '';
    const category = x.category || '';
    if (team && category && !String(team).endsWith(` ${category}`)) return `${team} ${category}`;
    return x.label || team || category || 'Unassigned';
  };
  const assignedByHallFloor = {};
  for (const x of a) {
    const hall = x.hall || x.sheet || '';
    const floor = x.floor != null ? String(x.floor) : '';
    if (!assignedByHallFloor[hall]) assignedByHallFloor[hall] = {};
    assignedByHallFloor[hall][floor] = (assignedByHallFloor[hall][floor] || 0) + 1;
  }
  const capacityRows = templateHalls.map(h => {
    const assigned = Object.values(assignedByHallFloor[h.name] || {}).reduce((s, n) => s + n, 0);
    const floorUsage = Object.entries(h.floors || {})
      .sort((a,b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([fl, cap]) => `F${escape(fl)}: ${assignedByHallFloor[h.name]?.[fl] || 0}/${cap}`)
      .join(' ');
    return `<tr>
      <td><strong>${escape(h.name)}</strong>${h.is_staff_hall ? ' <span class="badge warn">staff</span>' : ''}</td>
      <td>${Object.keys(h.floors || {}).length}</td>
      <td>${h.capacity || 0}</td>
      <td>${assigned}</td>
      <td>${Math.max(0, (h.capacity || 0) - assigned)}</td>
      <td>${floorUsage}${(h.floorplans || []).length ? `<div class="vs-muted">${h.floorplans.length} floor plan${h.floorplans.length === 1 ? '' : 's'} on file</div>` : ''}</td>
      <td><span class="badge ${assigned > (h.capacity || 0) ? 'danger' : 'ok'}">${assigned > (h.capacity || 0) ? 'Over' : 'OK'}</span></td>
    </tr>`;
  }).join('');

  // Compliance categories
  const cats = [
    { key: 'occupancy_violations', name: 'Occupancy',    blocker: true },
    { key: 'bathroom_conflicts',   name: 'Bathroom',     blocker: true },
    { key: 'chaperone_gaps',       name: 'Chaperone',    blocker: false },
    { key: 'staff_separation',     name: 'Staff Sep',    blocker: true },
    { key: 'room_school_mix',      name: 'School Mix',   blocker: true },
    { key: 'mixed_gender_floor',   name: 'Gender Floor', blocker: false },
    { key: 'team_splits',          name: 'Team Splits',  blocker: false },
  ];
  const blockers = cats.filter(c2 => c2.blocker && (c[c2.key] || []).length > 0);
  const complianceCards = cats.map(c2 => {
    const items = c[c2.key] || [];
    const cls = items.length === 0 ? 'pass' : (c2.blocker ? 'danger' : 'warn');
    const status = items.length === 0 ? 'Pass' : (c2.blocker ? 'Action' : 'Info');
    return `<div class="cc ${cls}">
      <div class="name">${c2.name}</div>
      <div class="count">${items.length}</div>
      <div class="status">${status}</div>
    </div>`;
  }).join('');

  // Hall breakdown
  const bySheetFloor = {};
  for (const x of a) {
    const hallName = x.hall || x.sheet;
    if (!bySheetFloor[hallName]) bySheetFloor[hallName] = {};
    const fl = x.floor != null ? String(x.floor) : '?';
    if (!bySheetFloor[hallName][fl]) bySheetFloor[hallName][fl] = {};
    const label = displayAssignmentLabel(x);
    bySheetFloor[hallName][fl][label] = (bySheetFloor[hallName][fl][label] || 0) + 1;
  }
  const hallPanels = Object.entries(bySheetFloor).map(([hall, floors]) => {
    const totalBeds = Object.values(floors).reduce((s, f) => s + Object.values(f).reduce((a,b)=>a+b,0), 0);
    const floorBlocks = Object.entries(floors)
      .sort((a,b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([fl, labels]) => {
        const rows = Object.entries(labels).sort((a,b) => b[1]-a[1])
          .map(([lbl, n]) => `<div class="team-row"><span class="team-name">${escape(lbl)}</span><span class="team-count">${n}</span></div>`).join('');
        return `<div class="vs-floor"><div class="floor-head">Floor ${escape(fl)}</div>${rows}</div>`;
      }).join('');
    return `<div class="vs-hall-panel">
      <div class="hall-head">${escape(hall)} <span class="count">${totalBeds}</span></div>
      ${floorBlocks}
    </div>`;
  }).join('');

  const assignmentControls = (x, idx) => {
    const editable = !p.is_approved;
    const genderSel = editable
      ? `<select data-idx="${idx}" data-field="gender" class="vs-mini-sel">
           <option value="Female" ${x.gender === 'Female' ? 'selected':''}>F</option>
           <option value="Male" ${x.gender === 'Male' ? 'selected':''}>M</option>
         </select>`
      : `<span class="badge ${x.gender === 'Male' ? 'warn' : ''}">${x.gender === 'Male' ? 'M' : 'F'}</span>`;
    const catSel = editable
      ? `<select data-idx="${idx}" data-field="category" class="vs-mini-sel">
           ${['Athlete','Coach','Chaperone','Staff','Other'].map(c2 =>
             `<option value="${c2}" ${x.category === c2 ? 'selected':''}>${c2}</option>`).join('')}
         </select>`
      : `<span class="badge">${escape(x.category)}</span>`;
    return { catSel, genderSel };
  };

  // Grouped bed-by-bed editable review, arranged like the approval breakdown.
  const bedGroups = {};
  a.forEach((x, idx) => {
    const hall = x.hall || x.sheet || 'Unassigned Hall';
    const floor = x.floor != null ? String(x.floor) : '?';
    if (!bedGroups[hall]) bedGroups[hall] = {};
    if (!bedGroups[hall][floor]) bedGroups[hall][floor] = [];
    bedGroups[hall][floor].push({ ...x, _idx: idx });
  });
  const groupedBedPanels = Object.entries(bedGroups).map(([hall, floors]) => {
    const hallTotal = Object.values(floors).reduce((s, rows) => s + rows.length, 0);
    const floorBlocks = Object.entries(floors)
      .sort((a,b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([fl, rows]) => {
        const bedItems = rows
          .sort((a,b) => String(a.room_id || '').localeCompare(String(b.room_id || ''), undefined, { numeric: true }))
          .map(x => {
            const { catSel, genderSel } = assignmentControls(x, x._idx);
            return `<div class="vs-bed-row">
              <span class="room">${escape(x.room_id || '')}</span>
              <span class="team">${escape(x.team || x.account || '')}</span>
              <span class="role">${catSel}</span>
              <span class="gender">${genderSel}</span>
            </div>`;
          }).join('');
        return `<div class="vs-floor">
          <div class="floor-head">Floor ${escape(fl)} <span>${rows.length} beds</span></div>
          <div class="vs-bed-list">${bedItems}</div>
        </div>`;
      }).join('');
    return `<div class="vs-hall-panel">
      <div class="hall-head">${escape(hall)} <span class="count">${hallTotal}</span></div>
      ${floorBlocks}
    </div>`;
  }).join('');

  // Bed-by-bed editable table (if not approved)
  const bedRows = a.map((x, idx) => {
    const { catSel, genderSel } = assignmentControls(x, idx);
    return `<tr>
      <td>${escape(x.hall || x.sheet || '')}</td>
      <td>${escape(x.floor || '')}</td>
      <td>${escape(x.room_id || '')}</td>
      <td>${escape(x.team || x.account || '')}</td>
      <td>${catSel}</td>
      <td>${genderSel}</td>
    </tr>`;
  }).join('');

  // Conflicts with fixes
  const fixesMap = {
    bathroom_conflicts: ['Reassign one occupant to keep pod single-gender', 'Swap with same-gender team nearby', 'Designate buffer room'],
    chaperone_gaps: ['Move a Coach/Chaperone to this floor', 'Relocate athletes to a floor with adults', 'Add staff supervisor'],
    staff_separation: ['Move staff to staff hall', 'Move non-staff to team hall', 'Designate suite as staff-only'],
    occupancy_violations: ['Split team across floors', 'Move smallest team to spare hall', 'Reduce buffer allocations'],
    room_school_mix: ['Reassign smaller school occupant to next room', 'Insert buffer between schools', 'Move smaller team to different floor'],
    mixed_gender_floor: ['Relocate minority gender to single-gender floor', 'Swap with same-gender team', 'Informational only — accept if roster mix requires'],
    team_splits: ['Acceptable for large teams', 'Verify chaperone coverage on each floor', 'Move smaller subset to consolidate'],
  };
  const conflictSections = cats.filter(c2 => (c[c2.key] || []).length > 0).map(c2 => {
    const items = c[c2.key];
    const cls = c2.blocker ? 'danger' : 'warn';
    return `<div class="vs-conflict-section ${cls}">
      <div class="head">${c2.name} · ${items.length}</div>
      ${items.map(it => `
        <div class="vs-conflict-item">
          <div class="msg">${escape(it)}</div>
          <ul class="fixes">${(fixesMap[c2.key] || []).map(f => `<li>${escape(f)}</li>`).join('')}</ul>
        </div>
      `).join('')}
    </div>`;
  }).join('');

  $('review-body').innerHTML = `
    <div class="vs-stats" style="margin-bottom: 16px;">
      <div class="vs-stat"><div class="label">Teams</div><div class="value">${teams}</div></div>
      <div class="vs-stat"><div class="label">Total Beds</div><div class="value">${total}</div></div>
      <div class="vs-stat"><div class="label">Assigned</div><div class="value ${placed===total?'ok':'warn'}">${placed}</div><div class="sub">of ${total}</div></div>
      ${capacityFree == null ? '' : `<div class="vs-stat"><div class="label">Capacity Free</div><div class="value">${capacityFree}</div><div class="sub">of ${capacity}</div></div>`}
      <div class="vs-stat"><div class="label">Female</div><div class="value">${female}</div></div>
      <div class="vs-stat"><div class="label">Male</div><div class="value">${male}</div></div>
      <div class="vs-stat"><div class="label">Status</div><div class="value">${p.is_approved ? '✓ Approved' : 'Draft'}</div></div>
    </div>

    ${capacityRows ? `<div class="vs-panel" style="margin-bottom: 16px;">
      <div class="vs-panel-head"><h2>Dorm &amp; Floor Capacity</h2></div>
      <div class="vs-panel-body no-pad">
        <table class="vs-table zebra">
          <thead><tr><th>Hall</th><th>Floors</th><th>Capacity</th><th>Assigned</th><th>Remaining</th><th>Per-Floor Usage</th><th>Status</th></tr></thead>
          <tbody>${capacityRows}</tbody>
        </table>
      </div>
    </div>` : ''}

    <div class="vs-panel" style="margin-bottom: 16px;">
      <div class="vs-panel-head"><h2>Compliance Report</h2>
        ${blockers.length === 0 ? '<div class="right"><span class="vs-pill ok"><span class="dot"></span>All blockers clear</span></div>'
                                : `<div class="right"><span class="vs-pill danger"><span class="dot"></span>${blockers.length} blocker(s)</span></div>`}
      </div>
      <div class="vs-panel-body no-pad">
        <div class="vs-compliance">${complianceCards}</div>
        ${conflictSections ? `<div style="padding: 12px; border-top: 1px solid var(--vs-border);">${conflictSections}</div>` : ''}
      </div>
    </div>

    <div class="vs-panel" style="margin-bottom: 16px;">
      <div class="vs-panel-head"><h2>Placeholder Assignments — Ready for Approval</h2></div>
      <div class="vs-panel-body">
        <div class="vs-alert info">Team placeholders only. Participant names are written after approval when you finalize with names.</div>
        <div class="vs-placement-grid">${hallPanels || '<div class="vs-alert warn">No placeholder assignments were created. Check that the location template has RoomID, Floor, and Group/School columns with usable room rows.</div>'}</div>
      </div>
    </div>

    <details class="vs-disclosure">
      <summary>Team Headcount Breakdown · ${teams} teams</summary>
      <div class="vs-two-col">
        ${(roster.by_team || []).map(([team, n]) => `<div class="team-row"><span class="team-name">${escape(team)}</span><span class="team-count">${n}</span></div>`).join('')}
      </div>
    </details>

    <details class="vs-disclosure">
      <summary>Grouped Bed-by-bed Review${p.is_approved ? '' : ' (editable)'} · ${a.length} beds</summary>
      <div>
        <div class="vs-placement-grid">${groupedBedPanels || '<div class="vs-alert warn">No bed assignments to review yet.</div>'}</div>
      </div>
    </details>

    <details class="vs-disclosure">
      <summary>Bed-by-bed Review${p.is_approved ? '' : ' (editable)'} · ${a.length} beds</summary>
      <div style="max-height: 600px; overflow:auto;">
        <table class="vs-table zebra">
          <thead><tr><th>Hall</th><th>Floor</th><th>Room</th><th>Team</th><th>Role</th><th>Gender</th></tr></thead>
          <tbody>${bedRows}</tbody>
        </table>
      </div>
    </details>
  `;

  // Wire up bed-by-bed editors
  if (!p.is_approved) {
    document.querySelectorAll('.vs-mini-sel').forEach(sel => {
      sel.onchange = async (e) => {
        const idx = parseInt(e.target.dataset.idx, 10);
        const field = e.target.dataset.field;
        const body = {}; body[field] = e.target.value;
        const r = await api(`/api/placements/${p.id}/assignments/${idx}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!r || !r.ok) alert('Failed to update');
      };
    });
  }
}

/* =====================================================
   Approval + Finalize actions
   ===================================================== */
function renderApprovalActions(p) {
  const cats = [
    'occupancy_violations', 'bathroom_conflicts', 'staff_separation', 'room_school_mix'
  ];
  const blockers = cats.reduce((s, k) => s + ((p.compliance && p.compliance[k]) || []).length, 0);

  let html = '';
  if (!p.is_approved) {
    html = `<button class="vs-btn vs-btn-gold" id="approve-btn" ${blockers > 0 ? 'disabled' : ''}>
      ${blockers > 0 ? `Resolve ${blockers} blocker(s) to approve` : 'Approve Placeholder'}
    </button>`;
    if (p.output_file_id) html += ` <a class="vs-btn vs-btn-secondary" href="/api/files/${p.output_file_id}">Download Placeholder (preview)</a>`;
    setStepStatus('step-finalize', 'status-finalize', 'pending approval', 'enable');
  } else if (!p.finalized_at) {
    html = `<span class="vs-pill ok" style="margin-right: 10px;"><span class="dot"></span>Approved ${fmtDate(p.approved_at)}</span>
      <button class="vs-btn vs-btn-gold" id="finalize-btn">Finalize with Names &amp; Export</button>
      ${p.output_file_id ? ` <a class="vs-btn vs-btn-secondary" href="/api/files/${p.output_file_id}">Download Placeholder</a>` : ''}`;
    setStepStatus('step-finalize', 'status-finalize', 'ready to finalize', 'enable');
  } else {
    html = `<span class="vs-pill ok" style="margin-right: 10px;"><span class="dot"></span>Finalized ${fmtDate(p.finalized_at)}</span>
      <a class="vs-btn vs-btn-gold" href="/api/files/${p.final_file_id}">Download Final Workbook</a>
      ${p.output_file_id ? ` <a class="vs-btn vs-btn-secondary" href="/api/files/${p.output_file_id}">Download Placeholder</a>` : ''}`;
    setStepStatus('step-finalize', 'status-finalize', 'complete', 'done');
  }
  $('approval-actions').innerHTML = html;
  if ($('approve-btn')) $('approve-btn').onclick = approvePlacement;
  if ($('finalize-btn')) $('finalize-btn').onclick = finalizePlacement;
}

async function approvePlacement() {
  if (!state.placement) return;
  if (!confirm('Approve this placeholder layout? You will not be able to edit gender/role assignments after this, but you can still finalize with names.')) return;
  const r = await api(`/api/placements/${state.placement.id}/approve`, { method: 'POST' });
  if (!r) return;
  const d = await r.json();
  if (!r.ok) { alert(d.error || 'Failed to approve'); return; }
  await loadPlacement();
}

async function finalizePlacement() {
  if (!state.placement) return;
  $('finalize-status').innerHTML = '<div class="vs-alert info"><span class="vs-spinner"></span>Writing names into approved placeholder…</div>';
  const r = await api(`/api/placements/${state.placement.id}/finalize`, { method: 'POST' });
  if (!r) return;
  const d = await r.json();
  if (!r.ok) {
    $('finalize-status').innerHTML = `<div class="vs-alert danger">Finalize failed: ${escape(d.error || 'unknown')}</div>`;
    return;
  }
  $('finalize-status').innerHTML = `<div class="vs-alert ok">✓ Final workbook ready (${d.filled} beds filled).</div>`;
  await loadPlacement();
}

/* =====================================================
   Step nav state machine
   ===================================================== */
function setStepStatus(stepId, statusId, text, cls) {
  const step = $(stepId);
  const status = $(statusId);
  if (cls === 'done') { step.classList.remove('disabled'); status.className = 'vs-pill ok'; status.innerHTML = `<span class="dot"></span>${text}`; }
  else if (cls === 'enable') { step.classList.remove('disabled'); status.className = 'vs-pill'; status.innerHTML = `<span class="dot"></span>${text}`; }
  else if (cls === 'warn') { step.classList.remove('disabled'); status.className = 'vs-pill warn'; status.innerHTML = `<span class="dot"></span>${text}`; }
  else if (cls === 'danger') { step.classList.remove('disabled'); status.className = 'vs-pill danger'; status.innerHTML = `<span class="dot"></span>${text}`; }
  else { status.className = 'vs-pill'; status.innerHTML = `<span class="dot"></span>${text}`; }
  syncStepNav();
}

function syncStepNav() {
  const items = document.querySelectorAll('.vs-stepnav .step-item');
  items.forEach(it => { it.classList.remove('active', 'done', 'disabled'); });
  const set = (n, cls) => { const el = document.querySelector(`.vs-stepnav .step-item[data-step="${n}"]`); if (el) el.classList.add(cls); };

  const venueOK = !!state.selectedVenueId;
  const rawOK = !$('step-upload').classList.contains('disabled') && $('status-upload').classList.contains('ok');
  const placementDone = !!(state.placement && state.placement.id);
  const approved = !!(state.placement && state.placement.is_approved);
  const finalized = !!(state.placement && state.placement.finalized_at);

  if (venueOK) set(1, 'done'); else { set(1, 'active'); set(2,'disabled'); set(3,'disabled'); set(4,'disabled'); set(5,'disabled'); set(6,'disabled'); }
  if (venueOK && !rawOK) { set(2, 'active'); set(3,'disabled'); set(4,'disabled'); set(5,'disabled'); set(6,'disabled'); }
  else if (venueOK && rawOK) set(2, 'done');
  if (rawOK && !placementDone) { set(3, 'active'); set(4,'disabled'); set(5,'disabled'); set(6,'disabled'); }
  else if (placementDone) set(3, 'done');
  if (placementDone && !approved) { set(4, 'active'); set(5,'disabled'); set(6,'disabled'); }
  else if (approved) set(4, 'done');
  if (approved && !finalized) set(5, 'active');
  else if (finalized) { set(5, 'done'); set(6, 'done'); }

  // Step nav click handlers (jump to anchor)
  items.forEach(item => {
    item.onclick = () => {
      if (item.classList.contains('disabled')) return;
      const anchors = { '1': 'step-location', '2': 'step-upload', '3': 'step-review', '4': 'step-review', '5': 'step-finalize', '6': 'step-finalize' };
      const tgt = $(anchors[item.dataset.step]);
      if (tgt) tgt.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });

  // Header status pill
  const headerPill = $('ctx-status');
  if (!venueOK) { headerPill.className = 'vs-pill'; headerPill.innerHTML = '<span class="dot"></span>Awaiting Input'; }
  else if (!rawOK) { headerPill.className = 'vs-pill'; headerPill.innerHTML = '<span class="dot"></span>Awaiting Roster'; }
  else if (!placementDone) { headerPill.className = 'vs-pill'; headerPill.innerHTML = '<span class="dot"></span>Ready to Run'; }
  else if (!approved) { headerPill.className = 'vs-pill warn'; headerPill.innerHTML = '<span class="dot"></span>Pending Approval'; }
  else if (!finalized) { headerPill.className = 'vs-pill warn'; headerPill.innerHTML = '<span class="dot"></span>Approved – Pending Names'; }
  else { headerPill.className = 'vs-pill ok'; headerPill.innerHTML = '<span class="dot"></span>Complete'; }
}

bootstrap();
