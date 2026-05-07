const XLSX = require('xlsx');
const path = require('path');

const HEADERS = [
  'Ad Name', 'Amount Spent (USD)', 'Impressions', 'Clicks',
  'CTR (All)', 'CPC (All)', 'CPM (Cost per 1,000 Impressions)',
  'Purchase ROAS (Return on Ad Spend)', 'Reach', 'Frequency'
];

function makeSheet(rows) {
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...rows]);
  return ws;
}

function save(filename, rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, makeSheet(rows), 'Ads');
  const out = path.join(__dirname, filename);
  XLSX.writeFile(wb, out);
  console.log('Created', out);
}

const mock1 = [
  ['Summer Video UGC — Feel the difference v1',  1250, 85000, 2210, 2.60, 0.57, 14.71, 4.20, 72000, 1.18],
  ['Summer Video UGC — Feel the difference v2',   980, 70000, 1540, 2.20, 0.64, 14.00, 3.80, 61000, 1.15],
  ['Carousel — 5 reasons to switch today',        1450, 92000, 1380, 1.50, 1.05, 15.76, 2.90, 80000, 1.15],
  ['Static Image — Clean skin in 7 days',          390, 28000,  308, 1.10, 1.27, 13.93, 1.20, 25000, 1.12],
  ['Static Image — Before and after reveal',       275, 18000,  198, 1.10, 1.39, 15.28, 0.95, 16000, 1.13],
  ['Reel — Morning routine transformation',       1820,120000, 3600, 3.00, 0.51, 15.17, 5.10, 99000, 1.21],
  ['Reel — 30 second glow up',                   1650,110000, 3190, 2.90, 0.52, 15.00, 4.75, 93000, 1.18],
  ['Carousel — Customer favourites vol 1',         540, 38000,  494, 1.30, 1.09, 14.21, 2.10, 34000, 1.12],
  ['UGC Video — My honest review after 30 days', 1100, 74000, 1998, 2.70, 0.55, 14.86, 4.50, 65000, 1.14],
  ['Static Image — The one product I swear by',   180, 14000,  126, 0.90, 1.43, 12.86, 0.75, 13000, 1.08],
  ['Carousel — How it works step by step',        430, 30000,  360, 1.20, 1.19, 14.33, 1.80, 27000, 1.11],
  ['Static Image — Limited time offer',            95,  9000,   72, 0.80, 1.32, 10.56, 0.60,  8500, 1.06],
  ['Reel — Founder story why we built this',      760, 52000, 1196, 2.30, 0.64, 14.62, 3.20, 46000, 1.13],
  ['Video — Testimonial bundle pack',             620, 43000,  946, 2.20, 0.66, 14.42, 3.00, 39000, 1.10],
  ['Static Image — Free shipping this week only', 120, 10000,   80, 0.80, 1.50, 12.00, 0.55,  9500, 1.05],
];

const mock2 = [
  ['Video — Unboxing first impression v1',           1380, 95000, 2850, 3.00, 0.48, 14.53, 4.80,  80000, 1.19],
  ['Video — Unboxing first impression v2',            890, 63000, 1386, 2.20, 0.64, 14.13, 3.10,  55000, 1.15],
  ['Reel — This changed my routine',                 2100,140000, 4620, 3.30, 0.45, 15.00, 5.80, 115000, 1.22],
  ['Carousel — Shop the full collection',             670, 46000,  598, 1.30, 1.12, 14.57, 2.30,  41000, 1.12],
  ['Static Image — New arrival drop',                 210, 16000,  160, 1.00, 1.31, 13.13, 0.85,  15000, 1.07],
  ['UGC Video — Three weeks in here is what happened',1560,104000,3224, 3.10, 0.48, 15.00, 5.20,  88000, 1.18],
  ['Carousel — Compare the range',                    480, 34000,  408, 1.20, 1.18, 14.12, 1.90,  30000, 1.13],
  ['Static Image — Last chance sale ends Sunday',     145, 11000,   88, 0.80, 1.65, 13.18, 0.50,  10500, 1.05],
  ['Reel — POV you finally tried it',                1920,128000, 3968, 3.10, 0.48, 15.00, 5.50, 107000, 1.20],
  ['Video — Side by side comparison',                 730, 50000, 1100, 2.20, 0.66, 14.60, 3.40,  44000, 1.14],
  ['Static Image — The numbers dont lie',             165, 13000,  104, 0.80, 1.59, 12.69, 0.65,  12000, 1.08],
  ['Carousel — What customers are saying',            590, 41000,  533, 1.30, 1.11, 14.39, 2.20,  37000, 1.11],
  ['UGC Video — I was sceptical but then',           1240, 83000, 2324, 2.80, 0.53, 14.94, 4.30,  72000, 1.15],
  ['Reel — Results after day one',                    980, 67000, 1675, 2.50, 0.59, 14.63, 3.70,  58000, 1.13],
  ['Static Image — Bundle and save',                  230, 17000,  136, 0.80, 1.69, 13.53, 0.70,  16000, 1.06],
];

save('meta-mock-1.xlsx', mock1);
save('meta-mock-2.xlsx', mock2);
