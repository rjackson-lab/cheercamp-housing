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

  const mods = assignments.map(a => {
    const hall = halls.find(h => h.name === a.sheet);
    const colNum = hall && hall.cols['Group/School'];
    return colNum ? { sheet: a.sheet, row: a.row, col: colLetter(colNum), value: a.label } : null;
  }).filter(Boolean);

  const outputAB = await core.surgicalWrite(blankBuf, mods);
  const outputBuffer = Buffer.from(outputAB);

  return {
    beds: beds.length,
    placed: assignments.length,
    halls: halls.map(h => ({
      name: h.name,
      total_rooms: h.rooms.length,
      capacity: h.rooms.filter(r => !r.is_ra && !r.is_excluded).length
    })),
    assignments,
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

function headerMap(ws) {
  const out = {};
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
  const headerRow = 2;
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: headerRow, c })];
    if (cell && cell.v) out[String(cell.v).trim().toLowerCase()] = c;
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
  const rows = XLSX.utils.sheet_to_json(rawWB.Sheets[rawWB.SheetNames[0]], { defval: '' });
  const accounts = [...new Set(rows.map(r => String(r.Account || '').trim()).filter(Boolean))];
  const pools = {};

  for (const r of rows) {
    const account = String(r.Account || '').trim();
    if (!account) continue;
    const add = (first, last, role, gender) => {
      if (!role) return;
      const category = categoryForRole(String(role));
      const key = `${account}|${category}|${gender === 'Male' ? 'Male' : 'Female'}`;
      if (!pools[key]) pools[key] = [];
      pools[key].push({ account, first, last, role, category, gender: gender === 'Male' ? 'Male' : 'Female' });
    };
    add(r['Primary Guest First Name'], r['Primary Guest Last Name'], r['Primary Guest Role'], r['Primary Guest Gender']);
    if (Number(r.Occupancy) === 2) add(r['Guest 2 First'], r['Guest 2 Last'], r['Guest 2 Role'], r['Guest 2 Gender']);
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
    setCell(ws, a.row, headers['first name'] ?? headers['primary guest first name'], person.first);
    setCell(ws, a.row, headers['last name'] ?? headers['primary guest last name'], person.last);
    setCell(ws, a.row, headers['gender'] ?? headers['primary guest gender'], person.gender);
    setCell(ws, a.row, headers['role'] ?? headers['primary guest role'], person.role);
    setCell(ws, a.row, headers['group/school'] ?? headers['school'] ?? headers['account'], account);
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
