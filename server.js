require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');

const { parseBuffer, parseCSVText } = require('./lib/parser');
const { generateBrief } = require('./lib/brief');
const { getWeekKey, saveWeek, loadWeek, listWeeks, getPreviousWeekSummary, saveComments, deleteWeek } = require('./lib/storage');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
    const ads = parseBuffer(req.file.buffer, req.file.mimetype);
    if (!ads.length) return res.status(400).json({ error: 'No ad rows found. Check that your export has the correct columns.' });

    const weekKey = clientKey(getClient(req), getWeekKey());
    const existing = await loadWeek(weekKey) || {};
    const prev = existing.ads || [];
    const prevNames = new Set(prev.map(a => a.adName));
    const merged = [...prev, ...ads.filter(a => !prevNames.has(a.adName))];
    existing.ads = merged;
    existing.uploadedAt = new Date().toISOString();
    await saveWeek(weekKey, existing);

    res.json({ ok: true, weekKey, added: ads.length - (ads.length - (merged.length - prev.length)), total: merged.length });
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
    const ads = parseCSVText(text);
    if (!ads.length) return res.status(400).json({ error: 'No ad rows found in the sheet. Check column names.' });

    const weekKey = clientKey(getClient(req), getWeekKey());
    const existing = await loadWeek(weekKey) || {};
    const prev = existing.ads || [];
    const prevNames = new Set(prev.map(a => a.adName));
    const merged = [...prev, ...ads.filter(a => !prevNames.has(a.adName))];
    existing.ads = merged;
    existing.uploadedAt = new Date().toISOString();
    await saveWeek(weekKey, existing);

    res.json({ ok: true, weekKey, added: merged.length - prev.length, total: merged.length });
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

    const prevSummary = await getPreviousWeekSummary(weekKey);
    const result = await generateBrief(week.ads, prevSummary);

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

// ── TEMP: seed a fake previous week for history testing ────────────────────
app.get('/dev/seed-history', async (req, res) => {
  try {
    const current = getWeekKey();
    const [year, wk] = current.split('-W').map(Number);
    const prevKey = wk <= 1 ? `${year - 1}-W52` : `${year}-W${String(wk - 1).padStart(2, '0')}`;
    const client = getClient(req);
    const fullKey = clientKey(client, prevKey);

    const mockAds = [
      { adName: 'Reel — Winter launch hero', format: 'Reel', spend: 1800, roas: 4.9, ctr: 3.1, cpc: 0.49, cpm: 15.2, impressions: 118000, clicks: 3658, reach: 98000, frequency: 1.2 },
      { adName: 'Video — Behind the scenes', format: 'Video', spend: 920, roas: 3.2, ctr: 2.3, cpc: 0.63, cpm: 14.5, impressions: 63000, clicks: 1449, reach: 55000, frequency: 1.15 },
      { adName: 'Carousel — Gift guide top 5', format: 'Carousel', spend: 540, roas: 2.1, ctr: 1.4, cpc: 1.08, cpm: 14.9, impressions: 36000, clicks: 504, reach: 32000, frequency: 1.1 },
      { adName: 'Static Image — Holiday offer', format: 'Static', spend: 210, roas: 0.8, ctr: 0.9, cpc: 1.55, cpm: 13.4, impressions: 15000, clicks: 135, reach: 14000, frequency: 1.07 },
      { adName: 'UGC Video — Real customer story', format: 'Video', spend: 1350, roas: 4.4, ctr: 2.9, cpc: 0.52, cpm: 15.0, impressions: 90000, clicks: 2610, reach: 78000, frequency: 1.15 },
    ];

    const mockBrief = {
      summary: 'Strong week led by Reels and UGC. Short-form video outperformed static by 4x on ROAS. Carousel showed moderate results. Static holiday creative underperformed — high frequency with low conversion suggests creative fatigue setting in early.',
      topPerformers: [
        { adName: 'Reel — Winter launch hero', why: 'Highest ROAS at 4.9 with strong CTR of 3.1%. Efficient spend with broad reach.', action: 'Scale budget by 30% and test a v2 with alternate hook.' },
        { adName: 'UGC Video — Real customer story', why: 'ROAS 4.4 with authentic tone driving high engagement. Low CPC shows strong audience fit.', action: 'Duplicate and test with a different thumbnail.' },
      ],
      makeNext: [
        { concept: 'Reel — Customer unboxing moment', rationale: 'UGC and Reel formats are both working. Combining them should amplify results.' },
        { concept: 'Carousel — Before and after results', rationale: 'Carousel format has potential but needs stronger creative hook to convert.' },
      ],
      fatigueAlerts: [
        { adName: 'Static Image — Holiday offer', why: 'Frequency climbing without conversion improvement. Audience is tuning it out.', action: 'Refresh creative or pause for 7 days.' },
      ],
      underperformers: [
        { adName: 'Carousel — Gift guide top 5', why: 'ROAS of 2.1 is below break-even. CTR low despite reasonable impressions.', action: 'Test a stronger opening card and clearer CTA.' },
      ],
      retireNow: [
        { adName: 'Static Image — Holiday offer', reason: 'ROAS below 1.0 means spending more than returning. No signs of recovery.' },
      ],
    };

    await saveWeek(fullKey, { ads: mockAds, brief: mockBrief, uploadedAt: new Date().toISOString(), generatedAt: new Date().toISOString(), comments: [] });
    res.json({ ok: true, seeded: fullKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AdBrief running on http://localhost:${PORT}`));
