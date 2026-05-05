const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function getWeekKey(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function filePath(weekKey) {
  return path.join(DATA_DIR, `${weekKey}.json`);
}

function saveWeek(weekKey, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath(weekKey), JSON.stringify(data, null, 2));
}

function loadWeek(weekKey) {
  const fp = filePath(weekKey);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function getPreviousWeekKey(weekKey) {
  const [year, week] = weekKey.split('-W').map(Number);
  if (week === 1) return `${year - 1}-W52`;
  return `${year}-W${String(week - 1).padStart(2, '0')}`;
}

function listWeeks() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort()
    .reverse();
}

function getPreviousWeekSummary(currentWeekKey) {
  const prevKey = getPreviousWeekKey(currentWeekKey);
  const prev = loadWeek(prevKey);
  if (!prev || !prev.brief) return null;
  const brief = prev.brief;
  const tops = (brief.topPerformers || []).map(a => a.adName).join(', ');
  return tops ? `Top performers last week: ${tops}` : null;
}

function saveComments(weekKey, comments) {
  const existing = loadWeek(weekKey) || {};
  existing.comments = comments;
  saveWeek(weekKey, existing);
}

module.exports = { getWeekKey, saveWeek, loadWeek, listWeeks, getPreviousWeekSummary, saveComments };
