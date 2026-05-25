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

async function askPlacementAssistant({ message, location, placement }) {
  const summary = {
    location: location && { name: location.name, status: location.status },
    placement: placement && {
      status: placement.status,
      total_beds: placement.total_beds,
      placed: placement.placed,
      warnings: placement.warnings || [],
      compliance: placement.compliance || {}
    }
  };

  const response = await anthropicRequest({
    model: MODEL,
    max_tokens: 700,
    system: 'You are a concise housing placement assistant. Give operational guidance only. If changes are requested, describe them clearly; do not invent hidden data.',
    messages: [{
      role: 'user',
      content: `Placement context:\n${JSON.stringify(summary, null, 2)}\n\nUser question:\n${message}`
    }]
  });

  if (!response) {
    return {
      reply: 'AI chat is not configured yet. Set ANTHROPIC_API_KEY in Render to enable assistant responses.',
      changes: []
    };
  }
  if (response.error) return { reply: response.error, changes: [] };
  const content = (response.content || []).map(part => part.text || '').join('\n').trim();
  return { reply: content || 'No response.', changes: [] };
}

module.exports = { askPlacementAssistant };
