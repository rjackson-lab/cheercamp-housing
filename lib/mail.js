/**
 * Simple email sender. Uses Resend HTTPS API if RESEND_API_KEY is set.
 * Otherwise logs to console (still useful for dev).
 */
const https = require('https');

const FROM = process.env.MAIL_FROM || 'Cheer Camp Housing <onboarding@resend.dev>';

async function sendMail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`[mail:console] TO=${to} SUBJ=${subject}\n${text || html}`);
    return { skipped: true };
  }
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ from: FROM, to: [to], subject, html, text });
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, body });
        else { console.error('Resend error', res.statusCode, body); resolve({ ok: false, body }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

module.exports = { sendMail };
