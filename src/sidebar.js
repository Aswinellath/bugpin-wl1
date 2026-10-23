// BugPin v2 — Sidebar (project tree: domain → pages → bugs)
const $ = id => document.getElementById(id);
const post = (type,payload) => window.parent.postMessage({type,payload},'*');

const S = { projects:{}, domain:'', pageKey:'', search:'', sevFilter:'', exportScope:'page',
            viewBand:'desktop', viewWidth:0, hiddenCount:0, showAll:false };

// Responsive bands — must match content.js
const BANDS = [
  { id:'mobile',  label:'Mobile',  icon:'📱', max:480 },
  { id:'tablet',  label:'Tablet',  icon:'📄', max:1024 },
  { id:'desktop', label:'Desktop', icon:'🖥', max:Infinity },
];
function bandForWidth(w){ return (BANDS.find(b=>w<=b.max)||BANDS[2]).id; }
function bugBandOf(bug){
  if (bug.band) return bug.band;
  const w = parseInt(String(bug.viewport||'').split(/[x×]/)[0],10);
  return Number.isFinite(w) ? bandForWidth(w) : 'desktop';
}
function bandMeta(id){ return BANDS.find(b=>b.id===id)||BANDS[2]; }

/* ── Messages from content ── */
window.addEventListener('message', e => {
  const {type,payload} = e.data||{};
  if (type==='INIT' || type==='PROJECTS_UPDATE') {
    S.projects = payload.projects || {};
    S.domain   = payload.domain   || S.domain;
    S.pageKey  = payload.pageKey  || S.pageKey;
    $('sh-domain').textContent = S.domain || '—';
    render();
  }
  if (type==='VIEWPORT_INFO') {
    S.viewBand    = payload.band;
    S.viewWidth   = payload.width;
    S.hiddenCount = payload.hidden;
    S.showAll     = payload.showAll;
    renderViewportBar();
    render();
  }
  if (type==='LIVE_STATUS') {
    renderLiveStatus(payload);
  }
  if (type==='CLEAR_DONE') {
    flashShareNote(`Cleared ${payload.count} bug${payload.count===1?'':'s'}`);
  }
});

function renderViewportBar() {
  const bar = $('viewport-bar');
  if (!bar) return;
  const m = bandMeta(S.viewBand);
  const hiddenTxt = (!S.showAll && S.hiddenCount)
    ? ` · <span class="vp-hidden">${S.hiddenCount} hidden</span>` : '';
  bar.innerHTML = `
    <div class="vp-info">
      <span class="vp-band">${m.icon} ${S.viewWidth}px · ${m.label}</span>${hiddenTxt}
    </div>
    <label class="vp-toggle" title="Show pins from every screen size">
      <input type="checkbox" id="vp-showall" ${S.showAll?'checked':''}/>
      <span>All sizes</span>
    </label>
  `;
  $('vp-showall').addEventListener('change', ev => {
    post('TOGGLE_SHOW_ALL', { showAll: ev.target.checked });
  });
}

/* ── View all issues (full-size tab) ── */
$('view-all').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_VIEWER', domain: S.domain });
});

/* ── Toolbar ── */
$('stb-search').addEventListener('input', e => { S.search=e.target.value.toLowerCase(); render(); });
$('stb-sev').addEventListener('change', e => { S.sevFilter=e.target.value; render(); });
$('sh-close').addEventListener('click', () => post('SIDEBAR_CLOSE',{}));
// The button reflects whether Report Bug mode is on, and toggles it.
function renderModeBtn(on) {
  const b = $('sf-mode');
  b.textContent = on ? '⏹ Stop reporting' : '✚ Report Bug';
  b.classList.toggle('stop', !!on);
  S.modeOn = !!on;
}
chrome.storage.local.get('activeMode', r => renderModeBtn(r.activeMode));
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.activeMode) renderModeBtn(ch.activeMode.newValue);
});
$('sf-mode').addEventListener('click', () => {
  const turningOn = !S.modeOn;
  // Starting: close the sidebar so the page is clear to click.
  // Stopping: stay put — you're already here.
  if (turningOn) post('SIDEBAR_CLOSE', {});
  chrome.storage.local.set({ activeMode: turningOn });
});

/* ── Live session ── */
// Only one bottom panel is open at a time, so the issue list keeps its room.
function togglePanel(which) {
  for (const p of ['live', 'share']) {
    const body = $(p + '-body');
    const open = p === which ? body.hidden : false;
    body.hidden = !open;
    $(p + '-chev').classList.toggle('open', open);
  }
}
$('live-toggle').addEventListener('click', () => togglePanel('live'));
$('live-start').addEventListener('click', () => post('LIVE_START', {}));
$('live-join').addEventListener('click', () => {
  const code = $('live-code').value.trim();
  if (!code) return;
  post('LIVE_JOIN', { code });
});
$('live-leave').addEventListener('click', () => post('LIVE_LEAVE', {}));
$('live-copy').addEventListener('click', () => {
  const code = $('live-code-out').textContent;
  if (code && code !== '—') {
    navigator.clipboard?.writeText(code).then(
      () => { $('live-copy').textContent = '✓'; setTimeout(()=>$('live-copy').textContent='⧉',1200); },
      () => {}
    );
  }
});

function renderLiveStatus(s) {
  const active = s.role === 'host' || s.role === 'guest';
  $('live-idle').hidden   = active;
  $('live-active').hidden = !active;

  const statusEl = $('live-status');
  const liveHead = $('live-toggle').querySelector('span');

  if (!active) {
    statusEl.textContent = 'Not connected';
    statusEl.className = 'live-status';
    liveHead.innerHTML = '🔴 Live session';
    return;
  }

  $('live-code-out').textContent = s.code || '—';
  if (s.role === 'host') {
    statusEl.textContent = s.reconnecting
      ? 'Restoring your session…'
      : s.peers > 0 ? `Hosting · ${s.peers} connected` : 'Hosting · waiting for someone to join…';
  } else {
    statusEl.textContent = s.peers > 0 ? 'Connected to host'
      : s.reconnecting ? 'Host unreachable · reconnecting…' : 'Connecting…';
  }
  const good = s.peers > 0;
  statusEl.className = 'live-status ' + (good ? 'ok' : 'waiting');
  liveHead.innerHTML = good ? `🟢 Live · ${s.peers}` : '🟡 Live session';
}

/* ── Share panel ── */
$('share-toggle').addEventListener('click', () => togglePanel('share'));
document.querySelectorAll('.seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.exportScope = btn.dataset.scope;
  });
});
// ── Export as HTML document (readable, printable, self-contained) ──
$('sf-doc').addEventListener('click', () => {
  const project = S.projects[S.domain];
  if (!project) { flashShareNote('Nothing to export on this site yet'); return; }

  const scope = S.exportScope;
  let pages;
  if (scope === 'site') {
    pages = project.pages || {};
  } else {
    const page = project.pages?.[S.pageKey];
    if (!page) { flashShareNote('No bugs on this page to export'); return; }
    pages = { [S.pageKey]: page };
  }

  const includeShots = $('inc-shots').checked;
  const html = buildBugDocument(S.domain, pages, includeShots);
  if (!html) { flashShareNote('No bugs to export'); return; }

  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `${S.domain}-bugs-${stamp}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  const sizeKB = Math.round(blob.size / 1024);
  flashShareNote(`Document exported (${sizeKB} KB) — open it and print to PDF`);
});

function buildBugDocument(domain, pages, includeShots) {
  const SEV = {
    critical: { label:'Critical', color:'#dc2626', bg:'#fef2f2' },
    high:     { label:'High',     color:'#ea580c', bg:'#fff7ed' },
    medium:   { label:'Medium',   color:'#2563eb', bg:'#eff6ff' },
    low:      { label:'Low',      color:'#16a34a', bg:'#f0fdf4' },
  };
  const STATUS = { backlog:'Backlog', todo:'To Do', 'in-progress':'In Progress', done:'Done' };

  // Gather + count
  const all = [];
  for (const [pk, page] of Object.entries(pages)) {
    for (const b of (page.bugs || [])) all.push({ ...b, _pk: pk, _pt: page.title });
  }
  if (!all.length) return '';

  const counts = { critical:0, high:0, medium:0, low:0 };
  all.forEach(b => { counts[b.severity] = (counts[b.severity]||0) + 1; });
  const pageCount = Object.keys(pages).length;
  const summary = Object.entries(counts).filter(([,n])=>n)
    .map(([s,n]) => `${n} ${SEV[s].label.toLowerCase()}`).join(', ');

  const sevBadge = b => {
    const s = SEV[b.severity] || SEV.medium;
    return `<span class="sev" style="color:${s.color};background:${s.bg}">${s.label}</span>`;
  };
  const bandOf = b => { const m = bandMeta(bugBandOf(b)); return `${m.icon} ${m.label}`; };

  // One section per page
  const sections = Object.entries(pages).map(([pk, page]) => {
    const bugs = (page.bugs || []).slice().sort((a,b)=>a.num-b.num);
    if (!bugs.length) return '';
    const items = bugs.map(b => `
      <article class="bug">
        <div class="bug-head">
          <span class="num">#${b.num}</span>
          <h3>${esc(b.title || 'Untitled')}</h3>
          ${sevBadge(b)}
          <span class="status">${STATUS[b.status] || esc(b.status || '')}</span>
        </div>
        ${b.description ? `<p class="desc">${esc(b.description).replace(/\n/g,'<br>')}</p>` : ''}
        <div class="rowline">
          ${b.assignee ? `<span><b>Assignee:</b> ${esc(b.assignee)}</span>` : ''}
          ${(b.tags||[]).length ? `<span><b>Tags:</b> ${esc(b.tags.join(', '))}</span>` : ''}
        </div>
        ${(includeShots && b.screenshot) ? `<img class="shot" src="${b.screenshot}" alt="Screenshot for bug ${b.num}"/>` : ''}
        <dl class="tech">
          ${b.element  ? `<div><dt>Element</dt><dd>${esc(b.element)}</dd></div>` : ''}
          ${b.url      ? `<div><dt>URL</dt><dd>${esc(b.url)}</dd></div>` : ''}
          <div><dt>Screen</dt><dd>${esc(b.viewport||'')} · ${bandOf(b)}</dd></div>
          ${b.browser  ? `<div><dt>Browser</dt><dd>${esc(b.browser)}</dd></div>` : ''}
          ${b.timestamp? `<div><dt>Reported</dt><dd>${new Date(b.timestamp).toLocaleString()}</dd></div>` : ''}
        </dl>
      </article>`).join('');
    return `
      <section class="page">
        <div class="page-head">
          <span class="page-path">${esc(pk)}</span>
          <span class="page-title">${esc(page.title || '')}</span>
          <span class="page-count">${bugs.length} bug${bugs.length===1?'':'s'}</span>
        </div>
        ${items}
      </section>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BugPin — ${esc(domain)}</title>
<style>
  :root{--ink:#17171b;--muted:#6b7280;--faint:#9ca3af;--rule:#e5e7eb;--paper:#fafafa;}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:var(--ink);background:var(--paper);line-height:1.5;padding:40px 20px}
  .wrap{max-width:820px;margin:0 auto}
  header{border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:8px}
  .brand{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;letter-spacing:.02em;color:#5b21b6}
  .pin{width:10px;height:10px;border-radius:50% 50% 50% 2px;transform:rotate(45deg);background:#5b21b6;display:inline-block}
  h1{font-size:24px;font-weight:650;letter-spacing:-.02em;margin:10px 0 4px}
  .meta{color:var(--muted);font-size:13px}
  .summary{margin-top:6px;font-size:13px;color:var(--ink)}
  section.page{margin-top:34px}
  .page-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-bottom:8px;border-bottom:1px solid var(--rule);margin-bottom:14px}
  .page-path{font-family:ui-monospace,Menlo,monospace;font-size:13px;font-weight:700;color:#5b21b6}
  .page-title{font-size:13px;color:var(--muted)}
  .page-count{margin-left:auto;font-size:12px;color:var(--faint)}
  article.bug{background:#fff;border:1px solid var(--rule);border-radius:10px;padding:16px 18px;margin-bottom:14px;page-break-inside:avoid}
  .bug-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .num{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--faint)}
  .bug-head h3{font-size:15px;font-weight:600;flex:1;min-width:0}
  .sev{font-size:11px;font-weight:700;padding:2px 9px;border-radius:99px}
  .status{font-size:11px;color:var(--muted);border:1px solid var(--rule);border-radius:99px;padding:2px 9px}
  .desc{margin:10px 0;font-size:13.5px;color:#374151;white-space:pre-wrap}
  .rowline{display:flex;gap:18px;flex-wrap:wrap;font-size:12.5px;color:var(--muted);margin-bottom:4px}
  .rowline b{color:var(--ink);font-weight:600}
  img.shot{display:block;width:100%;max-width:640px;border:1px solid var(--rule);border-radius:8px;margin:12px 0}
  dl.tech{margin-top:12px;border-top:1px dashed var(--rule);padding-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:4px 24px}
  dl.tech div{display:flex;gap:8px;font-size:11.5px}
  dl.tech dt{color:var(--faint);font-weight:600;min-width:58px}
  dl.tech dd{color:#374151;font-family:ui-monospace,Menlo,monospace;word-break:break-all}
  footer{margin-top:40px;padding-top:14px;border-top:1px solid var(--rule);font-size:11px;color:var(--faint);text-align:center}
  @media print{body{background:#fff;padding:0}.wrap{max-width:100%}article.bug{border-color:#ddd}}
</style></head>
<body><div class="wrap">
  <header>
    <div class="brand"><span class="pin"></span> BugPin</div>
    <h1>${esc(domain)}</h1>
    <div class="meta">${all.length} bug${all.length===1?'':'s'} across ${pageCount} page${pageCount===1?'':'s'} · generated ${new Date().toLocaleString()}</div>
    ${summary ? `<div class="summary">${summary}</div>` : ''}
  </header>
  ${sections}
  <footer>Exported from BugPin · ${esc(domain)}</footer>
</div></body></html>`;
}

$('sf-clear').addEventListener('click', () => {
  const scope = S.exportScope; // reuses the same This page / Whole site toggle
  const label = scope === 'site' ? 'the WHOLE SITE' : 'this page';
  const ok = confirm(`Delete all bugs on ${label}?\n\nThis cannot be undone.`);
  if (!ok) return;
  post('CLEAR_BUGS', { scope });
});

function flashShareNote(text) {
  const el = $('share-note');
  if (!el) return;
  const prev = el.textContent;
  el.textContent = text;
  el.style.color = '#5b21b6';
  clearTimeout(flashShareNote._t);
  flashShareNote._t = setTimeout(() => {
    el.textContent = prev;
    el.style.color = '';
  }, 3500);
}

/* ── Render ── */
function render() {
  const project = S.projects[S.domain];
  const total = Object.values(project?.pages || {}).reduce((n, p) => n + (p.bugs || []).length, 0);
  $('viewall-count').textContent = total;
  const tree    = $('stree');

  const hasOwn = project && Object.keys(project.pages||{}).length;

  if (!hasOwn) {
    tree.innerHTML = `
      <div class="empty">
        <div class="empty-icon">📋</div>
        <div class="empty-title">No bugs yet</div>
        <div class="empty-sub">Click "Report Bug" then click<br>any element on the page</div>
      </div>`;
    return;
  }

  // Build page groups for this domain only
  const pages = hasOwn ? Object.entries(project.pages) : [];

  const html = pages.map(([pageKey, page]) => {
    let bugs = [...(page.bugs||[])];

    // Apply filters
    if (S.sevFilter) bugs = bugs.filter(b => b.severity === S.sevFilter);
    if (S.search)    bugs = bugs.filter(b =>
      (b.title||'').toLowerCase().includes(S.search) ||
      (b.description||'').toLowerCase().includes(S.search) ||
      (b.assignee||'').toLowerCase().includes(S.search)
    );

    if (!bugs.length && (S.search || S.sevFilter)) return ''; // hide page if filtered out

    const isCurrentPage = pageKey === S.pageKey;
    const isOpen        = isCurrentPage || bugs.length <= 5;

    // Group this page's bugs by responsive band.
    const byBand = { mobile:[], tablet:[], desktop:[] };
    for (const b of bugs) (byBand[bugBandOf(b)] || byBand.desktop).push(b);

    // Order: current band first, then the others. Only render non-empty bands.
    const order = [S.viewBand, ...BANDS.map(b=>b.id).filter(id=>id!==S.viewBand)];
    const bandBlocks = order.filter(id => byBand[id].length).map(id => {
      const m = bandMeta(id);
      const isCurrentBand = id === S.viewBand;
      // When a filter is active, expand every band that has matches so the
      // filtered results are always visible. Otherwise only the current band
      // is open and the rest collapse.
      const filtering = !!(S.search || S.sevFilter);
      const bandOpen = filtering || isCurrentBand;
      return `
        <div class="band-group${isCurrentBand?' current-band':''}">
          <div class="band-header" data-band="${id}">
            <span class="band-chevron${bandOpen?' open':''}">›</span>
            <span class="band-icon">${m.icon}</span>
            <span class="band-label">${m.label}</span>
            ${isCurrentBand?'<span class="band-now">now</span>':''}
            <span class="band-count">${byBand[id].length}</span>
          </div>
          <div class="band-bugs${bandOpen?' open':''}">
            ${byBand[id].map(bug => bugRow(bug, pageKey)).join('')}
          </div>
        </div>`;
    }).join('');

    return `
      <div class="page-group${isCurrentPage?' current-page':''}" data-pagekey="${esc(pageKey)}">
        <div class="page-header" data-pagekey="${esc(pageKey)}">
          <span class="page-chevron${isOpen?' open':''}">›</span>
          <div style="flex:1;min-width:0">
            <div class="page-path">${esc(pageKey)}</div>
            <div class="page-title">${esc(page.title||pageKey)}</div>
          </div>
          <span class="page-count">${bugs.length}</span>
        </div>
        <div class="page-bugs${isOpen?' open':''}">
          ${bandBlocks}
        </div>
      </div>
    `;
  }).join('');

  tree.innerHTML = html ||
    `<div class="empty"><div class="empty-icon">🔍</div><div class="empty-title">No matches</div></div>`;

  // Page header toggle
  tree.querySelectorAll('.page-header').forEach(h => {
    h.addEventListener('click', () => {
      const chevron = h.querySelector('.page-chevron');
      const bugs    = h.nextElementSibling;
      chevron.classList.toggle('open');
      bugs.classList.toggle('open');
    });
  });

  // Band header toggle
  tree.querySelectorAll('.band-header').forEach(h => {
    h.addEventListener('click', () => {
      h.querySelector('.band-chevron').classList.toggle('open');
      h.nextElementSibling.classList.toggle('open');
    });
  });

  // Bug row click → detail
  tree.querySelectorAll('.bug-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.bug-check')) return;
      post('OPEN_BUG_DETAIL', { bugId: row.dataset.bugid, pageKey: row.dataset.pagekey });
    });
  });

  // Done checkbox
  tree.querySelectorAll('.bug-check').forEach(chk => {
    chk.addEventListener('click', e => {
      e.stopPropagation();
      const newStatus = chk.classList.contains('done') ? 'open' : 'done';
      post('BUG_STATUS_TOGGLE', {
        bugId:   chk.dataset.bugid,
        pageKey: chk.dataset.pagekey,
        status:  newStatus,
      });
      // Optimistic UI
      chk.classList.toggle('done');
      const titleEl = chk.closest('.bug-row')?.querySelector('.bug-title');
      if (titleEl) titleEl.classList.toggle('done');
    });
  });
}

function bugRow(bug, pageKey) {
  const isDone   = bug.status === 'done';
  const initials = (bug.assignee||'').trim().split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
  const sevDot   = {critical:'🔴',high:'🟠',medium:'🔵',low:'🟢'}[bug.severity]||'🔵';
  const timeStr  = bug.timestamp ? timeAgo(bug.timestamp) : '';

  return `
    <div class="bug-row" data-bugid="${bug.id}" data-pagekey="${esc(pageKey)}">
      <div class="bug-num sev-${bug.severity||'medium'}">${bug.num}</div>
      <div class="bug-body">
        <div class="bug-title${isDone?' done':''}">${esc(bug.title||'(no title)')}</div>
        <div class="bug-meta">
          <span>${sevDot} ${cap(bug.severity||'medium')}</span>
          ${bug.tags?.length?`<span>· ${bug.tags.slice(0,2).join(', ')}</span>`:''}
          ${bug.comments?.length?`<span>· 💬 ${bug.comments.length}</span>`:''}
          ${timeStr?`<span>· ${timeStr}</span>`:''}
        </div>
      </div>
      ${initials?`<div class="bug-avatar" title="${esc(bug.assignee)}">${initials}</div>`:''}
      <div class="bug-check${isDone?' done':''}" data-bugid="${bug.id}" data-pagekey="${esc(pageKey)}"></div>
    </div>
  `;
}

function timeAgo(iso) {
  const d=Date.now()-new Date(iso).getTime();
  const m=Math.floor(d/60000);
  if(m<1)return'just now';if(m<60)return`${m}m`;
  const h=Math.floor(m/60);if(h<24)return`${h}h`;
  return`${Math.floor(h/24)}d`;
}

function cap(s){return s?s[0].toUpperCase()+s.slice(1):'';}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
