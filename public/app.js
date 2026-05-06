const isViewOnly = new URLSearchParams(location.search).get('role') === 'summary';
let currentWeekKey = null;

// Show wake-up banner once per day
(function() {
  const banner = document.getElementById('wakeupBanner');
  const today = new Date().toDateString();
  if (localStorage.getItem('wakeupDismissed') === today) {
    banner.style.display = 'none';
  } else {
    banner.querySelector('.wakeup-close').onclick = () => {
      banner.style.display = 'none';
      localStorage.setItem('wakeupDismissed', today);
    };
  }
})();

document.addEventListener('DOMContentLoaded', () => {
  if (isViewOnly) document.getElementById('sidebar').classList.add('hidden');

  setupTabs();
  setupSegment();
  setupFileUpload();
  setupSheetsLoad();
  setupGenerateBtn();
  setupComments();
  loadCurrentWeek();
});

// ── TOP TABS ───────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel-view').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-' + btn.dataset.panel).classList.add('active');

      // Hide sidebar on how-to and data tabs
      const sidebar = document.getElementById('sidebar');
      if (btn.dataset.panel === 'howto' || btn.dataset.panel === 'data') {
        sidebar.classList.add('hidden');
      } else {
        if (!isViewOnly) sidebar.classList.remove('hidden');
      }

      if (btn.dataset.panel === 'history') loadHistory();
      if (btn.dataset.panel === 'data') loadDataTab();
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

  input.addEventListener('change', () => { if (input.files[0]) uploadFile(input.files[0]); });

  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
  });
}

async function uploadFile(file) {
  setStatus('Uploading…');
  setDot('working', 'Uploading…');
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await fetch('/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) { setStatus(data.error, true); setDot('error', 'Upload failed'); return; }
    currentWeekKey = data.weekKey;
    setStatus(`${data.count} ads loaded`);
    setDot('ok', `${data.count} ads ready`);
    document.getElementById('generateBtn').disabled = false;
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
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) { setStatus(data.error, true); setDot('error', 'Load failed'); return; }
      currentWeekKey = data.weekKey;
      setStatus(`${data.count} ads loaded`);
      setDot('ok', `${data.count} ads ready`);
      document.getElementById('generateBtn').disabled = false;
    } catch {
      setStatus('Could not load sheet.', true);
      setDot('error', 'Load failed');
    }
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
      const res = await fetch('/generate-brief', { method: 'POST' });
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
    const res = await fetch('/week/current');
    const data = await res.json();
    if (!data.week) return;
    currentWeekKey = data.weekKey;
    if (data.week.ads?.length) {
      setStatus(`${data.week.ads.length} ads loaded`);
      setDot('ok', `${data.week.ads.length} ads ready`);
      document.getElementById('generateBtn').disabled = false;
    }
    if (data.week.brief) renderBrief(data.week.brief, data.weekKey, data.week.comments);
  } catch { /* silent */ }
}

// ── RENDER BRIEF ───────────────────────────────────────────────────────────
function renderBrief(brief, weekKey, existingComments) {
  currentWeekKey = weekKey;
  document.getElementById('briefTitle').textContent = `Creative Brief — ${weekKey}`;
  document.getElementById('briefMeta').textContent = 'Generated from your Meta Ads export';
  document.getElementById('briefSummary').textContent = brief.summary || '';

  renderAdList('topPerformers', brief.topPerformers, 'green', a => `
    <div class="ad-name">${esc(a.adName)}</div>
    <div class="ad-why">${esc(a.why)}</div>
    <span class="ad-action">${esc(a.action)}</span>
  `);
  renderAdList('makeNext', brief.makeNext, 'blue', a => `
    <div class="ad-name">${esc(a.concept)}</div>
    <div class="ad-why">${esc(a.rationale)}</div>
  `);
  renderAdList('fatigueAlerts', brief.fatigueAlerts, 'orange', a => `
    <div class="ad-name">${esc(a.adName)}</div>
    <div class="ad-why">${esc(a.why)}</div>
    <span class="ad-action">${esc(a.action)}</span>
  `);
  renderAdList('underperformers', brief.underperformers, 'orange', a => `
    <div class="ad-name">${esc(a.adName)}</div>
    <div class="ad-why">${esc(a.why)}</div>
    <span class="ad-action">${esc(a.action)}</span>
  `);
  renderAdList('retireNow', brief.retireNow, 'red', a => `
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
    const res = await fetch('/history');
    const data = await res.json();
    if (!data.weeks.length) { show('historyEmpty'); return; }
    hide('historyEmpty');
    grid.innerHTML = data.weeks.map(w => `
      <div class="history-card" data-week="${w}">
        <div>
          <div class="history-week">${w}</div>
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

function renderComments(comments) {
  const el = document.getElementById('commentsList');
  if (!comments?.length) { el.innerHTML = '<p class="empty-note" style="margin-bottom:12px">No comments yet.</p>'; return; }
  el.innerHTML = comments.map(c => `
    <div class="comment-item">
      <div class="comment-meta">
        <span class="comment-author">${esc(c.author)}</span>
        <span class="comment-time">${formatTime(c.createdAt)}</span>
      </div>
      <div class="comment-text">${esc(c.text)}</div>
    </div>
  `).join('');
}

// ── DATA TAB ───────────────────────────────────────────────────────────────
let dataAds = [];
let dataSortCol = null;
let dataSortAsc = true;

async function loadDataTab() {
  try {
    const res = await fetch('/week/current');
    const data = await res.json();
    if (!data.week?.ads?.length) {
      show('dataEmpty');
      document.getElementById('dataTableWrap').classList.add('hidden');
      document.getElementById('dataWeekLabel').textContent = '';
      return;
    }
    dataAds = data.week.ads;
    document.getElementById('dataWeekLabel').textContent = data.weekKey + ' · ' + dataAds.length + ' ads';
    hide('dataEmpty');
    renderDataTable();
    document.getElementById('dataTableWrap').classList.remove('hidden');
    setupDataSort();
  } catch { /* silent */ }
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

  document.getElementById('dataTableBody').innerHTML = rows.map(ad => `
    <tr>
      <td class="ad-name-cell">${esc(ad.adName || '—')}</td>
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
