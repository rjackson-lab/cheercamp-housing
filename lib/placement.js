/**
 * Placement engine for cheer camp housing.
 * Ported from the browser tool. Pure JS — uses XLSX + JSZip.
 */
const XLSX = require('xlsx');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

const coreSrc = fs.readFileSync(path.join(__dirname, '_placement_core.js'), 'utf8');
const core = (new Function(
  'XLSX', 'JSZip',
  coreSrc + '\nreturn { ingestRaw, parseTemplate, buildPlacements, checkCompliance, surgicalWrite, shortTeamName, labelToAccount, CATEGORY_ORDER };'
))(XLSX, JSZip);

function colLetter(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

async function runPlacement(rawBuf, blankBuf, referenceBuf) {
  const rawWB = XLSX.read(rawBuf, { type: 'buffer' });
  const blankWB = XLSX.read(blankBuf, { type: 'buffer', cellStyles: true });
  const refWB = referenceBuf ? XLSX.read(referenceBuf, { type: 'buffer', cellStyles: true }) : blankWB;

  const beds = core.ingestRaw(rawWB);
  const halls = core.parseTemplate(blankWB, refWB);
  const { assignments, warnings } = core.buildPlacements(beds, halls);
  const compliance = core.checkCompliance(halls, assignments, beds);
  const accounts = [...new Set(beds.map(b => b.account).filter(Boolean))];
  const enrichedAssignments = assignments.map(a => {
    const account = core.labelToAccount(String(a.label || a.team || ''), accounts);
    return {
      ...a,
      account: account || a.account || '',
      team: account || a.team || a.label || '',
      category: assignmentCategory(a)
    };
  });

  const mods = enrichedAssignments.map(a => {
    const hall = halls.find(h => h.name === a.sheet);
    const colNum = hall && hall.cols['Group/School'];
    return colNum ? { sheet: a.sheet, row: a.row, col: colLetter(colNum), value: a.label } : null;
  }).filter(Boolean);

  const outputAB = await core.surgicalWrite(blankBuf, mods);
  const outputBuffer = Buffer.from(outputAB);

  return {
    beds: beds.length,
    placed: assignments.length,
    halls: Object.values(halls.reduce((out, h) => {
      for (const room of h.rooms) {
        const name = room.hall_name || h.name;
        if (!out[name]) out[name] = { name, total_rooms: 0, capacity: 0, floors: {} };
        out[name].total_rooms += 1;
        if (!room.is_ra && !room.is_excluded) {
          out[name].capacity += 1;
          const floor = room.floor == null ? '' : String(room.floor);
          out[name].floors[floor] = (out[name].floors[floor] || 0) + 1;
        }
      }
      return out;
    }, {})),
    assignments: enrichedAssignments,
    warnings,
    compliance,
    outputBuffer
  };
}

function categoryForRole(role) {
  const map = {
    'Athlete/Team Member': 'Athlete',
    'Coach/Sponsor/Advisor': 'Coach',
    'Assistant/Skills Coach': 'Coach',
    'Skills/Assistant Coach': 'Coach',
    'Athletic Director': 'Coach',
    'Chaperone': 'Chaperone',
    'Camp Staff': 'Staff'
  };
  return map[role] || 'Other';
}

const OUTPUT_COLUMN_ALIASES = {
  first: ['first name', 'primary guest first name', 'participant first name', 'guest first name', 'first'],
  last: ['last name', 'primary guest last name', 'participant last name', 'guest last name', 'last'],
  gender: ['gender', 'primary guest gender', 'participant gender', 'guest gender', 'sex'],
  role: ['role', 'primary guest role', 'participant role', 'guest role', 'type'],
  group: ['group/school', 'school', 'account', 'team', 'group', 'organization', 'assigned to', 'placeholder']
};

function normalizeHeader(v) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ');
}

function headerMap(ws) {
  const out = {};
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 14); r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell || !cell.v) continue;
      const header = normalizeHeader(cell.v);
      for (const [key, aliases] of Object.entries(OUTPUT_COLUMN_ALIASES)) {
        if (out[key] == null && aliases.includes(header)) out[key] = c;
      }
      if (out[header] == null) out[header] = c;
    }
  }
  return out;
}

function setCell(ws, row1, colIndex, value) {
  if (colIndex === undefined) return;
  const addr = XLSX.utils.encode_cell({ r: row1 - 1, c: colIndex });
  ws[addr] = { t: 's', v: value == null ? '' : String(value) };
}

function participantPools(rawBuf, assignments) {
  const rawWB = XLSX.read(rawBuf, { type: 'buffer' });
  const beds = core.ingestRaw(rawWB);
  const accounts = [...new Set(beds.map(b => String(b.account || '').trim()).filter(Boolean))];
  const pools = {};

  for (const bed of beds) {
    const account = String(bed.account || '').trim();
    if (!account) continue;
    const category = bed.category || categoryForRole(String(bed.role || ''));
    const gender = bed.gender === 'Male' ? 'Male' : 'Female';
    const key = `${account}|${category}|${gender}`;
    if (!pools[key]) pools[key] = [];
    pools[key].push({ account, first: bed.first, last: bed.last, role: bed.role, category, gender });
  }

  return { pools, accounts };
}

function assignmentCategory(a) {
  if (a.category) return a.category;
  const label = String(a.label || '');
  for (const cat of core.CATEGORY_ORDER) {
    if (label.endsWith(` ${cat}`)) return cat;
  }
  return 'Other';
}

async function finalizeWithNames(rawBuf, placeholderBuf, assignments) {
  const { pools, accounts } = participantPools(rawBuf, assignments);
  const wb = XLSX.read(placeholderBuf, { type: 'buffer', cellStyles: true });

  for (const a of assignments || []) {
    const account = core.labelToAccount(String(a.team || a.label || ''), accounts);
    if (!account) continue;
    const category = assignmentCategory(a);
    const gender = a.gender === 'Male' ? 'Male' : 'Female';
    const person = (pools[`${account}|${category}|${gender}`] || pools[`${account}|${category}|Female`] || pools[`${account}|${category}|Male`] || []).shift();
    if (!person) continue;

    const ws = wb.Sheets[a.sheet];
    if (!ws) continue;
    const headers = headerMap(ws);
    setCell(ws, a.row, headers.first, person.first);
    setCell(ws, a.row, headers.last, person.last);
    setCell(ws, a.row, headers.gender, person.gender);
    setCell(ws, a.row, headers.role, person.role);
    setCell(ws, a.row, headers.group, account);
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}

function computeStatus(result) {
  const c = result.compliance || {};
  const blockers =
      (c.occupancy_violations || []).length
    + (c.bathroom_conflicts || []).length
    + (c.staff_separation || []).length
    + (c.room_school_mix || []).length;
  if (result.placed < result.beds) return 'errors';
  if (blockers > 0) return 'errors';
  const advisories = (c.team_splits || []).length + (c.mixed_gender_floor || []).length + (result.warnings || []).length;
  if (advisories > 0) return 'in_process';
  return 'completed';
}

module.exports = { runPlacement, computeStatus, finalizeWithNames };
