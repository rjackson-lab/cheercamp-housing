const $ = (id) => document.getElementById(id);
const locationId = parseInt(window.location.pathname.split('/').pop(), 10);
let me = null;
let placementState = null;

function fmtDate(ts) { return ts ? new Date(ts).toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }) : '—'; }
function escape(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
async function api(p, o) {
  const r = await fetch(p, o);
  if (r.status === 401) { window.location.href = '/'; return null; }
  return r;
}

async function loadMe() {
  const r = await api('/api/me'); if (!r) return;
  const d = await r.json();
  me = d.user;
  $('user-name').textContent = me.name;
}

async function loadLocation() {
  const r = await api(`/api/locations/${locationId}`);
  if (!r) return;
  if (r.status === 403) { document.body.innerHTML = '<div style="padding:50px;text-align:center;">No access to this location.</div>'; return; }
  const { location, files, placements, members } = await r.json();

  $('header-block').innerHTML = `
    <div class="vs-flex-between vs-mb-lg">
      <div>
        <h1 style="margin:0; font-size:22px; color:var(--vs-navy);">${escape(location.name)}</h1>
        ${location.description ? `<div class="vs-muted" style="font-size:13px; margin-top:4px;">${escape(location.description)}</div>` : ''}
        <div class="vs-muted" style="font-size:11px; margin-top:6px;">Created by ${escape(location.created_by_name || '—')}</div>
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        <span class="vs-status ${location.status}" style="font-size:11px;">${location.status.replace('_',' ')}</span>
        <button class="vs-btn vs-btn-sm vs-btn-secondary" id="edit-loc-btn">Edit</button>
      </div>
    </div>
  `;
  $('edit-loc-btn').onclick = () => {
    $('edit-name').value = location.name;
    $('edit-desc').value = location.description || '';
    $('modal-edit-loc').classList.remove('hidden');
  };

  // File slots
  const grouped = { raw:[], blank:[], reference:[], floorplan:[], output:[] };
  for (const f of files) grouped[f.kind].push(f);
  $('status-raw').innerHTML = grouped.raw.length ? `<strong>${escape(grouped.raw[0].filename)}</strong>` : '<em>No file</em>';
  $('status-blank').innerHTML = grouped.blank.length ? `<strong>${escape(grouped.blank[0].filename)}</strong>` : '<em>No file</em>';
  $('status-reference').innerHTML = grouped.reference.length ? `<strong>${escape(grouped.reference[0].filename)}</strong>` : '<em>No file</em>';
  $('status-floorplan').innerHTML = `${grouped.floorplan.length} file(s)`;

  const allDataFiles = [...grouped.raw, ...grouped.blank, ...grouped.reference, ...grouped.floorplan];
  $('files-table-block').innerHTML = allDataFiles.length ? `
    <div class="vs-table-scroll" style="margin-top:14px;"><table class="vs-table">
      <thead><tr><th>Kind</th><th>Filename</th><th>Size</th><th>Uploaded</th><th class="vs-actions"></th></tr></thead>
      <tbody>${allDataFiles.map(f => `
        <tr>
          <td><span class="vs-status ${f.kind==='raw'?'in_process':'not_started'}">${f.kind}</span></td>
          <td>${escape(f.filename)}</td>
          <td class="vs-muted">${(f.size_bytes/1024).toFixed(1)} KB</td>
          <td class="vs-muted">${fmtDate(f.uploaded_at)}</td>
          <td class="vs-actions">
            <a class="vs-btn vs-btn-sm vs-btn-secondary" href="/api/files/${f.id}">Download</a>
            <button class="vs-btn vs-btn-sm vs-btn-danger" data-del-file="${f.id}">Remove</button>
          </td>
        </tr>`).join('')}</tbody>
    </table></div>` : '';
  document.querySelectorAll('button[data-del-file]').forEach(b => {
    b.onclick = async () => { if (!confirm('Remove this file?')) return; await api(`/api/files/${b.dataset.delFile}`, { method:'DELETE' }); loadLocation(); };
  });

  $('run-btn').disabled = !(grouped.raw.length && grouped.blank.length);

  // Latest placement
  if (placements.length > 0) await loadPlacement();
  else { $('review-panel').classList.add('hidden'); $('finalize-panel').classList.add('hidden'); }

  // Run history
  if (placements.length > 1) {
    $('history-panel').classList.remove('hidden');
    $('history-body').innerHTML = `
      <div class="vs-table-scroll"><table class="vs-table">
        <thead><tr><th>Run At</th><th>Placed</th><th>Status</th><th class="vs-actions"></th></tr></thead>
        <tbody>${placements.map(p => `
          <tr>
            <td>${fmtDate(p.run_at)}</td>
            <td>${p.placed}/${p.total_beds}</td>
            <td>
              ${p.finalized_at ? '<span class="vs-status completed">finalized</span>' : (p.is_approved ? '<span class="vs-status in_process">approved</span>' : '<span class="vs-status not_started">draft</span>')}
            </td>
            <td class="vs-actions">
              ${p.output_file_id ? `<a class="vs-btn vs-btn-sm vs-btn-secondary" href="/api/files/${p.output_file_id}">Placeholder</a>` : ''}
              ${p.final_file_id ? `<a class="vs-btn vs-btn-sm vs-btn-gold" href="/api/files/${p.final_file_id}">Final</a>` : ''}
            </td>
          </tr>`).join('')}</tbody>
      </table></div>
    `;
  } else $('history-panel').classList.add('hidden');

  // Members panel
  $('members-panel').classList.remove('hidden');
  $('members-body').innerHTML = `
    <div style="margin-bottom:12px;">
      <strong>Shared with:</strong>
      ${members.length === 0 ? ' <span class="vs-muted">no one</span>' : ''}
      <ul style="margin:8px 0 0 0; padding:0; list-style:none;">
        ${members.map(m => `<li style="padding:6px 0; border-bottom:1px solid var(--vs-border);">
          ${escape(m.name)} <span class="vs-muted">(${escape(m.email)})</span>
          <button class="vs-btn vs-btn-sm vs-btn-danger" data-remove-member="${m.id}" style="float:right;">Remove</button>
        </li>`).join('')}
      </ul>
    </div>
    <form id="add-member-form" style="display:flex; gap:8px; flex-wrap:wrap;">
      <input type="email" class="vs-input" id="member-email" placeholder="Email of approved user" style="flex:1; min-width:200px;">
      <button class="vs-btn vs-btn-sm" type="submit">Grant access</button>
    </form>
  `;
  $('add-member-form').onsubmit = async (e) => {
    e.preventDefault();
    const r = await api(`/api/locations/${locationId}/members`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: $('member-email').value }) });
    const d = await r.json();
    if (!r.ok) alert(d.error || 'Failed'); else loadLocation();
  };
  document.querySelectorAll('button[data-remove-member]').forEach(b => {
    b.onclick = async () => { await api(`/api/locations/${locationId}/members/${b.dataset.removeMember}`, { method:'DELETE' }); loadLocation(); };
  });
}

async function loadPlacement() {
  const r = await api(`/api/locations/${locationId}/placement`);
  if (!r) return;
  const { placement } = await r.json();
  placementState = placement;
  if (!placement) return;
  renderReview(placement);
}

function renderReview(p) {
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
  const blockerKeys = ['Occupancy','Bathroom','Staff Sep','School Mix'];
  const blockerCount = checks.filter(([l,a]) => blockerKeys.includes(l) && a.length).length;

  $('review-panel').classList.remove('hidden');

  // Action buttons depend on approval state
  let actions = '';
  if (!p.is_approved) {
    actions = `<button class="vs-btn vs-btn-gold" id="approve-btn" ${blockerCount > 0 ? 'disabled' : ''}>Approve Placeholder</button>`;
  } else {
    actions = `<span class="vs-status completed" style="margin-right:10px;">✓ Approved ${fmtDate(p.approved_at)}</span>`;
    if (me.role === 'admin') actions += `<button class="vs-btn vs-btn-sm vs-btn-secondary" id="unapprove-btn">Unapprove</button>`;
  }
  $('review-actions').innerHTML = actions;
  if ($('approve-btn')) $('approve-btn').onclick = () => approvePlacement(p.id);
  if ($('unapprove-btn')) $('unapprove-btn').onclick = () => unapprovePlacement(p.id);

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
        const bg = arr.length===0 ? 'var(--vs-success-bg)' : (isBlocker ? 'var(--vs-error-bg)' : 'var(--vs-warn-bg)');
        const color = arr.length===0 ? 'var(--vs-success)' : (isBlocker ? 'var(--vs-error)' : 'var(--vs-warn)');
        return `<div style="background:${bg}; padding:10px; border-radius:4px;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--vs-text-mute);">${label}</div>
          <div style="font-size:22px;font-weight:800;color:${color};line-height:1.2;">${arr.length}</div>
          <div style="font-size:10px;color:var(--vs-text-mute);text-transform:uppercase;letter-spacing:0.06em;">${arr.length===0?'pass':(isBlocker?'blocker':'info')}</div>
        </div>`;
      }).join('')}
    </div>
    ${checks.filter(([l,a]) => a.length > 0).map(([l,a]) => `
      <details style="margin-bottom:8px;">
        <summary style="cursor:pointer; font-size:12px; font-weight:600; color:var(--vs-navy); padding:6px 0;">${l} (${a.length})</summary>
        <ul style="font-size:12px;color:var(--vs-text-mute);margin:4px 0 8px 18px;">${a.map(x=>`<li>${escape(x)}</li>`).join('')}</ul>
      </details>`).join('')}
  `;

  // === Review table — every bed, with Gender + Role columns ===
  const a = p.assignments || [];
  const bySheet = {};
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; x._idx = i;
    if (!bySheet[x.sheet]) bySheet[x.sheet] = [];
    bySheet[x.sheet].push(x);
  }
  const placeholderFileLink = p.output_file_id ? `<a class="vs-btn vs-btn-sm vs-btn-secondary" href="/api/files/${p.output_file_id}">Download placeholder .xlsx</a>` : '';

  $('review-body').innerHTML = `
    ${blockerCount > 0 ? `<div class="vs-alert error">⚠ ${blockerCount} blocker violation(s). Resolve before approving.</div>` : ''}
    ${(p.warnings && p.warnings.length) ? `<div class="vs-alert warn">${p.warnings.map(escape).join('<br>')}</div>` : ''}
    <div style="margin-bottom:14px;">${placeholderFileLink}</div>
    <h3 class="vs-section-title">Bed-by-bed Review</h3>
    <div style="font-size:12px; color:var(--vs-text-mute); margin-bottom:8px;">
      Verify gender (M/F) and role (Athlete / Coach / Chaperone) before approving.
      ${p.is_approved ? 'Approved placements are locked.' : 'Click any cell to override.'}
    </div>
    <div class="vs-flex" style="gap:8px; margin-bottom:10px; flex-wrap:wrap;">
      <input type="search" class="vs-input" id="review-search" placeholder="Search team, room, or hall…" style="flex:1; min-width:200px; padding:8px 10px; font-size:13px;">
      <select class="vs-select" id="review-team-filter" style="width:auto; padding:8px 10px; font-size:13px;"><option value="">All teams</option>${[...new Set(a.map(x=>x.team))].sort().map(t => `<option value="${escape(t)}">${escape(t)}</option>`).join('')}</select>
    </div>
    <div class="vs-table-scroll"><table class="vs-table" id="review-table">
      <thead><tr>
        <th>Hall</th><th>Floor</th><th>Pod</th><th>Room</th><th>Gender</th><th>Role</th><th>Team</th>
      </tr></thead>
      <tbody>${a.map(x => reviewRow(x, p.is_approved)).join('')}</tbody>
    </table></div>
  `;

  $('review-search').oninput = filterReviewTable;
  $('review-team-filter').onchange = filterReviewTable;

  // Cell editing handlers (only if not approved)
  if (!p.is_approved) {
    document.querySelectorAll('select[data-idx][data-field]').forEach(sel => {
      sel.onchange = async () => {
        const idx = parseInt(sel.dataset.idx);
        const field = sel.dataset.field;
        const body = {}; body[field] = sel.value;
        const r = await api(`/api/placements/${p.id}/assignments/${idx}`, {
          method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
        });
        if (!r.ok) { alert('Update failed'); return; }
        // Re-run compliance check by refreshing placement
        await loadPlacement();
      };
    });
  }

  // Finalize panel
  if (p.is_approved) {
    $('finalize-panel').classList.remove('hidden');
    if (p.final_file_id) {
      $('finalize-body').innerHTML = `
        <div class="vs-alert success">✓ Finalized ${fmtDate(p.finalized_at)}</div>
        <a class="vs-btn vs-btn-gold" href="/api/files/${p.final_file_id}">Download Final Roster (with names)</a>
      `;
    } else {
      $('finalize-body').innerHTML = `
        <div class="vs-alert info">Placeholder approved. Click below to fill in real names from the raw roster.</div>
        <button class="vs-btn vs-btn-gold" id="finalize-btn">Finalize with Names</button>
      `;
      $('finalize-btn').onclick = () => finalize(p.id);
    }
  } else {
    $('finalize-panel').classList.add('hidden');
  }
}

function reviewRow(x, locked) {
  const genderOpts = ['Female','Male'].map(g => `<option value="${g}"${g===x.gender?' selected':''}>${g[0]}</option>`).join('');
  const roleOpts = ['Athlete','Coach','Chaperone','Staff','Other'].map(c => `<option value="${c}"${c===x.category?' selected':''}>${c}</option>`).join('');
  return `<tr data-search="${escape((x.team+' '+x.room_id+' '+x.sheet).toLowerCase())}" data-team="${escape(x.team)}">
    <td>${escape(x.sheet.replace(' Hall',''))}</td>
    <td>${x.floor}</td>
    <td>${escape(x.suite_id || '-')}</td>
    <td><strong>${escape(x.room_id || '-')}</strong></td>
    <td>${locked ? (x.gender === 'Male' ? 'M' : 'F') : `<select class="vs-mini-select" data-idx="${x._idx}" data-field="gender">${genderOpts}</select>`}</td>
    <td>${locked ? escape(x.category) : `<select class="vs-mini-select" data-idx="${x._idx}" data-field="category">${roleOpts}</select>`}</td>
    <td>${escape(x.team)}</td>
  </tr>`;
}

function filterReviewTable() {
  const q = $('review-search').value.toLowerCase();
  const team = $('review-team-filter').value;
  document.querySelectorAll('#review-table tbody tr').forEach(tr => {
    const matchQ = !q || tr.dataset.search.includes(q);
    const matchT = !team || tr.dataset.team === team;
    tr.style.display = (matchQ && matchT) ? '' : 'none';
  });
}

async function approvePlacement(id) {
  if (!confirm('Approve this placeholder? After approval the bed assignments are locked and you can finalize with real names.')) return;
  const r = await api(`/api/placements/${id}/approve`, { method:'POST' });
  if (r.ok) loadPlacement();
}

async function unapprovePlacement(id) {
  if (!confirm('Unapprove? This will unlock the placement for editing.')) return;
  const r = await api(`/api/placements/${id}/unapprove`, { method:'POST' });
  if (r.ok) loadPlacement();
}

async function finalize(id) {
  if (!confirm('Generate the final roster with real participant names?')) return;
  const btn = $('finalize-btn');
  btn.disabled = true; btn.textContent = 'Generating…';
  const r = await api(`/api/placements/${id}/finalize`, { method:'POST' });
  const d = await r.json();
  if (!r.ok) { alert(d.error || 'Finalize failed'); btn.disabled = false; btn.textContent = 'Finalize with Names'; return; }
  loadLocation();
}

// File uploads
document.querySelectorAll('button[data-upload]').forEach(btn => {
  btn.onclick = () => document.querySelector(`input[data-kind="${btn.dataset.upload}"]`).click();
});
document.querySelectorAll('input.file-input').forEach(inp => {
  inp.onchange = async () => {
    if (!inp.files?.[0]) return;
    const fd = new FormData();
    fd.append('file', inp.files[0]);
    fd.append('kind', inp.dataset.kind);
    const r = await api(`/api/locations/${locationId}/files`, { method:'POST', body: fd });
    if (r.ok) { inp.value=''; loadLocation(); }
    else { const d = await r.json(); alert(d.error || 'Upload failed'); }
  };
});

// Run
$('run-btn').onclick = async () => {
  $('run-btn').disabled = true; $('run-btn').textContent = 'Running…';
  $('run-results').innerHTML = '<div class="vs-alert info">Running placement engine…</div>';
  const r = await api(`/api/locations/${locationId}/run`, { method:'POST' });
  $('run-btn').textContent = 'Run Placement Engine'; $('run-btn').disabled = false;
  if (!r) return;
  const d = await r.json();
  if (!d.ok) { $('run-results').innerHTML = `<div class="vs-alert error">Placement failed: ${escape(d.message || d.error)}</div>`; return; }
  loadLocation();
};

// Edit modal
$('edit-cancel').onclick = () => $('modal-edit-loc').classList.add('hidden');
$('edit-save').onclick = async () => {
  const r = await api(`/api/locations/${locationId}`, {
    method:'PATCH', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name: $('edit-name').value, description: $('edit-desc').value })
  });
  if (r.ok) { $('modal-edit-loc').classList.add('hidden'); loadLocation(); }
};

// Delete
$('delete-loc').onclick = async () => {
  if (!confirm('Delete this location and all its files permanently?')) return;
  const r = await api(`/api/locations/${locationId}`, { method:'DELETE' });
  if (r.ok) window.location.href = '/';
};

// ===== AI Chat =====
$('open-chat-btn').onclick = () => { $('chat-drawer').classList.remove('hidden'); loadChat(); };
$('close-chat').onclick = () => $('chat-drawer').classList.add('hidden');

async function loadChat() {
  const r = await api(`/api/locations/${locationId}/chat`);
  if (!r) return;
  const { messages, ai_configured } = await r.json();
  const box = $('chat-messages');
  if (!ai_configured) {
    box.innerHTML = '<div class="vs-chat-empty">AI chat is not configured on this server. Set ANTHROPIC_API_KEY env var to enable.</div>';
    return;
  }
  if (messages.length === 0) {
    box.innerHTML = '<div class="vs-chat-empty">Ask about the placement or describe a change you need.</div>';
    return;
  }
  box.innerHTML = messages.map(renderMsg).join('');
  box.scrollTop = box.scrollHeight;
}

function renderMsg(m) {
  return `<div class="vs-chat-msg vs-chat-${m.role}">
    <div class="vs-chat-bubble">${escape(m.content).replace(/\n/g,'<br>')}</div>
  </div>`;
}

function renderProposedChanges(changes, placementId) {
  if (!changes || changes.length === 0) return '';
  const rows = changes.map((c, i) => {
    if (c.op === 'swap') {
      return `<li>Swap occupants between <strong>${escape(c.fromRoom)}</strong> ↔ <strong>${escape(c.toRoom)}</strong>${c.reason ? ` — <em>${escape(c.reason)}</em>` : ''}</li>`;
    } else if (c.op === 'reassign') {
      const bits = [];
      if (c.newTeam) bits.push(`team → ${escape(c.newTeam)}`);
      if (c.newCategory) bits.push(`role → ${escape(c.newCategory)}`);
      if (c.newGender) bits.push(`gender → ${escape(c.newGender)}`);
      return `<li>Reassign <strong>${escape(c.room)}</strong>: ${bits.join(', ')}${c.reason ? ` — <em>${escape(c.reason)}</em>` : ''}</li>`;
    }
    return `<li>${escape(JSON.stringify(c))}</li>`;
  }).join('');
  return `
    <div class="vs-chat-changes" id="proposed-changes">
      <div class="vs-chat-changes-header">Proposed changes (${changes.length})</div>
      <ul class="vs-chat-changes-list">${rows}</ul>
      <div class="vs-chat-changes-actions">
        <button class="vs-btn vs-btn-sm vs-btn-secondary" id="dismiss-changes">Dismiss</button>
        <button class="vs-btn vs-btn-sm vs-btn-gold" id="apply-changes">Apply changes</button>
      </div>
    </div>`;
}

let pendingChanges = null;

async function applyChanges() {
  if (!pendingChanges || !placementState) return;
  if (placementState.is_approved) { alert('Placement is approved — cannot apply changes. Unapprove first.'); return; }
  const btn = $('apply-changes'); if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
  const r = await api(`/api/placements/${placementState.id}/apply-changes`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ changes: pendingChanges })
  });
  if (!r) return;
  const d = await r.json();
  const box = $('chat-messages');
  let summary;
  if (r.ok && d.applied > 0) {
    summary = `✓ Applied ${d.applied} change${d.applied===1?'':'s'}.`;
    if (d.skipped && d.skipped.length) summary += ` Skipped ${d.skipped.length} (${d.skipped.map(s=>s.reason).join(', ')}).`;
  } else {
    summary = `Could not apply: ${d.error || 'unknown error'}.`;
    if (d.skipped && d.skipped.length) summary += ' ' + d.skipped.map(s=>s.reason).join('; ');
  }
  box.innerHTML += renderMsg({ role: 'assistant', content: summary });
  pendingChanges = null;
  document.getElementById('proposed-changes')?.remove();
  box.scrollTop = box.scrollHeight;
  // Refresh the review table to show the new state
  if (r.ok && d.applied > 0) await loadPlacement();
}

$('chat-form').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('chat-text').value.trim();
  if (!text) return;
  const box = $('chat-messages');
  if (box.querySelector('.vs-chat-empty')) box.innerHTML = '';
  document.getElementById('proposed-changes')?.remove();
  pendingChanges = null;
  box.innerHTML += renderMsg({ role: 'user', content: text });
  box.innerHTML += '<div class="vs-chat-msg vs-chat-assistant" id="thinking"><div class="vs-chat-bubble"><em>Thinking…</em></div></div>';
  box.scrollTop = box.scrollHeight;
  $('chat-text').value = '';
  const r = await api(`/api/locations/${locationId}/chat`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message: text })
  });
  document.getElementById('thinking')?.remove();
  if (!r) return;
  const d = await r.json();
  const content = d.reply || d.error || 'No response';
  box.innerHTML += renderMsg({ role: 'assistant', content });
  if (d.changes && d.changes.length > 0) {
    pendingChanges = d.changes;
    box.innerHTML += renderProposedChanges(d.changes, placementState?.id);
    document.getElementById('apply-changes')?.addEventListener('click', applyChanges);
    document.getElementById('dismiss-changes')?.addEventListener('click', () => {
      pendingChanges = null;
      document.getElementById('proposed-changes')?.remove();
    });
  }
  box.scrollTop = box.scrollHeight;
};

(async () => { await loadMe(); await loadLocation(); })();
