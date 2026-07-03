const isViewOnly = new URLSearchParams(location.search).get('role') === 'summary';
const CLIENT = (new URLSearchParams(location.search).get('client') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
let currentWeekKey = null;
let weekAds = [];
let darkMode = localStorage.getItem('darkMode') === '1';
let briefView = 'grid';
let cardSortCol = 'roas';
let cardSortAsc = false;

function displayKey(key) {
  return key && key.includes('__') ? key.split('__').slice(1).join('__') : (key || '');
}

function hasUsableMetrics(ads) {
  return (ads || []).some(ad =>
    ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm', 'reach', 'frequency', 'results', 'roas']
      .some(key => ad[key] != null && !isNaN(parseFloat(ad[key])))
  );
}

function findAdByName(name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  let hit = weekAds.find(a => a.adName && a.adName.toLowerCase() === lower);
  if (hit) return hit;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(name);
  if (!target) return null;
  hit = weekAds.find(a => norm(a.adName) === target);
  if (hit) return hit;
  hit = weekAds.find(a => {
    const adNorm = norm(a.adName);
    if (!adNorm) return false;
    const shorter = adNorm.length <= target.length ? adNorm : target;
    const longer  = adNorm.length <= target.length ? target : adNorm;
    return shorter.length >= 10 && longer.includes(shorter);
  });
  return hit || null;
}

function setFileDropCopy(main, sub) {
  const mainEl = document.querySelector('.drop-main');
  const subEl = document.querySelector('.drop-sub');
  if (mainEl) mainEl.textContent = main;
  if (subEl) subEl.textContent = sub;
}

function metaImportDiagnostics(data) {
  if (!data) return '';
  const accountRows = Number(data.accountInsightRows || 0);
  const perAdRows = Number(data.perAdInsightRows || 0);
  const metricRows = Number(data.metricRows || 0);
  return ` Insights: ${accountRows + perAdRows} rows (${accountRows} account, ${perAdRows} per-ad), ${metricRows} with metrics.`;
}

// Show wake-up banner once per day
(function() {
  const banner = document.getElementById('wakeupBanner');
  const today = new Date().toDateString();
  if (localStorage.getItem('wakeupDismissed') === today) {
    banner.style.display = 'none';
  } else {
    const dismissWakeup = () => {
      banner.style.display = 'none';
      localStorage.setItem('wakeupDismissed', today);
    };
    document.getElementById('wakeupClose').onclick = dismissWakeup;
    setTimeout(dismissWakeup, 12000);
  }
})();

document.addEventListener('DOMContentLoaded', () => {
  if (isViewOnly) document.getElementById('sidebar').classList.add('hidden');

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
  setupClientSwitcher();
  setupSop();
  loadCurrentWeek();
  loadContextDocs();

  document.getElementById('staleWeekClose')?.addEventListener('click', () => hide('staleWeekBanner'));
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
      if (btn.dataset.panel === 'sop') loadSopTab();
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

  const replaceChecked = document.getElementById('replaceMode')?.checked;
  let totalAdded = 0, totalUpdated = 0, lastTotal = 0, skipped = 0;
  for (let i = 0; i < arr.length; i++) {
    setStatus(`Uploading ${i + 1} of ${arr.length}…`);
    setDot('working', `Uploading ${i + 1}/${arr.length}…`);
    const form = new FormData();
    form.append('file', arr[i]);
    form.append('client', CLIENT);
    // Only the first file in a batch may replace; later files must merge onto it.
    if (replaceChecked && i === 0) form.append('mode', 'replace');
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
      totalUpdated += data.updated || 0;
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
  const updatedNote = totalUpdated ? `, ${totalUpdated} updated` : '';
  const msg = `${totalAdded} added${updatedNote} — ${lastTotal} total${skipNote}`;
  setStatus(msg);
  setDot('ok', `${lastTotal} ads ready`);
  document.getElementById('generateBtn').disabled = false;
  document.getElementById('clearBtn').style.display = 'block';
  setFileDropCopy(`${arr.length - skipped} of ${arr.length} files loaded`, 'Spreadsheet import ready');
}

async function uploadFile(file) {
  setStatus('Uploading…');
  setDot('working', 'Uploading…');
  const form = new FormData();
  form.append('file', file);
  form.append('client', CLIENT);
  if (document.getElementById('replaceMode')?.checked) form.append('mode', 'replace');
  try {
    const res = await fetch('/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) { setStatus(data.error, true); setDot('error', 'Upload failed'); return; }
    currentWeekKey = data.weekKey;
    if (data.columns) {
      console.log('[AdBrief] Columns detected from file:', data.columns.fromFile);
      if (data.columns.unrecognized.length) console.warn('[AdBrief] Unrecognized columns (ignored):', data.columns.unrecognized);
    }
    const updatedNote = data.updated ? `, ${data.updated} updated` : '';
    const msg = data.total > data.added || data.updated
      ? `${data.added} added${updatedNote} — ${data.total} total`
      : `${data.added} ads loaded`;
    setStatus(msg);
    setDot('ok', `${data.total} ads ready`);
    document.getElementById('generateBtn').disabled = false;
    document.getElementById('clearBtn').style.display = 'block';
    setFileDropCopy(file.name, 'Spreadsheet import ready');
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
      const mode = document.getElementById('replaceMode')?.checked ? 'replace' : undefined;
      const res = await fetch('/sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, client: CLIENT, mode }),
      });
      const data = await res.json();
      if (!res.ok) { setStatus(data.error, true); setDot('error', 'Load failed'); return; }
      currentWeekKey = data.weekKey;
      const updatedNote = data.updated ? `, ${data.updated} updated` : '';
      const msg = data.total > data.added || data.updated
        ? `${data.added} added${updatedNote} — ${data.total} total`
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
      weekAds = [];
      setStatus('');
      setDot('idle', 'No data loaded');
      document.getElementById('generateBtn').disabled = true;
      document.getElementById('clearBtn').style.display = 'none';
      setFileDropCopy('Drop files or click to browse', 'Any spreadsheet or export file');
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
      const res = await fetch('/generate-brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: CLIENT, weekKey: currentWeekKey }) });
      const data = await res.json();
      hide('loading');
      if (!res.ok) { setStatus(data.error, true); setDot('error', 'Failed'); show('emptyState'); return; }
      currentWeekKey = data.weekKey;
      setDot('ok', 'Brief ready');
      renderBrief(data.brief, data.weekKey);
      try {
        const wres = await fetch('/week/current?client=' + CLIENT);
        const wdata = await wres.json();
        if (wres.ok && wdata.week) weekAds = wdata.week.ads || [];
      } catch { /* thumbnails just won't show until next load */ }
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
    if (!res.ok) throw new Error(data.error || 'Could not load brief');
    document.getElementById('briefLoadError').innerHTML = '';
    if (!data.week) return;
    currentWeekKey = data.weekKey;
    weekAds = data.week.ads || [];
    if (data.week.ads?.length) {
      const hasMetrics = hasUsableMetrics(data.week.ads);
      setStatus(`${data.week.ads.length} ads loaded`);
      setDot(hasMetrics ? 'ok' : 'idle', hasMetrics ? `${data.week.ads.length} ads ready` : `${data.week.ads.length} names loaded`);
      document.getElementById('generateBtn').disabled = !hasMetrics;
      document.getElementById('clearBtn').style.display = 'block';
    }
    if (data.isCurrentWeek === false) {
      document.getElementById('staleWeekLabel').textContent = displayKey(data.weekKey);
      show('staleWeekBanner');
    } else {
      hide('staleWeekBanner');
    }
    if (data.week.brief) renderBrief(data.week.brief, data.weekKey, data.week.comments);
  } catch {
    hide('loading');
    hide('emptyState');
    renderLoadError('briefLoadError', loadCurrentWeek);
  }
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
  const modalAds = [...weekAds];
  el.innerHTML = items.map(i => {
    const match = i.adName ? findAdByName(i.adName) : null;
    const thumb = match?.imageUrl
      ? `<img class="ad-item-thumb" src="${esc(match.imageUrl)}" alt="" onerror="this.style.display='none'">`
      : '';
    const clickable = match ? ' clickable' : '';
    return `<div class="ad-item ${color}${clickable}">${thumb}${tpl(i)}</div>`;
  }).join('');
  if (countEl) countEl.textContent = items.length;
  // Wire click handlers by re-walking items in lockstep with rendered cards
  const cards = el.querySelectorAll('.ad-item');
  items.forEach((i, idx) => {
    const match = i.adName ? findAdByName(i.adName) : null;
    if (!match) return;
    const modalIdx = modalAds.indexOf(match);
    if (modalIdx === -1) return;
    const card = cards[idx];
    card.addEventListener('click', () => openAdModal(modalAds, modalIdx));
  });
}

// ── HISTORY ────────────────────────────────────────────────────────────────
async function loadHistory() {
  const grid = document.getElementById('historyGrid');
  const empty = document.getElementById('historyEmpty');
  grid.innerHTML = '';
  document.getElementById('historyLoadError').innerHTML = '';
  try {
    const res = await fetch('/history?client=' + CLIENT);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load history');
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
  } catch {
    hide('historyEmpty');
    renderLoadError('historyLoadError', loadHistory);
  }
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
    weekAds = data.week.ads || [];
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
// SOP readout
let sopSettingsLoaded = false;

function setupSop() {
  const saveBtn = document.getElementById('sopSaveBtn');
  if (!saveBtn) return;
  applySopSettings({ spendTier: 'lite', brandRegister: 'mainstream', activeStages: ['TOF'] });
  if (isViewOnly) {
    saveBtn.style.display = 'none';
    document.querySelectorAll('#panel-sop input, #panel-sop select').forEach(el => { el.disabled = true; });
    return;
  }
  saveBtn.addEventListener('click', saveSopSettings);
}

async function ensureSopSettings() {
  if (sopSettingsLoaded) return;
  try {
    const res = await fetch('/sop/settings?client=' + CLIENT);
    const data = await res.json();
    applySopSettings(data.settings || {});
    sopSettingsLoaded = true;
  } catch { /* silent */ }
}

function applySopSettings(settings) {
  document.getElementById('sopSpendTier').value = settings.spendTier || 'lite';
  document.getElementById('sopBrandRegister').value = settings.brandRegister || 'mainstream';
  document.getElementById('sopTargetCpa').value = settings.targetCpa ?? '';
  document.getElementById('sopBaselineCtr').value = settings.baselineCtr ?? '';
  const stages = new Set(settings.activeStages || ['TOF']);
  document.querySelectorAll('.sop-stage').forEach(cb => { cb.checked = stages.has(cb.value); });
}

function collectSopSettings() {
  return {
    spendTier: document.getElementById('sopSpendTier').value,
    brandRegister: document.getElementById('sopBrandRegister').value,
    targetCpa: document.getElementById('sopTargetCpa').value || null,
    baselineCtr: document.getElementById('sopBaselineCtr').value || null,
    activeStages: [...document.querySelectorAll('.sop-stage:checked')].map(cb => cb.value),
  };
}

async function saveSopSettings() {
  const status = document.getElementById('sopSaveStatus');
  status.textContent = 'Saving...';
  try {
    const res = await fetch('/sop/settings?client=' + CLIENT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectSopSettings()),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save SOP settings');
    applySopSettings(data.settings);
    status.textContent = 'Creative rules saved.';
    status.className = 'ctx-status ctx-ok';
    await loadSopTab(true);
  } catch (err) {
    status.textContent = err.message || 'Could not save SOP settings.';
    status.className = 'ctx-status ctx-warn';
  }
}

async function loadSopTab(force) {
  await ensureSopSettings();
  const readoutEl = document.getElementById('sopReadout');
  if (!readoutEl || (!force && !document.getElementById('panel-sop')?.classList.contains('active'))) return;

  document.getElementById('sopLoadError').innerHTML = '';
  try {
    const qs = new URLSearchParams({ client: CLIENT });
    if (currentWeekKey) qs.set('weekKey', currentWeekKey);
    const res = await fetch('/sop/readout?' + qs.toString());
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load SOP readout');
    document.getElementById('sopWeekLabel').textContent = displayKey(data.weekKey);
    renderSopReadout(data.readout);
    if (data.readout.summary.adCount) {
      hide('sopEmpty');
      show('sopReadout');
    } else {
      show('sopEmpty');
      hide('sopReadout');
    }
  } catch {
    hide('sopEmpty');
    hide('sopReadout');
    renderLoadError('sopLoadError', () => loadSopTab());
  }
}

function renderSopReadout(readout) {
  const el = document.getElementById('sopReadout');
  const s = readout.summary;
  const tier = readout.tier;
  el.innerHTML = `
    <div class="sop-metrics">
      ${sopMetric('Target', `${readout.nextCreative.target} ads`)}
      ${sopMetric('Present', s.adCount)}
      ${sopMetric('Metrics', `${s.metricsCount}/${s.adCount}`)}
      ${sopMetric('Winners', s.winners)}
      ${sopMetric('Pause', s.pause)}
      ${sopMetric('Need data', s.needsMoreDelivery)}
    </div>
    <div class="sop-section">
      <h2>Definition of done</h2>
      <div class="sop-checks">
        ${readout.checks.map(check => `
          <div class="sop-check ${check.ok ? 'ok' : 'warn'}">
            <span>${check.ok ? 'OK' : '!'}</span>
            <div><strong>${esc(check.label)}</strong><p>${esc(check.detail)}</p></div>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="sop-columns">
      ${sopDecisionColumn('Winners / EVG candidates', readout.decisions.winners)}
      ${sopDecisionColumn('Pause candidates', readout.decisions.pause)}
      ${sopDecisionColumn('Needs more delivery', readout.decisions.needsMoreDelivery)}
    </div>
    <div class="sop-section">
      <h2>Next creative request</h2>
      <p class="sop-muted">${esc(tier.label)} target: ${tier.adsPerWeek} ads/week, roughly ${tier.fresh} fresh and ${tier.iterations} iterations.</p>
      <div class="sop-next-grid">
        ${readout.nextCreative.concepts.map(c => `
          <div class="sop-next-card">
            <div class="sop-pill">${esc(c.stage)}</div>
            <strong>${esc(c.angle)} / ${esc(c.format)}</strong>
            <p>${esc(c.count)} asset${c.count === 1 ? '' : 's'} - ${esc(c.note)}</p>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="sop-section">
      <h2>SOP gaps</h2>
      ${renderSopGaps(readout.gaps)}
    </div>
  `;
}

function sopMetric(label, value) {
  return `<div class="ds-stat"><span class="ds-label">${esc(label)}</span><span class="ds-val">${esc(value)}</span></div>`;
}

function sopDecisionColumn(title, ads) {
  return `
    <div class="sop-decision-col">
      <h3>${esc(title)}</h3>
      ${ads.length ? ads.map(ad => `
        <div class="sop-ad-row">
          <strong>${esc(ad.adName || 'Unnamed ad')}</strong>
          <p>${esc(ad.reason || '')}</p>
          <span>${ad.ctr != null ? `CTR ${fmtPct(ad.ctr)}` : ''}${ad.spend != null ? ` - Spend ${fmtNum(ad.spend, '$')}` : ''}${ad.results != null ? ` - Results ${fmtInt(ad.results)}` : ''}</span>
        </div>
      `).join('') : '<p class="empty-note">None yet.</p>'}
    </div>
  `;
}

function renderSopGaps(gaps) {
  const missing = gaps.missingFields || [];
  const formatIssues = gaps.formatIssues || [];
  const stageText = gaps.missingStages?.length ? `Missing stage coverage: ${gaps.missingStages.join(', ')}.` : '';
  if (!missing.length && !formatIssues.length && !stageText) return '<p class="empty-note">No obvious SOP gaps detected.</p>';
  return `
    <div class="sop-gap-list">
      ${stageText ? `<div class="sop-gap">${esc(stageText)}</div>` : ''}
      ${formatIssues.map(i => `<div class="sop-gap">${esc(i.level)}: ${esc(i.format)} on ${esc(i.adName || 'unnamed ad')}</div>`).join('')}
      ${missing.map(m => `<div class="sop-gap">${esc(m.adName || 'Unnamed ad')} missing ${esc(m.missing.join(', '))}</div>`).join('')}
    </div>
  `;
}

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
    if (!res.ok) throw new Error(data.error || 'Could not load data');
    document.getElementById('dataLoadError').innerHTML = '';

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
    document.getElementById('cardSortBar').classList.toggle('hidden', dataView !== 'cards' || !hasUsableMetrics(dataAds));
    if (!dataTabInitialized) {
      setupDataSort();
      setupViewToggle();
      setupCardSort();
      dataTabInitialized = true;
    }
    renderDataSummary();
    renderCurrentDataView();
  } catch {
    hide('dataEmpty');
    document.getElementById('dataTableWrap').classList.add('hidden');
    renderLoadError('dataLoadError', () => loadDataTab());
  }
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

  if (!hasUsableMetrics(dataAds)) {
    const firstAd = dataAds[0];
    el.innerHTML = [
      `<div class="ds-stat"><span class="ds-label">Ads</span><span class="ds-val">${dataAds.length}</span></div>`,
      `<div class="ds-stat ds-top"><span class="ds-label">Metrics</span><span class="ds-val ds-topname">Not returned by Meta</span></div>`,
      firstAd ? `<div class="ds-stat ds-top"><span class="ds-label">First Ad</span><span class="ds-val ds-topname" title="${esc(firstAd.adName)}">${esc(firstAd.adName.length > 32 ? firstAd.adName.slice(0, 32) + '...' : firstAd.adName)}</span></div>` : '',
      `<div class="ds-note">Meta gave AdBrief ad names and creatives, but no spend, clicks, impressions, or rate metrics for this range. Use an Ads Manager export if those historical stats are visible there.</div>`,
    ].join('');
    return;
  }

  const totalSpend = dataAds.reduce((s, a) => s + (a.spend || 0), 0);

  // Avg CTR: weighted by clicks/impressions where both non-null; fall back to unweighted mean of ctr.
  const ctrWeightedAds = dataAds.filter(a => a.clicks != null && a.impressions != null);
  const ctrImpressionsSum = ctrWeightedAds.reduce((s, a) => s + a.impressions, 0);
  let avgCtr = null;
  if (ctrWeightedAds.length && ctrImpressionsSum > 0) {
    avgCtr = (ctrWeightedAds.reduce((s, a) => s + a.clicks, 0) / ctrImpressionsSum) * 100;
  } else {
    const ctrAds = dataAds.filter(a => a.ctr != null);
    avgCtr = ctrAds.length ? ctrAds.reduce((s, a) => s + a.ctr, 0) / ctrAds.length : null;
  }

  // Avg CPM: weighted by spend/impressions where both non-null; fall back to unweighted mean of cpm.
  const cpmWeightedAds = dataAds.filter(a => a.spend != null && a.impressions != null);
  const cpmImpressionsSum = cpmWeightedAds.reduce((s, a) => s + a.impressions, 0);
  let avgCpm = null;
  if (cpmWeightedAds.length && cpmImpressionsSum > 0) {
    avgCpm = (cpmWeightedAds.reduce((s, a) => s + a.spend, 0) / cpmImpressionsSum) * 1000;
  } else {
    const cpmAds = dataAds.filter(a => a.cpm != null);
    avgCpm = cpmAds.length ? cpmAds.reduce((s, a) => s + a.cpm, 0) / cpmAds.length : null;
  }

  // Avg ROAS: spend-weighted where both non-null; fall back to unweighted mean.
  const roasWeightedAds = dataAds.filter(a => a.roas != null && a.spend != null);
  const roasSpendSum = roasWeightedAds.reduce((s, a) => s + a.spend, 0);
  let avgRoas = null;
  if (roasWeightedAds.length && roasSpendSum > 0) {
    avgRoas = roasWeightedAds.reduce((s, a) => s + a.roas * a.spend, 0) / roasSpendSum;
  } else {
    const roasAds = dataAds.filter(a => a.roas != null);
    avgRoas = roasAds.length ? roasAds.reduce((s, a) => s + a.roas, 0) / roasAds.length : null;
  }

  // Results: group by resultType, show the dominant type's total.
  const resultsAds = dataAds.filter(a => a.results != null);
  let totalResults = null;
  let resultLabel = 'Results';
  let resultTitle = '';
  let resultSuffix = '';
  if (resultsAds.length) {
    const byType = new Map();
    resultsAds.forEach(a => {
      const type = a.resultType || 'Results';
      byType.set(type, (byType.get(type) || 0) + a.results);
    });
    const sortedTypes = [...byType.entries()].sort((a, b) => b[1] - a[1]);
    resultLabel = sortedTypes[0][0];
    totalResults = sortedTypes[0][1];
    if (sortedTypes.length > 1) {
      resultSuffix = ` <span class="ds-suffix">+${sortedTypes.length - 1} types</span>`;
      resultTitle = sortedTypes.map(([t, v]) => `${t}: ${Math.round(v).toLocaleString()}`).join(', ');
    }
  }

  const topAd = [...dataAds].sort((a, b) => (b.spend || 0) - (a.spend || 0))[0];

  const stat = (label, val) => val != null
    ? `<div class="ds-stat"><span class="ds-label">${label}</span><span class="ds-val">${val}</span></div>`
    : '';

  el.innerHTML = [
    stat('Total Spend', '$' + totalSpend.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })),
    stat('Ads', dataAds.length),
    totalResults != null ? `<div class="ds-stat"${resultTitle ? ` title="${esc(resultTitle)}"` : ''}><span class="ds-label">${esc(resultLabel)}</span><span class="ds-val">${Math.round(totalResults).toLocaleString()}${resultSuffix}</span></div>` : '',
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
      document.getElementById('cardSortBar').classList.toggle('hidden', dataView !== 'cards' || !hasUsableMetrics(dataAds));
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
  const showMetrics = hasUsableMetrics(dataAds);
  const ads = [...dataAds].sort((a, b) => {
    const av = parseFloat(a[cardSortCol]) || 0;
    const bv = parseFloat(b[cardSortCol]) || 0;
    return cardSortAsc ? av - bv : bv - av;
  });
  document.getElementById('cardView').innerHTML = ads.map((ad, i) => `
    <div class="ad-data-card${showMetrics ? '' : ' names-only'}" data-adidx="${i}" style="cursor:pointer">
      ${ad.imageUrl ? `<div class="adc-thumb"><img src="${esc(ad.imageUrl)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>` : ''}
      <div class="adc-top">${formatBadge(ad.format)}${ad.adStatus ? statusBadge(ad.adStatus) : ''}</div>
      <div class="adc-name">${esc(ad.adName || '—')}</div>
      ${showMetrics ? `<div class="adc-metrics">
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
      </div>` : `<div class="adc-note">No performance stats returned</div>`}
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
        x: { grid: { color: dark ? 'rgba(255,255,255,0.06)' : 'rgba(60,60,67,0.06)' }, ticks: { font: { size: 11, family: 'Nunito Sans' }, color: dark ? 'rgba(247,255,249,0.60)' : undefined } },
        y: { grid: { display: false }, ticks: { font: { size: 11, family: 'Nunito Sans' }, color: dark ? 'rgba(247,255,249,0.60)' : '#3A3A3C' } }
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
  if (s === 'passed')
    return `<span class="status-badge-pill status-active">Approved</span>`;
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
  document.getElementById('trendsLoadError').innerHTML = '';
  try {
    const res = await fetch('/trends?client=' + CLIENT);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Could not load trends');
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
  } catch {
    hide('trendsEmpty');
    hide('trendsContent');
    renderLoadError('trendsLoadError', loadTrendsTab);
  }
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
  const colors = { roas: '#00FF7A', spend: '#00D968', ctr: '#FFB84D' };
  const color = colors[trendsMetric] || '#00FF7A';
  const gridColor = dark ? 'rgba(255,255,255,0.06)' : 'rgba(60,60,67,0.08)';
  const tickColor = dark ? 'rgba(247,255,249,0.60)' : '#636366';

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
        x: { grid: { color: gridColor }, ticks: { font: { size: 12, family: 'Nunito Sans' }, color: tickColor } },
        y: { grid: { color: gridColor }, ticks: { font: { size: 12, family: 'Nunito Sans' }, color: tickColor } },
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

function renderLoadError(containerId, retryFn) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div class="load-error">Couldn't load this. <button class="btn-outline">Retry</button></div>`;
  el.querySelector('.load-error button').addEventListener('click', () => retryFn());
}

function esc(str) {
  if (str == null) return '';
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
    if (!res.ok) throw new Error(data.error || 'Could not load context files');
    renderContextList(data.docs || []);
  } catch {
    renderLoadError('ctxList', loadContextDocs);
  }
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

// ── CLIENT SWITCHER ────────────────────────────────────────────────────────
async function setupClientSwitcher() {
  if (!CLIENT) return; // no switcher on the default workspace

  const switcher  = document.getElementById('clientSwitcher');
  const label     = document.getElementById('clientSwitchLabel');
  const btn       = document.getElementById('clientSwitchBtn');
  const dropdown  = document.getElementById('clientSwitchDropdown');

  switcher.classList.remove('hidden');

  // Set current client label — use pretty name from registry if available
  label.textContent = CLIENT;

  // Populate dropdown lazily on first open
  let loaded = false;

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const isOpen = !dropdown.classList.contains('hidden');
    dropdown.classList.toggle('hidden', isOpen);
    if (isOpen) return;

    if (!loaded) {
      dropdown.innerHTML = '<div class="csw-loading">Loading…</div>';
      try {
        const res  = await fetch('/clients');
        const data = await res.json();
        const clients = data.clients || [];

        // Use the registry name for current client label if found
        const current = clients.find(c => c.slug === CLIENT);
        if (current) label.textContent = current.name;

        const items = clients.map(c => {
          const active = c.slug === CLIENT ? ' csw-active' : '';
          return `<a class="csw-item${active}" href="/?client=${encodeURIComponent(c.slug)}">${esc(c.name)}</a>`;
        }).join('');

        dropdown.innerHTML = `
          <a class="csw-item csw-home" href="/">← All clients</a>
          <div class="csw-divider"></div>
          ${items || '<div class="csw-loading">No clients found</div>'}
        `;
        loaded = true;
      } catch {
        dropdown.innerHTML = '<div class="csw-loading">Could not load</div>';
      }
    }
  });

  // Close on outside click
  document.addEventListener('click', () => dropdown.classList.add('hidden'));
}

// ── META API THUMBNAIL ENRICHMENT ──────────────────────────────────────────
async function setupMetaEnrich() {
  const enrichBtn = document.getElementById('metaEnrichBtn');
  const importBtn = document.getElementById('metaImportBtn');
  const rangeSel  = document.getElementById('metaImportRange');
  const changeBtn = document.getElementById('metaChangeBtn');
  const status    = document.getElementById('metaStatus');
  const connected = document.getElementById('metaConnected');
  const fields    = document.getElementById('metaFields');
  const hintEl    = document.getElementById('metaAccountHint');
  const setupLink = document.getElementById('metaSetupLink');

  // Point setup link to the right client
  if (setupLink && CLIENT) setupLink.href = `/setup?client=${CLIENT}`;

  function setMetaStatus(msg, type) {
    status.textContent = msg;
    const cls = { ok: 'ctx-ok', error: 'ctx-error', warn: 'ctx-warn' };
    status.className = 'ctx-status' + (type && cls[type] ? ' ' + cls[type] : '');
  }

  function showConnected(hint) {
    if (hintEl) hintEl.textContent = hint ? `(${hint})` : '';
    connected.classList.remove('hidden');
    fields.classList.add('hidden');
    setMetaStatus('', '');
  }

  function showFields() {
    connected.classList.add('hidden');
    fields.classList.remove('hidden');
    setMetaStatus('', '');
  }

  async function doEnrich() {
    enrichBtn.disabled = true;
    enrichBtn.textContent = 'Fetching…';
    setMetaStatus('', '');
    try {
      const r = await fetch('/meta/enrich?client=' + CLIENT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setMetaStatus(data.error || 'Something went wrong.', 'error');
      } else if (data.enriched === 0) {
        setMetaStatus(data.message || 'No ads matched. Upload your CSV first.', 'warn');
      } else {
        setMetaStatus(`✓ Thumbnails added to ${data.enriched} of ${data.total} ads.`, 'ok');
        if (dataAds.length) loadDataTab();
      }
    } catch {
      setMetaStatus('Network error — check your connection.', 'error');
    } finally {
      enrichBtn.disabled = false;
      enrichBtn.textContent = 'Fetch thumbnails';
    }
  }

  async function doImport(force) {
    importBtn.disabled = true;
    enrichBtn.disabled = true;
    importBtn.textContent = 'Importing...';
    setMetaStatus('', '');
    try {
      const r = await fetch('/meta/import?client=' + CLIENT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datePreset: rangeSel?.value || 'last_30d', force: !!force }),
      });
      const data = await r.json();
      if (r.status === 409 && data.needsConfirm) {
        importBtn.disabled = false;
        enrichBtn.disabled = false;
        importBtn.textContent = 'Import ads + stats';
        if (confirm(data.message + ' Continue?')) {
          await doImport(true);
        }
        return;
      }
      if (!r.ok || !data.ok) {
        setMetaStatus(data.error || 'Meta import failed.', 'error');
      } else if (data.imported === 0) {
        setMetaStatus(data.message || 'No Meta ads found for that range.', 'warn');
      } else {
        const hasMetrics = data.hasMetrics !== false;
        const diagnosticText = metaImportDiagnostics(data);
        currentWeekKey = data.weekKey;
        if (hasMetrics) {
          setMetaStatus(`${data.imported} ads imported from Meta.${diagnosticText}`, 'ok');
          setStatus(`${data.imported} ads loaded from Meta`);
          setDot('ok', `${data.imported} ads ready`);
        } else {
          setMetaStatus((data.message || `${data.imported} ad names imported, but Meta returned no stats.`) + diagnosticText, 'warn');
          setStatus(`${data.imported} ad names loaded. No stats returned.`, true);
          setDot('idle', `${data.imported} names loaded`);
        }
        document.getElementById('generateBtn').disabled = !hasMetrics;
        document.getElementById('clearBtn').style.display = 'block';
        hide('briefOutput');
        hide('loading');
        show('emptyState');
        setFileDropCopy(
          hasMetrics ? 'Meta stats imported' : 'Meta names imported',
          hasMetrics ? 'Ready to generate a brief' : 'No spend or performance stats returned'
        );
        dataWeekSelectInitialized = false;
        await loadCurrentWeek();
        document.getElementById('generateBtn').disabled = !hasMetrics;
        if (document.getElementById('panel-data')?.classList.contains('active')) {
          await loadDataTab();
        }
      }
    } catch {
      setMetaStatus('Network error. Check your connection.', 'error');
    } finally {
      importBtn.disabled = false;
      enrichBtn.disabled = false;
      importBtn.textContent = 'Import ads + stats';
    }
  }

  if (importBtn) importBtn.addEventListener('click', () => doImport(false));
  enrichBtn.addEventListener('click', doEnrich);

  changeBtn.addEventListener('click', async () => {
    if (!confirm('Disconnect Meta Ads? You can reconnect anytime via the setup page.')) return;
    try { await fetch('/meta/credentials?client=' + CLIENT, { method: 'DELETE' }); } catch {}
    showFields();
  });

  // On load: check if already configured
  try {
    const cfg = await fetch('/meta/config?client=' + CLIENT).then(r => r.json());
    if (cfg.configured) showConnected(cfg.hint);
    else showFields();
  } catch {
    showFields();
  }
}
