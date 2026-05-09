require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');

const { parseBuffer, parseCSVText } = require('./lib/parser');
const { generateBrief } = require('./lib/brief');
const { parseContextFile } = require('./lib/context-parser');
const { getWeekKey, saveWeek, loadWeek, listWeeks, getRecentHistory, saveComments, deleteWeek, saveContextDoc, loadContextDocs, deleteContextDoc } = require('./lib/storage');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

function getClient(req) {
  const c = (req.body?.client || req.query?.client || '');
  return c.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}
function clientKey(client, baseKey) {
  return client ? `${client}__${baseKey}` : baseKey;
}

app.use(express.json());
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
    const weekKey = clientKey(getClient(req), getWeekKey());
    const week = await loadWeek(weekKey);
    if (!week || !week.ads || !week.ads.length) {
      return res.status(400).json({ error: 'No data for this week. Upload a file or load from Sheets first.' });
    }

    const historySummary = await getRecentHistory(weekKey, 4);
    const contextDocs = await loadContextDocs(getClient(req));
    const contextText = contextDocs.length
      ? contextDocs.map(d => `--- ${d.name} ---\n${d.text}`).join('\n\n')
      : null;
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
    const weekKey = clientKey(getClient(req), getWeekKey());
    const week = await loadWeek(weekKey);
    res.json({ weekKey, week: week || null });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AdBrief running on http://localhost:${PORT}`));
