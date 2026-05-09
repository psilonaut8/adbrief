# AdBrief — Claude Code Instructions

## Always push changes
After every edit session, commit and push to `main`. Do not leave changes in the worktree without pushing.
The live app runs at adbrief.onrender.com and deploys automatically from `main` on push.

## Stack
- Node.js + Express backend (`server.js`)
- Vanilla JS frontend (`public/app.js`, `public/index.html`, `public/style.css`)
- MongoDB storage via `lib/storage.js`
- CSV/XLSX parsing via `lib/parser.js`
- AI brief generation via `lib/brief.js` (Groq API)

## Deployment
- Hosting: Render (auto-deploys from `main`)
- Always push to `main` — feature branches do not trigger deploys

## Key conventions
- Parser derives CTR, CPC, CPM from raw values when not present in the Meta export
- ROAS cannot be derived — it requires Meta purchase conversion data and will be null for awareness/traffic campaigns
- Excel serial dates are converted to ISO strings in the parser
- Column detection info is logged to browser console after each upload (`[AdBrief] Columns detected`)
