// BugPin — full-size issue list (opened from the sidebar's "View all issues").
// Reads bugs straight from chrome.storage and re-renders whenever they change,
// so it stays current while you keep working or while a live session syncs.
const $ = id => document.getElementById(id);
const SEV_ORDER = { critical:0, high:1, medium:2, low:3 };
const STATUS = { backlog:'Backlog', todo:'To Do', 'in-progress':'In Progress', done:'Done', open:'Open' };
const SEV = { critical:'Critical', high:'High', medium:'Medium', low:'Low' };

let projects = {};
let domain = new URLSearchParams(location.search).get('domain') || '';

const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function load() {
  chrome.storage.local.get('projects', d => { projects = d.projects || {}; render(); });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.projects) { projects = changes.projects.newValue || {}; render(); }
});

function flatten(proj) {
  const out = [];
  for (const [pk, page] of Object.entries(proj?.pages || {})) {
    for (const b of (page.bugs || [])) out.push({ ...b, _pk: pk, _title: page.title || pk });
  }
  return out;
}

function fillDomains() {
  const names = Object.keys(projects);
  if (!names.includes(domain)) domain = names[0] || domain;
  $('v-domain').innerHTML = names.map(n => `<option value="${esc(n)}"${n === domain ? ' selected' : ''}>${esc(n)}</option>`).join('')
    || '<option>No projects</option>';
}

function fillPages(all) {
  const sel = $('v-page'), cur = sel.value;
  const pages = [...new Set(all.map(b => b._pk))];
  sel.innerHTML = '<option value="">All pages</option>' +
    pages.map(p => `<option value="${esc(p)}"${p === cur ? ' selected' : ''}>${esc(p)}</option>`).join('');
}

function pageUrl(pk, bugs) {
  const withUrl = bugs.find(b => b.url);
  if (withUrl) { try { const u = new URL(withUrl.url); return u.origin + pk; } catch (_) {} }
  return `https://${domain}${pk}`;
}

function timeAgo(iso) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function bugCard(b) {
  const sev = b.severity || 'medium';
  const cs = b.comments || [];
  return `
  <article class="bug sev-${sev}">
    <div class="num">#${b.num}</div>
    <div class="title${b.status === 'done' ? ' done' : ''}">${esc(b.title || '(no title)')}</div>
    <div class="chips">
      <span class="chip sev-${sev}">${SEV[sev] || sev}</span>
      <span class="chip">${esc(STATUS[b.status] || b.status || 'Backlog')}</span>
    </div>
    <div class="body">
      ${b.description ? `<div class="desc">${esc(b.description)}</div>` : ''}
      <div class="meta">
        ${b.assignee ? `<span><b>Assignee</b> ${esc(b.assignee)}</span>` : ''}
        ${(b.tags || []).length ? `<span><b>Tags</b> ${esc(b.tags.join(', '))}</span>` : ''}
        ${b.viewport ? `<span><b>Screen</b> ${esc(b.viewport)}</span>` : ''}
        ${b.timestamp ? `<span>${esc(timeAgo(b.timestamp))}</span>` : ''}
      </div>
      ${b.screenshot ? `<img class="shot" loading="lazy" src="${b.screenshot}" alt="Screenshot for bug ${b.num}"/>` : ''}
      ${cs.length ? `<details class="comments"><summary>💬 ${cs.length} comment${cs.length === 1 ? '' : 's'}</summary>
        ${cs.map(c => `<div class="comment"><span class="who">${esc(c.author || 'Someone')}</span><span class="when">${c.timestamp ? esc(timeAgo(c.timestamp)) : ''}</span><p>${esc(c.text || '')}</p></div>`).join('')}
      </details>` : ''}
    </div>
  </article>`;
}

function render() {
  fillDomains();
  const all = flatten(projects[domain]);
  fillPages(all);
  document.title = `BugPin — ${domain || 'All issues'}`;

  const q = $('v-search').value.trim().toLowerCase();
  const sev = $('v-sev').value, st = $('v-status').value, pg = $('v-page').value, sort = $('v-sort').value;

  let bugs = all.filter(b => {
    if (sev && b.severity !== sev) return false;
    if (st && (b.status || 'backlog') !== st) return false;
    if (pg && b._pk !== pg) return false;
    if (q) {
      const hay = [b.title, b.description, b.assignee, (b.tags || []).join(' '),
        (b.comments || []).map(c => (c.author || '') + ' ' + (c.text || '')).join(' ')].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const open = all.filter(b => b.status !== 'done').length;
  $('v-summary').textContent = `${bugs.length} shown of ${all.length} · ${open} open · ${all.length - open} done`;

  const list = $('v-list');
  if (!all.length) {
    list.innerHTML = '<div class="empty"><div class="big">📋</div><p>No issues for this site yet.</p></div>';
    return;
  }
  if (!bugs.length) {
    list.innerHTML = '<div class="empty"><div class="big">🔍</div><p>No issues match these filters.</p></div>';
    return;
  }

  if (sort === 'newest' || sort === 'severity') {
    bugs = bugs.slice().sort(sort === 'newest'
      ? (a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)
      : (a, b) => (SEV_ORDER[a.severity] ?? 2) - (SEV_ORDER[b.severity] ?? 2) || new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    list.innerHTML = bugs.map(b => `<div class="page-path" style="margin:0 0 4px 2px;font-size:11.5px">${esc(b._pk)}</div>${bugCard(b)}`).join('');
  } else {
    const groups = {};
    bugs.forEach(b => (groups[b._pk] = groups[b._pk] || []).push(b));
    list.innerHTML = Object.entries(groups).map(([pk, bs]) => `
      <div class="page-head">
        <span class="page-path">${esc(pk)}</span>
        <span class="page-title">${esc(bs[0]._title)}</span>
        <span class="count">${bs.length} issue${bs.length === 1 ? '' : 's'}</span>
        <a class="page-open" href="${esc(pageUrl(pk, bs))}" target="_blank" rel="noopener">Open page ↗</a>
      </div>
      ${bs.slice().sort((a, b) => a.num - b.num).map(bugCard).join('')}`).join('');
  }
}

['v-search', 'v-sev', 'v-status', 'v-page', 'v-sort'].forEach(id =>
  $(id).addEventListener(id === 'v-search' ? 'input' : 'change', render));
$('v-domain').addEventListener('change', e => { domain = e.target.value; $('v-page').value = ''; render(); });

// Click a screenshot to enlarge; click anywhere to close.
$('v-list').addEventListener('click', e => {
  if (e.target.classList.contains('shot')) {
    $('v-lightbox-img').src = e.target.src; $('v-lightbox').hidden = false;
  }
});
$('v-lightbox').addEventListener('click', () => { $('v-lightbox').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('v-lightbox').hidden = true; });

load();
