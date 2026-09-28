/* Task Manager — app.js
   Vanilla JS, localStorage persistence, drag & drop, import/export. */

const STORAGE_KEY = 'taskManagerBoard.v1';
const THEME_KEY = 'taskManagerTheme';

let board = null;
const filters = { search: '', tag: null };
const COMPLETED_VIS_KEY = 'taskManagerCompletedVisibility';
const BACKGROUND_KEY = 'taskManagerBackground';
const SORT_KEY = 'taskManagerColumnSorts';
const shownCompleted = new Set();
const expandedCards = new Set();
const columnSorts = {};
let dragState = { taskId: null, sourceColumnId: null, targetColumnId: null, index: null };
let columnDragId = null;
let columnDropTarget = null;
let confirmCallback = null;
let pendingImport = null;
let toastTimer = null;
const paletteRenders = {};
let draftProgress = [];
let draftLinks = [];
let allTags = [];
let currentBackground = 'none';

/* ---------- Utilities ---------- */

function generateId(prefix) {
  return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlight(text, query) {
  const esc = escapeHtml(text);
  if (!query) return esc;
  const q = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return esc.replace(new RegExp('(' + q + ')', 'ig'), '<mark>$1</mark>');
}

const TAG_COLORS = ['#5e72e4', '#11cdef', '#2dce89', '#fb6340', '#f5365c', '#b28aff', '#00bcd4', '#ffa000'];

function tagColor(tag) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_COLORS[hash % TAG_COLORS.length];
}

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return 'rgba(128,128,128,' + alpha + ')';
  return 'rgba(' + parseInt(m[1], 16) + ', ' + parseInt(m[2], 16) + ', ' + parseInt(m[3], 16) + ', ' + alpha + ')';
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function todayISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function isoDateShift(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function isExternalLink(url) {
  return /^https?:\/\//i.test(url) || /^www\./i.test(url);
}

function webHref(url) {
  return /^www\./i.test(url) ? 'https://' + url : url;
}

function collectAllTags() {
  const set = new Set();
  board.columns.forEach(c => c.tasks.forEach(t => t.tags.forEach(tag => set.add(tag))));
  return Array.from(set);
}

function isOverdue(task) {
  if (!task.dueDate || task.completed) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(task.dueDate + 'T00:00:00') < today;
}

/* ---------- Color palette ---------- */

const PALETTE_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#a855f7', '#ec4899'];

function buildPalette(containerId, inputId) {
  const container = document.getElementById(containerId);
  const input = document.getElementById(inputId);
  if (!container || !input) return;

  function renderSelection() {
    container.querySelectorAll('.swatch').forEach(s => s.classList.remove('selected'));
    const current = input.value;
    if (!current) {
      const none = container.querySelector('.swatch[data-color=""]');
      if (none) none.classList.add('selected');
    } else {
      const sw = container.querySelector('.swatch[data-color="' + current + '"]');
      if (sw) sw.classList.add('selected');
    }
  }

  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'swatch swatch-none';
  none.dataset.color = '';
  none.title = 'No color';
  none.innerHTML = '<span class="none-slash"></span>';
  none.addEventListener('click', () => { input.value = ''; renderSelection(); });
  container.appendChild(none);

  PALETTE_COLORS.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.color = c;
    b.style.backgroundColor = c;
    b.title = c;
    b.addEventListener('click', () => { input.value = c; renderSelection(); });
    container.appendChild(b);
  });

  paletteRenders[inputId] = renderSelection;
}

function refreshPalette(inputId) {
  if (paletteRenders[inputId]) paletteRenders[inputId]();
}

/* ---------- Persistence & normalization ---------- */

function defaultBoard() {
  return {
    columns: [
      { id: generateId('col'), title: 'To Do', color: '', tasks: [] },
      { id: generateId('col'), title: 'In Progress', color: '', tasks: [] },
      { id: generateId('col'), title: 'Done', color: '', tasks: [] }
    ],
    recycleBin: { cards: [], columns: [] }
  };
}

function normalizeProgressItem(p) {
  return {
    id: (p && p.id) || generateId('prog'),
    text: String((p && p.text) || ''),
    date: (p && p.date) || ''
  };
}

function normalizeLink(l) {
  return {
    id: (l && l.id) || generateId('link'),
    label: String((l && l.label) || ''),
    url: String((l && l.url) || '')
  };
}

function normalizeTask(t) {
  return {
    id: t.id || generateId('task'),
    title: String(t.title || 'Untitled'),
    description: String(t.description || ''),
    tags: Array.isArray(t.tags) ? t.tags.map(x => String(x)).filter(Boolean) : [],
    completed: !!t.completed,
    createdAt: t.createdAt || new Date().toISOString(),
    updatedAt: t.updatedAt || new Date().toISOString(),
    completedAt: typeof t.completedAt === 'string' ? t.completedAt : '',
    dueDate: t.dueDate || '',
    priority: ['low', 'medium', 'high'].includes(t.priority) ? t.priority : '',
    color: typeof t.color === 'string' ? t.color : '',
    progress: Array.isArray(t.progress) ? t.progress.map(normalizeProgressItem) : [],
    links: Array.isArray(t.links) ? t.links.map(normalizeLink) : []
  };
}

function normalizeColumn(col, i) {
  return {
    id: col.id || generateId('col'),
    title: String(col.title || 'Column ' + (i + 1)),
    color: typeof col.color === 'string' ? col.color : '',
    tasks: Array.isArray(col.tasks) ? col.tasks.map(normalizeTask) : []
  };
}

function normalizeRecycleBin(bin) {
  bin = bin || {};
  const cards = Array.isArray(bin.cards) ? bin.cards.map(item => ({
    task: normalizeTask(item && item.task ? item.task : {}),
    columnId: item && typeof item.columnId === 'string' ? item.columnId : ''
  })) : [];
  const columns = Array.isArray(bin.columns) ? bin.columns.map(item => {
    const col = item && item.column ? item.column : {};
    return {
      column: normalizeColumn(col, 0),
      index: item && Number.isFinite(item.index) ? item.index : 0
    };
  }) : [];
  return { cards, columns };
}

function normalizeBoard(data) {
  const columns = data && Array.isArray(data.columns) ? data.columns : [];
  return {
    columns: columns.map(normalizeColumn),
    recycleBin: normalizeRecycleBin(data && data.recycleBin)
  };
}

function loadBoard() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.columns)) return normalizeBoard(data);
    }
  } catch (e) { /* ignore */ }
  return defaultBoard();
}

function saveBoard() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(board));
  } catch (e) {
    showToast('Could not save to localStorage (storage may be full).');
  }
}

function loadCompletedVisibility() {
  shownCompleted.clear();
  try {
    const raw = localStorage.getItem(COMPLETED_VIS_KEY);
    if (raw) {
      JSON.parse(raw).forEach(id => shownCompleted.add(id));
    }
  } catch (e) { /* ignore */ }
}

function saveCompletedVisibility() {
  try {
    localStorage.setItem(COMPLETED_VIS_KEY, JSON.stringify(Array.from(shownCompleted)));
  } catch (e) { /* ignore */ }
}

function loadColumnSorts() {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (raw) Object.assign(columnSorts, JSON.parse(raw));
  } catch (e) { /* ignore */ }
}

function saveColumnSorts() {
  try { localStorage.setItem(SORT_KEY, JSON.stringify(columnSorts)); } catch (e) { /* ignore */ }
}

function openSortMenu(columnId, btnEl) {
  const menu = document.getElementById('sortMenu');
  const sortKey = columnSorts[columnId] || 'manual';
  const options = [
    { value: 'manual', label: 'Manual' },
    { value: 'created-desc', label: 'Created (newest first)' },
    { value: 'created-asc', label: 'Created (oldest first)' },
    { value: 'updated-desc', label: 'Updated (newest first)' },
    { value: 'updated-asc', label: 'Updated (oldest first)' }
  ];
  menu.innerHTML = '';
  options.forEach(o => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sort-option' + (sortKey === o.value ? ' selected' : '');
    b.textContent = o.label + (sortKey === o.value ? '  ✓' : '');
    b.addEventListener('click', () => {
      columnSorts[columnId] = o.value;
      saveColumnSorts();
      renderBoard();
      closeSortMenu();
    });
    menu.appendChild(b);
  });
  const rect = btnEl.getBoundingClientRect();
  const width = 200;
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = Math.max(4, Math.min(rect.right - width, window.innerWidth - width - 4)) + 'px';
  menu.hidden = false;
}

function closeSortMenu() {
  const menu = document.getElementById('sortMenu');
  menu.hidden = true;
  menu.innerHTML = '';
}

/* ---------- Filtering ---------- */

function matchesTask(task) {
  if (filters.tag && !task.tags.some(t => t.toLowerCase() === filters.tag.toLowerCase())) return false;
  if (filters.search) {
    const q = filters.search.toLowerCase();
    const hay = (task.title + '\n' + task.description + '\n' + task.tags.join(' ') +
      '\n' + (task.progress || []).map(p => p.text).join(' ') +
      '\n' + (task.links || []).map(l => l.label + ' ' + l.url).join(' ')).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/* ---------- Rendering ---------- */

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  if (board.columns.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-board';
    empty.innerHTML = '<p>No columns yet.</p><button class="btn" data-action="add-column">＋ Add a column</button>';
    boardEl.appendChild(empty);
    updateFilterBar();
    return;
  }
  board.columns.forEach(col => boardEl.appendChild(renderColumn(col)));
  updateFilterBar();
}

function renderColumn(col) {
  const sec = document.createElement('section');
  sec.className = 'column';
  sec.dataset.columnId = col.id;

  const accent = col.color || '';
  if (accent) sec.style.setProperty('--col-accent', accent);

  const showing = shownCompleted.has(col.id);
  const visible = col.tasks.filter(t => matchesTask(t) && (!t.completed || showing));
  const sortKey = columnSorts[col.id] || 'manual';
  if (sortKey === 'created-asc') visible.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  else if (sortKey === 'created-desc') visible.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  else if (sortKey === 'updated-asc') visible.sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''));
  else if (sortKey === 'updated-desc') visible.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const headerTint = accent ? hexToRgba(accent, 0.14) : '';

  sec.innerHTML =
    '<header class="column-header" draggable="true"' + (headerTint ? ' style="background-color:' + headerTint + ';"' : '') + '>' +
      '<h2 class="column-title">' + escapeHtml(col.title) +
        ' <span class="column-count">' + visible.length + '</span></h2>' +
      '<div class="column-actions">' +
        '<button class="icon-btn sort-btn' + (sortKey !== 'manual' ? ' active' : '') + '" data-action="open-sort-menu" data-column-id="' + col.id + '" title="Sort tasks" aria-label="Sort tasks">⇅</button>' +
        '<button class="icon-btn' + (showing ? ' active' : '') + '" data-action="toggle-completed-visibility" data-column-id="' + col.id + '" title="' + (showing ? 'Hide completed cards' : 'Show completed cards') + '" aria-label="Toggle completed cards visibility">☑</button>' +
        '<button class="icon-btn" data-action="edit-column" data-column-id="' + col.id + '" title="Rename column" aria-label="Rename column">✎</button>' +
        '<button class="icon-btn" data-action="delete-column" data-column-id="' + col.id + '" title="Delete column" aria-label="Delete column">🗑</button>' +
      '</div>' +
    '</header>' +
    '<div class="task-list" data-column-id="' + col.id + '">' +
      visible.map(task => renderCardHTML(col, task)).join('') +
    '</div>' +
    '<button class="add-card-btn" data-action="add-card" data-column-id="' + col.id + '">＋ Add a card</button>';

  return sec;
}

function renderCardHTML(col, task) {
  const accent = task.color || '';
  const completedClass = task.completed ? ' completed' : '';
  const checkedClass = task.completed ? 'checked' : '';
  const priorityLabel = task.priority ? task.priority[0].toUpperCase() + task.priority.slice(1) : '';
  const overdue = isOverdue(task);
  const isExpanded = expandedCards.has(task.id);

  const tagsHTML = task.tags.map(tag => {
    const color = tagColor(tag);
    return '<button class="tag-chip" data-action="filter-tag" data-tag="' + escapeHtml(tag) + '"' +
      ' style="color:' + color + ';border-color:' + color + ';background-color:' + hexToRgba(color, 0.14) + '">' +
      escapeHtml(tag) + '</button>';
  }).join('');

  const progressHTML = (task.progress && task.progress.length)
    ? '<div class="card-progress">' + task.progress.slice().reverse().map(p =>
        '<div class="progress-entry"><span class="progress-date">📅 ' + formatDate(p.date) + '</span><span class="progress-text">' + escapeHtml(p.text) + '</span></div>'
      ).join('') + '</div>'
    : '';

  const linksHTML = (task.links && task.links.length)
    ? '<div class="card-links">' + task.links.map(l => {
        if (isExternalLink(l.url)) {
          return '<a class="card-link" href="' + escapeHtml(webHref(l.url)) + '" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(l.url) + '">🌐 ' + escapeHtml(l.label || l.url) + '</a>';
        }
        return '<button type="button" class="card-link card-link-copy" data-action="copy-link" data-url="' + escapeHtml(l.url) + '" title="Click to copy: ' + escapeHtml(l.url) + '">📋 ' + escapeHtml(l.label || l.url) + '</button>';
      }).join('') + '</div>'
    : '';

  const moveOptions = board.columns.map(c =>
    '<option value="' + c.id + '"' + (c.id === col.id ? ' selected' : '') + '>' + escapeHtml(c.title) + '</option>'
  ).join('');

  return (
    '<article class="card' + completedClass + '" draggable="true" data-task-id="' + task.id + '"' +
      (accent ? ' style="--accent:' + accent + ';"' : '') + '>' +
      '<div class="card-top">' +
        '<button class="check-toggle ' + checkedClass + '" data-action="toggle-complete" data-task-id="' + task.id + '"' +
          ' role="checkbox" aria-checked="' + task.completed + '" title="Mark ' + (task.completed ? 'incomplete' : 'complete') + '"></button>' +
        '<h3 class="card-title">' + highlight(task.title, filters.search) + '</h3>' +
        '<button class="icon-btn expand-toggle' + (isExpanded ? ' active' : '') + '" data-action="toggle-collapse" data-task-id="' + task.id + '" title="' + (isExpanded ? 'Collapse' : 'Expand') + '" aria-label="Toggle card">' + (isExpanded ? '▴' : '▾') + '</button>' +
      '</div>' +
      (isExpanded
        ? (task.description ? '<p class="card-desc">' + highlight(task.description, filters.search) + '</p>' : '') +
          progressHTML +
          linksHTML +
          (tagsHTML ? '<div class="card-tags">' + tagsHTML + '</div>' : '') +
          '<div class="card-meta">' +
            (priorityLabel ? '<span class="priority priority-' + task.priority + '">' + priorityLabel + '</span>' : '') +
            (task.dueDate
              ? '<span class="due-date' + (overdue ? ' overdue' : '') + '">📅 ' + formatDate(task.dueDate) + (overdue ? ' · overdue' : '') + '</span>'
              : '') +
          '</div>' +
          '<div class="card-actions">' +
            '<label class="move-wrap" title="Move to…">' +
              '<select class="move-select" data-task-id="' + task.id + '" aria-label="Move card to column">' + moveOptions + '</select>' +
            '</label>' +
            '<button class="icon-btn" data-action="edit-card" data-task-id="' + task.id + '" title="Edit card" aria-label="Edit card">✎</button>' +
            '<button class="icon-btn" data-action="delete-card" data-task-id="' + task.id + '" title="Delete card" aria-label="Delete card">🗑</button>' +
          '</div>'
        : '') +
    '</article>'
  );
}

function updateFilterBar() {
  const bar = document.getElementById('activeFilterBar');
  const tagEl = document.getElementById('activeFilterTag');
  if (filters.tag) {
    bar.hidden = false;
    tagEl.textContent = '#' + filters.tag;
  } else {
    bar.hidden = true;
  }
}

/* ---------- Modals ---------- */

function openModal(id) {
  document.getElementById(id).hidden = false;
}

function closeModal(id) {
  document.getElementById(id).hidden = true;
}

function openCardModal(columnId, task) {
  const isEdit = !!task;
  draftProgress = isEdit ? task.progress.map(p => Object.assign({}, p)) : [];
  draftLinks = isEdit ? task.links.map(l => Object.assign({}, l)) : [];
  allTags = collectAllTags();

  document.getElementById('cardModalTitle').textContent = isEdit ? 'Edit Task' : 'New Task';
  document.getElementById('cardId').value = isEdit ? task.id : '';
  document.getElementById('cardColumnId').value = columnId;
  document.getElementById('cardTitle').value = isEdit ? task.title : '';
  document.getElementById('cardDescription').value = isEdit ? task.description : '';
  document.getElementById('cardTags').value = isEdit ? task.tags.join(', ') : '';
  document.getElementById('cardDueDate').value = isEdit ? (task.dueDate || '') : '';
  document.getElementById('cardPriority').value = isEdit ? (task.priority || '') : '';
  document.getElementById('cardColor').value = isEdit ? (task.color || '') : '';
  document.getElementById('progressText').value = '';
  document.getElementById('progressDate').value = todayISO();
  document.getElementById('linkLabel').value = '';
  document.getElementById('linkUrl').value = '';
  refreshPalette('cardColor');
  renderProgressList();
  renderLinksList();
  hideTagSuggestions();
  openModal('cardModal');
  setTimeout(() => document.getElementById('cardTitle').focus(), 0);
}

function openColumnModal(columnId) {
  const col = board.columns.find(c => c.id === columnId);
  document.getElementById('columnModalTitle').textContent = col ? 'Rename Column' : 'New Column';
  document.getElementById('columnId').value = col ? col.id : '';
  document.getElementById('columnTitle').value = col ? col.title : '';
  document.getElementById('columnColor').value = col ? (col.color || '') : '';
  refreshPalette('columnColor');
  openModal('columnModal');
  setTimeout(() => document.getElementById('columnTitle').focus(), 0);
}

function confirmDialog(message, okLabel, callback) {
  document.getElementById('confirmTitle').textContent = 'Are you sure?';
  document.getElementById('confirmMessage').textContent = message;
  document.getElementById('confirmOk').textContent = okLabel || 'Delete';
  confirmCallback = callback;
  openModal('confirmModal');
}

function showToast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => showToast('Link copied to clipboard'))
      .catch(() => {
        if (fallbackCopy(text)) showToast('Link copied to clipboard');
        else showToast('Could not copy link');
      });
  } else {
    if (fallbackCopy(text)) showToast('Link copied to clipboard');
    else showToast('Could not copy link');
  }
}

/* ---------- Card draft (progress, links) & tag suggestions ---------- */

function renderProgressList() {
  const ul = document.getElementById('progressList');
  ul.innerHTML = '';
  if (draftProgress.length === 0) {
    ul.innerHTML = '<li class="draft-empty">No progress entries yet.</li>';
    return;
  }
  draftProgress.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'draft-item';
    li.innerHTML =
      '<input type="date" class="draft-date" data-index="' + i + '" value="' + escapeHtml(p.date) + '">' +
      '<textarea class="draft-text" data-index="' + i + '" rows="2" placeholder="Progress note">' + escapeHtml(p.text) + '</textarea>' +
      '<button type="button" class="icon-btn" data-action="remove-progress" data-index="' + i + '" title="Remove" aria-label="Remove">🗑</button>';
    ul.appendChild(li);
  });
}

function renderLinksList() {
  const ul = document.getElementById('linkList');
  ul.innerHTML = '';
  if (draftLinks.length === 0) {
    ul.innerHTML = '<li class="draft-empty">No links yet.</li>';
    return;
  }
  draftLinks.forEach((l, i) => {
    const li = document.createElement('li');
    li.className = 'draft-item';
    li.innerHTML =
      '<input type="text" class="draft-link-label" data-index="' + i + '" value="' + escapeHtml(l.label) + '" placeholder="Label">' +
      '<input type="text" class="draft-link-url" data-index="' + i + '" value="' + escapeHtml(l.url) + '" placeholder="URL / path">' +
      '<button type="button" class="icon-btn" data-action="remove-link" data-index="' + i + '" title="Remove" aria-label="Remove">🗑</button>';
    ul.appendChild(li);
  });
}

function addProgressItem() {
  const text = document.getElementById('progressText').value.trim();
  if (!text) return;
  draftProgress.push({
    id: generateId('prog'),
    text,
    date: document.getElementById('progressDate').value || todayISO()
  });
  document.getElementById('progressText').value = '';
  document.getElementById('progressDate').value = todayISO();
  renderProgressList();
}

function addLinkItem() {
  const label = document.getElementById('linkLabel').value.trim();
  const url = document.getElementById('linkUrl').value.trim();
  if (!url) return;
  draftLinks.push({ id: generateId('link'), label, url });
  document.getElementById('linkLabel').value = '';
  document.getElementById('linkUrl').value = '';
  renderLinksList();
}

function onProgressInput(e) {
  const idx = e.target.dataset.index;
  if (idx === undefined) return;
  const i = parseInt(idx, 10);
  if (!draftProgress[i]) return;
  if (e.target.classList.contains('draft-date')) draftProgress[i].date = e.target.value;
  else if (e.target.classList.contains('draft-text')) draftProgress[i].text = e.target.value;
}

function onProgressClick(e) {
  const btn = e.target.closest('[data-action="remove-progress"]');
  if (!btn) return;
  draftProgress.splice(parseInt(btn.dataset.index, 10), 1);
  renderProgressList();
}

function onLinkInput(e) {
  const idx = e.target.dataset.index;
  if (idx === undefined) return;
  const i = parseInt(idx, 10);
  if (!draftLinks[i]) return;
  if (e.target.classList.contains('draft-link-label')) draftLinks[i].label = e.target.value;
  else if (e.target.classList.contains('draft-link-url')) draftLinks[i].url = e.target.value;
}

function onLinkClick(e) {
  const btn = e.target.closest('[data-action="remove-link"]');
  if (!btn) return;
  draftLinks.splice(parseInt(btn.dataset.index, 10), 1);
  renderLinksList();
}

function showTagSuggestions() {
  const input = document.getElementById('cardTags');
  const box = document.getElementById('tagSuggestions');
  const value = input.value;
  const caret = input.selectionStart != null ? input.selectionStart : value.length;
  const before = value.slice(0, caret);
  const after = value.slice(caret);
  const lastComma = before.lastIndexOf(',');
  const token = before.slice(lastComma + 1).trim();
  const prefix = before.slice(0, lastComma + 1);

  if (!token) { hideTagSuggestions(); return; }

  const existing = value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const matches = allTags.filter(t =>
    t.toLowerCase().startsWith(token.toLowerCase()) && !existing.includes(t.toLowerCase())
  );

  if (matches.length === 0) { hideTagSuggestions(); return; }

  box.innerHTML = '';
  matches.slice(0, 8).forEach(tag => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag-suggestion';
    btn.textContent = '#' + tag;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      input.value = prefix + tag + after;
      hideTagSuggestions();
      input.focus();
    });
    box.appendChild(btn);
  });
  box.hidden = false;
}

function hideTagSuggestions() {
  const box = document.getElementById('tagSuggestions');
  box.hidden = true;
  box.innerHTML = '';
}

/* ---------- Background ---------- */

const PRESET_BACKGROUNDS = {
  sunset: 'linear-gradient(135deg, #ff9a9e 0%, #fecfef 50%, #a18cd1 100%)',
  ocean: 'linear-gradient(135deg, #89f7fe 0%, #66a6ff 100%)',
  forest: 'linear-gradient(135deg, #134e5e 0%, #71b280 100%)',
  night: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
  aurora: 'linear-gradient(135deg, #8e2de2 0%, #4a00e0 50%, #00c6ff 100%)',
  blush: 'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)'
};

function loadBackground() {
  try { return localStorage.getItem(BACKGROUND_KEY) || 'none'; }
  catch (e) { return 'none'; }
}

function saveBackground(bg) {
  try { localStorage.setItem(BACKGROUND_KEY, bg); }
  catch (e) { showToast('Background could not be saved (image may be too large).'); }
}

function applyBackground(bg) {
  const body = document.body;
  body.style.backgroundImage = '';
  body.style.backgroundSize = '';
  body.style.backgroundPosition = '';
  body.style.backgroundRepeat = '';
  if (!bg || bg === 'none') return;
  if (bg.indexOf('preset:') === 0) {
    const gradient = PRESET_BACKGROUNDS[bg.slice(7)];
    if (gradient) body.style.backgroundImage = gradient;
  } else if (bg.indexOf('data:') === 0) {
    body.style.backgroundImage = 'url("' + bg + '")';
    body.style.backgroundSize = 'cover';
    body.style.backgroundPosition = 'center';
    body.style.backgroundRepeat = 'no-repeat';
  }
}

function setBackground(bg) {
  currentBackground = bg || 'none';
  saveBackground(currentBackground);
  applyBackground(currentBackground);
  renderBgPresets();
  updateBgStatus();
}

function updateBgStatus() {
  const el = document.getElementById('bgStatus');
  if (!currentBackground || currentBackground === 'none') {
    el.textContent = 'No background (using the theme color).';
  } else if (currentBackground.indexOf('preset:') === 0) {
    const id = currentBackground.slice(7);
    el.textContent = 'Background: ' + (id.charAt(0).toUpperCase() + id.slice(1)) + ' preset.';
  } else {
    el.textContent = 'Background: custom image.';
  }
}

function renderBgPresets() {
  const box = document.getElementById('bgPresets');
  box.innerHTML = '';
  Object.keys(PRESET_BACKGROUNDS).forEach(id => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bg-preset';
    btn.dataset.preset = id;
    btn.style.background = PRESET_BACKGROUNDS[id];
    btn.title = id.charAt(0).toUpperCase() + id.slice(1);
    if (currentBackground === 'preset:' + id) btn.classList.add('selected');
    btn.addEventListener('click', () => setBackground('preset:' + id));
    box.appendChild(btn);
  });
}

function openBackgroundModal() {
  renderBgPresets();
  updateBgStatus();
  openModal('backgroundModal');
}

function handleBgFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.type.indexOf('image/') !== 0) { showToast('Please choose an image file.'); return; }
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(url);
    setBackground(resizeImage(img));
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    showToast('Could not read the image.');
  };
  img.src = url;
}

function resizeImage(img) {
  const MAX = 1920;
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  const scale = Math.min(1, MAX / w, MAX / h);
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  try {
    const webp = canvas.toDataURL('image/webp', 0.85);
    if (webp.indexOf('data:image/webp') === 0) return webp;
  } catch (err) { /* ignore */ }
  return canvas.toDataURL('image/jpeg', 0.85);
}

/* ---------- Summary ---------- */

function openSummaryModal() {
  document.getElementById('summaryStart').value = isoDateShift(-6);
  document.getElementById('summaryEnd').value = isoDateShift(0);
  renderSummary();
  openModal('summaryModal');
}

function setSummaryPreset(days) {
  document.getElementById('summaryStart').value = days === 0 ? isoDateShift(0) : isoDateShift(-(days - 1));
  document.getElementById('summaryEnd').value = isoDateShift(0);
  renderSummary();
}

function inPeriod(ts, start, end) {
  if (!ts) return false;
  const d = ts.slice(0, 10);
  return d >= start && d <= end;
}

function renderSummary() {
  const start = document.getElementById('summaryStart').value;
  const end = document.getElementById('summaryEnd').value;
  const statsEl = document.getElementById('summaryStats');
  const listEl = document.getElementById('summaryList');
  statsEl.innerHTML = '';
  listEl.innerHTML = '';

  if (!start || !end) {
    listEl.innerHTML = '<p class="hint">Choose a date range.</p>';
    return;
  }

  let createdCount = 0, updatedCount = 0, completedCount = 0, progressCount = 0;
  const groups = {};

  board.columns.forEach(col => {
    col.tasks.forEach(task => {
      const createdIn = inPeriod(task.createdAt, start, end);
      const updatedIn = inPeriod(task.updatedAt, start, end);
      const completedIn = inPeriod(task.completedAt, start, end);
      const progressIn = (task.progress || []).filter(p => p.date && p.date >= start && p.date <= end).length;

      if (createdIn) createdCount++;
      if (updatedIn) updatedCount++;
      if (completedIn) completedCount++;
      progressCount += progressIn;

      if (createdIn || updatedIn || completedIn || progressIn) {
        if (!groups[col.id]) groups[col.id] = { title: col.title, items: [] };
        groups[col.id].items.push({ task, createdIn, updatedIn, completedIn, progressIn });
      }
    });
  });

  statsEl.innerHTML =
    '<div class="stat"><span class="stat-num">' + createdCount + '</span><span class="stat-label">Created</span></div>' +
    '<div class="stat"><span class="stat-num">' + updatedCount + '</span><span class="stat-label">Updated</span></div>' +
    '<div class="stat"><span class="stat-num">' + completedCount + '</span><span class="stat-label">Completed</span></div>' +
    '<div class="stat"><span class="stat-num">' + progressCount + '</span><span class="stat-label">Progress notes</span></div>';

  const groupIds = Object.keys(groups);
  if (groupIds.length === 0) {
    listEl.innerHTML = '<p class="hint">No updates in this period.</p>';
    return;
  }

  groupIds.forEach(colId => {
    const g = groups[colId];
    const head = document.createElement('div');
    head.className = 'summary-group-head';
    head.textContent = g.title;
    listEl.appendChild(head);

    g.items.forEach(item => {
      const badges = [];
      if (item.createdIn) badges.push('created');
      if (item.updatedIn) badges.push('updated');
      if (item.completedIn) badges.push('completed');
      if (item.progressIn) badges.push(item.progressIn + ' note' + (item.progressIn > 1 ? 's' : ''));

      const meta = [];
      if (item.createdIn) meta.push('Created ' + formatDateTime(item.task.createdAt));
      if (item.updatedIn) meta.push('Updated ' + formatDateTime(item.task.updatedAt));
      if (item.completedIn) meta.push('Completed ' + formatDateTime(item.task.completedAt));

      const row = document.createElement('div');
      row.className = 'summary-item';
      row.innerHTML =
        '<span class="summary-title">' + escapeHtml(item.task.title) + '</span>' +
        '<span class="summary-badges">' + badges.map(b => '<span class="summary-badge">' + b + '</span>').join('') + '</span>' +
        (meta.length ? '<span class="summary-meta">' + escapeHtml(meta.join(' · ')) + '</span>' : '');
      listEl.appendChild(row);
    });
  });
}

/* ---------- Actions ---------- */

function findTask(taskId) {
  for (const col of board.columns) {
    const task = col.tasks.find(x => x.id === taskId);
    if (task) return { col, task };
  }
  return null;
}

function toggleComplete(taskId) {
  const found = findTask(taskId);
  if (!found) return;
  const now = new Date().toISOString();
  found.task.completed = !found.task.completed;
  found.task.updatedAt = now;
  found.task.completedAt = found.task.completed ? now : '';
  saveBoard();
  renderBoard();
}

function toggleShownCompleted(columnId) {
  if (shownCompleted.has(columnId)) shownCompleted.delete(columnId);
  else shownCompleted.add(columnId);
  saveCompletedVisibility();
  renderBoard();
}

function moveTask(taskId, sourceColId, targetColId, index) {
  const source = board.columns.find(c => c.id === sourceColId);
  const target = board.columns.find(c => c.id === targetColId);
  if (!source || !target) return;
  const i = source.tasks.findIndex(t => t.id === taskId);
  if (i === -1) return;
  const task = source.tasks.splice(i, 1)[0];
  if (sourceColId === targetColId && i < index) index--;
  const pos = Math.max(0, Math.min(index, target.tasks.length));
  target.tasks.splice(pos, 0, task);
  task.updatedAt = new Date().toISOString();
  saveBoard();
  renderBoard();
}

function deleteTask(taskId) {
  const found = findTask(taskId);
  if (!found) return;
  found.col.tasks = found.col.tasks.filter(t => t.id !== taskId);
  board.recycleBin.cards.push({ task: found.task, columnId: found.col.id });
  saveBoard();
  renderBoard();
  showToast('Moved to Recycle Bin');
}

function deleteColumn(columnId) {
  const index = board.columns.findIndex(c => c.id === columnId);
  if (index === -1) return;
  const col = board.columns.splice(index, 1)[0];
  board.recycleBin.columns.push({ column: col, index: index });
  saveBoard();
  renderBoard();
  showToast('Moved to Recycle Bin');
}

function toggleTagFilter(tag) {
  filters.tag = filters.tag === tag ? null : tag;
  renderBoard();
}

/* ---------- Recycle Bin ---------- */

function openRecycleBin() {
  renderRecycleBin();
  openModal('recycleModal');
}

function renderRecycleBin() {
  const list = document.getElementById('recycleList');
  const summary = document.getElementById('recycleSummary');
  const total = board.recycleBin.cards.length + board.recycleBin.columns.length;
  summary.textContent = total === 0 ? 'Recycle Bin is empty.' : total + ' item(s) waiting in the Recycle Bin.';
  list.innerHTML = '';

  if (total === 0) {
    const empty = document.createElement('div');
    empty.className = 'recycle-empty';
    empty.textContent = 'Nothing here yet. Deleted tasks and columns will appear here.';
    list.appendChild(empty);
    return;
  }

  board.recycleBin.cards.forEach((item, i) => {
    const colName = board.columns.find(c => c.id === item.columnId);
    const row = document.createElement('div');
    row.className = 'recycle-item';
    row.innerHTML =
      '<span class="recycle-kind">Card</span>' +
      '<span class="recycle-title">' + escapeHtml(item.task.title) + '</span>' +
      '<span class="recycle-meta">→ ' + escapeHtml(colName ? colName.title : 'No column') + '</span>' +
      '<button class="btn btn-secondary btn-small" data-action="restore-card" data-index="' + i + '">↩ Restore</button>';
    list.appendChild(row);
  });

  board.recycleBin.columns.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'recycle-item';
    row.innerHTML =
      '<span class="recycle-kind">Column</span>' +
      '<span class="recycle-title">' + escapeHtml(item.column.title) + '</span>' +
      '<span class="recycle-meta">' + item.column.tasks.length + ' task(s)</span>' +
      '<button class="btn btn-secondary btn-small" data-action="restore-column" data-index="' + i + '">↩ Restore</button>';
    list.appendChild(row);
  });
}

function restoreCard(index) {
  const item = board.recycleBin.cards[index];
  if (!item) return;
  board.recycleBin.cards.splice(index, 1);
  let col = board.columns.find(c => c.id === item.columnId);
  if (!col) col = board.columns[0];
  if (!col) {
    col = { id: generateId('col'), title: 'To Do', color: '', tasks: [] };
    board.columns.push(col);
  }
  col.tasks.push(normalizeTask(item.task));
  saveBoard();
  renderBoard();
  renderRecycleBin();
  showToast('Restored task');
}

function restoreColumn(index) {
  const item = board.recycleBin.columns[index];
  if (!item) return;
  board.recycleBin.columns.splice(index, 1);
  const pos = Math.max(0, Math.min(item.index, board.columns.length));
  board.columns.splice(pos, 0, item.column);
  saveBoard();
  renderBoard();
  renderRecycleBin();
  showToast('Restored column');
}

function emptyRecycleBin() {
  const total = board.recycleBin.cards.length + board.recycleBin.columns.length;
  board.recycleBin = { cards: [], columns: [] };
  saveBoard();
  renderBoard();
  renderRecycleBin();
  showToast(total + ' item(s) permanently deleted');
}

/* ---------- Forms ---------- */

function handleCardSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('cardId').value;
  const columnId = document.getElementById('cardColumnId').value;
  const title = document.getElementById('cardTitle').value.trim();
  if (!title) return;

  const tags = document.getElementById('cardTags').value
    .split(',').map(t => t.trim()).filter(Boolean);

  if (id) {
    const found = findTask(id);
    if (!found) return;
    const t = found.task;
    t.title = title;
    t.description = document.getElementById('cardDescription').value.trim();
    t.tags = tags;
    t.dueDate = document.getElementById('cardDueDate').value;
    t.priority = document.getElementById('cardPriority').value;
    t.color = document.getElementById('cardColor').value;
    t.progress = draftProgress;
    t.links = draftLinks;
    t.updatedAt = new Date().toISOString();
  } else {
    const col = board.columns.find(c => c.id === columnId);
    if (!col) return;
    col.tasks.unshift({
      id: generateId('task'),
      title,
      description: document.getElementById('cardDescription').value.trim(),
      tags,
      completed: false,
      completedAt: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dueDate: document.getElementById('cardDueDate').value,
      priority: document.getElementById('cardPriority').value,
      color: document.getElementById('cardColor').value,
      progress: draftProgress,
      links: draftLinks
    });
  }
  saveBoard();
  renderBoard();
  closeModal('cardModal');
}

function handleColumnSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('columnId').value;
  const title = document.getElementById('columnTitle').value.trim();
  if (!title) return;
  const color = document.getElementById('columnColor').value;
  if (id) {
    const col = board.columns.find(c => c.id === id);
    if (col) { col.title = title; col.color = color; }
  } else {
    board.columns.push({ id: generateId('col'), title: title, color: color, tasks: [] });
  }
  saveBoard();
  renderBoard();
  closeModal('columnModal');
}

/* ---------- Drag & drop ---------- */

function clearColumnHighlights() {
  document.querySelectorAll('.column.drag-over').forEach(el => el.classList.remove('drag-over'));
}

function clearDropPlaceholders() {
  document.querySelectorAll('.drop-placeholder').forEach(el => el.remove());
}

function getInsertionIndex(list, clientY) {
  const cards = Array.from(list.querySelectorAll('.card[draggable="true"]'));
  let index = cards.length;
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) { index = i; break; }
  }
  return index;
}

function showDropPlaceholder(list, index) {
  clearDropPlaceholders();
  const cards = Array.from(list.querySelectorAll('.card[draggable="true"]'));
  const ph = document.createElement('div');
  ph.className = 'drop-placeholder';
  const before = cards[index];
  if (before) list.insertBefore(ph, before);
  else list.appendChild(ph);
}

function resetDragState() {
  dragState = { taskId: null, sourceColumnId: null, targetColumnId: null, index: null };
}

function clearColumnInsertIndicators() {
  document.querySelectorAll('.column.drag-insert-left, .column.drag-insert-right')
    .forEach(el => el.classList.remove('drag-insert-left', 'drag-insert-right'));
}

function resetColumnDrag() {
  document.querySelectorAll('.column.dragging-column').forEach(el => el.classList.remove('dragging-column'));
  columnDragId = null;
  columnDropTarget = null;
}

function reorderColumn(columnId, target) {
  const srcIdx = board.columns.findIndex(c => c.id === columnId);
  if (srcIdx === -1) return;
  const tgtIdx = board.columns.findIndex(c => c.id === target.id);
  if (tgtIdx === -1 || srcIdx === tgtIdx) return;
  let insertIdx = target.after ? tgtIdx + 1 : tgtIdx;
  const col = board.columns.splice(srcIdx, 1)[0];
  if (srcIdx < insertIdx) insertIdx--;
  board.columns.splice(insertIdx, 0, col);
  saveBoard();
  renderBoard();
}

/* ---------- Event binding ---------- */

function bindEvents() {
  const boardEl = document.getElementById('board');

  boardEl.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    const taskId = el.dataset.taskId;
    const columnId = el.dataset.columnId;

    if (action === 'add-card') {
      openCardModal(columnId);
    } else if (action === 'add-column') {
      openColumnModal();
    } else if (action === 'edit-card') {
      const found = findTask(taskId);
      if (found) openCardModal(found.col.id, found.task);
    } else if (action === 'delete-card') {
      confirmDialog('Delete this task? This cannot be undone.', 'Delete', () => deleteTask(taskId));
    } else if (action === 'copy-link') {
      copyToClipboard(el.dataset.url);
    } else if (action === 'toggle-complete') {
      toggleComplete(taskId);
    } else if (action === 'toggle-collapse') {
      if (expandedCards.has(taskId)) expandedCards.delete(taskId);
      else expandedCards.add(taskId);
      renderBoard();
    } else if (action === 'toggle-completed-visibility') {
      toggleShownCompleted(columnId);
    } else if (action === 'open-sort-menu') {
      openSortMenu(columnId, el);
    } else if (action === 'edit-column') {
      openColumnModal(columnId);
    } else if (action === 'delete-column') {
      const col = board.columns.find(c => c.id === columnId);
      const count = col ? col.tasks.length : 0;
      confirmDialog('Delete column "' + (col ? col.title : '') + '"' + (count ? ' and its ' + count + ' task(s)' : '') + '? This cannot be undone.', 'Delete', () => deleteColumn(columnId));
    } else if (action === 'filter-tag') {
      toggleTagFilter(el.dataset.tag);
    }
  });

  boardEl.addEventListener('change', (e) => {
    if (!e.target.matches('.move-select')) return;
    const taskId = e.target.dataset.taskId;
    const card = e.target.closest('.card');
    const sourceColId = card.closest('.column').dataset.columnId;
    const targetColId = e.target.value;
    if (targetColId !== sourceColId) moveTask(taskId, sourceColId, targetColId, Infinity);
  });

  boardEl.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card[draggable="true"]');
    if (card) {
      dragState.taskId = card.dataset.taskId;
      dragState.sourceColumnId = card.closest('.column').dataset.columnId;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragState.taskId);
      card.classList.add('dragging');
      return;
    }
    const header = e.target.closest('.column-header[draggable="true"]');
    if (!header) return;
    if (e.target.closest('button, select, input, textarea, a')) { e.preventDefault(); return; }
    columnDragId = header.closest('.column').dataset.columnId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'column:' + columnDragId);
    header.closest('.column').classList.add('dragging-column');
  });

  boardEl.addEventListener('dragend', () => {
    clearColumnHighlights();
    clearDropPlaceholders();
    clearColumnInsertIndicators();
    resetDragState();
    resetColumnDrag();
  });

  boardEl.addEventListener('dragover', (e) => {
    if (columnDragId) {
      const col = e.target.closest('.column');
      if (!col || col.dataset.columnId === columnDragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearColumnInsertIndicators();
      const rect = col.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      col.classList.add(after ? 'drag-insert-right' : 'drag-insert-left');
      columnDropTarget = { id: col.dataset.columnId, after };
      return;
    }
    const list = e.target.closest('.task-list');
    if (!list) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearColumnHighlights();
    list.closest('.column').classList.add('drag-over');
    dragState.targetColumnId = list.dataset.columnId;
    dragState.index = getInsertionIndex(list, e.clientY);
    showDropPlaceholder(list, dragState.index);
  });

  boardEl.addEventListener('dragleave', (e) => {
    const col = e.target.closest('.column');
    if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
  });

  boardEl.addEventListener('drop', (e) => {
    if (columnDragId && columnDropTarget) {
      e.preventDefault();
      reorderColumn(columnDragId, columnDropTarget);
      clearColumnInsertIndicators();
      resetColumnDrag();
      return;
    }
    const list = e.target.closest('.task-list');
    if (!list) return;
    e.preventDefault();
    const targetColId = list.dataset.columnId;
    if (dragState.taskId && dragState.sourceColumnId) {
      moveTask(dragState.taskId, dragState.sourceColumnId, targetColId, dragState.index ?? Infinity);
    }
    clearColumnHighlights();
    clearDropPlaceholders();
    resetDragState();
  });
}

function bindHeaderEvents() {
  document.getElementById('searchInput').addEventListener('input', (e) => {
    filters.search = e.target.value.trim();
    renderBoard();
  });

  document.getElementById('themeSelect').addEventListener('change', (e) => {
    applyTheme(e.target.value);
  });

  document.getElementById('backgroundBtn').addEventListener('click', openBackgroundModal);
  document.getElementById('removeBgBtn').addEventListener('click', () => setBackground('none'));
  document.getElementById('uploadBgBtn').addEventListener('click', () => {
    document.getElementById('bgFileInput').click();
  });
  document.getElementById('bgFileInput').addEventListener('change', handleBgFile);

  document.getElementById('summaryBtn').addEventListener('click', openSummaryModal);
  document.getElementById('summaryStart').addEventListener('change', renderSummary);
  document.getElementById('summaryEnd').addEventListener('change', renderSummary);
  document.querySelectorAll('#summaryModal [data-preset]').forEach(btn => {
    btn.addEventListener('click', () => setSummaryPreset(parseInt(btn.dataset.preset, 10)));
  });

  document.getElementById('recycleBinBtn').addEventListener('click', openRecycleBin);
  document.getElementById('recycleList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const index = parseInt(btn.dataset.index, 10);
    if (btn.dataset.action === 'restore-card') restoreCard(index);
    else if (btn.dataset.action === 'restore-column') restoreColumn(index);
  });
  document.getElementById('emptyRecycleBtn').addEventListener('click', () => {
    const total = board.recycleBin.cards.length + board.recycleBin.columns.length;
    if (total === 0) return;
    confirmDialog('Permanently delete all ' + total + ' item(s) in the Recycle Bin? This cannot be undone.', 'Empty', emptyRecycleBin);
  });

  document.getElementById('addColumnBtn').addEventListener('click', () => openColumnModal());
  document.getElementById('clearTagFilter').addEventListener('click', () => {
    filters.tag = null;
    renderBoard();
  });

  document.getElementById('exportBtn').addEventListener('click', exportBoard);
  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFileInput').click();
  });
  document.getElementById('importFileInput').addEventListener('change', handleImportFile);

  document.getElementById('cardForm').addEventListener('submit', handleCardSubmit);
  document.getElementById('columnForm').addEventListener('submit', handleColumnSubmit);

  document.getElementById('addProgressBtn').addEventListener('click', addProgressItem);
  document.getElementById('addLinkBtn').addEventListener('click', addLinkItem);
  document.getElementById('progressList').addEventListener('input', onProgressInput);
  document.getElementById('progressList').addEventListener('click', onProgressClick);
  document.getElementById('linkList').addEventListener('input', onLinkInput);
  document.getElementById('linkList').addEventListener('click', onLinkClick);
  document.getElementById('progressText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addProgressItem(); }
  });
  document.getElementById('linkUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addLinkItem(); }
  });

  document.getElementById('cardTags').addEventListener('input', showTagSuggestions);
  document.getElementById('cardTags').addEventListener('blur', () => {
    setTimeout(hideTagSuggestions, 150);
  });

  document.getElementById('confirmCancel').addEventListener('click', () => {
    confirmCallback = null;
    closeModal('confirmModal');
  });
  document.getElementById('confirmOk').addEventListener('click', () => {
    closeModal('confirmModal');
    if (confirmCallback) { const cb = confirmCallback; confirmCallback = null; cb(); }
  });

  document.getElementById('importCancel').addEventListener('click', () => {
    pendingImport = null;
    closeModal('importModal');
  });
  document.getElementById('importMerge').addEventListener('click', () => applyImport('merge'));
  document.getElementById('importReplace').addEventListener('click', () => applyImport('replace'));

  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSortMenu();
      document.querySelectorAll('.modal-overlay:not([hidden])').forEach(m => { m.hidden = true; });
      confirmCallback = null;
      pendingImport = null;
    }
  });

  document.addEventListener('click', (e) => {
    const menu = document.getElementById('sortMenu');
    if (menu.hidden) return;
    if (!menu.contains(e.target) && !e.target.closest('.sort-btn')) closeSortMenu();
  });
}

/* ---------- Import / Export ---------- */

function exportBoard() {
  const data = JSON.stringify(board, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tasks-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Exported tasks.json');
}

function handleImportFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.columns)) {
        showToast('Invalid file: expected {"columns": [...]}');
        return;
      }
      const colCount = data.columns.length;
      const taskCount = data.columns.reduce((n, c) => n + (Array.isArray(c.tasks) ? c.tasks.length : 0), 0);
      pendingImport = data;
      document.getElementById('importSummary').textContent =
        'Found ' + colCount + ' column(s) and ' + taskCount + ' task(s).';
      openModal('importModal');
    } catch (err) {
      showToast('Could not parse the file as JSON.');
    }
  };
  reader.onerror = () => showToast('Could not read the file.');
  reader.readAsText(file);
}

function applyImport(mode) {
  if (!pendingImport) { closeModal('importModal'); return; }
  const incoming = normalizeBoard(pendingImport);
  board = mode === 'replace' ? incoming : mergeBoards(board, incoming);
  pendingImport = null;
  saveBoard();
  renderBoard();
  closeModal('importModal');
  showToast('Import complete');
}

function mergeBoards(current, incoming) {
  const merged = {
    columns: current.columns.map(c => ({
      id: c.id,
      title: c.title,
      color: c.color || '',
      tasks: c.tasks.map(t => Object.assign({}, t))
    })),
    recycleBin: {
      cards: (current.recycleBin ? current.recycleBin.cards : []).map(i => Object.assign({}, i)),
      columns: (current.recycleBin ? current.recycleBin.columns : []).map(i => Object.assign({}, i))
    }
  };
  incoming.columns.forEach(inc => {
    const existing = merged.columns.find(c => c.title.toLowerCase() === inc.title.toLowerCase());
    const freshTasks = inc.tasks.map(t => Object.assign({}, t, { id: generateId('task') }));
    if (existing) {
      existing.tasks.push.apply(existing.tasks, freshTasks);
    } else {
      merged.columns.push({ id: generateId('col'), title: inc.title, color: inc.color || '', tasks: freshTasks });
    }
  });
  (incoming.recycleBin ? incoming.recycleBin.cards : []).forEach(i => merged.recycleBin.cards.push(Object.assign({}, i)));
  (incoming.recycleBin ? incoming.recycleBin.columns : []).forEach(i => merged.recycleBin.columns.push(Object.assign({}, i)));
  return merged;
}

/* ---------- Theme & init ---------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
  const sel = document.getElementById('themeSelect');
  if (sel) sel.value = theme;
}

function init() {
  try {
    applyTheme(localStorage.getItem(THEME_KEY) || 'light');
  } catch (e) {
    applyTheme('light');
  }
  board = loadBoard();
  loadCompletedVisibility();
  loadColumnSorts();
  currentBackground = loadBackground();
  applyBackground(currentBackground);
  buildPalette('cardColorPalette', 'cardColor');
  buildPalette('columnColorPalette', 'columnColor');
  renderBoard();
  bindHeaderEvents();
  bindEvents();
}

document.addEventListener('DOMContentLoaded', init);





