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
  'link ctr': 'ctr',
  'click through rate': 'ctr',

  // CPC
  'cpc (all)': 'cpc',
  'cpc (cost per link click)': 'cpc',
  'cpc': 'cpc',
  'cost per click': 'cpc',
  'cost per link click': 'cpc',
  'cost per result': 'cpc',

  // ROAS
  'purchase roas (return on ad spend)': 'roas',
  'website purchase roas (return on ad spend)': 'roas',
  'website purchases roas (return on ad spend)': 'roas',
  'roas': 'roas',
  'return on ad spend': 'roas',
  'all roas': 'roas',
  'roas (return on ad spend)': 'roas',

  // Frequency
  'frequency': 'frequency',

  // Reach
  'reach': 'reach',

  // Clicks
  'clicks (all)': 'clicks',
  'link clicks': 'clicks',
  'clicks': 'clicks',
  'outbound clicks': 'clicks',

  // Dates
  'reporting starts': 'dateStart',
  'reporting start': 'dateStart',
  'start date': 'dateStart',
  'date start': 'dateStart',
  'date': 'dateStart',
  'reporting ends': 'dateEnd',
  'reporting end': 'dateEnd',
  'end date': 'dateEnd',
  'ad created': 'dateCreated',

  // Image / preview URL — Meta uses various names for this
  'preview url': 'imageUrl',
  'ad preview url': 'imageUrl',
  'ad creative preview url': 'imageUrl',
  'creative preview url': 'imageUrl',
  'image url': 'imageUrl',
  'thumbnail url': 'imageUrl',
  'ad image url': 'imageUrl',
  'creative url': 'imageUrl',
  'media url': 'imageUrl',
  'asset url': 'imageUrl',
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

function parseRows(rawRows, detectedCols) {
  if (!rawRows || rawRows.length < 2) return [];

  const headers = rawRows[0].map(normalizeHeader);

  // Map header index → standard key
  const colMap = {};
  headers.forEach((h, i) => {
    const key = COLUMN_ALIASES[h];
    if (key && !(key in colMap)) colMap[i] = key;
  });

  // Report which standard keys were found directly in the file
  if (detectedCols) {
    for (const key of Object.values(colMap)) detectedCols.fromFile.add(key);
    for (const h of headers) if (!COLUMN_ALIASES[h] && h) detectedCols.unrecognized.push(h);
  }

  // Fallback: if no imageUrl column matched by name, find the first unmapped column
  // whose first data row contains a URL — covers any column name Meta might use
  if (!Object.values(colMap).includes('imageUrl')) {
    const mappedIndexes = new Set(Object.keys(colMap).map(Number));
    const firstDataRow = rawRows[1] || [];
    for (let i = 0; i < headers.length; i++) {
      if (mappedIndexes.has(i)) continue;
      const val = String(firstDataRow[i] || '');
      if (/^https?:\/\//i.test(val)) {
        colMap[i] = 'imageUrl';
        break;
      }
    }
  }

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

    // Derive metrics that weren't in the export but can be calculated from what we have
    if (ad.ctr == null && ad.clicks != null && ad.impressions != null && ad.impressions > 0) {
      ad.ctr = Math.round(ad.clicks / ad.impressions * 10000) / 100; // as percentage
    }
    if (ad.cpm == null && ad.spend != null && ad.impressions != null && ad.impressions > 0) {
      ad.cpm = Math.round(ad.spend / ad.impressions * 1000 * 100) / 100;
    }
    if (ad.cpc == null && ad.spend != null && ad.clicks != null && ad.clicks > 0) {
      ad.cpc = Math.round(ad.spend / ad.clicks * 100) / 100;
    }

    // Keep date and URL fields as strings; convert Excel serial date numbers to ISO dates
    for (const field of ['dateStart', 'dateEnd', 'dateCreated', 'imageUrl']) {
      if (ad[field] != null) {
        let v = String(ad[field]).trim();
        // Excel stores dates as integer day counts from 1899-12-30
        if (/^\d{4,6}$/.test(v) && Number(v) > 40000 && Number(v) < 70000) {
          const d = new Date(Date.UTC(1899, 11, 30) + Number(v) * 86400000);
          v = d.toISOString().slice(0, 10);
        }
        ad[field] = v || null;
      }
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

function parseBuffer(buffer, mimetype) {
  // Try binary Excel/ODS formats first; fall back to plain-text CSV/TSV
  // This handles wrong mimetypes, unusual extensions, and drag-and-dropped files
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', raw: false, cellDates: true, dense: false });
  } catch {
    // Not a recognised binary format — try treating as CSV/TSV text
    return parseCSVText(buffer.toString('utf8'));
  }

  // Binary parse succeeded but might be a plain-text file misread — fall back if no rows
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!firstSheet || Object.keys(firstSheet).length <= 1) {
    return parseCSVText(buffer.toString('utf8'));
  }

  // Multi-sheet format: separate Ads + Performance sheets (e.g. simulation files)
  const adsSheetName  = findSheet(workbook, ['ads']);
  const perfSheetName = findSheet(workbook, ['performance', 'perf', 'metrics']);

  if (adsSheetName && perfSheetName && workbook.SheetNames.length > 1) {
    return { ads: parseMultiSheet(workbook, adsSheetName, perfSheetName), columns: null };
  }

  // Single-sheet format: standard Meta Ads Manager export
  const bestSheet = findSheet(workbook, ['ads', 'ad', 'report', 'export']) || workbook.SheetNames[0];
  const rawRows = getSheetRows(workbook, bestSheet);
  const detectedCols = { fromFile: new Set(), unrecognized: [] };
  const ads = parseRows(rawRows, detectedCols);
  return { ads, columns: { fromFile: [...detectedCols.fromFile], unrecognized: detectedCols.unrecognized } };
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
    const spend       = Math.round(p.spend * 100) / 100;
    const impressions = p.impressions;
    const clicks      = p.clicks;
    const ctr = p.ctrCount ? Math.round((p.ctr / p.ctrCount) * 100) / 100
              : (clicks && impressions ? Math.round(clicks / impressions * 10000) / 100 : null);
    const cpm = p.cpmCount ? Math.round((p.cpm / p.cpmCount) * 100) / 100
              : (spend && impressions ? Math.round(spend / impressions * 1000 * 100) / 100 : null);
    const cpc = p.cpcCount ? Math.round((p.cpc / p.cpcCount) * 100) / 100
              : (spend && clicks ? Math.round(spend / clicks * 100) / 100 : null);
    ads.push({
      adName: info.adName,
      format: info.format || format,
      hook,
      spend, impressions, clicks, ctr, cpm, cpc,
      roas:      p.roasCount ? Math.round((p.roas / p.roasCount) * 100) / 100 : null,
      frequency: null,
      reach:     null,
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
  const detectedCols = { fromFile: new Set(), unrecognized: [] };
  const ads = parseRows(rawRows, detectedCols);
  return { ads, columns: { fromFile: [...detectedCols.fromFile], unrecognized: detectedCols.unrecognized } };
}

module.exports = { parseBuffer, parseCSVText };
