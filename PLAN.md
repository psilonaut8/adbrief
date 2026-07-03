# AdBrief Execution Plan

This is the work queue for AdBrief. Tasks are designed to be executed **one per session, in order**, by any capable model. Each task is self-contained: it says what to build, exactly where, what NOT to touch, and how to prove it works.

A senior reviewer will verify each task after completion using the "Verify" section of each card. Do not mark a task done unless every Verify item passes locally.

## Global rules (read before every task)

1. **Scope discipline.** Touch only the files listed in the task. No refactors, no renames, no formatting sweeps, no drive-by fixes. If you notice an unrelated bug, add a note under "Discoveries" at the bottom of this file — do not fix it.
2. **Match existing style.** Vanilla JS, no build step, no new frameworks. Frontend uses plain DOM APIs and the existing helpers (`esc()`, `show()`, `hide()`, `setStatus()`, `fmtNum()` etc. in `public/app.js`). Backend is plain Express in `server.js` with helpers in `lib/`.
3. **New dependencies** are allowed only where a task explicitly names them. Add to `package.json` via `npm install <pkg>`.
4. **Run locally before committing.** `npm install && node server.js` with a `.env` containing `MONGODB_URI` and `GROQ_API_KEY` (ask the operator if missing). App runs at http://localhost:3000.
5. **Commit per task** with message `T<number>: <short description>`. Push to `main` only when the task's Verify checklist passes (main auto-deploys to adbrief.onrender.com).
6. **Update this file** when you finish a task: change its status line from `Status: TODO` to `Status: DONE (<date>, <commit sha>)`.
7. **CSS design tokens** are `--accent`, `--label`, `--label3`, `--surface`, `--sep`, `--bg`. Do not invent new token names.
8. **Never expose Meta tokens to the frontend.** Any endpoint returning credentials info may return masked hints only.

## Environment / manual steps for the operator (Dee)

- Before T1 deploys: add `APP_PASSWORD` (choose a login password) and `SESSION_SECRET` (any long random string) in the Render dashboard env vars.
- After T1 deploys: internal pages require login; existing client view links keep working with no login.

---

# Phase 1 — Security & stability (do these first, in order)

## T1 — Password gate on internal pages · Status: DONE (2026-07-03, 5079258)

**Problem:** Every internal route (dashboard, workspace, delete endpoints, Meta import, `/clients` which returns share tokens) is publicly accessible. The client-facing token URLs are the only thing that should be public.

**Files:** `server.js`, new `public/login.html`, `package.json`.

**Build:**
1. `npm install cookie-session`.
2. In `server.js`, after `app.use(express.json())`, add cookie-session middleware: name `adbrief_sess`, keys `[process.env.SESSION_SECRET || 'dev-secret']`, maxAge 30 days.
3. Create `public/login.html`: minimal centered card matching existing style.css look (reuse `.bcard`, `.input`, `.btn-primary` classes; link `style.css`). One password field, POSTs JSON to `/login`, on success `location.href` to the `next` query param or `/`. Show error text on 401.
4. Add routes: `GET /login` serves login.html (always public). `POST /login` compares `req.body.password` to `process.env.APP_PASSWORD`; on match set `req.session.authed = true` and return `{ ok: true }`; else 401 `{ error: 'Wrong password.' }`. If `APP_PASSWORD` is unset, treat auth as disabled (everything public) so local dev without env vars still works — log a warning at startup.
5. Add an auth middleware placed **before** all other routes/static and after session middleware. PUBLIC allowlist (no auth required):
   - `GET /login`, `POST /login`
   - `GET /view/:token`, `GET /api/view/:token`
   - `POST /comment`, `POST /reaction` (the public view page uses these; PUT/DELETE `/comment` stay protected)
   - Static files: `/style.css` only (view.html and login.html need it), plus font requests go to Google so nothing else is needed.
   - Everything else: if `!req.session.authed` → for `GET` requests that accept HTML, redirect to `/login?next=<originalUrl>`; for API/JSON requests return 401 `{ error: 'Not logged in' }`.
6. IMPORTANT: `express.static` currently serves `home.html`, `index.html`, `app.js`, `setup.html` directly. The auth middleware must run **before** `express.static`, and the allowlist must be an explicit path check (e.g. a function testing `req.path`), so `/home.html`, `/index.html`, `/app.js`, `/setup.html` are all protected. `view.html` is served via the `/view/:token` route; direct `/view.html` static access may remain protected (the route sends the file server-side, which bypasses the middleware — verify this works).

**Do not:** add user accounts, roles, password hashing (single shared password is the spec), or touch any frontend page other than the new login.html.

**Verify:**
- [ ] Logged out: `/`, `/?client=x`, `/home.html`, `/app.js`, `/clients`, `/history` all redirect to login or 401.
- [ ] Logged out: `/view/<real-token>` renders fully (styles load, brief loads, posting a comment works).
- [ ] `POST /login` with wrong password → 401; right password → dashboard works, session survives refresh.
- [ ] `DELETE /comment` and `PUT /comment` fail with 401 when logged out.
- [ ] With `APP_PASSWORD` unset locally, app behaves exactly as before (no login required).

## T2 — Fix the Monday data-loss trap (week rollover) · Status: DONE (2026-07-03, 410c5f8, verified)

**Problem:** All reads/writes key on the *current* ISO week. Data uploaded Friday appears "gone" on Monday because the week key rolled over.

**Files:** `server.js`, `public/app.js`, `public/index.html`.

**Build:**
1. In `GET /week/current` (server.js): if the current week has no ads, find the most recent week for this client that HAS ads (use `listWeeks(client)`, iterate newest-first, load until one has `ads.length`; cap at 8 lookups). Return `{ weekKey, week, isCurrentWeek: false, currentWeekKey }` for the fallback case; `{ weekKey, week, isCurrentWeek: true }` normally.
2. In `POST /generate-brief`: accept optional `weekKey` in the body (validate: must start with the client prefix `<client>__` when a client is set, else must not contain `__`). Default remains the current week.
3. In `public/app.js` `loadCurrentWeek()`: when `isCurrentWeek === false`, set `currentWeekKey` to the returned key, render as today, and show a dismissible banner above the brief panel: "Showing last week's data (`<display key>`) — this week has no data yet. Uploading new files starts a fresh week." Add the banner element to `index.html` (hidden by default) styled like the existing `.wakeup-banner`.
4. `generateBrief` click handler: send `{ client: CLIENT, weekKey: currentWeekKey }` so the brief lands on the week being viewed.

**Do not:** change how uploads choose their week (uploads still write to the actual current week), and do not touch the Data tab's week picker.

**Verify:**
- [ ] Seed a past week in Mongo with ads, leave current week empty → workspace loads that week, banner visible, Generate produces a brief saved on the PAST week key.
- [ ] With current-week data present → no banner, behavior unchanged.
- [ ] `POST /generate-brief` with a weekKey belonging to a different client prefix → 400.

## T3 — Stop Meta import from silently destroying briefs · Status: DONE (2026-07-03, 0833771 + review fix 6b7a9fe, verified)

**Problem:** `POST /meta/import` sets `existing.brief = null` and replaces ads even when a generated (possibly client-shared) brief exists.

**Files:** `server.js`, `public/app.js`.

**Build:**
1. In `/meta/import`: before writing, load the existing week. If `existing.brief` exists and `req.body.force !== true`, return 409 `{ needsConfirm: true, message: 'This week already has a generated brief. Importing will replace the data and delete the brief.' }`.
2. In `doImport()` (app.js): on 409 with `needsConfirm`, show `confirm(message + ' Continue?')`; if confirmed, retry with `force: true`.

**Verify:**
- [ ] Week with brief + import → confirm dialog appears; Cancel leaves brief intact; OK replaces data and clears brief.
- [ ] Week without brief → imports with no dialog (unchanged behavior).

## T4 — Harden brief generation (JSON mode, retry, context cap, W53) · Status: DONE (2026-07-03, 55eb3e6, verified)

**Files:** `lib/brief.js`, `lib/storage.js`, `server.js`.

**Build:**
1. `lib/brief.js`: add `response_format: { type: 'json_object' }` to the Groq request body. Keep the existing `raw.match(/\{[\s\S]*\}/)` parse as fallback.
2. Retry: wrap the request+parse in a loop of max 2 attempts. Retry only when parsing fails or Groq returns 429/5xx (on 429, wait 3 seconds first). If both attempts fail, return the existing `{ ok: false, raw }` shape.
3. Context cap in `server.js` `/generate-brief`: truncate each context doc's text to 4,000 chars and the combined context block to 12,000 chars, appending `"\n[truncated]"` when cut.
4. ISO-week math fix in `lib/storage.js`: `getRecentHistory` currently does `w += 52` (wrong in 53-week ISO years). Replace the manual arithmetic: derive each previous week key by calling `getWeekKey(new Date(Date.now() - i * 7 * 86400000))`... **No** — the base week is not "now"; it's the passed `currentWeekKey`. Correct approach: convert the base `YYYY-WNN` to a date (the Thursday of that ISO week: Jan 4 of YYYY + (NN−1)×7 days, then shift to that week's Thursday via the same day-of-week math used in `getWeekKey`), subtract `i*7` days, and call `getWeekKey()` on the result. Apply the same fix to `getPreviousWeekSummary` (or delete it if truly unused — check: it is exported but verify no callers; if unused, remove the export and function).

**Verify:**
- [ ] Generate a brief against real data — succeeds; server log shows no parse fallback.
- [ ] Unit-style check in node REPL: history keys walk correctly across a year boundary (e.g. base `2027-W01` → `2026-W53`, since 2026 is a 53-week ISO year).
- [ ] Upload a huge context file (>20k chars) → generation still succeeds; prompt context is capped.

---

# Phase 2 — Data trust

## T5 — Correct aggregate metrics (weighted, typed results) · Status: DONE (2026-07-03, 7b0a422, verified)

**Problem:** Summary bar and Trends show unweighted per-ad means; mixed result types get summed under one label.

**Files:** `public/app.js` (`renderDataSummary`), `server.js` (`/trends`).

**Build — exact formulas:**
- Avg CTR = (Σ clicks ÷ Σ impressions) × 100, using only ads where both are non-null; fall back to unweighted mean of `ctr` if no ad has clicks+impressions.
- Avg CPM = (Σ spend ÷ Σ impressions) × 1000, same fallback rule with `cpm`.
- Avg CPC = Σ spend ÷ Σ clicks (only if you already display CPC; do not add new stats).
- Avg ROAS = Σ(roas × spend) ÷ Σ(spend) over ads where both non-null; fall back to unweighted mean.
- Results: group ads by `resultType`; display the type with the largest summed value as `"<total> <type>"`; if more than one type exists, append `" (+N other types)"` to the label's title attribute and render a small suffix like `+2 types`.
- Apply the same CTR/ROAS formulas inside `/trends` week aggregation.

**Do not:** change table columns, card layout, chart code, or per-ad values — only the aggregate computations and the results label.

**Verify:**
- [ ] Construct a CSV with one ad at $1000 spend / 1% CTR and one at $2 spend / 9% CTR → Avg CTR displays ≈1.02% (weighted), not ≈5%.
- [ ] CSV mixing `Leads` and `Link Clicks` result types → summary shows the dominant type, not a mixed sum.
- [ ] Trends chart still renders; values change only where weighting differs.

## T6 — Upload semantics: update on re-upload, optional replace · Status: DONE (2026-07-03, c6c2eaa, verified)

**Problem:** `/upload` and `/sheets` skip rows whose `adName` already exists, so re-uploading a corrected export does nothing.

**Files:** `server.js`, `public/app.js`, `public/index.html`.

**Build:**
1. Server (`/upload` and `/sheets` share this logic — extract a small local helper `mergeAds(prevAds, newAds, mode)` in server.js): mode `merge` (default) = new rows with an existing `adName` **replace** that row (preserve `imageUrl` from the old row if the new row has none); unmatched old rows are kept; genuinely new names are appended. Mode `replace` = discard all previous ads. Accept `mode` from the request (form field for /upload, JSON field for /sheets).
2. Response: include `updated` count alongside `added`/`total`.
3. Frontend: under the file-drop in the sidebar, add a small checkbox `Replace existing data` (default unchecked) → sends `mode=replace`. Status line becomes e.g. `"3 added, 12 updated — 34 total"`.

**Verify:**
- [ ] Upload a CSV, change one ad's spend in the file, re-upload → spend updates, no duplicates, status shows `1 updated`.
- [ ] Replace checkbox ticked → only the new file's ads remain.
- [ ] Ads enriched with thumbnails keep their `imageUrl` after a metric-only re-upload.

## T7 — Visible error states (kill the silent catches) · Status: DONE (2026-07-03, 147e1c4, verified)

**Problem:** ~10 `catch { /* silent */ }` blocks make server/Mongo failures look like empty data.

**Files:** `public/app.js`, `public/index.html`, `public/style.css` (one small class).

**Build:**
1. Add a helper in app.js: `renderLoadError(containerId, retryFn)` that injects `<div class="load-error">Couldn't load this. <button>Retry</button></div>` and wires the button.
2. Apply it in the catch blocks of: `loadCurrentWeek`, `loadDataTab`, `loadHistory`, `loadTrendsTab`, `loadContextDocs`, `loadSopTab`. Choose the natural container for each (e.g. `historyGrid`, `dataEmpty`'s parent, `trendsEmpty`'s parent, `ctxList`, the brief panel's empty-state area).
3. Add `.load-error` styling in style.css using existing tokens (muted text, small outline button).
4. Keep catches that are legitimately silent (reaction clicks, wakeup banner) as they are.

**Verify:**
- [ ] Stop MongoDB (or point `MONGODB_URI` at a bad host) → each tab shows the error + Retry instead of an empty state; Retry works after restoring the DB.
- [ ] Normal operation renders identically to before.

---

# Phase 3 — Product value

## T8 — Show creatives inside the brief (thumbnails + click-through) · Status: TODO

**Problem:** The brief names ads but never shows them; users must hunt in the Data tab to see what "Summer Sale v2" looks like.

**Files:** `public/app.js`, `server.js` (`/api/view/:token`), `public/view.html`, `public/style.css`.

**Build:**
1. app.js: keep the loaded week's ads in a module-level `weekAds` array — set it in `loadCurrentWeek`, `loadWeek`, and after generate (refetch `/week/current?client=` after a successful generate to populate it).
2. Add `findAdByName(name)`: try exact case-insensitive match on `adName`; else compare normalized forms (lowercase, strip all non-alphanumerics); else `normalizedWeekAdName.includes(normalizedBriefName)` or vice-versa when the shorter is ≥10 chars. Return the ad or null.
3. In `renderAdList`, for item types that have `adName`: if a matching ad has `imageUrl`, render a small thumbnail (`<img class="ad-item-thumb">`, ~48px, rounded, `onerror` hides it) at the start of the card. If a match exists (with or without image), make the card clickable → `openAdModal([...weekAds], indexOfMatch)` (reuses the existing modal + arrow navigation). Add `cursor:pointer` only for matched cards.
4. Client view: in `/api/view/:token`, add `adImages: [{ adName, imageUrl }]` built from the week's ads that have an `imageUrl` (names + image URLs only — no metrics, no ids). In view.html, apply the same matching to show thumbnails on brief cards (no modal needed on the client page; image only).
5. style.css: `.ad-item-thumb` sizing/spacing for both pages; keep the cards' current layout intact when no image exists.

**Verify:**
- [ ] Meta-imported week: brief cards show thumbnails for matched ads; clicking a matched card opens the ad modal on the right ad; arrows navigate.
- [ ] Brief items whose names don't match any ad render exactly as before (no cursor change, no broken layout).
- [ ] Client view page shows thumbnails; response payload contains only names + image URLs.

## T9 — Draft/publish workflow + brief editing · Status: TODO

**Problem:** Raw AI output is instantly visible on the client link; operators can't fix wording or hide a bad recommendation first.

**Files:** `server.js`, `public/app.js`, `public/index.html`, `public/style.css`.

**Build:**
1. Data model: `week.briefStatus` = `'draft'` | `'published'`. `POST /generate-brief` sets `'draft'`. New endpoints: `POST /brief/publish` `{ weekKey }` → sets `'published'`; `POST /brief/update` `{ weekKey, brief }` → validates `brief` is an object with only the known top-level keys (`topPerformers`, `underperformers`, `fatigueAlerts`, `makeNext`, `retireNow`, `summary`) and saves it (keeps current status). Both require auth (already covered by T1 middleware).
2. `GET /api/view/:token`: walk weeks newest-first and serve the most recent week whose `briefStatus === 'published'` (legacy weeks with a brief but no status count as published, so existing client links don't break).
3. UI (index.html brief header): status pill (`Draft` amber / `Published` green) + `Publish` button (hidden when published). Add an `Edit` toggle: in edit mode, `.ad-why`, `.ad-action`, `.ad-name`, `.ad-metric` and summary bullets become `<textarea>`/`<input>` fields; a per-card ✕ removes an item; `Save changes` collects the DOM back into the brief object and POSTs `/brief/update`; `Cancel` re-renders from the saved brief. Keep it simple: rebuild the whole brief DOM in edit mode via a parallel render path rather than mutating the read-only one.
4. After Publish, show the copyable view link (fetch it from `/clients` and find the current slug's token, or add `token` to the `/week/current` response for the client — pick the simpler; do not create new token logic).

**Do not:** version briefs, add rich text, or touch the comments system.

**Verify:**
- [ ] Generate → status Draft; client link shows the previous published week (or "not ready" if none), NOT the draft.
- [ ] Edit → change a `why`, delete one item, Save → persists after refresh; counts update.
- [ ] Publish → pill flips, client link now shows this week with edits.
- [ ] A legacy week (brief, no `briefStatus`) still appears on the client link.

## T10 — Merge the Meta sidebar into one coherent data-source flow · Status: TODO

**Problem:** Section is labeled "Meta thumbnails" but its main button imports full stats and replaces data; a separate button patches thumbnails. Two mental models, one wrong label.

**Files:** `public/index.html`, `public/app.js`.

**Build:**
1. Rename the section label to `Meta Ads account`. Connected state shows: account hint, range select, primary `Import from Meta` button, small `Disconnect` text-button. Remove the standalone `Fetch thumbnails` button from the UI.
2. Auto-enrich: after a successful CSV/Sheets upload, if Meta is connected (`/meta/config` said `configured`), automatically call `/meta/enrich` and append to the status line: `· thumbnails matched for X/Y ads` (or silently skip on error — enrichment is best-effort). Keep the `/meta/enrich` endpoint itself unchanged.
3. Keep all IDs referenced by app.js consistent — update both files together.

**Verify:**
- [ ] Connected + CSV upload → thumbnails appear in Data tab without any extra click; status mentions the match count.
- [ ] Not connected → upload works exactly as before, no enrich call fired (check network tab).
- [ ] Import from Meta still works, including the T3 confirm flow.

---

# Phase 4 — Hardening & performance

## T11 — Comment integrity: IDs, caps, rate limit · Status: TODO

**Files:** `server.js`, `public/app.js`, `public/view.html`.

**Build:**
1. New comments get `id: crypto.randomBytes(6).toString('hex')` on create. `PUT /comment` and `DELETE /comment` accept `{ weekKey, id }` (keep index-based handling as fallback when `id` is absent, for old comments without ids). Frontend sends ids when present.
2. Caps on `POST /comment`: author ≤ 40 chars, text ≤ 2000 chars, max 200 comments per week → 400 with clear messages. Trim both fields.
3. Rate limit (hand-rolled, no new dependency): in-memory `Map<ip, timestamps[]>`; allow 10 `POST /comment` and 30 `POST /reaction` per IP per minute; over limit → 429 `{ error: 'Too many requests — slow down.' }`. Prune old timestamps on each hit.
4. `/reaction`: only accept emoji in the known set `['👍','❤️','🔥']` and `delta` of ±1 → else 400.

**Verify:**
- [ ] Edit/delete still work on both old (no id) and new comments; two browsers commenting concurrently can't delete the wrong comment via stale index when ids are present.
- [ ] 11th comment within a minute from one IP → 429.
- [ ] Oversized author/text rejected with a readable error shown in the UI alert.

## T12 — API hygiene: token handling, limits, timeouts, indexed queries · Status: TODO

**Files:** `server.js`, `lib/storage.js`.

**Build:**
1. Meta Graph calls: move `access_token` out of URLs — send header `Authorization: Bearer <token>` on every `fetch` to graph.facebook.com (Graph API supports it). Remove `access_token` query params, including the un-encoded one in `/meta/test`.
2. `fetchMetaPages`: add `{ timeout: 30000 }` to fetch options (node-fetch v2 supports it) and a hard cap of 25 pages; if the cap is hit, stop and continue with what was fetched.
3. Multer limit 100MB → 15MB. On multer's `LIMIT_FILE_SIZE` error return 400 `"File too large — export a smaller date range (max 15MB)."` (add an error-handling middleware after routes or wrap the handler).
4. `saveWeek`: also `$set` a `client` field (derive: `weekKey.includes('__') ? weekKey.split('__')[0] : ''`). `listWeeks`: query `{ weekKey: new RegExp('^' + prefix + '__') }` (escape the prefix) or `{ weekKey: { $not: /__/ } }` for the no-client case, instead of fetching everything. On startup, `createIndex({ weekKey: 1 })` and `createIndex({ client: 1 })` on `weeks` (fire-and-forget with `.catch(console.error)`).

**Verify:**
- [ ] Meta import + test-connection + enrich all still work (header auth).
- [ ] 20MB file upload → clean 400 message, server stays up.
- [ ] `/history` and `/clients` return the same lists as before the query change (compare against a pre-change response).

## T13 — Thumbnail persistence (Meta CDN URLs expire) · Status: TODO

**Problem:** Stored `imageUrl`s are signed Meta CDN links that die after days/weeks; historical weeks silently lose their images.

**Files:** `server.js`, `lib/storage.js`, `public/app.js`, `public/view.html`.

**Build:**
1. New Mongo collection `thumbs`: `{ key, contentType, data (base64), updatedAt }` where `key` = `<client>__<adId or normalized adName>`. Add `saveThumb`/`loadThumb` in storage.js.
2. New route `GET /thumb/:key` (public — images are embedded in the client view too): serve from `thumbs` with `Cache-Control: public, max-age=604800`; 404 if missing. Reject keys not matching `/^[a-z0-9_-]+$/i`.
3. On `/meta/import` and `/meta/enrich`: after resolving each ad's image URL, fetch the image (timeout 15s, skip if > 500KB or non-image content-type), store it in `thumbs`, and set the ad's `imageUrl` to `/thumb/<key>`. Fetch sequentially in batches of 5; failures fall back to storing the raw Meta URL as before.
4. Frontend needs no change if `imageUrl` is already used verbatim — confirm both `<img src>` sites (card view, modal, brief thumbs, view page) work with relative URLs.

**Verify:**
- [ ] Import from Meta → ads' `imageUrl` values are `/thumb/...`; images render in Data tab, modal, brief, and client view.
- [ ] `GET /thumb/<key>` returns the image with cache headers; bogus key → 404.
- [ ] An ad whose image download failed still shows via the raw Meta URL (fallback intact).

---

# Discoveries

(Executors: note unrelated bugs here instead of fixing them.)

- `lib/storage.js` exports `getPreviousWeekSummary` — appears unused by `server.js`; T4 may remove it after confirming no callers.
