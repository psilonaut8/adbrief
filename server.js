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
const { getWeekKey, saveWeek, loadWeek, listWeeks, getRecentHistory, saveComments, deleteWeek, saveContextDoc, loadContextDocs, deleteContextDoc, saveMetaCredentials, loadMetaCredentials, deleteMetaCredentials, saveSopSettings, loadSopSettings, saveClient, listClients, findClientByToken, deleteClient } = require('./lib/storage');
const { normalizeSettings, buildSopReadout } = require('./lib/sop');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

function getClient(req) {
  const c = (req.body?.client || req.query?.client || '');
  return c.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}
function clientKey(client, baseKey) {
  return client ? `${client}__${baseKey}` : baseKey;
}

const META_API_VERSION = 'v19.0';
const META_DATE_PRESETS = new Set(['last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month', 'maximum']);

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

async function fetchMetaPages(startUrl) {
  const rows = [];
  let url = startUrl;
  while (url) {
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.error) {
      const err = new Error(data.error.message || 'Meta API error');
      err.meta = data.error;
      throw err;
    }
    if (Array.isArray(data.data)) rows.push(...data.data);
    url = data.paging?.next || null;
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
  const accessToken = encodeURIComponent(token);
  for (let i = 0; i < metaAds.length; i += 8) {
    const batch = metaAds.slice(i, i + 8);
    const settled = await Promise.allSettled(batch.map(async metaAd => {
      const url = `https://graph.facebook.com/${META_API_VERSION}/${metaAd.id}/insights`
        + '?fields=spend,impressions,reach,frequency,clicks,ctr,cpc,cpm,actions,purchase_roas,website_purchase_roas,date_start,date_stop'
        + `&date_preset=${encodeURIComponent(datePreset)}`
        + `&access_token=${accessToken}`;
      const insightRows = await fetchMetaPages(url);
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
    const prevNames = new Set(prev.map(a => a.adName));
    const merged = [...prev, ...ads.filter(a => !prevNames.has(a.adName))];
    existing.ads = merged;
    existing.uploadedAt = new Date().toISOString();
    await saveWeek(weekKey, existing);

    res.json({ ok: true, weekKey, added: merged.length - prev.length, total: merged.length, columns: parsed.columns || null });
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
    const prevNames = new Set(prev.map(a => a.adName));
    const merged = [...prev, ...ads.filter(a => !prevNames.has(a.adName))];
    existing.ads = merged;
    existing.uploadedAt = new Date().toISOString();
    await saveWeek(weekKey, existing);

    res.json({ ok: true, weekKey, added: merged.length - prev.length, total: merged.length, columns: parsed.columns || null });
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
    week.generatedAt = new Date().toISOString();
    await saveWeek(weekKey, week);

    res.json({ ok: true, weekKey, brief: result.brief });
  } catch (err) {
    console.error('Brief error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get current week's data and brief
app.get('/week/current', async (req, res) => {
  try {
    const client = getClient(req);
    const currentWeekKey = clientKey(client, getWeekKey());
    const week = await loadWeek(currentWeekKey);
    if (week?.ads?.length) {
      return res.json({ weekKey: currentWeekKey, week, isCurrentWeek: true });
    }

    // Current week has no ads — fall back to the most recent week that has data
    const keys = await listWeeks(client);
    for (const key of keys.slice(0, 8)) {
      if (key === currentWeekKey) continue;
      const candidate = await loadWeek(key);
      if (candidate?.ads?.length) {
        return res.json({ weekKey: key, week: candidate, isCurrentWeek: false, currentWeekKey });
      }
    }

    res.json({ weekKey: currentWeekKey, week: week || null, isCurrentWeek: true });
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
      const roasAds = ads.filter(a => a.roas != null);
      const ctrAds  = ads.filter(a => a.ctr  != null);
      result.push({
        week: wk,
        spend:    Math.round(spend),
        roas:     roasAds.length ? Math.round(roasAds.reduce((s, a) => s + a.roas, 0) / roasAds.length * 100) / 100 : null,
        ctr:      ctrAds.length  ? Math.round(ctrAds.reduce((s, a)  => s + a.ctr,  0) / ctrAds.length  * 100) / 100 : null,
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
    const { weekKey, author, text } = req.body;
    if (!weekKey || !author || !text) return res.status(400).json({ error: 'weekKey, author, and text are required' });

    const week = await loadWeek(weekKey);
    if (!week) return res.status(404).json({ error: 'Week not found' });

    const comments = week.comments || [];
    comments.push({ author, text, createdAt: new Date().toISOString(), reactions: {} });
    await saveComments(weekKey, comments);

    res.json({ ok: true, comments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit a comment
app.put('/comment', async (req, res) => {
  try {
    const { weekKey, index, text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Text is required' });
    const week = await loadWeek(weekKey);
    if (!week) return res.status(404).json({ error: 'Week not found' });
    const comments = week.comments || [];
    if (index < 0 || index >= comments.length) return res.status(400).json({ error: 'Invalid index' });
    comments[index].text = text.trim();
    comments[index].editedAt = new Date().toISOString();
    await saveComments(weekKey, comments);
    res.json({ ok: true, comments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a comment
app.delete('/comment', async (req, res) => {
  try {
    const { weekKey, index } = req.body;
    const week = await loadWeek(weekKey);
    if (!week) return res.status(404).json({ error: 'Week not found' });
    const comments = week.comments || [];
    if (index < 0 || index >= comments.length) return res.status(400).json({ error: 'Invalid index' });
    comments.splice(index, 1);
    await saveComments(weekKey, comments);
    res.json({ ok: true, comments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// React to a comment
app.post('/reaction', async (req, res) => {
  try {
    const { weekKey, index, emoji, delta } = req.body;
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
    const latest = weeks[0];
    if (!latest) return res.json({ clientName: client.name, week: null });

    const weekData = await loadWeek(latest);
    const weekKey  = latest.includes('__') ? latest.split('__').slice(1).join('__') : latest;

    res.json({
      clientName: client.name,
      weekKey:    latest,   // full key needed for comment endpoints
      weekLabel:  weekKey,  // display key (no slug prefix)
      brief:      weekData?.brief   || null,
      comments:   weekData?.comments || [],
      adCount:    weekData?.ads?.length || 0,
    });
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
    const url = `https://graph.facebook.com/v19.0/${actId}?fields=name,account_status&access_token=${token}`;
    const r = await fetch(url);
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
    const accessToken = encodeURIComponent(token);

    const adsUrl = `https://graph.facebook.com/${META_API_VERSION}/${actId}/ads`
      + '?fields=id,name,effective_status,configured_status,creative{image_url,thumbnail_url,object_story_spec,asset_feed_spec}'
      + `&limit=500&access_token=${accessToken}`;
    const insightsUrl = `https://graph.facebook.com/${META_API_VERSION}/${actId}/insights`
      + '?level=ad'
      + '&fields=ad_id,ad_name,spend,impressions,reach,frequency,clicks,ctr,cpc,cpm,actions,purchase_roas,website_purchase_roas,date_start,date_stop'
      + `&date_preset=${encodeURIComponent(datePreset)}`
      + `&limit=500&access_token=${accessToken}`;

    const [metaAds, accountInsights] = await Promise.all([
      fetchMetaPages(adsUrl),
      fetchMetaPages(insightsUrl),
    ]);

    const perAdInsights = accountInsights.length
      ? []
      : await fetchPerAdInsights(metaAds, datePreset, token);
    const insights = accountInsights.length ? accountInsights : perAdInsights;

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
        imageUrl: creativeImage?.url || null,
        imageSource: creativeImage?.source || null,
        source: 'meta_api',
      };
    }).filter(ad => ad.adName);
    const metricRows = ads.filter(hasMetaMetrics).length;

    if (!ads.length) {
      return res.json({ ok: true, imported: 0, weekKey, message: 'No Meta ads found for that date range.' });
    }

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
            + `?fields=id,name,creative{image_url,thumbnail_url,object_story_spec,asset_feed_spec}`
            + `&limit=200`
            + `&access_token=${encodeURIComponent(token)}`;

    while (url) {
      const resp = await fetch(url);
      const data = await resp.json();
      if (data.error) {
        return res.status(400).json({ error: data.error.message || 'Meta API error', meta: data.error });
      }
      if (Array.isArray(data.data)) metaAds.push(...data.data);
      url = data.paging?.next || null;
    }

    if (!metaAds.length) {
      return res.json({ ok: true, enriched: 0, total: 0, message: 'No ads found in this account via the Meta API.' });
    }

    // Build lookup maps: by ID and by name (lowercased)
    const byId   = {};
    const byName = {};
    for (const ma of metaAds) {
      const image = pickCreativeImage(ma.creative);
      if (image?.url) {
        byId[String(ma.id)] = image.url;
        byName[String(ma.name || '').toLowerCase()] = image.url;
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

    await saveWeek(weekKey, week);
    res.json({ ok: true, enriched, total: week.ads.length });
  } catch (err) {
    console.error('Meta enrich error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AdBrief running on http://localhost:${PORT}`));
