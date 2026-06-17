# AdBrief - Codex Instructions

## Always Push Changes

After every edit session, commit and push to `main`. Do not leave changes in the worktree without pushing.
The live app runs at adbrief.onrender.com and deploys automatically from `main` on push.

## Stack

- Node.js + Express backend (`server.js`)
- Vanilla JS frontend (`public/app.js`, `public/index.html`, `public/style.css`)
- MongoDB storage via `lib/storage.js`
- CSV/XLSX parsing via `lib/parser.js`
- AI brief generation via `lib/brief.js` (Groq API -> `openai/gpt-oss-120b`)

## Deployment

- Hosting: Render (auto-deploys from `main`)
- Always push to `main`; feature branches do not trigger deploys

## Pages

- `/` -> `public/home.html`: internal client dashboard (lists all clients, copy view link, add/delete)
- `/?client=slug` -> `public/index.html`: main workspace for a specific client
- `/setup?client=slug` -> `public/setup.html`: 3-step Meta credentials wizard per client
- `/view/:token` -> `public/view.html`: token-secured client-facing brief page (no slug in URL)

## AI Model

- Provider: Groq (free tier), `api.groq.com`
- Model: `openai/gpt-oss-120b` (120B params, 500 t/s, free plan: 8K TPM / 200K TPD)
- Fallback if parse errors recur: switch to `meta-llama/llama-4-scout-17b-16e-instruct` (Llama 4, 30K TPM free) or `llama-3.3-70b-versatile` (proven stable)
- Model is set in `lib/brief.js` line ~119; one-line change to swap
- The gpt-oss-120b model occasionally calls built-in tools and returns non-JSON. If this becomes frequent, add retry logic or switch models.
- Prompt frames the AI as a "creative director" writing a Monday morning debrief
- Output is forced to strict JSON schema, parsed with `raw.match(/\{[\s\S]*\}/)`

## MongoDB Collections

- `weeks`: ad data + brief per client per week (keyed as `clientslug__YYYY-WNN` or `YYYY-WNN`)
- `context`: persistent context docs per client (brand info, audience, offer)
- `meta_credentials`: Meta System User token + account ID per client (never sent to frontend)
- `clients`: client registry: slug, name, token, updatedAt

## Client System

- Each client has a unique 20-char hex token generated on creation (`crypto.randomBytes(10).toString('hex')`)
- Token is used for the public `/view/:token` URL; internal slug is never exposed
- Existing clients without tokens are auto-backfilled on `GET /clients`
- `saveClient(slug, name, token)` only overwrites token if explicitly provided (preserves existing)

## Meta Credentials

- Stored server-side only in `meta_credentials` collection; never returned to frontend
- Setup flow: `/setup?client=slug` -> test connection via `POST /meta/test` -> save via `POST /meta/credentials`
- Uses Meta Graph API v19.0 to validate: `/{actId}?fields=name,account_status`
- System User tokens are preferred over personal tokens (do not expire)

## Key Conventions

- Parser derives CTR, CPC, CPM from raw values when not present in the Meta export
- ROAS cannot be derived; it requires Meta purchase conversion data and will be null for awareness/traffic campaigns
- Excel serial dates are converted to ISO strings in the parser
- Column detection info is logged to browser console after each upload (`[AdBrief] Columns detected`)
- Express static middleware comes after explicit route registrations (critical because otherwise `app.get('/')` is bypassed)
- CSS design tokens: `--accent`, `--label`, `--label3`, `--surface`, `--sep`, `--bg` (not `--border`, `--text-primary`, etc.)

## Environment Variables

Set these in the Render dashboard:

- `MONGODB_URI`: MongoDB Atlas connection string
- `GROQ_API_KEY`: Groq API key
- `SESSION_SECRET`: Express session secret (if used)

## Karpathy Skills

Behavioral guidelines to reduce common coding-agent mistakes. Merge with project-specific instructions as needed.

Tradeoff: These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

Do not assume. Do not hide confusion. Surface tradeoffs.

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them; do not pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what is confusing. Ask.

### 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No flexibility or configurability that was not requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

- Do not improve adjacent code, comments, or formatting.
- Do not refactor things that are not broken.
- Match existing style, even if you would do it differently.
- If you notice unrelated dead code, mention it; do not delete it.

When your changes create orphans:

- Remove imports/variables/functions that your changes made unused.
- Do not remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

- "Add validation" -> "Write tests for invalid inputs, then make them pass"
- "Fix the bug" -> "Write a test that reproduces it, then make it pass"
- "Refactor X" -> "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```text
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

These guidelines are working if there are fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions happen before implementation rather than after mistakes.
