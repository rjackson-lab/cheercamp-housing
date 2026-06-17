# UCA Camp Housing — Multi-Location Placement Tool

A multi-tenant Node.js web application for managing UCA cheer camp housing placement across multiple campus venues. Admins curate camp **Locations** (venues with reusable blank templates + reference rosters + floor plans). Non-admin users create **Sessions** against those locations, upload raw rosters, run the placement engine, review compliance, approve placeholders, and finalize with participant names.

Live: https://cheercamp-housing.onrender.com

## Architecture

- **Locations** = camp venues, admin-managed. Each has: name, description, blank rooming template (required), reference template (optional), floor plans (multiple PDFs/images, up to 100MB each).
- **Sessions** = user-owned placement instances. Each session is tied to one location and has its own raw roster, placement output, approval state, and final file.
- **Placements** = the actual algorithm runs. Each session can have multiple placement runs (re-runs preserve history).

## User roles & views

- **Admin** lands on `dashboard.html`:
  - **Locations tab** — grid of venues with template/floor plan status, "+ New Location" modal that captures name + blank template + reference template (optional) + multiple floor plans in one flow
  - **Sessions tab** — every user's sessions across all venues with status pills and direct links
  - **Admin Tools tab** — user approvals and role management
  - **Location detail** at `/location/:id` for editing venue + managing files
- **Non-admin** lands on `operations.html`:
  - Six-step nav (Upload → Analyze → Placeholder Build → Approval → Finalize → Export)
  - Step 1: pick a venue (only admin-curated venues with a blank template appear)
  - Step 2: upload raw roster (auto-creates a session)
  - Step 3: review with stats, compliance grid, hall breakdown, bed-by-bed editable table
  - Step 4: approve placeholder (locks edits) → finalize with names → download final
  - Resume panel at top for in-progress sessions; `/session/:id` deep-links

Every authenticated page has a profile dropdown (header avatar → Profile settings, Change password, Sign out) for editing name, email, and password.

## Two-stage approval workflow

1. Run placement → generates placeholder.xlsx + placement DB record with `is_approved=0`
2. Review the bed-by-bed table with editable Gender/Role dropdowns
3. Click **Approve Placeholder** → `is_approved=1`, edits locked
4. After approval, **Finalize with Names** appears → writes First/Last names into approved placeholder → download final
5. Admin can unapprove to unlock for re-editing if needed

## API summary

Auth/profile: `POST /api/signup`, `/login`, `/logout`, `GET /api/me`, `PATCH /api/profile`, `POST /api/password/change`, `POST /api/password/reset/request`, `POST /api/password/reset/confirm`

Admin: `GET /api/admin/users`, `POST /api/admin/users/:id/approve`, `/reject`, `/role`

Locations (admin-only writes, all-auth reads): `GET /api/locations`, `POST /api/locations` *(admin)*, `GET /api/locations/:id`, `PATCH /api/locations/:id` *(admin)*, `DELETE /api/locations/:id` *(admin)*, `POST /api/locations/:id/files` *(admin; kind=blank|reference|floorplan)*

Sessions (user-owned): `GET /api/sessions`, `POST /api/sessions`, `GET /api/sessions/:id`, `PATCH /api/sessions/:id`, `DELETE /api/sessions/:id`, `POST /api/sessions/:id/raw`, `POST /api/sessions/:id/run`, `GET /api/sessions/:id/placement`, `GET/POST /api/sessions/:id/chat`

Placements: `POST /api/placements/:id/approve`, `/unapprove` *(admin)*, `/finalize`, `/apply-changes`, `PATCH /api/placements/:id/assignments/:idx`

Files: `GET /api/files/:id`, `DELETE /api/files/:id`

## Deployment

Render Starter plan with a `/data` persistent disk. `render.yaml` is in the repo.

**Environment variables:**
- `PORT`, `SESSION_SECRET`, `DATA_DIR=/data`, `NODE_ENV=production`, `APP_URL=https://your-domain`
- *First boot only:* `PARKER_EMAIL`, `PARKER_PW` (seeds the initial admin)
- *Optional:* `OPENAI_API_KEY` + `OPENAI_MODEL=gpt-4.1-mini` for AI chat, `RESEND_API_KEY` + `MAIL_FROM` for emails

Default admin (first boot, override with env vars): **pjackson@varsity.com / Varsity2026**

## File upload limits

100MB per file (covers large floor-plan PDFs and images). Adjust the `multer` config in `server.js` if needed.

## Tech stack

Express · express-session · better-sqlite3 (WAL) · bcryptjs · multer · SheetJS (xlsx) · JSZip · connect-sqlite3 · OpenAI API · Resend
