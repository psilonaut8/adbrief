const XLSX = require('xlsx');

// Meta Ads Manager exports use inconsistent column names — map them all to standard keys
const COLUMN_ALIASES = {
  // Ad name
  'ad name': 'adName',
  'ad': 'adName',
  'name': 'adName',

  // Spend
  'amount spent (usd)': 'spend',
  'amount spent': 'spend',
  'spend': 'spend',
  'cost': 'spend',

  // Impressions
  'impressions': 'impressions',

  // CPM
  'cpm (cost per 1,000 impressions)': 'cpm',
  'cpm': 'cpm',

  // CTR
  'ctr (all)': 'ctr',
  'ctr (link click-through rate)': 'ctr',
  'ctr': 'ctr',
  'click-through rate': 'ctr',

  // CPC
  'cpc (all)': 'cpc',
  'cpc (cost per link click)': 'cpc',
  'cpc': 'cpc',
  'cost per click': 'cpc',

  // ROAS
  'purchase roas (return on ad spend)': 'roas',
  'website purchase roas (return on ad spend)': 'roas',
  'roas': 'roas',
  'return on ad spend': 'roas',

  // Frequency
  'frequency': 'frequency',

  // Reach
  'reach': 'reach',

  // Clicks
  'clicks (all)': 'clicks',
  'link clicks': 'clicks',
  'clicks': 'clicks',
};

function normalizeHeader(raw) {
  return raw.trim().toLowerCase();
}

function parseNumber(val) {
  if (val === undefined || val === null || val === '') return null;
  const n = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? null : n;
}

// Extract hook text and creative format from ad name
// Meta naming conventions vary wildly — this is best-effort
function extractMeta(adName) {
  if (!adName) return { hook: null, format: null };

  const name = String(adName);
  let format = null;
  let hook = name;

  // Detect format keywords
  const formatPatterns = [
    { pattern: /\bvideo\b/i, label: 'Video' },
    { pattern: /\breels?\b/i, label: 'Reel' },
    { pattern: /\bcarousel\b/i, label: 'Carousel' },
    { pattern: /\bstatic\b/i, label: 'Static' },
    { pattern: /\bimage\b/i, label: 'Static' },
    { pattern: /\bstory\b/i, label: 'Story' },
    { pattern: /\bcollection\b/i, label: 'Collection' },
    { pattern: /\bugc\b/i, label: 'UGC' },
  ];

  for (const { pattern, label } of formatPatterns) {
    if (pattern.test(name)) {
      format = label;
      break;
    }
  }

  // Strip common separators and prefixes to get at the hook text
  // e.g. "2024_Q1_Video_Hook-This is the hook text_v2" → "This is the hook text"
  const separators = /[_|\-–—]/;
  const parts = name.split(separators).map(p => p.trim()).filter(p => p.length > 3);

  // Find the longest meaningful part as the hook
  const skipWords = /^(v\d|copy\d?|test|ad|static|video|reel|carousel|story|ugc|image|\d{4}|q[1-4]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i;
  const meaningful = parts.filter(p => !skipWords.test(p));
  if (meaningful.length > 0) {
    hook = meaningful.reduce((a, b) => (a.length >= b.length ? a : b));
  }

  return { hook, format };
}

function parseRows(rawRows) {
  if (!rawRows || rawRows.length < 2) return [];

  const headers = rawRows[0].map(normalizeHeader);

  // Map header index → standard key
  const colMap = {};
  headers.forEach((h, i) => {
    const key = COLUMN_ALIASES[h];
    if (key && !(key in colMap)) colMap[i] = key;
  });

  const ads = [];

  for (let r = 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!row || row.every(cell => cell === null || cell === undefined || cell === '')) continue;

    const ad = {};
    for (const [i, key] of Object.entries(colMap)) {
      ad[key] = row[i];
    }

    if (!ad.adName) continue;

    const { hook, format } = extractMeta(ad.adName);
    ad.hook = hook;
    ad.format = format;

    // Normalize numeric fields
    for (const field of ['spend', 'impressions', 'cpm', 'ctr', 'cpc', 'roas', 'frequency', 'reach', 'clicks']) {
      ad[field] = parseNumber(ad[field]);
    }

    ads.push(ad);
  }

  return ads;
}

function getSheetRows(workbook, name) {
  const sheet = workbook.Sheets[name];
  if (!sheet) return null;
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
}

function findSheet(workbook, keywords) {
  return workbook.SheetNames.find(n =>
    keywords.some(k => n.toLowerCase().includes(k))
  );
}

function parseBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: false, cellDates: true, dense: false });
  const names = workbook.SheetNames.map(n => n.toLowerCase());

  // Multi-sheet format: separate Ads + Performance sheets (e.g. simulation files)
  const adsSheetName    = findSheet(workbook, ['ads']);
  const perfSheetName   = findSheet(workbook, ['performance', 'perf', 'metrics']);

  if (adsSheetName && perfSheetName && workbook.SheetNames.length > 1) {
    return parseMultiSheet(workbook, adsSheetName, perfSheetName);
  }

  // Single-sheet format: standard Meta Ads Manager export
  // Try to find a sheet with ad-level data, fall back to first sheet
  const bestSheet = findSheet(workbook, ['ads', 'ad', 'report', 'export']) || workbook.SheetNames[0];
  const rawRows = getSheetRows(workbook, bestSheet);
  return parseRows(rawRows);
}

function parseMultiSheet(workbook, adsSheetName, perfSheetName) {
  const adsRows  = XLSX.utils.sheet_to_json(workbook.Sheets[adsSheetName],  { defval: '' });
  const perfRows = XLSX.utils.sheet_to_json(workbook.Sheets[perfSheetName], { defval: '' });

  // Build a lookup of Ad ID → ad info from Ads sheet
  const adInfo = {};
  for (const row of adsRows) {
    const id = row['Ad ID'] || row['ad id'] || row['AdID'];
    if (!id) continue;
    adInfo[String(id)] = {
      adName:      row['Ad Name']      || row['ad name']      || row['Name'] || String(id),
      format:      row['Creative Type']|| row['creative type']|| null,
      hook:        row['Headline']     || row['headline']     || row['Primary Text'] || null,
    };
  }

  // Aggregate performance per Ad ID
  const perf = {};
  for (const row of perfRows) {
    const id = String(row['Ad ID'] || row['ad id'] || row['AdID'] || '');
    if (!id) continue;
    if (!perf[id]) perf[id] = { spend:0, impressions:0, clicks:0, roas:0, roasCount:0, cpc:0, cpcCount:0, cpm:0, cpmCount:0, ctr:0, ctrCount:0 };
    const p = perf[id];
    p.spend       += parseNumber(row['Spend']        || row['spend'])        || 0;
    p.impressions += parseNumber(row['Impressions']  || row['impressions'])  || 0;
    p.clicks      += parseNumber(row['Clicks']       || row['clicks'])       || 0;
    const roas = parseNumber(row['ROAS'] || row['roas']); if (roas != null) { p.roas += roas; p.roasCount++; }
    const cpc  = parseNumber(row['CPC']  || row['cpc']);  if (cpc  != null) { p.cpc  += cpc;  p.cpcCount++;  }
    const cpm  = parseNumber(row['CPM']  || row['cpm']);  if (cpm  != null) { p.cpm  += cpm;  p.cpmCount++;  }
    const ctr  = parseNumber(row['CTR (%)'] || row['CTR'] || row['ctr']); if (ctr != null) { p.ctr += ctr; p.ctrCount++; }
  }

  const ads = [];
  for (const [id, p] of Object.entries(perf)) {
    const info = adInfo[id] || { adName: `Ad ${id}`, format: null, hook: null };
    const { hook, format } = info.hook ? { hook: info.hook, format: info.format } : extractMeta(info.adName);
    ads.push({
      adName:      info.adName,
      format:      info.format || format,
      hook,
      spend:       Math.round(p.spend * 100) / 100,
      impressions: p.impressions,
      clicks:      p.clicks,
      roas:        p.roasCount       ? Math.round((p.roas / p.roasCount) * 100) / 100       : null,
      cpc:         p.cpcCount        ? Math.round((p.cpc  / p.cpcCount)  * 100) / 100        : null,
      cpm:         p.cpmCount        ? Math.round((p.cpm  / p.cpmCount)  * 100) / 100        : null,
      ctr:         p.ctrCount        ? Math.round((p.ctr  / p.ctrCount)  * 100) / 100        : null,
      frequency:   null,
      reach:       null,
    });
  }
  return ads;
}

function parseCSVText(text) {
  // Auto-detect delimiter — TSV uses tabs, CSV uses commas
  const delimiter = text.indexOf('\t') !== -1 ? '\t' : ',';
  const workbook = XLSX.read(text, { type: 'string', FS: delimiter });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  return parseRows(rawRows);
}

module.exports = { parseBuffer, parseCSVText };
