require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');

const { parseBuffer, parseCSVText } = require('./lib/parser');
const { generateBrief } = require('./lib/brief');
const { getWeekKey, saveWeek, loadWeek, listWeeks, getRecentHistory, saveComments, deleteWeek } = require('./lib/storage');

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

    const historySummary = await getRecentHistory(weekKey, 4);
    const result = await generateBrief(week.ads, historySummary);

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

// ── TEMP: seed fake previous weeks for history testing ─────────────────────
app.get('/dev/seed-history', async (req, res) => {
  try {
    const current = getWeekKey();
    const client = getClient(req);

    function weekOffset(baseKey, n) {
      const [year, wk] = baseKey.split('-W').map(Number);
      let y = year, w = wk - n;
      while (w < 1) { w += 52; y -= 1; }
      return `${y}-W${String(w).padStart(2, '0')}`;
    }

    const weeks = [
      {
        key: weekOffset(current, 1),
        ads: [
          { adName: 'Reel — Winter launch hero', format: 'Reel', spend: 1800, roas: 4.9, ctr: 3.1, cpc: 0.49, cpm: 15.2, impressions: 118000, clicks: 3658, reach: 98000, frequency: 1.2 },
          { adName: 'UGC Video — Real customer story', format: 'Video', spend: 1350, roas: 4.4, ctr: 2.9, cpc: 0.52, cpm: 15.0, impressions: 90000, clicks: 2610, reach: 78000, frequency: 1.15 },
          { adName: 'Video — Behind the scenes', format: 'Video', spend: 920, roas: 3.2, ctr: 2.3, cpc: 0.63, cpm: 14.5, impressions: 63000, clicks: 1449, reach: 55000, frequency: 1.15 },
          { adName: 'Reel — 60 second results reveal', format: 'Reel', spend: 1100, roas: 4.1, ctr: 2.8, cpc: 0.53, cpm: 14.9, impressions: 74000, clicks: 2072, reach: 65000, frequency: 1.14 },
          { adName: 'Carousel — Gift guide top 5', format: 'Carousel', spend: 540, roas: 2.1, ctr: 1.4, cpc: 1.07, cpm: 15.0, impressions: 36000, clicks: 504, reach: 32000, frequency: 1.1 },
          { adName: 'Static Image — Holiday offer', format: 'Static', spend: 210, roas: 0.8, ctr: 0.9, cpc: 1.56, cpm: 14.0, impressions: 15000, clicks: 135, reach: 14000, frequency: 1.07 },
          { adName: 'Static Image — New year new you', format: 'Static', spend: 310, roas: 1.1, ctr: 1.1, cpc: 1.34, cpm: 14.8, impressions: 21000, clicks: 231, reach: 19000, frequency: 1.1 },
          { adName: 'Video — Product demo walkthrough', format: 'Video', spend: 660, roas: 2.8, ctr: 2.1, cpc: 0.71, cpm: 15.0, impressions: 44000, clicks: 924, reach: 40000, frequency: 1.1 },
        ],
        summary: 'Strong week led by Reels and UGC. Short-form video outperformed static by 4x on ROAS. Static holiday creative flagging — frequency climbing with no conversion lift.',
        topPerformers: [
          { adName: 'Reel — Winter launch hero', why: 'ROAS 4.9 with CTR 3.1%. Broad reach and efficient spend.', action: 'Scale budget 30% and test a v2 with alternate hook.' },
          { adName: 'UGC Video — Real customer story', why: 'ROAS 4.4 with authentic tone driving high engagement.', action: 'Duplicate and test with a different thumbnail.' },
        ],
        makeNext: [
          { concept: 'Reel — Customer unboxing moment', rationale: 'UGC and Reel formats are both working — combining them should amplify results.' },
          { concept: 'Carousel — Before and after results', rationale: 'Carousel has potential but needs a stronger opening card.' },
        ],
        fatigueAlerts: [
          { adName: 'Static Image — Holiday offer', why: 'Frequency climbing with no conversion improvement.', action: 'Refresh creative or pause for 7 days.' },
        ],
        underperformers: [
          { adName: 'Carousel — Gift guide top 5', why: 'ROAS 2.1 below break-even. CTR low despite reasonable impressions.', action: 'Test a stronger opening card and clearer CTA.' },
        ],
        retireNow: [
          { adName: 'Static Image — Holiday offer', reason: 'ROAS below 1.0. Spending more than returning with no recovery trend.' },
        ],
      },
      {
        key: weekOffset(current, 2),
        ads: [
          { adName: 'Video — First video test hook A', format: 'Video', spend: 680, roas: 3.1, ctr: 2.2, cpc: 0.67, cpm: 14.8, impressions: 46000, clicks: 1012, reach: 41000, frequency: 1.12 },
          { adName: 'UGC Video — Trial run first week', format: 'Video', spend: 890, roas: 3.6, ctr: 2.2, cpc: 0.67, cpm: 14.8, impressions: 60000, clicks: 1335, reach: 54000, frequency: 1.11 },
          { adName: 'Carousel — Top 3 reasons customers love us', format: 'Carousel', spend: 720, roas: 2.4, ctr: 1.3, cpc: 1.15, cpm: 15.0, impressions: 48000, clicks: 624, reach: 43000, frequency: 1.12 },
          { adName: 'Static Image — Lifestyle shot morning', format: 'Static', spend: 1100, roas: 2.8, ctr: 1.1, cpc: 1.37, cpm: 15.1, impressions: 73000, clicks: 803, reach: 67000, frequency: 1.09 },
          { adName: 'Static Image — Clean and simple v1', format: 'Static', spend: 820, roas: 2.2, ctr: 1.2, cpc: 1.24, cpm: 14.9, impressions: 55000, clicks: 660, reach: 50000, frequency: 1.1 },
          { adName: 'Static Image — Text heavy offer', format: 'Static', spend: 310, roas: 0.7, ctr: 0.8, cpc: 1.85, cpm: 14.8, impressions: 21000, clicks: 168, reach: 20000, frequency: 1.05 },
          { adName: 'Static Image — Discount banner', format: 'Static', spend: 280, roas: 0.6, ctr: 0.8, cpc: 1.96, cpm: 14.7, impressions: 19000, clicks: 143, reach: 18000, frequency: 1.06 },
        ],
        summary: 'First video tests showing promise with ROAS above 3. Heavy static week overall — lifestyle imagery outperforming offer-led creatives. Discount and text-heavy ads underperforming badly.',
        topPerformers: [
          { adName: 'UGC Video — Trial run first week', why: 'Best performer at ROAS 3.6. UGC tone connecting with audience early.', action: 'Produce 2 more UGC-style videos with different hooks.' },
          { adName: 'Video — First video test hook A', why: 'ROAS 3.1 on a first test is a strong signal.', action: 'Test hook B and C variants to find the best angle.' },
        ],
        makeNext: [
          { concept: 'Reel — Short UGC testimonial', rationale: 'UGC video working well — a shorter Reel format could extend reach on Reels placement.' },
        ],
        fatigueAlerts: [],
        underperformers: [
          { adName: 'Static Image — Text heavy offer', why: 'ROAS 0.7 with low CTR. Audience not engaging with offer-led copy.', action: 'Strip back to a single benefit and test cleaner visual.' },
        ],
        retireNow: [
          { adName: 'Static Image — Discount banner', reason: 'ROAS 0.6. Discount framing is hurting brand perception and not converting.' },
        ],
      },
      {
        key: weekOffset(current, 3),
        ads: [
          { adName: 'Static Image — Brand launch hero', format: 'Static', spend: 1400, roas: 2.6, ctr: 1.1, cpc: 1.37, cpm: 15.1, impressions: 93000, clicks: 1023, reach: 87000, frequency: 1.07 },
          { adName: 'Static Image — After 4 weeks result', format: 'Static', spend: 1050, roas: 2.4, ctr: 1.1, cpc: 1.36, cpm: 15.0, impressions: 70000, clicks: 770, reach: 66000, frequency: 1.06 },
          { adName: 'Static Image — Launch week limited offer', format: 'Static', spend: 1650, roas: 3.1, ctr: 1.05, cpc: 1.43, cpm: 15.0, impressions: 110000, clicks: 1155, reach: 102000, frequency: 1.08 },
          { adName: 'Carousel — Brand story three slides', format: 'Carousel', spend: 850, roas: 2.3, ctr: 1.1, cpc: 1.36, cpm: 14.9, impressions: 57000, clicks: 627, reach: 52000, frequency: 1.1 },
          { adName: 'Static Image — Product range flat lay', format: 'Static', spend: 1100, roas: 2.1, ctr: 1.0, cpc: 1.51, cpm: 15.1, impressions: 73000, clicks: 730, reach: 69000, frequency: 1.06 },
          { adName: 'Static Image — Simple clean offer', format: 'Static', spend: 680, roas: 1.4, ctr: 0.8, cpc: 1.89, cpm: 15.1, impressions: 45000, clicks: 360, reach: 43000, frequency: 1.05 },
          { adName: 'Static Image — Trust badges social proof', format: 'Static', spend: 720, roas: 1.6, ctr: 0.8, cpc: 1.88, cpm: 15.0, impressions: 48000, clicks: 384, reach: 46000, frequency: 1.04 },
        ],
        summary: 'Launch week — all static, heavy brand awareness spend. Limited offer outperformed at ROAS 3.1 but most creatives hovering around 2x. No video yet. Strong reach numbers but CTR across the board is low, suggesting top-of-funnel audience.',
        topPerformers: [
          { adName: 'Static Image — Launch week limited offer', why: 'Best ROAS at 3.1 with the highest reach. Urgency framing working for launch.', action: 'Keep running but plan a refresh before frequency builds.' },
        ],
        makeNext: [
          { concept: 'Video — Brand story 30 seconds', rationale: 'All static this week. A single video test could unlock significantly better ROAS.' },
          { concept: 'UGC — Real customer first impression', rationale: 'Launch audience is cold. Authentic social proof could improve conversion rate.' },
        ],
        fatigueAlerts: [],
        underperformers: [
          { adName: 'Static Image — Simple clean offer', why: 'ROAS 1.4 with weak CTR. Clean aesthetic not communicating value clearly.', action: 'Add a stronger benefit headline.' },
          { adName: 'Static Image — Trust badges social proof', why: 'ROAS 1.6 — trust badges alone not enough to convert cold audience.', action: 'Pair with a product shot and single testimonial.' },
        ],
        retireNow: [],
      },
    ];

    const seeded = [];
    for (const w of weeks) {
      const fullKey = clientKey(client, w.key);
      await saveWeek(fullKey, {
        ads: w.ads,
        brief: { summary: w.summary, topPerformers: w.topPerformers, makeNext: w.makeNext, fatigueAlerts: w.fatigueAlerts, underperformers: w.underperformers, retireNow: w.retireNow },
        uploadedAt: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
        comments: [],
      });
      seeded.push(fullKey);
    }

    res.json({ ok: true, seeded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AdBrief running on http://localhost:${PORT}`));
