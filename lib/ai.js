const https = require('https');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

function anthropicRequest(payload) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
        } else {
          resolve({ error: `AI request failed (${res.statusCode})`, detail: text });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const ALLOWED_FIELDS = ['assignment', 'gender', 'category'];
const CATEGORIES = ['Athlete', 'Coach', 'Chaperone', 'Staff', 'Other'];

// Pull the first balanced top-level JSON object out of a model response.
function extractJson(text) {
  if (!text) return null;
  let s = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; } } }
  }
  return null;
}

// Keep only changes the apply-changes endpoint can actually execute.
function sanitizeChanges(raw, assignments) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const idx = Number(c.idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= assignments.length) continue;
    const field = String(c.field || '').trim();
    if (!ALLOWED_FIELDS.includes(field)) continue;
    const value = String(c.value == null ? '' : c.value).trim();
    if (!value) continue;
    if (field === 'gender' && !['Female', 'Male'].includes(value)) continue;
    if (field === 'category' && !CATEGORIES.includes(value)) continue;
    if (field === 'assignment') {
      const parts = value.split('||').map(v => String(v || '').trim());
      if (parts.length !== 3 || !CATEGORIES.includes(parts[1]) || !['Female', 'Male'].includes(parts[2])) continue;
    }
    out.push({ idx, field, value, reason: String(c.reason || '').trim().slice(0, 200) });
  }
  return out;
}

const SYSTEM = `You are the housing placement assistant for a cheer camp roster tool. You help the operator review and fix a draft room placement before it is approved and names are written.

You can propose edits ONLY through this fixed change vocabulary (each edit targets one bed by its idx):
- field "gender", value "Female" or "Male" — change a bed's gender.
- field "category", value one of Athlete | Coach | Chaperone | Staff | Other — change a bed's role category.
- field "assignment", value "Team||Category||Gender" (e.g. "Brentwood||Athlete||Female") — reassign team, category, and gender together. Team must be an exact account name from the roster headcounts.

You CANNOT relocate a bed to a different room number, add or remove beds, or change room capacity. To "move" a group, reassign the labels of the relevant existing beds. Never invent teams, rooms, or rules not present in the context. Respect any session conditions provided.

Always reply with ONE JSON object and nothing else:
{"reply": "<short plain-language message to the operator>", "changes": [{"idx": <bed idx>, "field": "<assignment|gender|category>", "value": "<value>", "reason": "<why>"}]}

If the operator only asks a question, return an empty changes array. When proposing fixes, keep the reply concise and explain the tradeoff. Do not include markdown fences.`;

function compactContext({ conditions, assignments, compliance, warnings, roster, inventory }) {
  const c = compliance || {};
  const beds = (assignments || []).map(a => ({
    idx: a._idx,
    hall: a.hall || a.sheet || '',
    floor: a.floor == null ? '' : String(a.floor),
    room: a.room_id || '',
    suite: a.suite_id || '',
    team: a.team || a.account || '',
    category: a.category || '',
    gender: a.gender || ''
  }));
  return {
    session_conditions: conditions || '(none provided)',
    problems: {
      occupancy_violations: c.occupancy_violations || [],
      bathroom_conflicts: c.bathroom_conflicts || [],
      staff_separation: c.staff_separation || [],
      room_school_mix: c.room_school_mix || [],
      team_splits: c.team_splits || [],
      mixed_gender_floor: c.mixed_gender_floor || []
    },
    warnings: warnings || [],
    roster_headcounts: roster && roster.by_team ? roster.by_team : [],
    gender_counts: roster && roster.gender_counts ? roster.gender_counts : {},
    inventory_halls: (inventory && inventory.halls) || [],
    beds
  };
}

async function askPlacementAssistant(ctx) {
  const { message, history = [] } = ctx;
  const assignments = ctx.assignments || [];

  const context = compactContext(ctx);
  const messages = [];
  for (const h of history.slice(-8)) {
    if (h.role === 'user' || h.role === 'assistant') {
      messages.push({ role: h.role, content: h.content });
    }
  }
  messages.push({
    role: 'user',
    content: `Current placement context (JSON):\n${JSON.stringify(context)}\n\nOperator says:\n${message}`
  });

  const response = await anthropicRequest({
    model: MODEL,
    max_tokens: 1200,
    system: SYSTEM,
    messages
  });

  if (!response) {
    return {
      reply: 'AI chat is not configured yet. Set ANTHROPIC_API_KEY in the Render environment to enable the assistant.',
      changes: []
    };
  }
  if (response.error) return { reply: response.error, changes: [] };

  const text = (response.content || []).map(part => part.text || '').join('\n').trim();
  const parsed = extractJson(text);
  if (!parsed) {
    return { reply: text || 'No response.', changes: [] };
  }
  return {
    reply: String(parsed.reply || '').trim() || 'Done.',
    changes: sanitizeChanges(parsed.changes, assignments)
  };
}

module.exports = { askPlacementAssistant };
