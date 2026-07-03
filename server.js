require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const cookieSession = require('cookie-session');

const { parseBuffer, parseCSVText } = require('./lib/parser');
const { generateBrief } = require('./lib/brief');
const { parseContextFile } = require('./lib/context-parser');
const { getWeekKey, saveWeek, loadWeek, listWeeks, getRecentHistory, saveComments, deleteWeek, saveContextDoc, loadContextDocs, deleteContextDoc, saveMetaCredentials, loadMetaCredentials, deleteMetaCredentials, saveSopSettings, loadSopSettings, saveClient, listClients, findClientByToken, findClient, deleteClient, saveThumb, loadThumb } = require('./lib/storage');
const { normalizeSettings, buildSopReadout } = require('./lib/sop');

const app = express();
app.set('trust proxy', 1);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Hand-rolled rate limiting: Map<ip, timestamps[]>, pruned on each hit.
const rateLimitMaps = { comment: new Map(), reaction: new Map() };
function rateLimit(map, ip, max, windowMs) {
  const now = Date.now();
  const hits = (map.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  map.set(ip, hits);
  return hits.length <= max;
}

function getClient(req) {
  const c = (req.body?.client || req.query?.client || '');
  return c.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}
function clientKey(client, baseKey) {
  return client ? `${client}__${baseKey}` : baseKey;
}

// Merge freshly parsed ads into the previously stored ads for a week.
// mode 'replace' discards all previous ads; default 'merge' updates matching
// adNames in place (keeping the old imageUrl if the new row has none),
// keeps unmatched old rows, and appends genuinely new names.
function mergeAds(prevAds, newAds, mode) {
  if (mode === 'replace') {
    return { ads: newAds, added: newAds.length, updated: 0 };
  }
  const prevByName = new Map(prevAds.map(a => [a.adName, a]));
  let updated = 0;
  const seen = new Set();
  const ads = prevAds.map(old => {
    const fresh = prevByName.has(old.adName) ? newAds.find(a => a.adName === old.adName) : null;
    if (fresh && !seen.has(old.adName)) {
      seen.add(old.adName);
      updated++;
      return { ...fresh, imageUrl: fresh.imageUrl ?? old.imageUrl };
    }
    return old;
  });
  const added = newAds.filter(a => !prevByName.has(a.adName));
  return { ads: [...ads, ...added], added: added.length, updated };
}

// Derives a stable, URL-safe key for a persisted thumbnail from the client slug
// and the ad's Meta ad ID (preferred) or its normalized name (fallback).
function thumbKey(client, ad) {
  const normalized = String(ad.adName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${client || 'default'}__${ad.adId || normalized}`;
}

// Downloads external creative images and persists them in the `thumbs` collection so
// they survive Meta's expiring signed CDN URLs. Mutates ad.imageUrl to `/thumb/<key>`
// on success; leaves the raw URL untouched on any failure (fetch error, timeout,
// non-image content-type, or > 500KB). Runs sequentially in batches of 5.
async function cacheThumbnails(client, ads) {
  const targets = ads.filter(ad => /^https?:\/\//i.test(ad.imageUrl || ''));
  for (let i = 0; i < targets.length; i += 5) {
    const batch = targets.slice(i, i + 5);
    for (const ad of batch) {
      try {
        const resp = await fetch(ad.imageUrl, { timeout: 15000 });
        if (!resp.ok) continue;
        const contentType = resp.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) continue;
        const buf = await resp.buffer();
        if (buf.length > 500 * 1024) continue;
        const key = thumbKey(client, ad);
        await saveThumb(key, contentType, buf.toString('base64'));
        ad.imageUrl = '/thumb/' + key;
      } catch {
        // leave ad.imageUrl as the raw URL — fallback per spec
      }
    }
  }
}

const META_API_VERSION = 'v19.0';
const META_DATE_PRESETS = new Set(['last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month', 'maximum']);

// Creative sub-fields requested on ad fetches. thumbnail_width/height lift Meta's
// default 64px thumbnail_url to a usable size; effective_object_story_id lets us
// resolve images for boosted page posts whose creative carries no inline media.
const META_CREATIVE_FIELDS = 'creative.thumbnail_width(512).thumbnail_height(512)'
  + '{image_url,thumbnail_url,object_story_spec,asset_feed_spec,effective_object_story_id}';

// Boosted page posts ("Post: ...") reference an existing post via effective_object_story_id
// and often return no inline image fields at all. Fetch each referenced post's full_picture
// as a fallback. Best-effort: failures return an empty map and never break the import.
async function fetchStoryPostImages(metaAds, token) {
  const images = {};
  const storyIds = [...new Set(
    metaAds
      .filter(ad => !pickCreativeImage(ad.creative) && ad.creative?.effective_object_story_id)
      .map(ad => ad.creative.effective_object_story_id)
  )];
  for (let i = 0; i < storyIds.length; i += 8) {
    const batch = storyIds.slice(i, i + 8);
    const settled = await Promise.allSettled(batch.map(async storyId => {
      const resp = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(storyId)}?fields=full_picture`,
        { timeout: 15000, headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await resp.json();
      if (data?.full_picture) return { storyId, url: data.full_picture };
      return null;
    }));
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) images[result.value.storyId] = result.value.url;
    }
  }
  return images;
}

function storyImageFor(metaAd, storyImages) {
  const storyId = metaAd?.creative?.effective_object_story_id;
  return storyId ? storyImages[storyId] || null : null;
}

async function getMetaAuth(req) {
  const stored = await loadMetaCredentials(getClient(req));
  const token = (stored?.token && stored.token !== '') ? stored.token : (req.body.token || process.env.META_ACCESS_TOKEN);
  const accountId = (stored?.accountId && stored.accountId !== '') ? stored.accountId : (req.body.accountId || process.env.META_ACCOUNT_ID);
  if (!token) {
    const err = new Error('No access token saved. Enter your Meta access token and save it first.');
    err.status = 400;
    throw err;
  }
  if (!accountId) {
    const err = new Error('No ad account ID saved. Enter your account ID and save it first.');
    err.status = 400;
    throw err;
  }
  return {
    token,
    actId: accountId.startsWith('act_') ? accountId : `act_${accountId}`,
  };
}

async function fetchMetaPages(startUrl, token) {
  const rows = [];
  let url = startUrl;
  let pages = 0;
  while (url && pages < 25) {
    const resp = await fetch(url, { timeout: 30000, headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json();
    if (data.error) {
      const err = new Error(data.error.message || 'Meta API error');
      err.meta = data.error;
      throw err;
    }
    if (Array.isArray(data.data)) rows.push(...data.data);
    pages++;
    let next = data.paging?.next || null;
    if (next) {
      const nextUrl = new URL(next);
      nextUrl.searchParams.delete('access_token');
      next = nextUrl.toString();
    }
    url = next;
  }
  return rows;
}

function metaNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function firstActionValue(rows, preferredTypes) {
  if (!Array.isArray(rows)) return { value: null, type: null };
  for (const type of preferredTypes) {
    const found = rows.find(r => r.action_type === type);
    const value = metaNumber(found?.value);
    if (value != null) return { value, type };
  }
  const fallback = rows.find(r => metaNumber(r.value) != null);
  return fallback ? { value: metaNumber(fallback.value), type: fallback.action_type || null } : { value: null, type: null };
}

function firstRoasValue(...groups) {
  for (const group of groups) {
    const picked = firstActionValue(group, ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase']);
    if (picked.value != null) return picked.value;
  }
  return null;
}

function hasMetaMetrics(ad) {
  return ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm', 'reach', 'frequency', 'results', 'roas']
    .some(key => ad[key] != null);
}

async function fetchPerAdInsights(metaAds, datePreset, token) {
  const rows = [];
  for (let i = 0; i < metaAds.length; i += 8) {
    const batch = metaAds.slice(i, i + 8);
    const settled = await Promise.allSettled(batch.map(async metaAd => {
      const url = `https://graph.facebook.com/${META_API_VERSION}/${metaAd.id}/insights`
        + '?fields=spend,impressions,reach,frequency,clicks,ctr,cpc,cpm,actions,purchase_roas,website_purchase_roas,date_start,date_stop'
        + `&date_preset=${encodeURIComponent(datePreset)}`;
      const insightRows = await fetchMetaPages(url, token);
      return insightRows.map(row => ({ ...row, ad_id: metaAd.id, ad_name: pickAdDisplayName(metaAd.name, metaAd) }));
    }));
    for (const result of settled) {
      if (result.status === 'fulfilled') rows.push(...result.value);
    }
  }
  return rows;
}

function pickCreativeImage(creative) {
  if (!creative) return null;
  const candidates = [
    ['image_url', creative.image_url],
    ['link_picture', creative.object_story_spec?.link_data?.picture],
    ['photo_url', creative.object_story_spec?.photo_data?.url],
    ['video_image_url', creative.object_story_spec?.video_data?.image_url],
    ...(creative.asset_feed_spec?.images || []).map(image => ['asset_image_url', image.url]),
    ['thumbnail_url', creative.thumbnail_url],
  ].filter(([, url]) => Boolean(url));
  if (!candidates.length) return null;
  return { url: candidates[0][1], source: candidates[0][0] };
}

function compactCreativeText(value) {
  if (!value) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > 90 ? text.slice(0, 87).trim() + '...' : text;
}

function isGenericMetaAdName(name) {
  const normalized = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return normalized === 'ad'
    || normalized === 'ongoing local business promotion ad'
    || normalized === 'ongoing local business promotion'
    || normalized === 'local business promotion ad'
    || normalized === 'local business promotion';
}

function pickCreativeText(creative) {
  if (!creative) return null;
  const story = creative.object_story_spec || {};
  const asset = creative.asset_feed_spec || {};
  const candidates = [
    story.link_data?.message,
    story.link_data?.name,
    story.link_data?.description,
    story.photo_data?.caption,
    story.video_data?.message,
    story.video_data?.title,
    story.template_data?.message,
    story.template_data?.name,
    ...(asset.bodies || []).map(body => body.text),
    ...(asset.titles || []).map(title => title.text),
    ...(asset.descriptions || []).map(description => description.text),
  ];
  for (const candidate of candidates) {
    const text = compactCreativeText(candidate);
    if (text) return text;
  }
  return null;
}

function pickAdDisplayName(rowName, metaAd) {
  const fallbackName = rowName || metaAd?.name || metaAd?.id || '';
  const creativeText = pickCreativeText(metaAd?.creative);
  if (creativeText && isGenericMetaAdName(fallbackName)) return `Post: "${creativeText}"`;
  return fallbackName;
}

app.use(express.json());
app.use(cookieSession({
  name: 'adbrief_sess',
  keys: [process.env.SESSION_SECRET || 'dev-secret'],
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
}));

// ── AUTH ──────────────────────────────────────────────────────────────────────
// Single shared password gates every internal page/route. Client-facing token
// URLs (and the endpoints they need) stay public. If APP_PASSWORD isn't set,
// auth is disabled entirely so local dev without env vars still works.
const AUTH_ENABLED = !!process.env.APP_PASSWORD;
if (!AUTH_ENABLED) {
  console.warn('AdBrief: APP_PASSWORD is not set — internal pages are NOT password protected.');
}

function isPublicPath(req) {
  if (req.path === '/login') return true;
  if (req.path === '/style.css') return true;
  if (/^\/view\/[^/]+$/.test(req.path)) return true;
  if (/^\/api\/view\/[^/]+$/.test(req.path)) return true;
  if (/^\/thumb\/[^/]+$/.test(req.path)) return true;
  if (req.method === 'POST' && (req.path === '/comment' || req.path === '/reaction')) return true;
  return false;
}

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ ok: true });
  const { password } = req.body || {};
  if (password && password === process.env.APP_PASSWORD) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password.' });
});

app.use((req, res, next) => {
  if (!AUTH_ENABLED) return next();
  if (isPublicPath(req)) return next();
  if (req.session?.authed) return next();

  if (req.method === 'GET' && req.accepts('html')) {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  res.status(401).json({ error: 'Not logged in' });
});

// Home page — serve client dashboard when no ?client= param
app.get('/', (req, res, next) => {
  if (!req.query.client) return res.sendFile(path.join(__dirname, 'public', 'home.html'));
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Upload a CSV or Excel file
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const parsed = parseBuffer(req.file.buffer, req.file.mimetype);
    const ads = parsed.ads ?? parsed; // backwards compat if shape changes
    if (!ads.length) return res.status(400).json({ error: 'No ad rows found. Check that your export has the correct columns.' });

    const weekKey = clientKey(getClient(req), getWeekKey());
    const existing = await loadWeek(weekKey) || {};
    const prev = existing.ads || [];
    const mode = req.body.mode === 'replace' ? 'replace' : 'merge';
    const { ads: merged, added, updated } = mergeAds(prev, ads, mode);
    existing.ads = merged;
    existing.uploadedAt = new Date().toISOString();
    await saveWeek(weekKey, existing);

    res.json({ ok: true, weekKey, added, updated, total: merged.length, columns: parsed.columns || null });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Load from a Google Sheets published CSV URL
app.post('/sheets', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL provided' });

    const response = await fetch(url);
    if (!response.ok) return res.status(400).json({ error: 'Could not fetch that URL. Make sure the sheet is published.' });

    const text = await response.text();
    const parsed = parseCSVText(text);
    const ads = parsed.ads ?? parsed;
    if (!ads.length) return res.status(400).json({ error: 'No ad rows found in the sheet. Check column names.' });

    const weekKey = clientKey(getClient(req), getWeekKey());
    const existing = await loadWeek(weekKey) || {};
    const prev = existing.ads || [];
    const mode = req.body.mode === 'replace' ? 'replace' : 'merge';
    const { ads: merged, added, updated } = mergeAds(prev, ads, mode);
    existing.ads = merged;
    existing.uploadedAt = new Date().toISOString();
    await saveWeek(weekKey, existing);

    res.json({ ok: true, weekKey, added, updated, total: merged.length, columns: parsed.columns || null });
  } catch (err) {
    console.error('Sheets error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Clear all uploaded ads for the current week
app.delete('/week/current/ads', async (req, res) => {
  try {
    const weekKey = clientKey(getClient(req), getWeekKey());
    const week = await loadWeek(weekKey);
    if (week) { week.ads = []; week.brief = null; await saveWeek(weekKey, week); }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Generate a brief from the current week's data
app.post('/generate-brief', async (req, res) => {
  try {
    const client = getClient(req);
    let weekKey = clientKey(client, getWeekKey());
    if (req.body.weekKey) {
      const requested = String(req.body.weekKey);
      const valid = client ? requested.startsWith(`${client}__`) : !requested.includes('__');
      if (!valid) return res.status(400).json({ error: 'weekKey does not belong to this client.' });
      weekKey = requested;
    }
    const week = await loadWeek(weekKey);
    if (!week || !week.ads || !week.ads.length) {
      return res.status(400).json({ error: 'No data for this week. Upload a file or load from Sheets first.' });
    }

    const historySummary = await getRecentHistory(weekKey, 4);
    const contextDocs = await loadContextDocs(getClient(req));
    const CONTEXT_DOC_CAP = 4000;
    const CONTEXT_BLOCK_CAP = 12000;
    const truncate = (text, cap) => text.length > cap ? text.slice(0, cap) + '\n[truncated]' : text;
    let contextText = contextDocs.length
      ? contextDocs.map(d => `--- ${d.name} ---\n${truncate(d.text, CONTEXT_DOC_CAP)}`).join('\n\n')
      : null;
    if (contextText) contextText = truncate(contextText, CONTEXT_BLOCK_CAP);
    const result = await generateBrief(week.ads, historySummary, contextText);

    if (!result.ok) {
      return res.status(500).json({ error: 'AI response could not be parsed.', raw: result.raw });
    }

    week.brief = result.brief;
    week.briefStatus = 'draft';
    week.generatedAt = new Date().toISOString();
    await saveWeek(weekKey, week);

    res.json({ ok: true, weekKey, brief: result.brief });
  } catch (err) {
    console.error('Brief error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Validates that a weekKey belongs to the requesting client (same rule as /generate-brief).
function weekKeyBelongsToClient(client, weekKey) {
  return client ? weekKey.startsWith(`${client}__`) : !weekKey.includes('__');
}

// Publish a draft brief so it appears on the client-facing link
app.post('/brief/publish', async (req, res) => {
  try {
    const client = getClient(req);
    const weekKey = String(req.body.weekKey || '');
    if (!weekKey || !weekKeyBelongsToClient(client, weekKey)) {
      return res.status(400).json({ error: 'weekKey does not belong to this client.' });
    }
    const week = await loadWeek(weekKey);
    if (!week || !week.brief) return res.status(404).json({ error: 'Week not found or has no brief.' });
    week.briefStatus = 'published';
    await saveWeek(weekKey, week);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit a brief's content (does not change its draft/published status)
app.post('/brief/update', async (req, res) => {
  try {
    const client = getClient(req);
    const weekKey = String(req.body.weekKey || '');
    if (!weekKey || !weekKeyBelongsToClient(client, weekKey)) {
      return res.status(400).json({ error: 'weekKey does not belong to this client.' });
    }
    const week = await loadWeek(weekKey);
    if (!week || !week.brief) return res.status(404).json({ error: 'Week not found or has no brief.' });

    const input = req.body.brief;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return res.status(400).json({ error: 'brief must be an object.' });
    }
    const listKeys = ['topPerformers', 'underperformers', 'fatigueAlerts', 'makeNext', 'retireNow'];
    for (const key of listKeys) {
      if (input[key] !== undefined && !Array.isArray(input[key])) {
        return res.status(400).json({ error: `${key} must be an array.` });
      }
    }
    if (input.summary !== undefined && !Array.isArray(input.summary) && typeof input.summary !== 'string') {
      return res.status(400).json({ error: 'summary must be an array or string.' });
    }
    const brief = {};
    for (const key of [...listKeys, 'summary']) {
      if (input[key] !== undefined) brief[key] = input[key];
    }

    week.brief = brief;
    await saveWeek(weekKey, week);
    res.json({ ok: true, brief });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get current week's data and brief
app.get('/week/current', async (req, res) => {
  try {
    const client = getClient(req);
    const viewToken = client ? (await findClient(client))?.token || null : null;
    const currentWeekKey = clientKey(client, getWeekKey());
    const week = await loadWeek(currentWeekKey);
    if (week?.ads?.length) {
      return res.json({ weekKey: currentWeekKey, week, isCurrentWeek: true, viewToken });
    }

    // Current week has no ads — fall back to the most recent week that has data
    const keys = await listWeeks(client);
    for (const key of keys.slice(0, 8)) {
      if (key === currentWeekKey) continue;
      const candidate = await loadWeek(key);
      if (candidate?.ads?.length) {
        return res.json({ weekKey: key, week: candidate, isCurrentWeek: false, currentWeekKey, viewToken });
      }
    }

    res.json({ weekKey: currentWeekKey, week: week || null, isCurrentWeek: true, viewToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a specific week's data
app.get('/week/:key', async (req, res) => {
  try {
    const week = await loadWeek(req.params.key);
    if (!week) return res.status(404).json({ error: 'Week not found' });
    res.json({ weekKey: req.params.key, week });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a week's data
app.delete('/week/:key', async (req, res) => {
  try {
    await deleteWeek(req.params.key);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Aggregated weekly metrics for trend charts
app.get('/trends', async (req, res) => {
  try {
    const client = getClient(req);
    const weeks = (await listWeeks(client)).sort();
    const result = [];
    for (const wk of weeks) {
      const week = await loadWeek(wk);
      if (!week?.ads?.length) continue;
      const ads = week.ads;
      const spend = ads.reduce((s, a) => s + (parseFloat(a.spend) || 0), 0);

      // Weighted CTR: Sigma clicks / Sigma impressions, fallback to unweighted mean of ctr.
      const ctrWeightedAds = ads.filter(a => a.clicks != null && a.impressions != null);
      const ctrImpressionsSum = ctrWeightedAds.reduce((s, a) => s + a.impressions, 0);
      let ctr = null;
      if (ctrWeightedAds.length && ctrImpressionsSum > 0) {
        ctr = (ctrWeightedAds.reduce((s, a) => s + a.clicks, 0) / ctrImpressionsSum) * 100;
      } else {
        const ctrAds = ads.filter(a => a.ctr != null);
        ctr = ctrAds.length ? ctrAds.reduce((s, a) => s + a.ctr, 0) / ctrAds.length : null;
      }

      // Spend-weighted ROAS: Sigma(roas*spend) / Sigma(spend), fallback to unweighted mean.
      const roasWeightedAds = ads.filter(a => a.roas != null && a.spend != null);
      const roasSpendSum = roasWeightedAds.reduce((s, a) => s + a.spend, 0);
      let roas = null;
      if (roasWeightedAds.length && roasSpendSum > 0) {
        roas = roasWeightedAds.reduce((s, a) => s + a.roas * a.spend, 0) / roasSpendSum;
      } else {
        const roasAds = ads.filter(a => a.roas != null);
        roas = roasAds.length ? roasAds.reduce((s, a) => s + a.roas, 0) / roasAds.length : null;
      }

      result.push({
        week: wk,
        spend:    Math.round(spend),
        roas:     roas != null ? Math.round(roas * 100) / 100 : null,
        ctr:      ctr  != null ? Math.round(ctr  * 100) / 100 : null,
        adCount:  ads.length,
      });
    }
    res.json({ ok: true, weeks: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Client-level SOP settings used for weekly creative readouts
app.get('/sop/settings', async (req, res) => {
  try {
    const settings = normalizeSettings(await loadSopSettings(getClient(req)) || {});
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/sop/settings', async (req, res) => {
  try {
    const settings = normalizeSettings(req.body || {});
    await saveSopSettings(getClient(req), settings);
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/sop/readout', async (req, res) => {
  try {
    const client = getClient(req);
    const weekKey = req.query.weekKey ? String(req.query.weekKey) : clientKey(client, getWeekKey());
    const week = await loadWeek(weekKey);
    const settings = normalizeSettings(await loadSopSettings(client) || {});
    const readout = buildSopReadout(week?.ads || [], settings);
    res.json({ ok: true, weekKey, readout });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all saved weeks
app.get('/history', async (req, res) => {
  try {
    res.json({ weeks: await listWeeks(getClient(req)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a comment
app.post('/comment', async (req, res) => {
  try {
    if (!rateLimit(rateLimitMaps.comment, req.ip, 10, 60000)) {
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }
    let { weekKey, author, text } = req.body;
    if (!weekKey || !author || !text) return res.status(400).json({ error: 'weekKey, author, and text are required' });
    author = String(author).trim();
    text = String(text).trim();
    if (!author || !text) return res.status(400).json({ error: 'weekKey, author, and text are required' });
    if (author.length > 40) return res.status(400).json({ error: 'Name is too long (max 40 characters).' });
    if (text.length > 2000) return res.status(400).json({ error: 'Comment is too long (max 2000 characters).' });

    const week = await loadWeek(weekKey);
    if (!week) return res.status(404).json({ error: 'Week not found' });

    const comments = week.comments || [];
    if (comments.length >= 200) return res.status(400).json({ error: 'Comment limit reached for this week.' });
    comments.push({ id: crypto.randomBytes(6).toString('hex'), author, text, createdAt: new Date().toISOString(), reactions: {} });
    await saveComments(weekKey, comments);

    res.json({ ok: true, comments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Find a comment by id (preferred) or index (legacy fallback). Returns -1 if not found.
function findCommentIndex(comments, id, index) {
  if (id != null) return comments.findIndex((c) => c.id === id);
  if (index != null && index >= 0 && index < comments.length) return index;
  return -1;
}

// Edit a comment
app.put('/comment', async (req, res) => {
  try {
    const { weekKey, id, index, text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Text is required' });
    const week = await loadWeek(weekKey);
    if (!week) return res.status(404).json({ error: 'Week not found' });
    const comments = week.comments || [];
    const i = findCommentIndex(comments, id, index);
    if (i < 0) return res.status(400).json({ error: 'Invalid index' });
    comments[i].text = text.trim();
    comments[i].editedAt = new Date().toISOString();
    await saveComments(weekKey, comments);
    res.json({ ok: true, comments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a comment
app.delete('/comment', async (req, res) => {
  try {
    const { weekKey, id, index } = req.body;
    const week = await loadWeek(weekKey);
    if (!week) return res.status(404).json({ error: 'Week not found' });
    const comments = week.comments || [];
    const i = findCommentIndex(comments, id, index);
    if (i < 0) return res.status(400).json({ error: 'Invalid index' });
    comments.splice(i, 1);
    await saveComments(weekKey, comments);
    res.json({ ok: true, comments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const VALID_REACTIONS = ['👍', '❤️', '🔥'];

// React to a comment
app.post('/reaction', async (req, res) => {
  try {
    if (!rateLimit(rateLimitMaps.reaction, req.ip, 30, 60000)) {
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }
    const { weekKey, index, emoji, delta } = req.body;
    if (!VALID_REACTIONS.includes(emoji) || (delta !== 1 && delta !== -1)) {
      return res.status(400).json({ error: 'Invalid reaction' });
    }
    const week = await loadWeek(weekKey);
    if (!week) return res.status(404).json({ error: 'Week not found' });
    const comments = week.comments || [];
    if (index < 0 || index >= comments.length) return res.status(400).json({ error: 'Invalid index' });
    if (!comments[index].reactions) comments[index].reactions = {};
    comments[index].reactions[emoji] = Math.max(0, (comments[index].reactions[emoji] || 0) + delta);
    await saveComments(weekKey, comments);
    res.json({ ok: true, comments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CONTEXT DOCS ──────────────────────────────────────────────────────────────

// Upload a context file (ICP, brand brief, company info, etc.)
app.post('/context', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const client = getClient(req);
    const filename = req.file.originalname || 'context';
    let text;
    try {
      text = await parseContextFile(req.file.buffer, filename, req.file.mimetype);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (!text) return res.status(400).json({ error: 'File appears to be empty.' });
    // Use filename (without extension) as the doc name
    const name = filename.replace(/\.[^.]+$/, '');
    await saveContextDoc(client, name, text);
    res.json({ ok: true, name, chars: text.length });
  } catch (err) {
    console.error('Context upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// List context docs for this client
app.get('/context', async (req, res) => {
  try {
    const docs = await loadContextDocs(getClient(req));
    // Return name, char count, date — not full text (can be large)
    res.json({ ok: true, docs: docs.map(d => ({ name: d.name, chars: d.text.length, updatedAt: d.updatedAt })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a context doc
app.delete('/context/:name', async (req, res) => {
  try {
    await deleteContextDoc(getClient(req), decodeURIComponent(req.params.name));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CLIENT REGISTRY ───────────────────────────────────────────────────────────

// List all clients with their latest week stats + ensure every client has a token
app.get('/clients', async (req, res) => {
  try {
    const clients = await listClients();

    // Backfill tokens for any clients created before this feature
    for (const c of clients) {
      if (!c.token) {
        c.token = crypto.randomBytes(10).toString('hex');
        await saveClient(c.slug, c.name, c.token);
      }
    }

    const enriched = await Promise.all(clients.map(async (c) => {
      try {
        const weeks    = await listWeeks(c.slug);
        const latest   = weeks[0];
        const weekData = latest ? await loadWeek(latest) : null;
        const creds    = await loadMetaCredentials(c.slug);
        const weekKey  = latest ? (latest.includes('__') ? latest.split('__').slice(1).join('__') : latest) : null;
        return {
          ...c,
          latestWeek: weekKey,
          adCount:    weekData?.ads?.length || 0,
          hasBrief:   !!weekData?.brief,
          metaLinked: !!creds,
        };
      } catch {
        return { ...c, latestWeek: null, adCount: 0, hasBrief: false, metaLinked: false };
      }
    }));
    res.json({ clients: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new client — generates a unique share token
app.post('/clients', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Client name is required.' });
    const slug  = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    if (!slug) return res.status(400).json({ error: 'Invalid client name — use letters and numbers.' });
    const token = crypto.randomBytes(10).toString('hex');
    await saveClient(slug, name.trim(), token);
    res.json({ ok: true, slug, name: name.trim(), token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a client (removes from registry only — week data stays intact)
app.delete('/clients/:slug', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    await deleteClient(slug);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CLIENT-FACING VIEW ────────────────────────────────────────────────────────

// Serve the client view page
app.get('/view/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'view.html'));
});

// API: return brief + comments for a token (never exposes the internal slug)
app.get('/api/view/:token', async (req, res) => {
  try {
    const client = await findClientByToken(req.params.token);
    if (!client) return res.status(404).json({ error: 'Link not found or expired.' });

    const weeks = await listWeeks(client.slug);
    let latest = null, weekData = null;
    for (const key of weeks.slice(0, 12)) {
      const candidate = await loadWeek(key);
      if (!candidate?.brief) continue;
      // Legacy weeks (brief present, no briefStatus) count as published.
      if (candidate.briefStatus === 'published' || candidate.briefStatus === undefined) {
        latest = key;
        weekData = candidate;
        break;
      }
    }
    if (!latest) return res.json({ clientName: client.name, week: null });

    const weekKey = latest.includes('__') ? latest.split('__').slice(1).join('__') : latest;

    const adImages = (weekData?.ads || [])
      .filter(a => a.imageUrl != null)
      .map(a => ({ adName: a.adName, imageUrl: a.imageUrl }));

    res.json({
      clientName: client.name,
      weekKey:    latest,   // full key needed for comment endpoints
      weekLabel:  weekKey,  // display key (no slug prefix)
      brief:      weekData?.brief   || null,
      comments:   weekData?.comments || [],
      adCount:    weekData?.ads?.length || 0,
      adImages,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve a persisted thumbnail (public — embedded on the client view page too)
app.get('/thumb/:key', async (req, res) => {
  try {
    if (!/^[a-z0-9_-]+$/i.test(req.params.key)) return res.status(400).json({ error: 'Invalid key.' });
    const doc = await loadThumb(req.params.key);
    if (!doc) return res.status(404).json({ error: 'Not found.' });
    res.set('Content-Type', doc.contentType);
    res.set('Cache-Control', 'public, max-age=604800');
    res.send(Buffer.from(doc.data, 'base64'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SETUP PAGE ────────────────────────────────────────────────────────────────
app.get('/setup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

// ── META API ENRICHMENT ───────────────────────────────────────────────────────

// Validate credentials without saving — used by the setup page "Test connection" button
app.post('/meta/test', async (req, res) => {
  try {
    const { accountId, token } = req.body || {};
    if (!accountId || !token) return res.status(400).json({ error: 'accountId and token are required.' });
    const actId = accountId.startsWith('act_') ? accountId : `act_${accountId}`;
    const url = `https://graph.facebook.com/v19.0/${actId}?fields=name,account_status`;
    const r = await fetch(url, { timeout: 30000, headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    if (data.error) {
      const msg = data.error.message || 'Meta API error.';
      return res.status(400).json({ error: msg });
    }
    res.json({ ok: true, name: data.name || actId, accountId: actId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save Meta credentials server-side — token never returned to client after this
app.post('/meta/credentials', async (req, res) => {
  try {
    const { accountId, token } = req.body;
    if (!accountId || !token) return res.status(400).json({ error: 'accountId and token are required' });
    await saveMetaCredentials(getClient(req), accountId.trim(), token.trim());
    // Return a hint only — last 4 chars of account ID so user can confirm it's right
    const hint = accountId.trim().slice(-4);
    res.json({ ok: true, hint });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Return whether credentials are saved — never expose the token itself
app.get('/meta/config', async (req, res) => {
  try {
    const creds = await loadMetaCredentials(getClient(req));
    if (!creds) return res.json({ configured: false });
    // Return a masked hint so the UI can show which account is connected
    const id = creds.accountId || '';
    const hint = id.length > 6 ? '••••' + id.slice(-4) : id;
    res.json({ configured: true, hint });
  } catch {
    res.json({ configured: false });
  }
});

// Clear saved credentials
app.delete('/meta/credentials', async (req, res) => {
  try {
    await deleteMetaCredentials(getClient(req));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import Meta ad-level insights and creative thumbnails into the current AdBrief week.
app.post('/meta/import', async (req, res) => {
  try {
    const { token, actId } = await getMetaAuth(req);

    const weekKey = clientKey(getClient(req), getWeekKey());
    if (req.body?.force !== true) {
      const existingWeek = await loadWeek(weekKey);
      if (existingWeek?.brief) {
        return res.status(409).json({
          needsConfirm: true,
          message: 'This week already has a generated brief. Importing will replace the data and delete the brief.',
        });
      }
    }

    const datePreset = META_DATE_PRESETS.has(req.body?.datePreset) ? req.body.datePreset : 'last_30d';

    const adsUrl = `https://graph.facebook.com/${META_API_VERSION}/${actId}/ads`
      + `?fields=id,name,effective_status,configured_status,${META_CREATIVE_FIELDS}`
      + '&limit=500';
    const insightsUrl = `https://graph.facebook.com/${META_API_VERSION}/${actId}/insights`
      + '?level=ad'
      + '&fields=ad_id,ad_name,spend,impressions,reach,frequency,clicks,ctr,cpc,cpm,actions,purchase_roas,website_purchase_roas,date_start,date_stop'
      + `&date_preset=${encodeURIComponent(datePreset)}`
      + '&limit=500';

    const [metaAds, accountInsights] = await Promise.all([
      fetchMetaPages(adsUrl, token),
      fetchMetaPages(insightsUrl, token),
    ]);

    const perAdInsights = accountInsights.length
      ? []
      : await fetchPerAdInsights(metaAds, datePreset, token);
    const insights = accountInsights.length ? accountInsights : perAdInsights;

    const storyImages = await fetchStoryPostImages(metaAds, token);

    const adLookup = {};
    for (const metaAd of metaAds) {
      adLookup[String(metaAd.id)] = metaAd;
    }

    const rows = insights.length
      ? insights
      : metaAds.map(ad => ({ ad_id: ad.id, ad_name: pickAdDisplayName(ad.name, ad) }));

    const ads = rows.map(row => {
      const adId = String(row.ad_id || row.id || '');
      const metaAd = adLookup[adId] || {};
      const creativeImage = pickCreativeImage(metaAd.creative);
      const storyImage = creativeImage ? null : storyImageFor(metaAd, storyImages);
      const result = firstActionValue(row.actions, [
        'purchase',
        'omni_purchase',
        'offsite_conversion.fb_pixel_purchase',
        'lead',
        'onsite_conversion.lead_grouped',
        'complete_registration',
        'link_click',
      ]);

      return {
        adId,
        adName: pickAdDisplayName(row.ad_name, metaAd) || adId,
        spend: metaNumber(row.spend),
        impressions: metaNumber(row.impressions),
        clicks: metaNumber(row.clicks),
        ctr: metaNumber(row.ctr),
        cpc: metaNumber(row.cpc),
        cpm: metaNumber(row.cpm),
        reach: metaNumber(row.reach),
        frequency: metaNumber(row.frequency),
        results: result.value,
        resultType: result.type,
        roas: firstRoasValue(row.purchase_roas, row.website_purchase_roas),
        dateStart: row.date_start || null,
        dateEnd: row.date_stop || null,
        adStatus: metaAd.effective_status || metaAd.configured_status || null,
        imageUrl: creativeImage?.url || storyImage || null,
        imageSource: creativeImage?.source || (storyImage ? 'story_full_picture' : null),
        source: 'meta_api',
      };
    }).filter(ad => ad.adName);
    const metricRows = ads.filter(hasMetaMetrics).length;

    if (!ads.length) {
      return res.json({ ok: true, imported: 0, weekKey, message: 'No Meta ads found for that date range.' });
    }

    await cacheThumbnails(getClient(req), ads);

    const existing = await loadWeek(weekKey) || {};
    existing.ads = ads;
    existing.brief = null;
    existing.importedAt = new Date().toISOString();
    existing.importSource = 'meta_api';
    existing.metaDatePreset = datePreset;
    existing.metaMetricRows = metricRows;
    await saveWeek(weekKey, existing);

    res.json({
      ok: true,
      weekKey,
      imported: ads.length,
      insightRows: insights.length,
      accountInsightRows: accountInsights.length,
      perAdInsightRows: perAdInsights.length,
      metricRows,
      hasMetrics: metricRows > 0,
      datePreset,
      message: metricRows > 0
        ? null
        : 'Meta returned ad names, but no performance stats for that range.',
    });
  } catch (err) {
    console.error('Meta import error:', err);
    const status = err.status || (err.meta ? 400 : 500);
    res.status(status).json({ error: err.message, meta: err.meta || null });
  }
});

// Fetch all ads from a Meta Ads account and enrich stored ad records with thumbnail URLs.
// Token and accountId can come from the request body (manual entry) or env vars (pre-configured).
// Matching: adId first (if the CSV export included an "Ad ID" column), then ad name.
app.post('/meta/enrich', async (req, res) => {
  try {
    // Load from DB first, fall back to request body, then env vars
    const stored    = await loadMetaCredentials(getClient(req));
    const token     = (stored?.token     && stored.token     !== '') ? stored.token     : (req.body.token     || process.env.META_ACCESS_TOKEN);
    const accountId = (stored?.accountId && stored.accountId !== '') ? stored.accountId : (req.body.accountId || process.env.META_ACCOUNT_ID);
    if (!token)     return res.status(400).json({ error: 'No access token saved. Enter your Meta access token and save it first.' });
    if (!accountId) return res.status(400).json({ error: 'No ad account ID saved. Enter your account ID and save it first.' });

    // Normalise account ID — accept with or without "act_" prefix
    const actId = accountId.startsWith('act_') ? accountId : `act_${accountId}`;

    // Pull all ads with creative thumbnail/image URLs, handling pagination
    const metaAds = [];
    let url = `https://graph.facebook.com/v19.0/${actId}/ads`
            + `?fields=id,name,${META_CREATIVE_FIELDS}`
            + `&limit=200`;
    let pages = 0;

    while (url && pages < 25) {
      const resp = await fetch(url, { timeout: 30000, headers: { Authorization: `Bearer ${token}` } });
      const data = await resp.json();
      if (data.error) {
        return res.status(400).json({ error: data.error.message || 'Meta API error', meta: data.error });
      }
      if (Array.isArray(data.data)) metaAds.push(...data.data);
      pages++;
      let next = data.paging?.next || null;
      if (next) {
        const nextUrl = new URL(next);
        nextUrl.searchParams.delete('access_token');
        next = nextUrl.toString();
      }
      url = next;
    }

    if (!metaAds.length) {
      return res.json({ ok: true, enriched: 0, total: 0, message: 'No ads found in this account via the Meta API.' });
    }

    // Build lookup maps: by ID and by name (lowercased)
    const storyImages = await fetchStoryPostImages(metaAds, token);
    const byId   = {};
    const byName = {};
    for (const ma of metaAds) {
      const image = pickCreativeImage(ma.creative);
      const url = image?.url || storyImageFor(ma, storyImages);
      if (url) {
        byId[String(ma.id)] = url;
        byName[String(ma.name || '').toLowerCase()] = url;
      }
    }

    // Load stored week, patch imageUrl on each ad
    const weekKey = clientKey(getClient(req), getWeekKey());
    const week    = await loadWeek(weekKey);
    if (!week?.ads?.length) {
      return res.json({ ok: true, enriched: 0, total: 0, message: 'No ads uploaded for this week yet.' });
    }

    let enriched = 0;
    for (const ad of week.ads) {
      const thumb =
        (ad.adId   && byId[String(ad.adId)])   ||
        (ad.adName && byName[ad.adName.toLowerCase()]) ||
        null;
      if (thumb) { ad.imageUrl = thumb; enriched++; }
    }

    await cacheThumbnails(getClient(req), week.ads);

    await saveWeek(weekKey, week);
    res.json({ ok: true, enriched, total: week.ads.length });
  } catch (err) {
    console.error('Meta enrich error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large — export a smaller date range (max 15MB).' });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AdBrief running on http://localhost:${PORT}`));
