# AdBrief — Claude Code Instructions

## Always push changes
After every edit session, commit and push to `main`. Do not leave changes in the worktree without pushing.
The live app runs at adbrief.onrender.com and deploys automatically from `main` on push.

## Stack
- Node.js + Express backend (`server.js`)
- Vanilla JS frontend (`public/app.js`, `public/index.html`, `public/style.css`)
- MongoDB storage via `lib/storage.js`
- CSV/XLSX parsing via `lib/parser.js`
- AI brief generation via `lib/brief.js` (Groq API → `openai/gpt-oss-120b`)

## Deployment
- Hosting: Render (auto-deploys from `main`)
- Always push to `main` — feature branches do not trigger deploys

## Pages
- `/` → `public/home.html` — internal client dashboard (lists all clients, copy view link, add/delete)
- `/?client=slug` → `public/index.html` — main workspace for a specific client
- `/setup?client=slug` → `public/setup.html` — 3-step Meta credentials wizard per client
- `/view/:token` → `public/view.html` — token-secured client-facing brief page (no slug in URL)

## AI Model
- Provider: Groq (free tier) — `api.groq.com`
- Model: `openai/gpt-oss-120b` (120B params, 500 t/s, free plan: 8K TPM / 200K TPD)
- Fallback if parse errors recur: switch to `meta-llama/llama-4-scout-17b-16e-instruct` (Llama 4, 30K TPM free) or `llama-3.3-70b-versatile` (proven stable)
- Model is set in `lib/brief.js` line ~119 — one-line change to swap
- The gpt-oss-120b model occasionally calls built-in tools and returns non-JSON. If this becomes frequent, add retry logic or switch models.
- Prompt frames the AI as a "creative director" writing a Monday morning debrief
- Output is forced to strict JSON schema — parsed with `raw.match(/\{[\s\S]*\}/)`

## MongoDB Collections
- `weeks` — ad data + brief per client per week (keyed as `clientslug__YYYY-WNN` or `YYYY-WNN`)
- `context` — persistent context docs per client (brand info, audience, offer)
- `meta_credentials` — Meta System User token + account ID per client (never sent to frontend)
- `clients` — client registry: slug, name, token, updatedAt

## Client system
- Each client has a unique 20-char hex token generated on creation (`crypto.randomBytes(10).toString('hex')`)
- Token is used for the public `/view/:token` URL — internal slug is never exposed
- Existing clients without tokens are auto-backfilled on `GET /clients`
- `saveClient(slug, name, token)` — only overwrites token if explicitly provided (preserves existing)

## Meta credentials
- Stored server-side only in `meta_credentials` collection — never returned to frontend
- Setup flow: `/setup?client=slug` → test connection via `POST /meta/test` → save via `POST /meta/credentials`
- Uses Meta Graph API v19.0 to validate: `/{actId}?fields=name,account_status`
- System User tokens are preferred over personal tokens (don't expire)

## Key conventions
- Parser derives CTR, CPC, CPM from raw values when not present in the Meta export
- ROAS cannot be derived — it requires Meta purchase conversion data and will be null for awareness/traffic campaigns
- Excel serial dates are converted to ISO strings in the parser
- Column detection info is logged to browser console after each upload (`[AdBrief] Columns detected`)
- Express static middleware comes AFTER explicit route registrations (critical — otherwise `app.get('/')` is bypassed)
- CSS design tokens: `--accent`, `--label`, `--label3`, `--surface`, `--sep`, `--bg` (not `--border`, `--text-primary`, etc.)

## Environment variables (set in Render dashboard)
- `MONGODB_URI` — MongoDB Atlas connection string
- `GROQ_API_KEY` — Groq API key
- `SESSION_SECRET` — Express session secret (if used)
