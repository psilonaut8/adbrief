const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
let client, db;

async function connect() {
  if (db) return db;
  if (!uri) throw new Error('MONGODB_URI environment variable is not set.');
  client = new MongoClient(uri);
  await client.connect();
  db = client.db('adbrief');
  return db;
}

function getWeekKey(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

async function saveWeek(weekKey, data) {
  const database = await connect();
  await database.collection('weeks').updateOne(
    { weekKey },
    { $set: { ...data, weekKey } },
    { upsert: true }
  );
}

async function loadWeek(weekKey) {
  const database = await connect();
  const doc = await database.collection('weeks').findOne({ weekKey });
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

async function listWeeks(clientPrefix) {
  const database = await connect();
  const docs = await database.collection('weeks')
    .find({}, { projection: { weekKey: 1 } })
    .sort({ weekKey: -1 })
    .toArray();
  const keys = docs.map(d => d.weekKey);
  if (clientPrefix) return keys.filter(k => k.startsWith(clientPrefix + '__'));
  return keys.filter(k => !k.includes('__'));
}

async function getPreviousWeekSummary(currentWeekKey) {
  const [year, week] = currentWeekKey.split('-W').map(Number);
  const prevKey = week === 1
    ? `${year - 1}-W52`
    : `${year}-W${String(week - 1).padStart(2, '0')}`;
  const prev = await loadWeek(prevKey);
  if (!prev || !prev.brief) return null;
  const tops = (prev.brief.topPerformers || []).map(a => a.adName).join(', ');
  return tops ? `Top performers last week: ${tops}` : null;
}

async function saveComments(weekKey, comments) {
  const database = await connect();
  await database.collection('weeks').updateOne({ weekKey }, { $set: { comments } });
}

async function deleteWeek(weekKey) {
  const database = await connect();
  await database.collection('weeks').deleteOne({ weekKey });
}

async function getRecentHistory(currentWeekKey, count = 4) {
  const dblIdx = currentWeekKey.indexOf('__');
  const prefix = dblIdx >= 0 ? currentWeekKey.slice(0, dblIdx + 2) : '';
  const baseKey = dblIdx >= 0 ? currentWeekKey.slice(dblIdx + 2) : currentWeekKey;
  const [yearStr, wkStr] = baseKey.split('-W');
  let year = parseInt(yearStr), wk = parseInt(wkStr);
  const summaries = [];
  for (let i = 1; i <= count; i++) {
    let w = wk - i, y = year;
    if (w <= 0) { y--; w += 52; }
    const key = prefix + `${y}-W${String(w).padStart(2, '0')}`;
    const week = await loadWeek(key);
    if (!week?.brief) continue;
    const b = week.brief;
    const tops    = (b.topPerformers  || []).slice(0, 3).map(a => a.adName).join(', ');
    const fatigue = (b.fatigueAlerts  || []).slice(0, 2).map(a => a.adName).join(', ');
    const retires = (b.retireNow      || []).slice(0, 2).map(a => a.adName).join(', ');
    summaries.push(
      `${y}-W${String(w).padStart(2, '0')}: ${b.summary || ''}` +
      (tops    ? ` Top performers: ${tops}.`    : '') +
      (fatigue ? ` Fatigue alerts: ${fatigue}.` : '') +
      (retires ? ` Retired: ${retires}.`        : '')
    );
  }
  return summaries.length ? summaries.join('\n') : null;
}

module.exports = { getWeekKey, saveWeek, loadWeek, listWeeks, getPreviousWeekSummary, getRecentHistory, saveComments, deleteWeek };
