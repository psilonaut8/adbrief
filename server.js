require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');

const { parseBuffer, parseCSVText } = require('./lib/parser');
const { generateBrief } = require('./lib/brief');
const { getWeekKey, saveWeek, loadWeek, listWeeks, getPreviousWeekSummary, saveComments } = require('./lib/storage');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Upload a CSV or Excel file
app.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ads = parseBuffer(req.file.buffer, req.file.mimetype);
    if (!ads.length) return res.status(400).json({ error: 'No ad rows found. Check that your export has the correct columns.' });

    const weekKey = getWeekKey();
    const existing = loadWeek(weekKey) || {};
    existing.ads = ads;
    existing.uploadedAt = new Date().toISOString();
    saveWeek(weekKey, existing);

    res.json({ ok: true, weekKey, count: ads.length });
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

    const weekKey = getWeekKey();
    const existing = loadWeek(weekKey) || {};
    existing.ads = ads;
    existing.uploadedAt = new Date().toISOString();
    saveWeek(weekKey, existing);

    res.json({ ok: true, weekKey, count: ads.length });
  } catch (err) {
    console.error('Sheets error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Generate a brief from the current week's data
app.post('/generate-brief', async (req, res) => {
  try {
    const weekKey = getWeekKey();
    const week = loadWeek(weekKey);
    if (!week || !week.ads || !week.ads.length) {
      return res.status(400).json({ error: 'No data for this week. Upload a file or load from Sheets first.' });
    }

    const prevSummary = getPreviousWeekSummary(weekKey);
    const result = await generateBrief(week.ads, prevSummary);

    if (!result.ok) {
      return res.status(500).json({ error: 'AI response could not be parsed.', raw: result.raw });
    }

    week.brief = result.brief;
    week.generatedAt = new Date().toISOString();
    saveWeek(weekKey, week);

    res.json({ ok: true, weekKey, brief: result.brief });
  } catch (err) {
    console.error('Brief error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get current week's data and brief
app.get('/week/current', (req, res) => {
  const weekKey = getWeekKey();
  const week = loadWeek(weekKey);
  res.json({ weekKey, week: week || null });
});

// Get a specific week's data
app.get('/week/:key', (req, res) => {
  const week = loadWeek(req.params.key);
  if (!week) return res.status(404).json({ error: 'Week not found' });
  res.json({ weekKey: req.params.key, week });
});

// List all saved weeks
app.get('/history', (req, res) => {
  res.json({ weeks: listWeeks() });
});

// Add or update a comment on a week's brief
app.post('/comment', (req, res) => {
  try {
    const { weekKey, author, text } = req.body;
    if (!weekKey || !author || !text) return res.status(400).json({ error: 'weekKey, author, and text are required' });

    const week = loadWeek(weekKey);
    if (!week) return res.status(404).json({ error: 'Week not found' });

    const comments = week.comments || [];
    comments.push({ author, text, createdAt: new Date().toISOString() });
    saveComments(weekKey, comments);

    res.json({ ok: true, comments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AdBrief running on http://localhost:${PORT}`));
