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

// ── CONTEXT DOCS ──────────────────────────────────────────────────────────────
// Stored at the client level — persists across weeks

async function saveContextDoc(client, name, text) {
  const database = await connect();
  const docKey = client ? `${client}__${name}` : name;
  await database.collection('context').updateOne(
    { docKey },
    { $set: { docKey, client: client || '', name, text, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
}

async function loadContextDocs(client) {
  const database = await connect();
  const docs = await database.collection('context')
    .find({ client: client || '' })
    .sort({ updatedAt: -1 })
    .toArray();
  return docs.map(({ docKey, _id, ...rest }) => rest);
}

async function deleteContextDoc(client, name) {
  const database = await connect();
  const docKey = client ? `${client}__${name}` : name;
  await database.collection('context').deleteOne({ docKey });
}

// ── META CREDENTIALS ──────────────────────────────────────────────────────────
// Token stored server-side only — never sent back to the client

async function saveMetaCredentials(client, accountId, token) {
  const database = await connect();
  await database.collection('meta_credentials').updateOne(
    { client: client || '' },
    { $set: { client: client || '', accountId, token, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
}

async function loadMetaCredentials(client) {
  const database = await connect();
  return database.collection('meta_credentials').findOne({ client: client || '' });
}

async function deleteMetaCredentials(client) {
  const database = await connect();
  await database.collection('meta_credentials').deleteOne({ client: client || '' });
}

// SOP SETTINGS
// Client-level creative standards used to turn ad data into SOP readouts

async function saveSopSettings(client, settings) {
  const database = await connect();
  await database.collection('sop_settings').updateOne(
    { client: client || '' },
    { $set: { client: client || '', settings, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
}

async function loadSopSettings(client) {
  const database = await connect();
  const doc = await database.collection('sop_settings').findOne({ client: client || '' });
  return doc?.settings || null;
}

// ── CLIENTS ───────────────────────────────────────────────────────────────────
// Registry of client workspaces shown on the home dashboard

async function saveClient(slug, name, token) {
  const database = await connect();
  const setData = { slug, name, updatedAt: new Date().toISOString() };
  if (token) setData.token = token; // only overwrite if explicitly provided
  await database.collection('clients').updateOne(
    { slug },
    { $set: setData },
    { upsert: true }
  );
}

async function listClients() {
  const database = await connect();
  const docs = await database.collection('clients').find({}).sort({ name: 1 }).toArray();
  return docs.map(({ _id, ...rest }) => rest);
}

async function findClientByToken(token) {
  const database = await connect();
  const doc = await database.collection('clients').findOne({ token });
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

async function deleteClient(slug) {
  const database = await connect();
  await database.collection('clients').deleteOne({ slug });
}

module.exports = { getWeekKey, saveWeek, loadWeek, listWeeks, getPreviousWeekSummary, getRecentHistory, saveComments, deleteWeek, saveContextDoc, loadContextDocs, deleteContextDoc, saveMetaCredentials, loadMetaCredentials, deleteMetaCredentials, saveSopSettings, loadSopSettings, saveClient, listClients, findClientByToken, deleteClient };
