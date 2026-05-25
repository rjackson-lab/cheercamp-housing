# Cheer Camp Housing — Multi-Location Web App

A multi-user housing placement tool for cheer camp operations. Parker Jackson (master admin) approves user signups, manages multiple camp locations, and each location runs the same placement engine on its own files.

---

## What's in this app

**Auth & Roles**
- Public signup → status `pending`
- Parker Jackson must approve before login is allowed
- Roles: `admin` (full access), `user` (create/manage own locations)

**Per-Location Workflow**
Each camp location has:
- **Raw roster data** (xlsx — the registration export)
- **Blank template** (xlsx — the destination roster format)
- **Reference template** (xlsx, optional — completed prior-session for structural reference)
- **Floor plans** (PDFs, multiple allowed)
- Auto-runs the placement engine and stores the output

**Admin Dashboard (Parker only)**
- Pending access requests (approve / reject inline)
- Locations split into **Completed / In Process / Errors-or-Not-Started**
- Stat cards for at-a-glance counts
- User list (promote to admin)

**Placement Engine (same rules per location)**
- No mixed-gender pods (strict, per-bed gender enforcement)
- No mixed schools in any pod
- Teams kept on same floor when possible
- Proportional multi-floor split with chaperone coverage when forced
- Buffer pod left between teams when floor space allows
- Staff housed in dedicated staff hall
- Outputs a placeholder roster as xlsx (byte-preserving surgical writer)

---

## Quick start (local)

```bash
npm install
node server.js
# Visit http://localhost:3000
```

On first boot, Parker Jackson is auto-created:
- Email: `pjackson@varsity.com`
- Password: `Varsity2026`

These defaults can be overridden via `PARKER_EMAIL` and `PARKER_PW` env vars before first boot.

---

## Required environment variables

| Variable | Required? | Notes |
|---|---|---|
| `PORT` | no | defaults to `3000` (hosting platforms set this automatically) |
| `SESSION_SECRET` | **yes in production** | random 32+ char string for cookie signing |
| `PARKER_EMAIL` | recommended | Parker's email (used only on first boot to seed admin) |
| `PARKER_PW` | **strongly recommended** | Parker's initial password (8+ chars) |
| `DATA_DIR` | optional | absolute path where `housing.db` lives (default: `./data`) |
| `NODE_ENV` | recommended | set to `production` on the host to enable secure cookies |

---

## Deploy on Render

1. Push this repo to GitHub.
2. On render.com → **New +** → **Web Service** → connect your repo.
3. Configure:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Starter ($7/mo — required for persistent disk)
4. Under **Disks**, add a disk:
   - **Name:** `data`
   - **Mount Path:** `/data`
   - **Size:** 1 GB (plenty)
5. Under **Environment**, set:
   - `SESSION_SECRET` = (click Generate)
   - `PARKER_EMAIL` = `parker@yourdomain.com`
   - `PARKER_PW` = (a strong password — change after first login)
   - `DATA_DIR` = `/data`
   - `NODE_ENV` = `production`
6. Deploy. First boot will seed Parker. Sign in at the Render URL.

---

## Deploy on Railway

1. Push to GitHub.
2. railway.app → **New Project** → **Deploy from GitHub**.
3. Add a **Volume**:
   - Mount Path: `/data`
4. Variables (same as Render above): `SESSION_SECRET`, `PARKER_EMAIL`, `PARKER_PW`, `DATA_DIR=/data`, `NODE_ENV=production`.
5. Deploy.

---

## Deploy on a VPS (DigitalOcean, Linode, EC2, etc.)

```bash
# On the server
git clone <your-repo> /opt/cheercamp
cd /opt/cheercamp
npm install --production
mkdir -p /var/lib/cheercamp

# Run under systemd
sudo tee /etc/systemd/system/cheercamp.service <<EOF
[Unit]
Description=Cheer Camp Housing
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/cheercamp
Environment=PORT=3000
Environment=DATA_DIR=/var/lib/cheercamp
Environment=SESSION_SECRET=CHANGE_ME_TO_RANDOM_STRING
Environment=PARKER_EMAIL=parker@yourdomain.com
Environment=PARKER_PW=CHANGE_ME_STRONG_PASSWORD
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now cheercamp
```

Front it with nginx + Let's Encrypt for HTTPS.

---

## File / directory layout

```
.
├── server.js                # Express app — all API routes
├── package.json
├── lib/
│   ├── db.js                # SQLite schema + Parker bootstrap
│   ├── placement.js         # Engine entry: runPlacement(raw, blank, ref)
│   └── _placement_core.js   # Ported algorithm (ingest / parse / build / compliance / surgical writer)
├── public/
│   ├── styles.css           # UCA brand (Montserrat, navy + gold)
│   ├── gate.html            # Login + signup
│   ├── admin.html           # Parker's dashboard
│   ├── admin.js
│   ├── app.html             # User dashboard (location grid)
│   ├── location.html        # Per-location workspace
│   └── location.js
└── data/                    # SQLite DB + uploaded files (BLOBs)
    └── housing.db           # Created on first run
```

---

## How the engine status mapping works

After a placement run, the location's status is computed:

| Condition | Status |
|---|---|
| Any of: occupancy / bathroom / staff-sep / school-mix violations | `errors` |
| Beds placed < total beds | `errors` |
| Team splits OR mixed-gender floors OR warnings present | `in_process` |
| Clean — zero advisories | `completed` |

Team-splits and mixed-gender-floor counts are advisory, not blockers — they reflect operational reality when teams have minority-gender members.

---

## Admin operations cheat-sheet

| Task | How |
|---|---|
| Approve a signup | Pending Access Requests panel → **Approve** |
| Reject a signup | Pending Access Requests panel → **Reject** |
| Promote user to admin | All Users panel → **Make admin** |
| Create new location | **+ New Location** button (top right) |
| Upload files to a location | Click the location card → upload buttons in "Upload Files" panel |
| Run placement | Location page → **Run Placement Engine** |
| Download finished roster | Location page → "Download Roster" panel → **Download .xlsx** |
| Delete a location | API only (admin role): `DELETE /api/locations/:id` |

---

## Security notes

- Passwords hashed with bcrypt (10 rounds)
- Sessions stored server-side in SQLite (not JWT — easy revocation)
- Cookies are `httpOnly`; set `NODE_ENV=production` to enable `secure` flag (HTTPS-only)
- File uploads capped at 25 MB
- Generate a unique `SESSION_SECRET` per deployment
- Change Parker's default password immediately after first login (no UI for self-service password change yet — use SQL: `UPDATE users SET password_hash=? WHERE email='parker@...'` with a bcrypt-hashed value, or add an admin endpoint)

---

## Future enhancements (not yet built)

- Self-service password change UI
- Email notifications on signup/approval
- Per-location run history viewer with diff
- Floor-plan annotation overlay
- "Finalize with names" step (currently outputs placeholders only — name-filling is the next step in the placement workflow but not yet wired into the API)
