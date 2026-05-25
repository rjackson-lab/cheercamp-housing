# Cheer Camp Housing — Multi-Location Web App

Multi-user housing placement tool. Parker Jackson (master admin) approves access; team submitters upload rosters; the engine generates placement; Parker reviews and approves the placeholder, then finalizes with real names.

## Workflow

1. **Sign up** — request access → Parker approves
2. **Login** → Locations dashboard
3. **Create location** (or open one shared with you)
4. **Upload files**: raw roster (.xlsx), blank template (.xlsx), reference (optional .xlsx), floor plans (.pdf, optional)
5. **Run Placement Engine** — generates placeholder roster with Gender (M/F) and Role (Athlete/Coach/Chaperone) populated in every row for review
6. **Review** — bed-by-bed table with searchable filters; click any Gender or Role cell to override before approval
7. **Approve Placeholder** — locks the assignment, enables finalize
8. **Finalize with Names** — generates the final .xlsx with real first/last names filled in from the raw roster
9. **AI Chat** — ask the assistant questions about the placement or describe needed changes (requires `ANTHROPIC_API_KEY`)

## Default login

- Email: `pjackson@varsity.com`
- Password: `Varsity2026`

(Override via `PARKER_EMAIL` / `PARKER_PW` before first boot.)

## Required environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Render auto-sets; defaults to 3000 |
| `SESSION_SECRET` | **Required in production.** Random 32+ char string for cookie signing |
| `DATA_DIR` | Where SQLite DB lives. Use `/data` on Render (with attached disk) |
| `NODE_ENV` | Set to `production` to enable secure cookies |
| `APP_URL` | Public URL of your deployment (used in email links). E.g. `https://cheercamp-housing.onrender.com` |
| `PARKER_EMAIL` | Master admin email (first boot only) |
| `PARKER_PW` | Master admin password (first boot only) |

## Optional environment variables (for full feature set)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Enables AI chat. Get one at console.anthropic.com |
| `ANTHROPIC_MODEL` | Override default model (`claude-sonnet-4-20250514`) |
| `RESEND_API_KEY` | Enables outbound email. Sign up at resend.com (3,000 free emails/mo). Without this, all emails log to the server console |
| `MAIL_FROM` | From address. Default: `Cheer Camp Housing <onboarding@resend.dev>` (Resend's test sender). For production, verify your own domain in Resend and use `Housing <housing@yourdomain.com>` |

## Email notifications

When configured (`RESEND_API_KEY` set), the system sends:
- **New signup → all admins** with approve/reject link
- **Account approved → the user** with sign-in link
- **Password reset → the user** with a 1-hour reset link

Without `RESEND_API_KEY`, emails print to the server console (visible in Render logs) — useful for development, but real users won't get them.

## Per-location access

- **Admins** see all locations
- **Regular users** see only locations they created OR were granted access to
- Grant access from the location page → Shared Access panel → enter approved user's email

## Deployment on Render

Render auto-reads `render.yaml`. Steps:

1. Push to GitHub
2. render.com → New + → Web Service → connect repo
3. Set sensitive env vars in the dashboard:
   - `SESSION_SECRET` (click Generate)
   - `PARKER_EMAIL`, `PARKER_PW` (your choice)
   - `APP_URL` (your render URL, e.g. `https://cheercamp-housing.onrender.com`)
   - `ANTHROPIC_API_KEY` (optional, for AI chat)
   - `RESEND_API_KEY` + `MAIL_FROM` (optional, for emails)
4. Plan: **Starter** ($7/mo) — required for the persistent disk that keeps your DB alive across restarts
5. Deploy

## Local development

```bash
npm install
PARKER_EMAIL=test@local PARKER_PW=Varsity2026 node server.js
# visit http://localhost:3000
```

## Files

```
server.js               # Express app — all routes
package.json
render.yaml             # Render deploy config
lib/
  db.js                 # SQLite schema + Parker bootstrap
  placement.js          # Engine entry: runPlacement, finalizeWithNames
  _placement_core.js    # Ported placement algorithm
  mail.js               # Email helper (Resend)
  ai.js                 # AI chat helper (Anthropic)
public/
  styles.css            # UCA brand (Montserrat + navy/gold)
  gate.html             # Login + signup + forgot password
  dashboard.html        # Unified locations dashboard (admin + user)
  dashboard.js
  location.html         # Per-location workspace
  location.js
  reset.html            # Password reset confirmation
data/                   # Created at runtime — SQLite DB + uploaded files
```

## Status / approval state model

| Location status | Meaning |
|---|---|
| `not_started` | No placement runs yet |
| `in_process` | Placement run but has advisory issues (team splits, mixed-gender floors) |
| `errors` | Placement run with blocker violations or fewer than expected beds placed |
| `completed` | Finalized roster generated |

| Placement state | UI |
|---|---|
| Run, not approved | "Approve Placeholder" button enabled (or disabled if blockers) |
| Approved | "Approved [date]" stamp; "Finalize with Names" button appears |
| Finalized | Download Final Roster button |

Admin can **unapprove** to unlock for further edits.
