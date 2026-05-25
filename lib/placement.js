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

module.exports = { runPlacement, computeStatus };
