const isViewOnly = new URLSearchParams(location.search).get('role') === 'summary';
const CLIENT = (new URLSearchParams(location.search).get('client') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
let currentWeekKey = null;
let darkMode = localStorage.getItem('darkMode') === '1';
let briefView = 'grid';
let cardSortCol = 'roas';
let cardSortAsc = false;

function displayKey(key) {
  return key && key.includes('__') ? key.split('__').slice(1).join('__') : (key || '');
}

// Show wake-up banner once per day
(function() {
  const banner = document.getElementById('wakeupBanner');
  const today = new Date().toDateString();
  if (localStorage.getItem('wakeupDismissed') === today) {
    banner.style.display = 'none';
  } else {
    document.getElementById('wakeupClose').onclick = () => {
      banner.style.display = 'none';
      localStorage.setItem('wakeupDismissed', today);
    };
  }
})();

document.addEventListener('DOMContentLoaded', () => {
  if (isViewOnly) document.getElementById('sidebar').classList.add('hidden');
  if (CLIENT) {
    const badge = document.getElementById('demoBadge');
    if (badge) { badge.textContent = CLIENT.toUpperCase(); badge.style.display = 'flex'; }
  }

  setupTabs();
  setupSegment();
  setupFileUpload();
  setupSheetsLoad();
  setupGenerateBtn();
  setupClearBtn();
  setupComments();
  setupDarkToggle();
  setupBriefViewToggle();
  setupAdModal();
  setupContextUpload();
  setupMetaEnrich();
  loadCurrentWeek();
  loadContextDocs();
});

// ── TOP TABS ───────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel-view').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-' + btn.dataset.panel).classList.add('active');

      // Hide sidebar on how-to and trends tabs; keep it visible on data tab (Meta panel lives there)
      const sidebar = document.getElementById('sidebar');
      if (btn.dataset.panel === 'howto' || btn.dataset.panel === 'trends') {
        sidebar.classList.add('hidden');
      } else {
        if (!isViewOnly) sidebar.classList.remove('hidden');
      }

      if (btn.dataset.panel === 'history') loadHistory();
      if (btn.dataset.panel === 'data') loadDataTab();
      if (btn.dataset.panel === 'trends') loadTrendsTab();
    });
  });
}

// ── SIDEBAR SEGMENT CONTROL ────────────────────────────────────────────────
function setupSegment() {
  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.getElementById('tab-file').classList.toggle('hidden', tab !== 'file');
      document.getElementById('tab-sheets').classList.toggle('hidden', tab !== 'sheets');
    });
  });
}

// ── FILE UPLOAD ────────────────────────────────────────────────────────────
function setupFileUpload() {
  const drop = document.getElementById('fileDrop');
  const input = document.getElementById('fileInput');

  input.addEventListener('change', () => { if (input.files.length) uploadFiles(input.files); });

  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('dragover');
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });
}

async function uploadFiles(files) {
  const arr = [...files];
  if (arr.length === 1) { await uploadFile(arr[0]); return; }

  let totalAdded = 0, lastTotal = 0, skipped = 0;
  for (let i = 0; i < arr.length; i++) {
    setStatus(`Uploading ${i + 1} of ${arr.length}…`);
    setDot('working', `Uploading ${i + 1}/${arr.length}…`);
    const form = new FormData();
    form.append('file', arr[i]);
    form.append('client', CLIENT);
    try {
      const res = await fetch('/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) {
        skipped++;
        console.warn(`[AdBrief] Skipped "${arr[i].name}": ${data.error}`);
        continue; // skip this file, keep going
      }
      currentWeekKey = data.weekKey;
      totalAdded += data.added || 0;
      lastTotal = data.total;
      if (data.columns) {
        console.log(`[AdBrief] ${arr[i].name} — columns:`, data.columns.fromFile);
        if (data.columns.unrecognized.length) console.warn('[AdBrief] Unrecognized columns:', data.columns.unrecognized);
      }
    } catch {
      skipped++;
      console.warn(`[AdBrief] Failed to upload "${arr[i].name}"`);
    }
  }

  if (lastTotal === 0) {
    setStatus('No ad rows found in any file. Check your export format.', true);
    setDot('error', 'Upload failed');
    return;
  }

  const skipNote = skipped ? ` (${skipped} file${skipped > 1 ? 's' : ''} skipped)` : '';
  const msg = `${lastTotal} ads loaded from ${arr.length - skipped} file${arr.length - skipped !== 1 ? 's' : ''}${skipNote}`;
  setStatus(msg);
  setDot('ok', `${lastTotal} ads ready`);
  document.getElementById('generateBtn').disabled = false;
  document.getElementById('clearBtn').style.display = 'block';
  document.querySelector('.drop-main').textContent = `${arr.length - skipped} of ${arr.length} files loaded`;
}

async function uploadFile(file) {
  setStatus('Uploading…');
  setDot('working', 'Uploading…');
  const form = new FormData();
  form.append('file', file);
  form.append('client', CLIENT);
  try {
    const res = await fetch('/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) { setStatus(data.error, true); setDot('error', 'Upload failed'); return; }
    currentWeekKey = data.weekKey;
    if (data.columns) {
      console.log('[AdBrief] Columns detected from file:', data.columns.fromFile);
      if (data.columns.unrecognized.length) console.warn('[AdBrief] Unrecognized columns (ignored):', data.columns.unrecognized);
    }
    const msg = data.total > data.added
      ? `${data.added} ads added — ${data.total} total`
      : `${data.added} ads loaded`;
    setStatus(msg);
    setDot('ok', `${data.total} ads ready`);
    document.getElementById('generateBtn').disabled = false;
    document.getElementById('clearBtn').style.display = 'block';
    document.querySelector('.drop-main').textContent = file.name;
  } catch {
    setStatus('Upload failed. Please try again.', true);
    setDot('error', 'Upload failed');
  }
}

// ── SHEETS LOAD ────────────────────────────────────────────────────────────
function setupSheetsLoad() {
  document.getElementById('loadSheetsBtn').addEventListener('click', async () => {
    const url = document.getElementById('sheetsUrl').value.trim();
    if (!url) return setStatus('Please enter a URL.', true);
    setStatus('Fetching sheet…');
    setDot('working', 'Fetching sheet…');
    try {
      const res = await fetch('/sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, client: CLIENT }),
      });
      const data = await res.json();
      if (!res.ok) { setStatus(data.error, true); setDot('error', 'Load failed'); return; }
      currentWeekKey = data.weekKey;
      const msg = data.total > data.added
        ? `${data.added} ads added — ${data.total} total`
        : `${data.added} ads loaded`;
      setStatus(msg);
      setDot('ok', `${data.total} ads ready`);
      document.getElementById('generateBtn').disabled = false;
      document.getElementById('clearBtn').style.display = 'block';
    } catch {
      setStatus('Could not load sheet.', true);
      setDot('error', 'Load failed');
    }
  });
}

// ── CLEAR DATA ─────────────────────────────────────────────────────────────
function setupClearBtn() {
  document.getElementById('clearBtn').addEventListener('click', async () => {
    if (!confirm('Clear all uploaded ads for this week? The brief will also be removed.')) return;
    try {
      await fetch('/week/current/ads?client=' + CLIENT, { method: 'DELETE' });
      currentWeekKey = null;
      setStatus('');
      setDot('idle', 'No data loaded');
      document.getElementById('generateBtn').disabled = true;
      document.getElementById('clearBtn').style.display = 'none';
      document.querySelector('.drop-main').textContent = 'Drop file or click to browse';
      hide('briefOutput');
      hide('loading');
      show('emptyState');
    } catch { alert('Could not clear data. Please try again.'); }
  });
}

// ── GENERATE BRIEF ─────────────────────────────────────────────────────────
function setupGenerateBtn() {
  document.getElementById('generateBtn').addEventListener('click', async () => {
    hide('emptyState');
    hide('briefOutput');
    show('loading');
    setDot('working', 'Generating brief…');
    try {
      const res = await fetch('/generate-brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: CLIENT }) });
      const data = await res.json();
      hide('loading');
      if (!res.ok) { setStatus(data.error, true); setDot('error', 'Failed'); show('emptyState'); return; }
      currentWeekKey = data.weekKey;
      setDot('ok', 'Brief ready');
      renderBrief(data.brief, data.weekKey);
    } catch {
      hide('loading');
      setStatus('Brief generation failed.', true);
      setDot('error', 'Failed');
      show('emptyState');
    }
  });
}

// ── LOAD CURRENT WEEK ON STARTUP ───────────────────────────────────────────
async function loadCurrentWeek() {
  try {
    const res = await fetch('/week/current?client=' + CLIENT);
    const data = await res.json();
    if (!data.week) return;
    currentWeekKey = data.weekKey;
    if (data.week.ads?.length) {
      setStatus(`${data.week.ads.length} ads loaded`);
      setDot('ok', `${data.week.ads.length} ads ready`);
      document.getElementById('generateBtn').disabled = false;
      document.getElementById('clearBtn').style.display = 'block';
    }
    if (data.week.brief) renderBrief(data.week.brief, data.weekKey, data.week.comments);
  } catch { /* silent */ }
}

// ── RENDER BRIEF ───────────────────────────────────────────────────────────
function renderBrief(brief, weekKey, existingComments) {
  currentWeekKey = weekKey;
  document.getElementById('briefTitle').textContent = `Creative Brief — ${displayKey(weekKey)}`;
  document.getElementById('briefMeta').textContent = 'Generated from your Meta Ads export';

  // Summary — array of bullets (new) or legacy string
  const summaryEl = document.getElementById('briefSummary');
  if (Array.isArray(brief.summary)) {
    summaryEl.innerHTML = brief.summary.map(s => `<li>${esc(s)}</li>`).join('');
    summaryEl.className = 'summary-bullets';
  } else {
    summaryEl.textContent = brief.summary || '';
    summaryEl.className = 'summary-text';
  }

  renderAdList('topPerformers', brief.topPerformers, 'green', a => `
    ${a.metric ? `<span class="ad-metric">${esc(a.metric)}</span>` : ''}
    <div class="ad-name">${esc(a.adName)}</div>
    <div class="ad-why">${esc(a.why)}</div>
    <span class="ad-action">${esc(a.action)}</span>
  `);
  renderAdList('makeNext', brief.makeNext, 'blue', a => `
    <div class="ad-name">${esc(a.concept)}</div>
    <div class="ad-why">${esc(a.rationale)}</div>
  `);
  renderAdList('fatigueAlerts', brief.fatigueAlerts, 'orange', a => `
    ${a.metric ? `<span class="ad-metric">${esc(a.metric)}</span>` : ''}
    <div class="ad-name">${esc(a.adName)}</div>
    <div class="ad-why">${esc(a.why)}</div>
    <span class="ad-action">${esc(a.action)}</span>
  `);
  renderAdList('underperformers', brief.underperformers, 'orange', a => `
    ${a.metric ? `<span class="ad-metric">${esc(a.metric)}</span>` : ''}
    <div class="ad-name">${esc(a.adName)}</div>
    <div class="ad-why">${esc(a.why)}</div>
    <span class="ad-action">${esc(a.action)}</span>
  `);
  renderAdList('retireNow', brief.retireNow, 'red', a => `
    ${a.metric ? `<span class="ad-metric">${esc(a.metric)}</span>` : ''}
    <div class="ad-name">${esc(a.adName)}</div>
    <div class="ad-why">${esc(a.reason)}</div>
  `);

  renderComments(existingComments || []);
  hide('emptyState');
  hide('loading');
  show('briefOutput');
}

function renderAdList(id, items, color, tpl) {
  const el = document.getElementById(id);
  const countEl = document.getElementById('count-' + id);
  if (!items?.length) {
    el.innerHTML = '<p class="empty-note">None this week.</p>';
    if (countEl) countEl.textContent = '';
    return;
  }
  el.innerHTML = items.map(i => `<div class="ad-item ${color}">${tpl(i)}</div>`).join('');
  if (countEl) countEl.textContent = items.length;
}

// ── HISTORY ────────────────────────────────────────────────────────────────
async function loadHistory() {
  const grid = document.getElementById('historyGrid');
  const empty = document.getElementById('historyEmpty');
  grid.innerHTML = '';
  try {
    const res = await fetch('/history?client=' + CLIENT);
    const data = await res.json();
    if (!data.weeks.length) { show('historyEmpty'); return; }
    hide('historyEmpty');
    grid.innerHTML = data.weeks.map(w => `
      <div class="history-card" data-week="${w}">
        <div>
          <div class="history-week">${displayKey(w)}</div>
          <div class="history-meta">Click to view brief</div>
        </div>
        <div class="history-card-actions">
          <button class="delete-btn" data-week="${w}" title="Delete brief">Delete</button>
          <div class="history-arrow">→</div>
        </div>
      </div>
    `).join('');
    grid.querySelectorAll('.history-card').forEach(card => {
      card.addEventListener('click', () => loadWeek(card.dataset.week));
    });
    grid.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete the brief for ${btn.dataset.week}? This cannot be undone.`)) return;
        try {
          await fetch(`/week/${btn.dataset.week}`, { method: 'DELETE' });
          if (btn.dataset.week === currentWeekKey) {
            currentWeekKey = null;
            hide('briefOutput');
            hide('loading');
            show('emptyState');
            setDot('idle', 'No data loaded');
            document.getElementById('generateBtn').disabled = true;
          }
          loadHistory();
        } catch {
          alert('Could not delete. Please try again.');
        }
      });
    });
  } catch { empty.classList.remove('hidden'); }
}

async function loadWeek(weekKey) {
  // Switch to brief tab
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.panel-view').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-panel="brief"]').classList.add('active');
  document.getElementById('panel-brief').classList.add('active');
  if (!isViewOnly) document.getElementById('sidebar').classList.remove('hidden');

  hide('emptyState');
  show('loading');
  try {
    const res = await fetch(`/week/${weekKey}`);
    const data = await res.json();
    hide('loading');
    if (!res.ok || !data.week?.brief) { show('emptyState'); return; }
    renderBrief(data.week.brief, weekKey, data.week.comments);
  } catch { hide('loading'); show('emptyState'); }
}

// ── COMMENTS ───────────────────────────────────────────────────────────────
let briefComments = [];
let editingIdx = null;
const REACTIONS = ['👍', '❤️', '🔥'];

function setupComments() {
  document.getElementById('submitComment').addEventListener('click', async () => {
    const author = document.getElementById('commentAuthor').value.trim();
    const text = document.getElementById('commentText').value.trim();
    if (!author || !text) return alert('Please enter your name and a comment.');
    if (!currentWeekKey) return alert('No brief loaded yet.');
    try {
      const res = await fetch('/comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekKey: currentWeekKey, author, text }),
      });
      const data = await res.json();
      if (!res.ok) return alert(data.error);
      document.getElementById('commentText').value = '';
      renderComments(data.comments);
    } catch { alert('Could not post comment.'); }
  });
}

function renderComments(comments, keepEditState) {
  briefComments = comments || [];
  if (!keepEditState) editingIdx = null;
  _drawComments();
}

function _drawComments() {
  const el = document.getElementById('commentsList');
  if (!briefComments.length) {
    el.innerHTML = '<p class="empty-note" style="margin-bottom:12px">No comments yet.</p>';
    return;
  }

  el.innerHTML = briefComments.map((c, i) => {
    const reactions = c.reactions || {};
    const isEditing = editingIdx === i;
    const rKey = `r_${currentWeekKey}_${c.createdAt}`;
    return `
      <div class="comment-item">
        <div class="comment-meta">
          <span class="comment-author">${esc(c.author)}</span>
          <span class="comment-time">${formatTime(c.createdAt)}${c.editedAt ? ' · edited' : ''}</span>
          <div class="comment-actions">
            <button class="comment-action-btn edit-comment-btn" data-i="${i}">Edit</button>
            <button class="comment-action-btn delete-comment-btn" data-i="${i}">Delete</button>
          </div>
        </div>
        ${isEditing ? `
          <textarea class="input comment-edit-ta" id="edit-ta-${i}">${esc(c.text)}</textarea>
          <div class="comment-edit-row">
            <button class="btn-outline save-comment-btn" data-i="${i}">Save</button>
            <button class="btn-outline cancel-edit-btn" style="color:var(--label3)">Cancel</button>
          </div>
        ` : `<div class="comment-text">${esc(c.text)}</div>`}
        <div class="comment-reactions">
          ${REACTIONS.map(emoji => {
            const count = reactions[emoji] || 0;
            const reacted = localStorage.getItem(`${rKey}_${emoji}`) === '1';
            return `<button class="reaction-btn${reacted ? ' reacted' : ''}" data-i="${i}" data-emoji="${emoji}" data-rkey="${rKey}_${emoji}">${emoji}${count ? '<span class="reaction-count">' + count + '</span>' : ''}</button>`;
          }).join('')}
        </div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.edit-comment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      editingIdx = parseInt(btn.dataset.i);
      _drawComments();
      document.getElementById(`edit-ta-${editingIdx}`)?.focus();
    });
  });

  el.querySelectorAll('.cancel-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => { editingIdx = null; _drawComments(); });
  });

  el.querySelectorAll('.save-comment-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = parseInt(btn.dataset.i);
      const text = document.getElementById(`edit-ta-${i}`)?.value.trim();
      if (!text) return;
      try {
        const res = await fetch('/comment', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ weekKey: currentWeekKey, index: i, text }),
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error);
        renderComments(data.comments);
      } catch { alert('Could not save edit.'); }
    });
  });

  el.querySelectorAll('.delete-comment-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = parseInt(btn.dataset.i);
      if (!confirm('Delete this comment?')) return;
      try {
        const res = await fetch('/comment', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ weekKey: currentWeekKey, index: i }),
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error);
        renderComments(data.comments);
      } catch { alert('Could not delete comment.'); }
    });
  });

  el.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = parseInt(btn.dataset.i);
      const emoji = btn.dataset.emoji;
      const rkey = btn.dataset.rkey;
      const reacted = localStorage.getItem(rkey) === '1';
      try {
        const res = await fetch('/reaction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ weekKey: currentWeekKey, index: i, emoji, delta: reacted ? -1 : 1 }),
        });
        const data = await res.json();
        if (!res.ok) return;
        reacted ? localStorage.removeItem(rkey) : localStorage.setItem(rkey, '1');
        briefComments = data.comments;
        _drawComments();
      } catch {}
    });
  });
}

// ── DATA TAB ───────────────────────────────────────────────────────────────
let dataAds = [];
let dataSortCol = null;
let dataSortAsc = true;
let dataView = 'table';
let chartInstance = null;
let chartMetric = 'roas';
let dataTabInitialized = false;
let dataWeekSelectInitialized = false;

async function loadDataTab(weekKey) {
  try {
    // Populate week picker on first load
    if (!dataWeekSelectInitialized) {
      await populateDataWeekSelect();
      dataWeekSelectInitialized = true;
    }

    // Resolve which week to show
    const url = weekKey ? `/week/${encodeURIComponent(weekKey)}` : `/week/current?client=${CLIENT}`;
    const res  = await fetch(url);
    const data = await res.json();

    // Sync the select to whichever week was loaded
    const sel = document.getElementById('dataWeekSelect');
    const resolvedKey = data.weekKey || weekKey;
    if (sel && resolvedKey) sel.value = resolvedKey;

    if (!data.week?.ads?.length) {
      show('dataEmpty');
      document.getElementById('dataTableWrap').classList.add('hidden');
      document.getElementById('dataWeekLabel').textContent = '';
      return;
    }
    dataAds = data.week.ads;
    document.getElementById('dataWeekLabel').textContent = displayKey(resolvedKey) + ' · ' + dataAds.length + ' ads';
    const hasDate    = dataAds.some(a => a.dateStart || a.dateCreated);
    const hasStatus  = dataAds.some(a => a.adStatus);
    const hasResults = dataAds.some(a => a.results != null);
    document.getElementById('thDate').style.display    = hasDate    ? '' : 'none';
    document.getElementById('thStatus').style.display  = hasStatus  ? '' : 'none';
    document.getElementById('thResults').style.display = hasResults ? '' : 'none';
    hide('dataEmpty');
    document.getElementById('dataTableWrap').classList.remove('hidden');
    if (!dataTabInitialized) {
      setupDataSort();
      setupViewToggle();
      setupCardSort();
      dataTabInitialized = true;
    }
    renderDataSummary();
    renderCurrentDataView();
  } catch { /* silent */ }
}

async function populateDataWeekSelect() {
  const sel = document.getElementById('dataWeekSelect');
  if (!sel) return;
  try {
    const res  = await fetch('/history?client=' + CLIENT);
    const data = await res.json();
    const weeks = (data.weeks || []).slice().sort().reverse(); // newest first
    sel.innerHTML = weeks.length
      ? weeks.map(w => `<option value="${w}">${displayKey(w)}</option>`).join('')
      : '<option value="">No saved weeks</option>';
    sel.addEventListener('change', () => {
      if (sel.value) loadDataTab(sel.value);
    });
  } catch { /* silent */ }
}

function renderDataSummary() {
  const el = document.getElementById('dataSummary');
  if (!el || !dataAds.length) { if (el) el.innerHTML = ''; return; }

  const totalSpend = dataAds.reduce((s, a) => s + (a.spend || 0), 0);
  const ctrAds = dataAds.filter(a => a.ctr != null);
  const avgCtr = ctrAds.length ? ctrAds.reduce((s, a) => s + a.ctr, 0) / ctrAds.length : null;
  const cpmAds = dataAds.filter(a => a.cpm != null);
  const avgCpm = cpmAds.length ? cpmAds.reduce((s, a) => s + a.cpm, 0) / cpmAds.length : null;
  const roasAds = dataAds.filter(a => a.roas != null);
  const avgRoas = roasAds.length ? roasAds.reduce((s, a) => s + a.roas, 0) / roasAds.length : null;
  const resultsAds = dataAds.filter(a => a.results != null);
  const totalResults = resultsAds.length ? resultsAds.reduce((s, a) => s + a.results, 0) : null;
  const resultLabel = resultsAds.length && resultsAds[0].resultType ? resultsAds[0].resultType : 'Results';
  const topAd = [...dataAds].sort((a, b) => (b.spend || 0) - (a.spend || 0))[0];

  const stat = (label, val) => val != null
    ? `<div class="ds-stat"><span class="ds-label">${label}</span><span class="ds-val">${val}</span></div>`
    : '';

  el.innerHTML = [
    stat('Total Spend', '$' + totalSpend.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })),
    stat('Ads', dataAds.length),
    totalResults != null ? stat(resultLabel, Math.round(totalResults).toLocaleString()) : '',
    avgRoas != null ? stat('Avg ROAS', avgRoas.toFixed(2)) : '',
    avgCtr  != null ? stat('Avg CTR',  avgCtr.toFixed(2) + '%') : '',
    avgCpm  != null ? stat('Avg CPM',  '$' + avgCpm.toFixed(2)) : '',
    topAd ? `<div class="ds-stat ds-top"><span class="ds-label">Top Ad</span><span class="ds-val ds-topname" title="${esc(topAd.adName)}">${esc(topAd.adName.length > 32 ? topAd.adName.slice(0, 32) + '…' : topAd.adName)}</span></div>` : '',
  ].join('');
}

function renderCurrentDataView() {
  if (dataView === 'table') renderDataTable();
  else if (dataView === 'cards') renderCardView();
  else renderChartView();
}

function setupViewToggle() {
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      dataView = btn.dataset.view;
      document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === dataView));
      document.getElementById('tableView').classList.toggle('hidden', dataView !== 'table');
      document.getElementById('cardView').classList.toggle('hidden', dataView !== 'cards');
      document.getElementById('chartView').classList.toggle('hidden', dataView !== 'chart');
      document.getElementById('chartMetricBar').classList.toggle('hidden', dataView !== 'chart');
      document.getElementById('cardSortBar').classList.toggle('hidden', dataView !== 'cards');
      renderCurrentDataView();
    });
  });
  document.querySelectorAll('[data-metric]').forEach(btn => {
    btn.addEventListener('click', () => {
      chartMetric = btn.dataset.metric;
      document.querySelectorAll('[data-metric]').forEach(b => b.classList.toggle('active', b.dataset.metric === chartMetric));
      renderChartView();
    });
  });
}

function renderCardView() {
  const ads = [...dataAds].sort((a, b) => {
    const av = parseFloat(a[cardSortCol]) || 0;
    const bv = parseFloat(b[cardSortCol]) || 0;
    return cardSortAsc ? av - bv : bv - av;
  });
  document.getElementById('cardView').innerHTML = ads.map((ad, i) => `
    <div class="ad-data-card" data-adidx="${i}" style="cursor:pointer">
      ${ad.imageUrl ? `<div class="adc-thumb"><img src="${esc(ad.imageUrl)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>` : ''}
      <div class="adc-top">${formatBadge(ad.format)}${ad.adStatus ? statusBadge(ad.adStatus) : ''}</div>
      <div class="adc-name">${esc(ad.adName || '—')}</div>
      <div class="adc-metrics">
        ${ad.results != null ? `<div class="adc-metric adc-metric-wide">
          <span class="adc-label">${esc(ad.resultType || 'Results')}</span>
          <span class="adc-value">${Math.round(ad.results).toLocaleString()}</span>
        </div>` : ''}
        <div class="adc-metric">
          <span class="adc-label">ROAS</span>
          <span class="adc-value ${roasColor(ad.roas)}">${fmtNum(ad.roas)}</span>
        </div>
        <div class="adc-metric">
          <span class="adc-label">Spend</span>
          <span class="adc-value">${fmtNum(ad.spend, '$')}</span>
        </div>
        <div class="adc-metric">
          <span class="adc-label">CTR</span>
          <span class="adc-value">${fmtPct(ad.ctr)}</span>
        </div>
        <div class="adc-metric">
          <span class="adc-label">Clicks</span>
          <span class="adc-value">${fmtInt(ad.clicks)}</span>
        </div>
      </div>
    </div>
  `).join('');

  // Wire up click to open modal — pass full sorted list so arrows navigate in card order
  document.getElementById('cardView').querySelectorAll('.ad-data-card').forEach(card => {
    card.addEventListener('click', () => openAdModal(ads, parseInt(card.dataset.adidx)));
  });
}

function roasColor(val) {
  const n = parseFloat(val);
  if (isNaN(n)) return '';
  if (n >= 3) return 'val-green';
  if (n >= 1.5) return 'val-orange';
  return 'val-red';
}

function renderChartView() {
  const dark = document.documentElement.dataset.theme === 'dark';
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

  // Auto-fallback: if selected metric has no data, find one that does
  const METRIC_ORDER = ['spend', 'clicks', 'impressions', 'ctr', 'cpm', 'cpc', 'roas'];
  const hasData = m => dataAds.some(a => a[m] != null && !isNaN(parseFloat(a[m])));
  if (!hasData(chartMetric)) {
    const fallback = METRIC_ORDER.find(hasData);
    if (fallback) {
      chartMetric = fallback;
      document.querySelectorAll('[data-metric]').forEach(b => b.classList.toggle('active', b.dataset.metric === chartMetric));
    }
  }

  const sorted = [...dataAds]
    .filter(a => !isNaN(parseFloat(a[chartMetric])))
    .sort((a, b) => (parseFloat(b[chartMetric]) || 0) - (parseFloat(a[chartMetric]) || 0))
    .slice(0, 25);

  const chartWrap = document.getElementById('chartView');

  if (sorted.length === 0) {
    chartWrap.style.height = '200px';
    chartWrap.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--label3);font-size:14px;">No data available for this metric</div>';
    return;
  }

  // Restore canvas + legend if replaced by the no-data message
  if (!document.getElementById('adChart')) {
    chartWrap.innerHTML = '<div class="chart-legend" id="adChartLegend"></div><canvas id="adChart"></canvas>';
  }

  const labels = sorted.map(a => { const n = a.adName || '—'; return n.length > 38 ? n.slice(0, 38) + '…' : n; });
  const values = sorted.map(a => parseFloat(a[chartMetric]) || 0);
  const colors = sorted.map(a => FORMAT_PALETTE[adFormatKey(a.format)].bg);

  // Legend — only show formats that appear in this data set
  const seen = new Set();
  const legendItems = [];
  sorted.forEach(a => {
    const key = adFormatKey(a.format);
    if (!seen.has(key)) { seen.add(key); legendItems.push({ key, ...FORMAT_PALETTE[key] }); }
  });
  const legendEl = document.getElementById('adChartLegend');
  if (legendEl) {
    legendEl.innerHTML = legendItems.map(item =>
      `<span class="chart-legend-item"><span class="chart-legend-dot" style="background:${item.bg}"></span>${item.label}</span>`
    ).join('');
  }

  chartWrap.style.height = Math.max(320, sorted.length * 38 + 76) + 'px';
  chartInstance = new Chart(document.getElementById('adChart'), {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 4, borderSkipped: false }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => {
          const v = ctx.raw;
          const ad = sorted[ctx.dataIndex];
          const fmt = ad?.format ? ` · ${ad.format}` : '';
          if (['spend','cpc','cpm'].includes(chartMetric)) return ` $${v.toFixed(2)}${fmt}`;
          if (chartMetric === 'ctr') return ` ${v.toFixed(2)}%${fmt}`;
          if (['impressions','clicks'].includes(chartMetric)) return ` ${Math.round(v).toLocaleString()}${fmt}`;
          return ` ${v.toFixed(2)}${fmt}`;
        }}}
      },
      scales: {
        x: { grid: { color: dark ? 'rgba(255,255,255,0.06)' : 'rgba(60,60,67,0.06)' }, ticks: { font: { size: 11, family: 'Inter' }, color: dark ? 'rgba(235,235,245,0.55)' : undefined } },
        y: { grid: { display: false }, ticks: { font: { size: 11, family: 'Inter' }, color: dark ? 'rgba(235,235,245,0.55)' : '#3A3A3C' } }
      }
    }
  });
}

const FORMAT_PALETTE = {
  video:    { bg: '#6366F1', label: 'Video' },
  carousel: { bg: '#F59E0B', label: 'Carousel' },
  image:    { bg: '#0EA5E9', label: 'Image' },
  vertical: { bg: '#10B981', label: 'Story / Vertical' },
  other:    { bg: '#8E8E93', label: 'Other' },
};

function adFormatKey(raw) {
  const f = (raw || '').toLowerCase();
  if (f.includes('video') || f.includes('reel'))                              return 'video';
  if (f.includes('carousel'))                                                  return 'carousel';
  if (f.includes('story') || f.includes('stories') || f.includes('vertical')) return 'vertical';
  if (f.includes('image') || f.includes('photo') || f.includes('static'))     return 'image';
  return 'other';
}

function formatIcon(raw) {
  const f = (raw || '').toLowerCase();
  if (f.includes('video') || f.includes('reel')) return '▶ ';
  if (f.includes('carousel'))                    return '≡ ';
  if (f.includes('story') || f.includes('stories') || f.includes('vertical')) return '▌ ';
  if (f.includes('image') || f.includes('photo') || f.includes('static'))     return '◼ ';
  return '';
}

function statusBadge(raw) {
  if (!raw) return '';
  const s = raw.toLowerCase();
  if (s.includes('active') && !s.includes('in') && !s.includes('not'))
    return `<span class="status-badge-pill status-active">Active</span>`;
  if (s.includes('paused'))
    return `<span class="status-badge-pill status-paused">Paused</span>`;
  if (s.includes('not deliver') || s.includes('not delivered'))
    return `<span class="status-badge-pill status-undelivered">Not delivered</span>`;
  if (s.includes('learning limited'))
    return `<span class="status-badge-pill status-learning">Learning limited</span>`;
  if (s.includes('learning'))
    return `<span class="status-badge-pill status-learning">Learning</span>`;
  if (s.includes('inactive') || s.includes('archived') || s.includes('draft'))
    return `<span class="status-badge-pill status-inactive">${esc(raw)}</span>`;
  return `<span class="status-badge-pill status-inactive">${esc(raw)}</span>`;
}

function formatBadge(raw) {
  const f = (raw || '').toLowerCase();
  if (f.includes('video'))    return '<span class="fmt-badge fmt-video">▶ Video</span>';
  if (f.includes('carousel')) return '<span class="fmt-badge fmt-carousel">≡ Carousel</span>';
  if (f.includes('reel'))     return '<span class="fmt-badge fmt-video">▶ Reel</span>';
  if (f.includes('story') || f.includes('stories') || f.includes('vertical'))
                               return '<span class="fmt-badge fmt-vertical">▌Vertical</span>';
  if (f.includes('horizontal') || f.includes('landscape'))
                               return '<span class="fmt-badge fmt-horizontal">▬ Horizontal</span>';
  if (f.includes('square'))   return '<span class="fmt-badge fmt-square">⬛ Square</span>';
  if (f.includes('image') || f.includes('photo') || f.includes('static'))
                               return '<span class="fmt-badge fmt-image">◼ Image</span>';
  return raw ? `<span class="fmt-badge fmt-other">${esc(raw)}</span>` : '—';
}

function naturalCmp(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function renderDataTable() {
  const rows = [...dataAds];
  if (dataSortCol) {
    rows.sort((a, b) => {
      const av = a[dataSortCol] ?? '';
      const bv = b[dataSortCol] ?? '';
      const an = parseFloat(av), bn = parseFloat(bv);
      const isNum = !isNaN(an) && !isNaN(bn);
      let cmp = isNum ? an - bn : naturalCmp(av, bv);
      return dataSortAsc ? cmp : -cmp;
    });
  }

  const showDate    = document.getElementById('thDate').style.display    !== 'none';
  const showStatus  = document.getElementById('thStatus').style.display  !== 'none';
  const showResults = document.getElementById('thResults').style.display !== 'none';
  document.getElementById('dataTableBody').innerHTML = rows.map((ad, i) => `
    <tr class="clickable-row" data-rowidx="${i}">
      <td class="ad-name-cell">${esc(ad.adName || '—')}</td>
      ${showDate    ? `<td class="date-cell">${esc(ad.dateCreated || ad.dateStart || '—')}</td>` : ''}
      ${showStatus  ? `<td>${statusBadge(ad.adStatus)}</td>` : ''}
      ${showResults ? `<td class="num">${esc(fmtResults(ad))}</td>` : ''}
      <td>${formatBadge(ad.format)}</td>
      <td class="num">${fmtNum(ad.spend, '$')}</td>
      <td class="num">${fmtNum(ad.roas)}</td>
      <td class="num">${fmtPct(ad.ctr)}</td>
      <td class="num">${fmtNum(ad.cpc, '$')}</td>
      <td class="num">${fmtNum(ad.cpm, '$')}</td>
      <td class="num">${fmtInt(ad.impressions)}</td>
      <td class="num">${fmtInt(ad.clicks)}</td>
    </tr>
  `).join('');

  document.querySelectorAll('.data-table thead th').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === dataSortCol) {
      th.classList.add(dataSortAsc ? 'sort-asc' : 'sort-desc');
    }
  });

  // Table rows open modal; arrows navigate in current sort order
  document.getElementById('dataTableBody').querySelectorAll('.clickable-row').forEach(tr => {
    tr.addEventListener('click', () => openAdModal(rows, parseInt(tr.dataset.rowidx)));
  });
}

function setupDataSort() {
  document.querySelectorAll('.data-table thead th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      if (dataSortCol === th.dataset.col) {
        dataSortAsc = !dataSortAsc;
      } else {
        dataSortCol = th.dataset.col;
        dataSortAsc = true;
      }
      renderDataTable();
    });
  });
}

function fmtResults(ad) {
  if (ad.results == null) return '—';
  const n = Math.round(ad.results).toLocaleString();
  return ad.resultType ? `${n} ${ad.resultType}` : n;
}

function fmtNum(val, prefix) {
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  return (prefix || '') + n.toFixed(2);
}
function fmtPct(val) {
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  return n.toFixed(2) + '%';
}
function fmtInt(val) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return '—';
  return n.toLocaleString();
}

// ── TRENDS TAB ─────────────────────────────────────────────────────────────
let trendsChart = null;
let trendsMetric = 'roas';
let trendsData = [];

async function loadTrendsTab() {
  try {
    const res = await fetch('/trends?client=' + CLIENT);
    const json = await res.json();
    trendsData = json.weeks || [];
    if (trendsData.length < 2) {
      show('trendsEmpty');
      hide('trendsContent');
      return;
    }
    hide('trendsEmpty');
    show('trendsContent');
    setupTrendsMetricBtns();
    renderTrendsChart();
    renderTrendsTable();
  } catch { show('trendsEmpty'); hide('trendsContent'); }
}

function setupTrendsMetricBtns() {
  document.querySelectorAll('[data-tmetric]').forEach(btn => {
    btn.onclick = () => {
      trendsMetric = btn.dataset.tmetric;
      document.querySelectorAll('[data-tmetric]').forEach(b => b.classList.toggle('active', b.dataset.tmetric === trendsMetric));
      renderTrendsChart();
    };
  });
}

function renderTrendsChart() {
  const dark = document.documentElement.dataset.theme === 'dark';
  if (trendsChart) { trendsChart.destroy(); trendsChart = null; }

  const labels = trendsData.map(w => displayKey(w.week));
  const values = trendsData.map(w => w[trendsMetric]);
  const colors = { roas: '#34C759', spend: '#1B6EF3', ctr: '#FF9500' };
  const color = colors[trendsMetric] || '#1B6EF3';
  const gridColor = dark ? 'rgba(255,255,255,0.06)' : 'rgba(60,60,67,0.08)';
  const tickColor = dark ? 'rgba(235,235,245,0.55)' : '#636366';

  trendsChart = new Chart(document.getElementById('trendsChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: color,
        backgroundColor: color + '22',
        borderWidth: 2.5,
        pointRadius: 5,
        pointBackgroundColor: color,
        fill: true,
        tension: 0.3,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => {
          const v = ctx.raw;
          if (v == null) return ' No data';
          if (trendsMetric === 'spend') return ` $${v.toLocaleString()}`;
          if (trendsMetric === 'ctr') return ` ${v.toFixed(2)}%`;
          return ` ${v.toFixed(2)}`;
        }}}
      },
      scales: {
        x: { grid: { color: gridColor }, ticks: { font: { size: 12, family: 'Inter' }, color: tickColor } },
        y: { grid: { color: gridColor }, ticks: { font: { size: 12, family: 'Inter' }, color: tickColor } },
      }
    }
  });
}

function renderTrendsTable() {
  document.getElementById('trendsTableBody').innerHTML = [...trendsData].reverse().map(w => `
    <tr>
      <td style="font-weight:600">${esc(displayKey(w.week))}</td>
      <td class="num">$${(w.spend || 0).toLocaleString()}</td>
      <td class="num ${roasColor(w.roas)}">${w.roas != null ? w.roas.toFixed(2) : '—'}</td>
      <td class="num">${w.ctr != null ? w.ctr.toFixed(2) + '%' : '—'}</td>
      <td class="num">${w.adCount}</td>
    </tr>
  `).join('');
}

// ── AD DETAIL MODAL ────────────────────────────────────────────────────────
let modalAdList = [];
let modalAdIndex = 0;

function openAdModal(adList, index) {
  modalAdList  = adList;
  modalAdIndex = index;
  _renderModalAd();
  document.getElementById('adModalOverlay').classList.remove('hidden');
}

function _renderModalAd() {
  const ad = modalAdList[modalAdIndex];
  if (!ad) return;

  // Image
  const imgWrap = document.getElementById('adModalImage');
  if (ad.imageUrl) {
    imgWrap.innerHTML = `<img src="${esc(ad.imageUrl)}" alt="" onerror="this.parentElement.style.display='none'">`;
    imgWrap.style.display = '';
  } else {
    imgWrap.innerHTML = '';
    imgWrap.style.display = 'none';
  }

  // Format badge + status + name
  document.getElementById('adModalTop').innerHTML = formatBadge(ad.format) + (ad.adStatus ? statusBadge(ad.adStatus) : '');
  document.getElementById('adModalName').textContent = ad.adName || '—';

  // Metrics
  const metrics = [
    ad.results != null ? { label: ad.resultType || 'Results', value: Math.round(ad.results).toLocaleString(), cls: '' } : null,
    { label: 'ROAS',        value: fmtNum(ad.roas),              cls: roasColor(ad.roas) },
    { label: 'Spend',       value: fmtNum(ad.spend, '$'),         cls: '' },
    { label: 'CTR',         value: fmtPct(ad.ctr),               cls: '' },
    { label: 'CPC',         value: fmtNum(ad.cpc, '$'),           cls: '' },
    { label: 'CPM',         value: fmtNum(ad.cpm, '$'),           cls: '' },
    { label: 'Clicks',      value: fmtInt(ad.clicks),             cls: '' },
    { label: 'Impressions', value: fmtInt(ad.impressions),        cls: '' },
    { label: 'Reach',       value: fmtInt(ad.reach),              cls: '' },
    { label: 'Frequency',   value: ad.frequency != null ? parseFloat(ad.frequency).toFixed(2) : '—', cls: '' },
  ].filter(Boolean);
  document.getElementById('adModalMetrics').innerHTML = metrics.map(m => `
    <div class="ad-modal-metric">
      <span class="adc-label">${m.label}</span>
      <span class="adc-value ${m.cls}">${m.value}</span>
    </div>`).join('');

  // Counter + nav state
  const total = modalAdList.length;
  document.getElementById('adModalCounter').textContent = total > 1 ? `${modalAdIndex + 1} / ${total}` : '';
  document.getElementById('adModalPrev').disabled = modalAdIndex === 0;
  document.getElementById('adModalNext').disabled = modalAdIndex === total - 1;

  // Scroll modal body back to top on navigation
  document.getElementById('adModal').scrollTop = 0;
}

function setupAdModal() {
  const overlay = document.getElementById('adModalOverlay');
  const close   = () => overlay.classList.add('hidden');

  document.getElementById('adModalClose').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  document.getElementById('adModalPrev').addEventListener('click', () => {
    if (modalAdIndex > 0) { modalAdIndex--; _renderModalAd(); }
  });
  document.getElementById('adModalNext').addEventListener('click', () => {
    if (modalAdIndex < modalAdList.length - 1) { modalAdIndex++; _renderModalAd(); }
  });

  document.addEventListener('keydown', e => {
    if (overlay.classList.contains('hidden')) return;
    if (e.key === 'Escape')      close();
    if (e.key === 'ArrowLeft'  && modalAdIndex > 0)                          { modalAdIndex--; _renderModalAd(); }
    if (e.key === 'ArrowRight' && modalAdIndex < modalAdList.length - 1)     { modalAdIndex++; _renderModalAd(); }
  });
}

// ── DARK MODE ──────────────────────────────────────────────────────────────
function setupDarkToggle() {
  const btn = document.getElementById('darkToggle');
  btn.textContent = darkMode ? '☀️' : '🌙';
  btn.addEventListener('click', () => {
    darkMode = !darkMode;
    document.documentElement.dataset.theme = darkMode ? 'dark' : '';
    btn.textContent = darkMode ? '☀️' : '🌙';
    localStorage.setItem('darkMode', darkMode ? '1' : '0');
    if (dataView === 'chart' && chartInstance) renderChartView();
    if (trendsChart) renderTrendsChart();
  });
}

// ── BRIEF VIEWS ─────────────────────────────────────────────────────────────
function setupBriefViewToggle() {
  document.querySelectorAll('[data-bview]').forEach(btn => {
    btn.addEventListener('click', () => {
      briefView = btn.dataset.bview;
      document.querySelectorAll('[data-bview]').forEach(b => b.classList.toggle('active', b.dataset.bview === briefView));
      document.querySelector('.brief-grid').classList.toggle('list-view', briefView === 'list');
    });
  });
}

// ── CARD SORT ──────────────────────────────────────────────────────────────
function setupCardSort() {
  updateCardSortUI();
  document.querySelectorAll('[data-csort]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (cardSortCol === btn.dataset.csort) {
        cardSortAsc = !cardSortAsc;
      } else {
        cardSortCol = btn.dataset.csort;
        cardSortAsc = false;
      }
      updateCardSortUI();
      renderCardView();
    });
  });
}

function updateCardSortUI() {
  document.querySelectorAll('[data-csort]').forEach(btn => {
    const isActive = btn.dataset.csort === cardSortCol;
    btn.classList.toggle('active', isActive);
    const label = btn.dataset.csort.toUpperCase();
    btn.textContent = isActive ? label + (cardSortAsc ? ' ↑' : ' ↓') : label;
  });
}

// ── HELPERS ────────────────────────────────────────────────────────────────
function setStatus(msg, isError) {
  const el = document.getElementById('uploadStatus');
  el.textContent = msg;
  el.className = 'upload-status' + (isError ? ' error' : '');
}

function setDot(state, text) {
  const dot = document.querySelector('.status-badge .dot');
  const label = document.getElementById('statusText');
  dot.className = `dot ${state}`;
  label.textContent = text;
}

function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id) { document.getElementById(id)?.classList.add('hidden'); }

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' · ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ── CONTEXT FILES ──────────────────────────────────────────────────────────────
function setupContextUpload() {
  const input = document.getElementById('ctxInput');
  const drop  = document.getElementById('ctxDrop');

  input.addEventListener('change', () => { if (input.files.length) uploadContextFiles(input.files); });

  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('dragover');
    if (e.dataTransfer.files.length) uploadContextFiles(e.dataTransfer.files);
  });
}

async function uploadContextFiles(files) {
  const arr = [...files];
  const statusEl = document.getElementById('ctxStatus');
  statusEl.textContent = `Uploading ${arr.length} file${arr.length > 1 ? 's' : ''}…`;
  statusEl.className = 'ctx-status';

  let ok = 0, failed = [];
  for (const file of arr) {
    const form = new FormData();
    form.append('file', file);
    form.append('client', CLIENT);
    try {
      const res = await fetch('/context', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) { failed.push(file.name); console.warn('[AdBrief] Context upload failed:', data.error); }
      else ok++;
    } catch {
      failed.push(file.name);
    }
  }

  if (failed.length) {
    statusEl.textContent = `${ok} uploaded${failed.length ? `, ${failed.length} failed` : ''}`;
    statusEl.className = 'ctx-status ctx-error';
  } else {
    statusEl.textContent = `${ok} file${ok > 1 ? 's' : ''} added`;
    statusEl.className = 'ctx-status ctx-ok';
  }
  document.getElementById('ctxInput').value = '';
  loadContextDocs();
}

async function loadContextDocs() {
  try {
    const res = await fetch('/context?client=' + CLIENT);
    const data = await res.json();
    renderContextList(data.docs || []);
  } catch { /* silent */ }
}

function renderContextList(docs) {
  const list = document.getElementById('ctxList');
  if (!docs.length) { list.innerHTML = '<div class="ctx-empty">No context files yet</div>'; return; }
  list.innerHTML = docs.map(d => `
    <div class="ctx-item">
      <div class="ctx-item-info">
        <span class="ctx-item-name" title="${esc(d.name)}">${esc(d.name)}</span>
        <span class="ctx-item-meta">${(d.chars / 1000).toFixed(1)}k chars · ${formatTime(d.updatedAt)}</span>
      </div>
      <button class="ctx-delete" data-name="${esc(d.name)}" title="Remove">✕</button>
    </div>
  `).join('');

  list.querySelectorAll('.ctx-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      if (!confirm(`Remove "${name}" from context?`)) return;
      await fetch(`/context/${encodeURIComponent(name)}?client=${CLIENT}`, { method: 'DELETE' });
      loadContextDocs();
    });
  });
}

// ── META API THUMBNAIL ENRICHMENT ──────────────────────────────────────────
function setupMetaEnrich() {
  const accountInput = document.getElementById('metaAccountId');
  const tokenInput   = document.getElementById('metaToken');
  const btn          = document.getElementById('metaEnrichBtn');
  const status       = document.getElementById('metaStatus');

  // Restore saved values (token stored as convenience — user can clear manually)
  const savedAccount = localStorage.getItem('metaAccountId');
  const savedToken   = localStorage.getItem('metaToken');
  if (savedAccount) accountInput.value = savedAccount;
  if (savedToken)   tokenInput.value   = savedToken;

  btn.addEventListener('click', async () => {
    const token     = tokenInput.value.trim();
    const accountId = accountInput.value.trim();
    if (!token)     { setMetaStatus('Enter your access token.', 'error'); return; }
    if (!accountId) { setMetaStatus('Enter your Ad Account ID.', 'error'); return; }

    // Persist for convenience
    localStorage.setItem('metaAccountId', accountId);
    localStorage.setItem('metaToken', token);

    btn.disabled = true;
    btn.textContent = 'Fetching…';
    setMetaStatus('', '');

    try {
      const r = await fetch('/meta/enrich?client=' + CLIENT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, accountId }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setMetaStatus(data.error || 'Something went wrong.', 'error');
      } else if (data.enriched === 0) {
        setMetaStatus(data.message || 'No ads matched. Upload your CSV first, then fetch.', 'warn');
      } else {
        setMetaStatus(`✓ Thumbnails added to ${data.enriched} of ${data.total} ads.`, 'ok');
        // Refresh data tab if it's open
        if (dataAds.length) loadDataTab();
      }
    } catch (e) {
      setMetaStatus('Network error — check your connection.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Fetch thumbnails';
    }
  });

  function setMetaStatus(msg, type) {
    status.textContent = msg;
    const cls = { ok: 'ctx-ok', error: 'ctx-error', warn: 'ctx-warn' };
    status.className = 'ctx-status' + (type && cls[type] ? ' ' + cls[type] : '');
  }
}
