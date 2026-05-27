/* ============================================================
   ALGORITHM CONSTANTS (mirrors Python tool)
   ============================================================ */
const ROLE_CATEGORIES = {
  "Athlete/Team Member":    "Athlete",
  "Coach/Sponsor/Advisor":  "Coach",
  "Assistant/Skills Coach": "Coach",
  "Skills/Assistant Coach": "Coach",
  "Athletic Director":      "Coach",
  "Chaperone":              "Chaperone",
  "Camp Staff":             "Staff",
};
const CATEGORY_ORDER = ["Athlete", "Coach", "Chaperone", "Staff", "Other"];
const HEADER_ROW = 3;   // 1-indexed row that contains column headers
const TEAM_NAME_STRIP = /\b(High School|Charter High School|Prep School|Day School|Upper School|Jr\/Sr High School|Preparatory School|College Prep School|Sans Facon|School|Academy)\b/gi;
const ROOM_ID_RE = /^(?:[A-Za-z]{0,8}[-\s]*)?\d+[A-Za-z0-9-]*\s*(?:RA)?$/i;
const COLUMN_ALIASES = {
  RoomID: ['roomid', 'room id', 'room', 'room number', 'room #', 'room no', 'room no.', 'bedroom', 'bed', 'bed #', 'bed number', 'space', 'space id', 'assignment space', 'summary room space description', 'roomspace description', 'roomspace_description', 'room space description'],
  Hall: ['hall', 'dorm', 'dormitory', 'building', 'residence hall', 'res hall', 'facility'],
  Floor: ['floor', 'floor number', 'floor #', 'flr', 'level', 'building level'],
  Capacity: ['capacity', 'beds', 'bed count', 'number of beds', '# beds', 'spaces', 'sleeping spaces', 'occupancy capacity', 'max occupancy'],
  'Group/School': ['group/school', 'group school', 'school/group', 'school', 'group', 'account', 'team', 'organization', 'assignment', 'assigned to', 'placeholder', 'occupant', 'name', 'camp/team'],
  Notes: ['notes', 'note', 'comments', 'comment', 'room notes']
};
const RAW_COLUMN_ALIASES = {
  account: ['account', 'school', 'school name', 'team', 'team name', 'program', 'group', 'group/school', 'organization', 'customer account'],
  occupancy: ['occupancy', 'occ', 'room occupancy', 'rooming occupancy', 'number of guests', 'guest count'],
  early: ['early arrival/late departure', 'early/late', 'early arrival', 'late departure', 'early late'],
  pFirst: ['primary guest first name', 'primary first name', 'primary first', 'first name', 'first', 'participant first name', 'athlete first name', 'guest first name'],
  pLast: ['primary guest last name', 'primary last name', 'primary last', 'last name', 'last', 'participant last name', 'athlete last name', 'guest last name'],
  pRole: ['primary guest role', 'primary role', 'role', 'participant role', 'guest role', 'type', 'participant type'],
  pGender: ['primary guest gender', 'primary gender', 'gender', 'participant gender', 'guest gender', 'sex'],
  g2First: ['guest 2 first', 'guest 2 first name', 'guest2 first', 'guest2 first name', 'second guest first name', 'secondary first name'],
  g2Last: ['guest 2 last', 'guest 2 last name', 'guest2 last', 'guest2 last name', 'second guest last name', 'secondary last name'],
  g2Role: ['guest 2 role', 'guest2 role', 'second guest role', 'secondary role'],
  g2Gender: ['guest 2 gender', 'guest2 gender', 'second guest gender', 'secondary gender']
};

/* ============================================================
   STATE
   ============================================================ */
const state = {
  location: null,
  rawWorkbook: null,
  rawBeds: [],
  blankWorkbook: null,           // SheetJS-parsed for structure detection
  blankArrayBuffer: null,        // Original bytes for surgical writing
  referenceWorkbook: null,
  halls: [],
  assignments: [],
  buildWarnings: [],
  compliance: null,
  placeholderBytes: null,        // ArrayBuffer of surgically-written placeholder workbook
  finalBytes: null,
};

/* ============================================================
   UTILITIES
   ============================================================ */
function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function readWorkbookFromArrayBuffer(buf) {
  return XLSX.read(buf, { type: 'array', cellStyles: true, cellFormula: true, cellDates: false });
}

function deepCloneWorkbook(wb) {
  // Re-parse from a serialized copy to get a true independent workbook
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellStyles: true });
  return XLSX.read(buf, { type: 'array', cellStyles: true, cellFormula: true });
}

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* ============================================================
   SURGICAL XLSX WRITER — guarantees byte-level structural fidelity
   ============================================================
   Reads the original .xlsx as a ZIP, modifies ONLY the target cells in
   the affected sheet XMLs, and leaves every other file (theme, styles,
   shared strings, custom XML, etc.) byte-identical. Avoids the
   round-trip degradation of SheetJS / openpyxl re-emitting workbook XML.
   ============================================================ */
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function patchCellXml(xml, cellRef, value) {
  const escaped = cellRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<c\\s+r="${escaped}"([^>]*?)/>|<c\\s+r="${escaped}"([^>]*?)>([\\s\\S]*?)</c>`
  );
  const m = re.exec(xml);
  if (!m) return xml;
  const attrs = (m[1] !== undefined) ? m[1] : m[2];
  const sMatch = /\bs="([^"]*)"/.exec(attrs);
  const sPart = sMatch ? ` s="${sMatch[1]}"` : '';
  const newCell = `<c r="${cellRef}"${sPart} t="str"><v>${xmlEscape(value)}</v></c>`;
  return xml.substring(0, m.index) + newCell + xml.substring(m.index + m[0].length);
}

function upsertCellXml(xml, cellRef, value) {
  const patched = patchCellXml(xml, cellRef, value);
  if (patched !== xml) return patched;
  const rowNum = cellRef.replace(/^[A-Z]+/i, '');
  const rowRe = new RegExp(`(<row\\b[^>]*\\br="${rowNum}"[^>]*>)([\\s\\S]*?)(</row>)`);
  const m = rowRe.exec(xml);
  if (!m) return xml;
  const newCell = `<c r="${cellRef}" t="str"><v>${xmlEscape(value)}</v></c>`;
  return xml.substring(0, m.index) + m[1] + m[2] + newCell + m[3] + xml.substring(m.index + m[0].length);
}

function colNumberFromLetters(letters) {
  let n = 0;
  for (const ch of String(letters || '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function updateDimensionXml(xml, cellRefs) {
  const m = /<dimension\s+ref="([^"]+)"/.exec(xml);
  if (!m) return xml;
  const refs = String(m[1]).split(':');
  const end = refs[1] || refs[0];
  const endMatch = /^([A-Z]+)(\d+)$/i.exec(end);
  if (!endMatch) return xml;
  let maxCol = colNumberFromLetters(endMatch[1]);
  let maxRow = Number(endMatch[2]);
  for (const ref of cellRefs) {
    const cm = /^([A-Z]+)(\d+)$/i.exec(ref);
    if (!cm) continue;
    maxCol = Math.max(maxCol, colNumberFromLetters(cm[1]));
    maxRow = Math.max(maxRow, Number(cm[2]));
  }
  const start = refs[0] || 'A1';
  return xml.replace(/<dimension\s+ref="[^"]+"/, `<dimension ref="${start}:${colLetter(maxCol)}${maxRow}"`);
}

function parseSheetFileMap(workbookXml, relsXml) {
  const sheetEntries = [...workbookXml.matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"/g)];
  const relEntries = [...relsXml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)];
  const relMap = {};
  for (const m of relEntries) relMap[m[1]] = m[2];
  const out = {};
  for (const m of sheetEntries) {
    let target = relMap[m[2]];
    if (target && !target.startsWith('xl/')) target = 'xl/' + target;
    if (target) out[m[1]] = target;
  }
  return out;
}

async function surgicalWrite(inputArrayBuffer, modifications) {
  const bySheet = {};
  for (const mod of modifications) {
    if (!bySheet[mod.sheet]) bySheet[mod.sheet] = [];
    bySheet[mod.sheet].push([`${mod.col}${mod.row}`, mod.value]);
  }
  const zip = await JSZip.loadAsync(inputArrayBuffer);
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const fileMap = parseSheetFileMap(workbookXml, relsXml);

  for (const [sheetName, cellMods] of Object.entries(bySheet)) {
    const file = fileMap[sheetName];
    if (!file || !zip.file(file)) continue;
    let xml = await zip.file(file).async('string');
    for (const [cellRef, value] of cellMods) {
      xml = upsertCellXml(xml, cellRef, value);
    }
    xml = updateDimensionXml(xml, cellMods.map(([cellRef]) => cellRef));
    zip.file(file, xml);
  }
  return await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

function cleanStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function shortTeamName(name) {
  let s = String(name).replace(TEAM_NAME_STRIP, '').replace(/\s+/g, ' ').trim();
  return s || name;
}

function normalizeHeader(v) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ');
}

function canonicalColumn(label) {
  const normalized = normalizeHeader(label);
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.includes(normalized)) return canonical;
  }
  return String(label == null ? '' : label).trim();
}

function canonicalRawColumn(label) {
  const normalized = normalizeHeader(label);
  for (const [canonical, aliases] of Object.entries(RAW_COLUMN_ALIASES)) {
    if (aliases.includes(normalized)) return canonical;
  }
  return null;
}

function roleCategory(role) {
  const raw = String(role || '').trim();
  const normalized = normalizeHeader(raw);
  if (ROLE_CATEGORIES[raw]) return ROLE_CATEGORIES[raw];
  if (/staff/.test(normalized)) return 'Staff';
  if (/chaperone|adult/.test(normalized)) return 'Chaperone';
  if (/coach|sponsor|advisor|director/.test(normalized)) return 'Coach';
  if (/athlete|team member|participant|student|camper/.test(normalized)) return 'Athlete';
  return raw ? 'Other' : null;
}

function normalizeGender(value) {
  const normalized = normalizeHeader(value);
  if (normalized.startsWith('m')) return 'Male';
  if (normalized.startsWith('f')) return 'Female';
  return cleanStr(value);
}

function detectRawColumns(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  let best = { cols: {}, score: -1, row: 0 };
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const cols = {};
    for (let c = 0; c < rows[r].length; c++) {
      const canonical = canonicalRawColumn(rows[r][c]);
      if (canonical && cols[canonical] == null) cols[canonical] = c;
    }
    const score = (cols.account != null ? 3 : 0)
      + (cols.pRole != null ? 2 : 0)
      + (cols.pGender != null ? 2 : 0)
      + (cols.pFirst != null ? 1 : 0)
      + (cols.pLast != null ? 1 : 0)
      + (cols.occupancy != null ? 1 : 0);
    if (score > best.score) best = { cols, score, row: r };
    if (score >= 8) break;
  }
  return { rows, cols: best.cols, headerRow: best.row };
}

function rawCell(row, cols, key) {
  const idx = cols[key];
  return idx == null ? null : row[idx];
}

function roomLike(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s || !/\d/.test(s)) return false;
  if (/total|capacity|count|floor|phone|zip/i.test(s)) return false;
  return ROOM_ID_RE.test(s) || /^[A-Za-z]?\d{1,4}[A-Za-z0-9-]*$/i.test(s) || !!parseRoomSpaceDescription(s);
}

function parseRoomSpaceDescription(value) {
  const s = String(value == null ? '' : value).trim();
  const m = /^(.+?)\s+-\s+(.+)$/.exec(s);
  if (!m) return null;
  const hall = m[1].trim();
  const roomSpace = m[2].trim();
  if (!hall || !/\d/.test(roomSpace)) return null;
  const floorMatch = roomSpace.match(/(\d)/);
  const roomMatch = roomSpace.match(/^([A-Za-z]*\d+[A-Za-z]*)/);
  return {
    hall,
    roomId: roomMatch ? roomMatch[1] : roomSpace,
    roomSpace,
    floor: floorMatch ? floorMatch[1] : '?'
  };
}

function floorLike(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return false;
  if (/^(?:floor|flr|f|level)\s*[-:]?\s*[A-Za-z0-9]+$/i.test(s)) return true;
  return /^[A-Za-z]?\d{1,2}$/.test(s);
}

function capacityLike(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 20;
}

function parseCapacity(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 20 ? n : 1;
}

function normalizeFloorValue(value, roomId) {
  const raw = String(value == null ? '' : value).trim();
  if (raw) {
    const m = raw.match(/(?:floor|flr|f|level)?\s*[-:]?\s*([A-Za-z]?\d{1,2})/i);
    if (m) return m[1];
    return raw;
  }
  const rid = String(roomId == null ? '' : roomId).trim();
  const n = rid.match(/\d/);
  return n ? n[0] : '?';
}

function inferTemplateColumns(sheet, cols) {
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
  const headerRow = cols._headerRow || HEADER_ROW;
  const stats = {};
  for (let c = range.s.c; c <= range.e.c; c++) {
    stats[c + 1] = { room: 0, floor: 0, empty: 0, values: 0 };
  }
  for (let row1 = headerRow + 1; row1 <= range.e.r + 1; row1++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const col1 = c + 1;
      const cell = cellAt(sheet, row1, col1);
      const value = cell ? cell.v : null;
      const s = String(value == null ? '' : value).trim();
      if (!s) stats[col1].empty++;
      else {
        stats[col1].values++;
        if (roomLike(s)) stats[col1].room++;
        if (floorLike(s)) stats[col1].floor++;
        if (capacityLike(s)) stats[col1].capacity = (stats[col1].capacity || 0) + 1;
      }
    }
  }

  let roomCol = cols.RoomID;
  if (!roomCol) {
    roomCol = Number(Object.entries(stats)
      .filter(([, s]) => s.room > 0)
      .sort((a, b) => b[1].room - a[1].room)[0]?.[0] || 0) || null;
  }

  let floorCol = cols.Floor;
  if (!floorCol) {
    floorCol = Number(Object.entries(stats)
      .filter(([c, s]) => Number(c) !== roomCol && s.floor > 0)
      .sort((a, b) => b[1].floor - a[1].floor)[0]?.[0] || 0) || null;
  }

  const hallCol = cols.Hall || null;
  let capacityCol = cols.Capacity || null;
  if (!capacityCol) {
    capacityCol = Number(Object.entries(stats)
      .filter(([c, s]) => Number(c) !== roomCol && Number(c) !== floorCol && (s.capacity || 0) > 0)
      .sort((a, b) => (b[1].capacity || 0) - (a[1].capacity || 0))[0]?.[0] || 0) || null;
  }

  let groupCol = cols['Group/School'];
  if (!groupCol) {
    const candidates = Object.entries(stats)
      .filter(([c]) => Number(c) !== roomCol && Number(c) !== floorCol && Number(c) !== hallCol && Number(c) !== capacityCol)
      .sort((a, b) => b[1].empty - a[1].empty);
    const emptyCandidate = candidates.find(([, s]) => s.empty > s.values);
    groupCol = Number(emptyCandidate?.[0] || 0) || (range.e.c + 2);
  }

  return { roomCol, hallCol, floorCol, capacityCol, groupCol, headerRow };
}

function detectColumns(sheet) {
  // 1-indexed map of {headerLabel: columnNumber}
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
  const preferredRows = [HEADER_ROW - 1];
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 14); r++) {
    if (!preferredRows.includes(r)) preferredRows.push(r);
  }

  let best = { cols: {}, score: -1, row: HEADER_ROW };
  for (const r of preferredRows) {
    const cols = {};
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (!cell || cell.v == null) continue;
      const raw = String(cell.v).trim();
      const canonical = canonicalColumn(raw);
      cols[raw] = c + 1;
      if (canonical) cols[canonical] = c + 1;
    }
    const score = (cols.RoomID ? 1 : 0) + (cols.Floor ? 1 : 0) + (cols['Group/School'] ? 1 : 0);
    if (score > best.score) best = { cols, score, row: r + 1 };
    if (score >= 3) break;
  }
  best.cols._headerRow = best.row;
  return best.cols;
}

function cellAt(sheet, row1, col1) {
  // row1, col1 are 1-indexed
  const ref = XLSX.utils.encode_cell({ r: row1 - 1, c: col1 - 1 });
  return sheet[ref];
}

function setCell(sheet, row1, col1, value) {
  const ref = XLSX.utils.encode_cell({ r: row1 - 1, c: col1 - 1 });
  if (sheet[ref]) {
    sheet[ref].v = value;
    sheet[ref].t = 's';
    if ('w' in sheet[ref]) delete sheet[ref].w; // force re-render
  } else {
    sheet[ref] = { t: 's', v: value };
    // Extend ref range if needed
    const range = XLSX.utils.decode_range(sheet['!ref']);
    if (col1 - 1 > range.e.c) range.e.c = col1 - 1;
    if (row1 - 1 > range.e.r) range.e.r = row1 - 1;
    sheet['!ref'] = XLSX.utils.encode_range(range);
  }
}

/* ============================================================
   STEP 1 — INGEST RAW DATA
   ============================================================ */
function ingestRaw(workbook) {
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const { rows, cols, headerRow } = detectRawColumns(sheet);

  const beds = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const account = cleanStr(rawCell(r, cols, 'account'));
    if (!account) continue;
    const early = ['x', 'yes', 'y', 'true', '1'].includes(String(rawCell(r, cols, 'early') || '').trim().toLowerCase());
    const primaryRole = cleanStr(rawCell(r, cols, 'pRole'));
    const primaryCategory = roleCategory(primaryRole);
    if (primaryCategory) {
      beds.push({
        account,
        first:    cleanStr(rawCell(r, cols, 'pFirst')),
        last:     cleanStr(rawCell(r, cols, 'pLast')),
        role:     primaryRole,
        category: primaryCategory,
        gender:   normalizeGender(rawCell(r, cols, 'pGender')),
        early,
        raw_row:  i + 1,
      });
    }
    const guest2Role = cleanStr(rawCell(r, cols, 'g2Role'));
    const guest2Category = roleCategory(guest2Role);
    const occupancy = Number(rawCell(r, cols, 'occupancy') || 0);
    if ((occupancy === 2 || guest2Category) && guest2Category) {
      beds.push({
        account,
        first:    cleanStr(rawCell(r, cols, 'g2First')),
        last:     cleanStr(rawCell(r, cols, 'g2Last')),
        role:     guest2Role,
        category: guest2Category,
        gender:   normalizeGender(rawCell(r, cols, 'g2Gender')),
        early,
        raw_row:  i + 1,
      });
    }
  }
  return beds;
}

function ingestSummary(beds) {
  const byTeam = {};
  const roleCounts = {};
  const genderCounts = {};
  const warnings = [];
  for (const b of beds) {
    byTeam[b.account] = (byTeam[b.account] || 0) + 1;
    roleCounts[b.role] = (roleCounts[b.role] || 0) + 1;
    genderCounts[b.gender || 'Unknown'] = (genderCounts[b.gender || 'Unknown'] || 0) + 1;
    if (!b.first || !b.last) warnings.push(`Missing name: ${b.account} — ${b.role}`);
  }
  return {
    total_beds: beds.length,
    team_count: Object.keys(byTeam).length,
    by_team: Object.entries(byTeam).sort((a,b) => b[1]-a[1]),
    role_counts: roleCounts,
    gender_counts: genderCounts,
    warnings,
  };
}

/* ============================================================
   STEP 2 — PARSE BLANK + REFERENCE TEMPLATES
   ============================================================ */
function parseTemplate(blankWB, referenceWB) {
  const halls = [];
  for (const sheetName of blankWB.SheetNames) {
    const ws = blankWB.Sheets[sheetName];
    const ws_ref = referenceWB ? referenceWB.Sheets[sheetName] : null;
    const cols = detectColumns(ws);
    const inferred = inferTemplateColumns(ws, cols);
    const colRoomId = inferred.roomCol;
    const colHall = inferred.hallCol;
    const colFloor = inferred.floorCol;
    const colCapacity = inferred.capacityCol;
    const colGroup = inferred.groupCol;
    cols.RoomID = colRoomId;
    cols.Hall = colHall;
    cols.Floor = colFloor;
    cols.Capacity = colCapacity;
    cols['Group/School'] = colGroup;
    const colNotes = cols['Notes'];
    if (!colRoomId) continue;
    const refCols = ws_ref ? detectColumns(ws_ref) : {};
    const refColGroup = refCols['Group/School'];

    const rooms = [];
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let row1 = inferred.headerRow + 1; row1 <= range.e.r + 1; row1++) {
      const ridCell = cellAt(ws, row1, colRoomId);
      const rid = ridCell ? ridCell.v : null;
      if (rid == null) continue;
      const parsedSpace = parseRoomSpaceDescription(rid);
      const ridStr = parsedSpace ? parsedSpace.roomSpace : String(rid).trim();
      if (!roomLike(rid)) continue;
      const floorCell = colFloor ? cellAt(ws, row1, colFloor) : null;
      const floor = parsedSpace ? parsedSpace.floor : normalizeFloorValue(floorCell ? floorCell.v : null, ridStr);
      const hallCell = colHall ? cellAt(ws, row1, colHall) : null;
      const hallName = parsedSpace?.hall || cleanStr(hallCell ? hallCell.v : null) || sheetName;
      const capacityCell = colCapacity ? cellAt(ws, row1, colCapacity) : null;
      const capacity = parseCapacity(capacityCell ? capacityCell.v : null);
      const notesCell = colNotes ? cellAt(ws, row1, colNotes) : null;
      const notes = notesCell ? notesCell.v : null;
      const refCell = (ws_ref && refColGroup) ? cellAt(ws_ref, row1, refColGroup) : null;
      const refLabel = refCell ? refCell.v : null;
      const isRA = /RA\s*$/i.test(ridStr) || (notes && String(notes).includes('RA'));
      const suiteMatch = /^([A-Za-z]+\d+)[A-Za-z]?\s*$/.exec(ridStr);
      const suiteId = suiteMatch ? suiteMatch[1] : ridStr;
      for (let bedNo = 1; bedNo <= capacity; bedNo++) {
        rooms.push({
          sheet: sheetName, row: row1, room_id: capacity > 1 ? `${ridStr}-${bedNo}` : ridStr,
          base_room_id: parsedSpace ? parsedSpace.roomId : ridStr, bed_no: bedNo, capacity,
          room_space_description: parsedSpace ? String(rid).trim() : '',
          hall_name: hallName, floor, is_ra: !!isRA, is_excluded: false,
          ref_label: refLabel, suite_id: capacity > 1 ? `${suiteId}-${bedNo}` : suiteId,
        });
      }
    }

    const isStaff = sheetName.includes('Staff') || rooms.some(r => /staff/i.test(r.hall_name || ''));
    halls.push({ name: sheetName, rooms, is_staff_hall: isStaff, cols });
  }
  return halls;
}

function hallCapacity(h) { return h.rooms.filter(r => !r.is_ra && !r.is_excluded).length; }
function hallFloors(h) {
  const map = {};
  for (const r of h.rooms) {
    if (r.is_ra || r.is_excluded) continue;
    const k = String(r.floor);
    if (!map[k]) map[k] = { floor: r.floor, total: 0, ra: 0, usable: 0 };
    map[k].total += 1;
    map[k].usable += 1;
  }
  // RA counts
  for (const r of h.rooms) {
    if (r.is_ra) {
      const k = String(r.floor);
      if (!map[k]) map[k] = { floor: r.floor, total: 0, ra: 0, usable: 0 };
      map[k].ra += 1;
      map[k].total += 1;
    }
  }
  return Object.values(map).sort((a,b) => String(a.floor).localeCompare(String(b.floor), undefined, { numeric: true }));
}

function splitHallsByDisplayName(halls) {
  const grouped = {};
  for (const h of halls) {
    for (const r of h.rooms) {
      const name = r.hall_name || h.name;
      if (!grouped[name]) grouped[name] = {
        name,
        rooms: [],
        is_staff_hall: h.is_staff_hall || /staff/i.test(name),
        cols: h.cols
      };
      grouped[name].rooms.push(r);
      grouped[name].is_staff_hall = grouped[name].is_staff_hall || h.is_staff_hall || /staff/i.test(name);
    }
  }
  return Object.values(grouped);
}

function extractNoSplitTerms(conditions) {
  const text = String(conditions || '');
  const terms = [];
  const patterns = [
    /([A-Za-z0-9&'.\- ]{2,80}?)\s+(?:can\s*not|cannot|can't|must\s+not|do\s+not|don't)\s+be\s+split/ig,
    /(?:keep|place)\s+all\s+([A-Za-z0-9&'.\- ]{2,80}?)\s+(?:together|on\s+the\s+same\s+floor)/ig,
    /([A-Za-z0-9&'.\- ]{2,80}?)\s+(?:same\s+floor|all\s+together)/ig
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const term = cleanStr(m[1]);
      if (term) terms.push(term.replace(/\b(for any reason|participants|team|school)$/i, '').trim());
    }
  }
  return [...new Set(terms.filter(Boolean))];
}

/* ============================================================
   STEP 3 — PLACEMENT ALGORITHM
   Rules enforced:
     • No school mixing in any pod (single team per pod)
     • No mixed-gender pods (single gender per pod)        ← strict
     • Teams kept on same floor when possible (program co-loc + chaperone-per-floor)
     • Buffer room left between teams when floor capacity allows
     • Staff hall: dedicated, suite-pair gender-segregated
   Assignments carry per-bed gender for downstream compliance.
   ============================================================ */
function buildPlacements(beds, halls, options = {}) {
  halls = splitHallsByDisplayName(halls || []);
  const assignments = [];
  const warnings = [];
  const noSplitTerms = extractNoSplitTerms(options.conditions);

  // Aggregate {account: {category: {gender: count}}}
  const teams = {};
  for (const b of beds) {
    const cat = b.category;
    const g = (b.gender === 'Male') ? 'Male' : 'Female'; // Unknown → Female default
    if (!teams[b.account]) teams[b.account] = {};
    if (!teams[b.account][cat]) teams[b.account][cat] = {};
    teams[b.account][cat][g] = (teams[b.account][cat][g] || 0) + 1;
  }

  const staffAccounts = {};
  const regularAccounts = {};
  for (const [acct, cats] of Object.entries(teams)) {
    const keys = Object.keys(cats);
    if (keys.every(k => k === 'Staff' || k === 'Other')) staffAccounts[acct] = cats;
    else regularAccounts[acct] = cats;
  }

  const teamSize = (cats) => Object.values(cats).reduce((s, g) => s + Object.values(g).reduce((a,b)=>a+b,0), 0);
  const teamGenderCount = (cats, gender) => Object.values(cats).reduce((s, g) => s + (g[gender] || 0), 0);
  const mustStayTogether = (acct) => noSplitTerms.some(term => acct.toLowerCase().includes(term.toLowerCase()));

  const staffHalls = halls.filter(h => h.is_staff_hall);
  const regularHalls = halls.filter(h => !h.is_staff_hall);

  // Program key strips Varsity/JV/Freshman so sibling teams group
  const programKey = (acct) => acct.replace(/\s+(?:Varsity|VA|JV|Junior\s+Varsity|Freshman|Frosh|9th(?:\s+Grade)?)\s*$/i, '').trim() || acct;

  // Build POD-grouped inventory: inv[hall||floor] = [pods] in spreadsheet order
  // pod = { id: suite_id, beds: [bedRow, ...] }
  // All beds with same suite_id form one pod (same physical room or bathroom-share cluster).
  const inv = {};
  for (const h of regularHalls) {
    const podsByFloor = {};
    const podOrderByFloor = {};
    for (const r of h.rooms) {
      if (r.is_ra || r.is_excluded) continue;
      const fk = String(r.floor);
      if (!podsByFloor[fk]) { podsByFloor[fk] = {}; podOrderByFloor[fk] = []; }
      const sid = r.suite_id;
      if (!podsByFloor[fk][sid]) {
        podsByFloor[fk][sid] = { id: sid, beds: [] };
        podOrderByFloor[fk].push(sid);
      }
      podsByFloor[fk][sid].beds.push(r);
    }
    for (const fk of Object.keys(podsByFloor).sort((a,b) => a.localeCompare(b, undefined, { numeric: true }))) {
      inv[`${h.name}||${fk}`] = podOrderByFloor[fk].map(sid => podsByFloor[fk][sid]);
    }
  }

  const podBeds = (pod) => pod.beds.length;
  const floorBedCap = (pods) => pods.reduce((s, p) => s + podBeds(p), 0);
  const podsNeededFor = (F, M, avg = 2) => Math.ceil(F / avg) + Math.ceil(M / avg);

  // Per-gender label pools (in CATEGORY_ORDER)
  const buildPools = (acct, cats) => {
    const short = shortTeamName(acct);
    const pools = { Female: [], Male: [] };
    for (const cat of CATEGORY_ORDER) {
      if (!cats[cat]) continue;
      for (const [g, n] of Object.entries(cats[cat])) {
        const bucket = (g === 'Male') ? 'Male' : 'Female';
        for (let i = 0; i < n; i++) pools[bucket].push(`${short} ${cat}`);
      }
    }
    return pools;
  };

  // Gender-greedy: walk pods in order. Each pod gets ONE gender (the side with most need; F on tie).
  // Returns number of pods consumed. Pools mutated.
  const fillPodsGenderAware = (podList, pools) => {
    let consumed = 0;
    for (let i = 0; i < podList.length; i++) {
      if (pools.Female.length === 0 && pools.Male.length === 0) break;
      const pod = podList[i];
      consumed = i + 1;
      let gender;
      if (pools.Female.length >= pools.Male.length && pools.Female.length > 0) gender = 'Female';
      else if (pools.Male.length > 0) gender = 'Male';
      else break;
      for (const bed of pod.beds) {
        if (pools[gender].length === 0) break;
        assignments.push({ sheet: bed.sheet, row: bed.row, label: pools[gender].shift(), gender, hall: bed.hall_name || bed.sheet, floor: bed.floor, room_id: bed.room_id });
      }
    }
    return consumed;
  };

  // After placing a team, consume only the pods used so the first draft prioritizes placing every roster bed.
  const advanceFloor = (fk, consumed) => {
    inv[fk] = inv[fk].slice(consumed);
  };

  // Group teams by program; sort largest first
  const programGroups = {};
  for (const [acct, cats] of Object.entries(regularAccounts)) {
    const pk = programKey(acct);
    if (!programGroups[pk]) programGroups[pk] = [];
    programGroups[pk].push([acct, cats]);
  }
  const sortedPrograms = Object.entries(programGroups)
    .map(([pk, list]) => ({ pk, list, total: list.reduce((s, [_,c]) => s + teamSize(c), 0) }))
    .sort((a,b) => b.total - a.total);
  for (const p of sortedPrograms) p.list.sort((a,b) => teamSize(b[1]) - teamSize(a[1]));

  const programFloor = {};

  for (const { pk, list: progTeams } of sortedPrograms) {
    for (const [acct, cats] of progTeams) {
      const F_count = teamGenderCount(cats, 'Female');
      const M_count = teamGenderCount(cats, 'Male');
      const size = F_count + M_count;
      const podsNeeded = podsNeededFor(F_count, M_count);

      // 1) Same-program co-location: try sibling's floor first
      if (programFloor[pk] && inv[programFloor[pk]] && inv[programFloor[pk]].length >= podsNeeded) {
        const fk = programFloor[pk];
        const pools = buildPools(acct, cats);
        const consumed = fillPodsGenderAware(inv[fk], pools);
        advanceFloor(fk, consumed);
        if (pools.Female.length + pools.Male.length > 0) {
          warnings.push(`${acct}: ${pools.Female.length + pools.Male.length} unplaced after program co-loc`);
        }
        continue;
      }

      // 2) Single-floor best fit by pod count (smallest viable)
      const candidates = Object.entries(inv)
        .map(([k, pods]) => ({ k, podCount: pods.length, pods }))
        .filter(c => c.podCount >= podsNeeded)
        .sort((a,b) => a.podCount - b.podCount);
      let placedFlag = false;
      for (const { k, pods } of candidates) {
        // Simulate
        const sim = { Female: F_count, Male: M_count };
        let used = 0;
        for (let i = 0; i < pods.length && (sim.Female > 0 || sim.Male > 0); i++) {
          used = i + 1;
          const g = (sim.Female >= sim.Male && sim.Female > 0) ? 'Female' : (sim.Male > 0 ? 'Male' : null);
          if (!g) break;
          const take = Math.min(sim[g], pods[i].beds.length);
          sim[g] -= take;
        }
        if (sim.Female === 0 && sim.Male === 0) {
          const pools = buildPools(acct, cats);
          const consumed = fillPodsGenderAware(pods, pools);
          advanceFloor(k, consumed);
          programFloor[pk] = k;
          placedFlag = true;
          break;
        }
      }
      if (placedFlag) continue;

      // 3) Multi-floor span within one hall — chaperone-aware, proportional
      if (mustStayTogether(acct)) {
        const sameFloorCandidates = Object.entries(inv)
          .map(([k, pods]) => ({ k, pods, beds: floorBedCap(pods) }))
          .filter(c => c.beds >= size)
          .sort((a,b) => a.beds - b.beds);
        for (const { k, pods } of sameFloorCandidates) {
          const pools = buildPools(acct, cats);
          const consumed = fillPodsGenderAware(pods, pools);
          if (pools.Female.length + pools.Male.length === 0) {
            advanceFloor(k, consumed);
            programFloor[pk] = k;
            placedFlag = true;
            warnings.push(`Mandatory condition honored: ${acct} kept together on ${k.split('||')[0]} Floor ${k.split('||')[1]}`);
            break;
          }
        }
        if (!placedFlag) {
          const best = Object.entries(inv)
            .map(([k, pods]) => ({ k, pods, beds: floorBedCap(pods) }))
            .sort((a,b) => b.beds - a.beds)[0];
          if (best) {
            const pools = buildPools(acct, cats);
            const consumed = fillPodsGenderAware(best.pods, pools);
            advanceFloor(best.k, consumed);
            warnings.push(`UNPLACED due to no-split condition: ${acct} short by ${pools.Female.length + pools.Male.length}`);
          } else {
            warnings.push(`UNPLACED due to no-split condition: ${acct} has no available floor inventory`);
          }
          continue;
        }
        continue;
      }

      const hallTotals = {};
      for (const [k, pods] of Object.entries(inv)) {
        const hn = k.split('||')[0];
        if (!hallTotals[hn]) hallTotals[hn] = { pods: 0, beds: 0 };
        hallTotals[hn].pods += pods.length;
        hallTotals[hn].beds += floorBedCap(pods);
      }
      const ranked = Object.entries(hallTotals).sort((a,b) => b[1].beds - a[1].beds);
      let placed = false;
      for (const [hname, totals] of ranked) {
        if (totals.pods < podsNeeded) continue;
        const fkeys = Object.keys(inv).filter(k => k.startsWith(hname + '||'))
          .sort((a,b) => a.split('||')[1].localeCompare(b.split('||')[1], undefined, { numeric: true }));

        // Proportional distribution of each category across floors by bed capacity share
        const capByFloor = fkeys.map(fk => ({ fk, cap: floorBedCap(inv[fk]) }));
        const totalCap = capByFloor.reduce((s, x) => s + x.cap, 0);
        if (totalCap < size) continue;

        // Per-category proportional counts (rounded)
        const catCounts = {}; // { cat: { Female, Male } per floor-array }
        for (const cat of CATEGORY_ORDER) {
          if (!cats[cat]) continue;
          for (const g of ['Female', 'Male']) {
            const total = cats[cat][g] || 0;
            if (total === 0) continue;
            // Distribute proportionally with largest-remainder rounding
            const raw = capByFloor.map(c => ({ fk: c.fk, share: total * (c.cap / totalCap) }));
            const floors = raw.map(r => ({ fk: r.fk, n: Math.floor(r.share), frac: r.share - Math.floor(r.share) }));
            let placedSum = floors.reduce((s, f) => s + f.n, 0);
            const need = total - placedSum;
            floors.sort((a,b) => b.frac - a.frac);
            for (let i = 0; i < need; i++) floors[i].n += 1;
            for (const f of floors) {
              if (!catCounts[f.fk]) catCounts[f.fk] = {};
              if (!catCounts[f.fk][cat]) catCounts[f.fk][cat] = { Female: 0, Male: 0 };
              catCounts[f.fk][cat][g] += f.n;
            }
          }
        }

        // Enforce: each athlete-bearing floor gets at least 1 adult (move 1 adult from heaviest floor if needed)
        const adultCats = ['Coach', 'Chaperone'];
        for (const { fk, cap } of capByFloor) {
          if (cap === 0) continue;
          const fc = catCounts[fk] || {};
          const ath = (fc.Athlete) ? (fc.Athlete.Female + fc.Athlete.Male) : 0;
          const adults = adultCats.reduce((s, ac) => s + (fc[ac] ? fc[ac].Female + fc[ac].Male : 0), 0);
          if (ath > 0 && adults === 0) {
            // Pull 1 adult from another floor with surplus
            for (const ac of adultCats) {
              let donor = capByFloor.find(c => c.fk !== fk && catCounts[c.fk] && catCounts[c.fk][ac] && (catCounts[c.fk][ac].Female + catCounts[c.fk][ac].Male) > 1);
              if (donor) {
                const dc = catCounts[donor.fk][ac];
                const moveGender = dc.Female >= dc.Male ? 'Female' : 'Male';
                dc[moveGender] -= 1;
                if (!fc[ac]) fc[ac] = { Female: 0, Male: 0 };
                fc[ac][moveGender] += 1;
                catCounts[fk] = fc;
                break;
              }
            }
          }
        }

        // Now place per floor by reconstructing per-floor pools and using gender-greedy fill
        const splitFloors = [];
        for (const { fk } of capByFloor) {
          const fc = catCounts[fk] || {};
          const F_here = Object.values(fc).reduce((s, x) => s + (x.Female || 0), 0);
          const M_here = Object.values(fc).reduce((s, x) => s + (x.Male || 0), 0);
          if (F_here === 0 && M_here === 0) continue;
          // Build pools for this floor from catCounts breakdown
          const short = shortTeamName(acct);
          const pools = { Female: [], Male: [] };
          for (const cat of CATEGORY_ORDER) {
            const fc_cat = fc[cat];
            if (!fc_cat) continue;
            for (let i = 0; i < (fc_cat.Female || 0); i++) pools.Female.push(`${short} ${cat}`);
            for (let i = 0; i < (fc_cat.Male || 0); i++) pools.Male.push(`${short} ${cat}`);
          }
          const consumed = fillPodsGenderAware(inv[fk], pools);
          advanceFloor(fk, consumed);
          splitFloors.push(fk.split('||')[1]);
          if (pools.Female.length + pools.Male.length > 0) {
            warnings.push(`${acct}: ${pools.Female.length + pools.Male.length} beds didn't fit on ${fk}`);
          }
        }
        warnings.push(`Team spans floors [${splitFloors.join(', ')}] in ${hname}: ${acct} (${size} beds, proportional split)`);
        programFloor[pk] = hname + '||' + splitFloors[0];
        placed = true;
        break;
      }

      // 4) Cross-hall fallback
      if (!placed) {
        const pools = buildPools(acct, cats);
        const splitLocs = [];
        const keys = Object.keys(inv).sort((a,b) => floorBedCap(inv[b]) - floorBedCap(inv[a]));
        for (const k of keys) {
          if (pools.Female.length === 0 && pools.Male.length === 0) break;
          const consumed = fillPodsGenderAware(inv[k], pools);
          if (consumed > 0) {
            advanceFloor(k, consumed);
            splitLocs.push(`${k.split('||')[0]}/${k.split('||')[1]}`);
          }
        }
        warnings.push(`Team spans halls [${splitLocs.join(', ')}]: ${acct}`);
        if (pools.Female.length + pools.Male.length > 0) warnings.push(`UNPLACED: ${acct} short by ${pools.Female.length + pools.Male.length}`);
      }
    }
  }

  // ---- Staff hall: pod-aware gender allocation ----
  for (const h of staffHalls) {
    const podsByFloor = {};
    const podOrder = {};
    for (const r of h.rooms) {
      if (r.is_ra || r.is_excluded) continue;
      const k = String(r.floor);
      if (!podsByFloor[k]) { podsByFloor[k] = {}; podOrder[k] = []; }
      const sid = r.suite_id || r.room_id;
      if (!podsByFloor[k][sid]) { podsByFloor[k][sid] = { id: sid, beds: [] }; podOrder[k].push(sid); }
      podsByFloor[k][sid].beds.push(r);
    }
    const floorsSorted = Object.keys(podsByFloor).sort((a,b) => a.localeCompare(b, undefined, { numeric: true }));

    const remaining = { Female: 0, Male: 0 };
    const beds_by_acct = {};
    for (const [acct, cats] of Object.entries(staffAccounts)) {
      beds_by_acct[acct] = {};
      for (const [cat, byG] of Object.entries(cats)) {
        for (const [g, n] of Object.entries(byG)) {
          const bucket = g === 'Male' ? 'Male' : 'Female';
          remaining[bucket] = (remaining[bucket] || 0) + n;
          beds_by_acct[acct][bucket] = (beds_by_acct[acct][bucket] || 0) + n;
        }
      }
    }

    const genderPool = { Female: [], Male: [] };
    for (const fk of floorsSorted) {
      for (const sid of podOrder[fk]) {
        const pod = podsByFloor[fk][sid];
        if ((remaining.Female || 0) === 0 && (remaining.Male || 0) === 0) break;
        const g = (remaining.Female >= remaining.Male && remaining.Female > 0) ? 'Female' : 'Male';
        const take = Math.min(pod.beds.length, remaining[g]);
        for (let i = 0; i < take; i++) genderPool[g].push(pod.beds[i]);
        remaining[g] -= take;
      }
    }

    for (const [acct, by_g] of Object.entries(beds_by_acct)) {
      for (const [g, n] of Object.entries(by_g)) {
        const pool = genderPool[g] || [];
        let placedN = 0;
        while (placedN < n && pool.length > 0) {
          const bed = pool.shift();
          assignments.push({ sheet: bed.sheet, row: bed.row, label: acct, gender: g, hall: bed.hall_name || bed.sheet, floor: bed.floor, room_id: bed.room_id });
          placedN++;
        }
        if (placedN < n) warnings.push(`Staff overflow ${acct} ${g}: ${n - placedN} short`);
      }
    }
  }

  return { assignments, warnings };
}


/* ============================================================
   COMPLIANCE ENGINE (Module 3 + Module 6 + Module 7)
   ============================================================ */
function labelToAccount(label, accounts) {
  for (const acct of accounts) {
    if (label === acct) return acct;
    if (label.startsWith(shortTeamName(acct) + ' ')) return acct;
  }
  return null;
}

function checkCompliance(halls, assignments, beds) {
  const teamGen = {};
  for (const b of beds) {
    if (!teamGen[b.account]) teamGen[b.account] = {};
    const g = b.gender || 'Unknown';
    teamGen[b.account][g] = (teamGen[b.account][g] || 0) + 1;
  }
  const accounts = Object.keys(teamGen);

  // Room lookup
  const roomByPos = {};
  for (const h of halls) {
    for (const r of h.rooms) {
      roomByPos[`${r.sheet}|${r.row}`] = r;
    }
  }
  const assignedRooms = {};
  for (const a of assignments) {
    assignedRooms[`${a.sheet}|${a.row}`] = { label: a.label, acct: labelToAccount(a.label, accounts), gender: a.gender };
  }

  // 1. Occupancy
  const occupancy_violations = [];
  for (const h of halls) {
    const used = {};
    const cap = {};
    for (const r of h.rooms) {
      if (r.is_ra || r.is_excluded) continue;
      cap[r.floor] = (cap[r.floor] || 0) + 1;
      if (assignedRooms[`${r.sheet}|${r.row}`]) used[r.floor] = (used[r.floor] || 0) + 1;
    }
    for (const fl of Object.keys(used)) {
      if (used[fl] > cap[fl]) {
        occupancy_violations.push(`${h.name} Floor ${fl}: ${used[fl]} assigned exceeds capacity ${cap[fl]}`);
      }
    }
  }

  // 2. Bathroom / pod gender (now uses per-bed gender from assignment)
  const bathroom_conflicts = [];
  const suites = {};
  for (const h of halls) {
    for (const r of h.rooms) {
      if (r.is_ra || r.is_excluded || !r.suite_id) continue;
      const key = `${h.name}||${r.suite_id}`;
      const rec = assignedRooms[`${r.sheet}|${r.row}`];
      if (!rec) continue;
      if (!suites[key]) suites[key] = [];
      suites[key].push({ r, label: rec.label, g: rec.gender || '' });
    }
  }
  for (const [key, occupants] of Object.entries(suites)) {
    if (occupants.length >= 2) {
      const sg = new Set(occupants.map(o => o.g).filter(g => g === 'Female' || g === 'Male'));
      if (sg.size > 1) {
        const [hname, sid] = key.split('||');
        bathroom_conflicts.push(`${hname} pod ${sid}: mixed gender — ${occupants.map(o => `${o.r.room_id}/${o.label}/${o.g}`).join(', ')}`);
      }
    }
  }

  // 3. Chaperone coverage
  const chaperone_gaps = [];
  const floorRoles = {};
  for (const a of assignments) {
    const r = roomByPos[`${a.sheet}|${a.row}`];
    if (!r) continue;
    const acct = labelToAccount(a.label, accounts);
    if (!acct) continue;
    let role = null;
    for (const cat of CATEGORY_ORDER) {
      if (a.label.endsWith(' ' + cat)) { role = cat; break; }
    }
    if (!role) continue;
    const key = `${a.sheet}||${r.floor}||${acct}`;
    if (!floorRoles[key]) floorRoles[key] = {};
    floorRoles[key][role] = (floorRoles[key][role] || 0) + 1;
  }
  for (const [key, roles] of Object.entries(floorRoles)) {
    if ((roles.Athlete || 0) > 0) {
      const adults = (roles.Coach || 0) + (roles.Chaperone || 0);
      if (adults === 0) {
        const [sheet, fl, acct] = key.split('||');
        chaperone_gaps.push(`${sheet} Floor ${fl}: ${acct} has ${roles.Athlete} athletes but no Coach/Chaperone on floor`);
      }
    }
  }

  // 4. Staff separation
  const staff_separation = [];
  for (const [key, occupants] of Object.entries(suites)) {
    const labels = occupants.map(o => o.label);
    const hasStaff = labels.some(l => l && l.includes('Staff'));
    const hasNonStaff = labels.some(l => l && !l.includes('Staff'));
    if (hasStaff && hasNonStaff) {
      const [hname, sid] = key.split('||');
      staff_separation.push(`${hname} suite ${sid}: staff and non-staff share suite — ${labels.join(', ')}`);
    }
  }

  // 5. Team splits
  const teamLocs = {};
  for (const a of assignments) {
    const r = roomByPos[`${a.sheet}|${a.row}`];
    if (!r) continue;
    const acct = labelToAccount(a.label, accounts);
    if (!acct) continue;
    const k = `${a.sheet}||${r.floor}`;
    if (!teamLocs[acct]) teamLocs[acct] = new Set();
    teamLocs[acct].add(k);
  }
  const team_splits = [];
  for (const [acct, locs] of Object.entries(teamLocs)) {
    if (locs.size > 1) {
      const arr = [...locs];
      const halls = new Set(arr.map(l => l.split('||')[0]));
      if (halls.size > 1) {
        team_splits.push(`${acct}: spans halls [${[...halls].join(', ')}]`);
      } else {
        const floors = arr.map(l => l.split('||')[1]).sort();
        team_splits.push(`${acct}: spans floors [${floors.join(', ')}] in ${[...halls][0]}`);
      }
    }
  }

  // 6. School mix per pod (suite/bathroom-share unit)
  const podOccupants = {};
  for (const a of assignments) {
    const r = roomByPos[`${a.sheet}|${a.row}`];
    if (!r) continue;
    const acct = labelToAccount(a.label, accounts);
    if (!acct) continue;
    const k = `${a.sheet}||${r.suite_id || r.room_id}`;
    if (!podOccupants[k]) podOccupants[k] = new Set();
    podOccupants[k].add(acct);
  }
  const room_school_mix = [];
  for (const [k, accts] of Object.entries(podOccupants)) {
    if (accts.size > 1) {
      const [sheet, sid] = k.split('||');
      room_school_mix.push(`${sheet} pod ${sid}: mixed schools — ${[...accts].join(', ')}`);
    }
  }

  // 7. Mixed-gender floors (uses per-bed gender)
  const mixed_gender_floor = [];
  const floorGenders = {};
  for (const a of assignments) {
    const r = roomByPos[`${a.sheet}|${a.row}`];
    if (!r) continue;
    const g = a.gender;
    if (g !== 'Female' && g !== 'Male') continue;
    const k = `${a.sheet}||${r.floor}`;
    if (!floorGenders[k]) floorGenders[k] = new Set();
    floorGenders[k].add(g);
  }
  for (const [k, gs] of Object.entries(floorGenders)) {
    if (gs.size > 1) {
      const [sheet, fl] = k.split('||');
      mixed_gender_floor.push(`${sheet} Floor ${fl}: both Female and Male occupants present`);
    }
  }

  return { occupancy_violations, bathroom_conflicts, chaperone_gaps, staff_separation, team_splits, room_school_mix, mixed_gender_floor };
}

function suggestFixes(report) {
  const out = {};
  const map = {
    bathroom_conflicts: [
      'Reassign one occupant of the suite to keep the pair single-gender',
      'Swap with a same-gender team in an adjacent suite',
      'Designate one room as buffer (leave empty)',
    ],
    chaperone_gaps: [
      'Move one Coach or Chaperone from the team to this floor',
      'Reassign all athletes of this team to a floor where their adults are placed',
      'Add a Camp Staff adult of matching gender to the floor',
    ],
    staff_separation: [
      'Move staff occupant to the staff hall',
      'Move non-staff occupant to a team hall suite',
      'Mark the suite as staff-only and relocate non-staff',
    ],
    occupancy_violations: [
      'Move smallest team off this floor to a hall with free capacity',
      'Split team across two floors of the same hall',
      'Reduce buffer-room allocations on this floor',
    ],
    room_school_mix: [
      'Reassign the smaller school occupant to the next empty room',
      'Insert a buffer room between the two schools',
      'Move the entire smaller team to a different floor',
    ],
    mixed_gender_floor: [
      'Relocate the minority-gender occupants to a single-gender floor',
      'Swap with a same-gender team on an adjacent floor',
      'Accept (informational only — single-gender floor not feasible with current roster mix)',
    ],
  };
  for (const cat of Object.keys(map)) {
    for (const item of report[cat] || []) out[item] = map[cat];
  }
  return out;
}
