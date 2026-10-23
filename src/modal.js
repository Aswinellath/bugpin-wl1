// BugPin — Modal Script
const $ = id => document.getElementById(id);
const post = (type, payload) => window.parent.postMessage({ type, payload }, '*');

const S = {
  pending: null, detailBug: null, screenshot: null,
  editing: false, domain: '', pageKey: '',
};

// ── Single message listener ───────────────────────────────────
window.addEventListener('message', e => {
  const { type, payload } = e.data || {};
  if (!type) return;

  if (type === 'MODAL_INIT') { init(payload); return; }

  if (type === 'MODAL_UPDATE_SS') {
    S.screenshot = payload.dataUrl;
    applyScreenshot(S.screenshot);
    return;
  }

  // Authoritative comment list from content.js — fires after our own post
  // saves, and also when a live peer adds a comment while this is open.
  if (type === 'COMMENTS_UPDATE') {
    if (S.detailBug && payload.bugId === S.detailBug.id) {
      S.detailBug.comments = payload.comments;
      renderComments(payload.comments);
    }
    return;
  }
});

// ── Init ─────────────────────────────────────────────────────
function init({ view, pending, bugId, pageKey, domain, screenshotOverride }) {
  S.domain  = domain  || S.domain;
  S.pageKey = pageKey || S.pageKey;
  if (view === 'form') {
    S.pending    = pending;
    S.screenshot = screenshotOverride || pending?.screenshot || null;
    S.editing    = false;
    resetForm();
    applyHeader(domain, pending?.pageTitle || pageKey);
    applyScreenshot(S.screenshot);
    showView('form');
  }
  if (view === 'detail') {
    loadDetail(bugId, pageKey || S.pageKey, domain || S.domain);
  }
}

function resetForm() {
  ['f-desc','f-assignee','f-tags'].forEach(id => $(id).value = '');
  $('f-severity').value       = '';
  $('f-status').value         = 'backlog';
  $('f-char').textContent     = '0';
  $('btn-create').textContent = 'Create task';
  $('btn-create').disabled    = false;
  $('btn-cancel').textContent = 'Cancel';
  $('mf-hint').hidden         = false;
  $('f-keep').checked         = false;

  // "Keep these settings" — if the last bug was filed with it on, restore
  // severity / status / assignee / tags so a run of similar bugs is quick.
  // Description always clears; it's unique per bug.
  chrome.storage.local.get('keepSettings', r => {
    const k = r.keepSettings;
    if (!k) return;
    $('f-severity').value = k.severity || '';
    $('f-status').value   = k.status   || 'backlog';
    $('f-assignee').value = k.assignee || '';
    $('f-tags').value     = k.tags     || '';
    $('f-keep').checked   = true;
  });
}

function applyHeader(domain, page) {
  $('form-domain').textContent = domain || '';
  $('form-page').textContent   = page   || '';
}

$('f-desc').addEventListener('input', () => {
  $('f-char').textContent = $('f-desc').value.length;
});

function applyScreenshot(url) {
  if (url) {
    $('ss-label').hidden = true;
    $('ss-img').src      = url;
    $('ss-img').hidden   = false;
    $('ss-del').hidden   = false;
    $('ss-btns').hidden  = false;
  } else {
    $('ss-label').hidden      = false;
    $('ss-label').textContent = '📸 No screenshot';
    $('ss-img').hidden        = true;
    $('ss-del').hidden        = true;
    $('ss-btns').hidden       = true;
  }
}

$('ss-del').addEventListener('click', () => {
  S.screenshot = null; applyScreenshot(null);
});

$('btn-ann').addEventListener('click', () => {
  if (!S.screenshot) return;
  post('OPEN_ANNOTATOR', { dataUrl: S.screenshot });
});
$('btn-crop').addEventListener('click', () => {
  if (!S.screenshot) return;
  post('OPEN_ANNOTATOR', { dataUrl: S.screenshot, defaultTool: 'crop' });
});

// ── Submit ───────────────────────────────────────────────────
$('btn-create').addEventListener('click', () => {
  const desc = $('f-desc').value.trim();
  if (!desc) {
    $('f-desc').style.borderColor = '#dc2626';
    $('f-desc').focus();
    return;
  }
  $('f-desc').style.borderColor = '';
  $('btn-create').disabled    = true;
  $('btn-create').textContent = 'Saving…';

  // Remember (or forget) settings for the next bug on this session.
  if ($('f-keep').checked) {
    chrome.storage.local.set({ keepSettings: {
      severity: $('f-severity').value || 'medium',
      status:   $('f-status').value   || 'backlog',
      assignee: $('f-assignee').value.trim(),
      tags:     $('f-tags').value.trim(),
    }});
  } else {
    chrome.storage.local.remove('keepSettings');
  }

  post(S.editing ? 'BUG_UPDATE' : 'BUG_SUBMIT', {
    title:       desc.slice(0, 80),
    description: desc,
    assignee:    $('f-assignee').value.trim(),
    severity:    $('f-severity').value || 'medium',
    status:      $('f-status').value   || 'backlog',
    tags:        $('f-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    screenshot:  S.screenshot,
    ...(S.editing ? { id: S.pending?.id, pageKey: S.pending?.pageKey } : {}),
  });
});

$('form-close').addEventListener('click', () => post('MODAL_CLOSE', {}));
$('btn-cancel').addEventListener('click',  () => post('MODAL_CLOSE', {}));

// ── Detail view ──────────────────────────────────────────────
function loadDetail(bugId, pageKey, domain) {
  chrome.storage.local.get('projects', r => {
    const bug = (r.projects||{})[domain]?.pages?.[pageKey]?.bugs?.find(b => b.id === bugId);
    if (!bug) { post('MODAL_CLOSE', {}); return; }
    S.detailBug = { ...bug, pageKey };
    renderDetail(bug, domain, pageKey, (r.projects||{})[domain]?.pages?.[pageKey]?.title);
    showView('detail');
  });
}

function renderDetail(bug, domain, pageKey, pageTitle) {
  $('d-badge').textContent = `#${bug.num}`;
  $('d-title').textContent = bug.title || '(no title)';
  $('d-desc').textContent  = bug.description || '—';
  const sevL = { critical:'🔴 Critical', high:'🟠 High', medium:'🔵 Medium', low:'🟢 Low' };
  const stL  = { backlog:'Backlog', todo:'To Do', 'in-progress':'In Progress', done:'Done' };
  $('d-meta').innerHTML = `
    <div class="dm-row"><span class="dm-lbl">Project</span><span class="dm-val" style="color:#1a56db;font-weight:600">${esc(domain)}</span></div>
    <div class="dm-row"><span class="dm-lbl">Page</span><span class="dm-val" style="color:#6b7280">${esc(pageTitle||pageKey)}</span></div>
    <div class="dm-row"><span class="dm-lbl">Severity</span><div><span class="sev-chip ${bug.severity||'medium'}">${sevL[bug.severity||'medium']}</span></div></div>
    <div class="dm-row"><span class="dm-lbl">Status</span><div><span class="st-chip">${stL[bug.status||'backlog']||bug.status}</span></div></div>
    ${bug.assignee?`<div class="dm-row"><span class="dm-lbl">Assignee</span><span class="dm-val">${esc(bug.assignee)}</span></div>`:''}
    ${(bug.tags||[]).length?`<div class="dm-row"><span class="dm-lbl">Tags</span><span class="dm-val">${bug.tags.join(', ')}</span></div>`:''}
    <div class="dm-row"><span class="dm-lbl">Element</span><span class="dm-val" style="font-size:11px;font-family:monospace;word-break:break-all">${esc(bug.element||'')}</span></div>
    <div class="dm-row"><span class="dm-lbl">Browser</span><span class="dm-val" style="font-size:11px">${esc(bug.browser||'')} · ${esc(bug.viewport||'')}</span></div>
    <div class="dm-row"><span class="dm-lbl">Reported</span><span class="dm-val" style="font-size:11px">${bug.timestamp?new Date(bug.timestamp).toLocaleString():''}</span></div>
  `;
  $('d-ss').innerHTML = bug.screenshot
    ? `<img src="${bug.screenshot}" style="width:100%;border-radius:7px;border:1px solid #e5e7eb;margin-top:10px"/>`
    : '';
  renderComments(bug.comments || []);
}

// ── Comments ─────────────────────────────────────────────────
function renderComments(comments) {
  $('c-count').textContent = comments.length ? `(${comments.length})` : '';
  $('c-list').innerHTML = comments.length
    ? comments.map(c => `
        <div class="comment">
          <div class="comment-head">
            <span class="comment-author">${esc(c.author || 'Anonymous')}</span>
            <span class="comment-time">${timeAgo(c.timestamp)}</span>
          </div>
          <div class="comment-text">${esc(c.text)}</div>
        </div>`).join('')
    : `<div class="comments-empty">No comments yet</div>`;
  $('c-list').scrollTop = $('c-list').scrollHeight;

  // Ask for a name once; after that, go straight to the comment box.
  chrome.storage.local.get('authorName', r => {
    const hasName = !!(r.authorName || '').trim();
    $('c-name-box').hidden = hasName;
    $('c-add-box').hidden  = !hasName;
  });
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return new Date(iso).toLocaleDateString();
}

$('c-name-save').addEventListener('click', () => {
  const name = $('c-name-input').value.trim();
  if (!name) { $('c-name-input').focus(); return; }
  chrome.storage.local.set({ authorName: name }, () => {
    $('c-name-box').hidden = true;
    $('c-add-box').hidden  = false;
    $('c-input').focus();
  });
});
$('c-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('c-name-save').click(); });

$('c-post').addEventListener('click', () => {
  const text = $('c-input').value.trim();
  if (!text || !S.detailBug) return;
  chrome.storage.local.get('authorName', r => {
    const comment = {
      id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      author: (r.authorName || 'Anonymous').trim(),
      text,
      timestamp: new Date().toISOString(),
    };
    post('BUG_COMMENT', { id: S.detailBug.id, pageKey: S.detailBug.pageKey, comment });
    $('c-input').value = '';
    // Optimistic local render — content.js will also send COMMENTS_UPDATE
    // back, which is the source of truth if it differs.
    const merged = [...(S.detailBug.comments || []), comment];
    S.detailBug.comments = merged;
    renderComments(merged);
  });
});
$('c-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('c-post').click();
});

$('detail-close').addEventListener('click', () => post('MODAL_CLOSE', {}));
$('d-close').addEventListener('click',      () => post('MODAL_CLOSE', {}));
$('btn-del').addEventListener('click', () => {
  if (!confirm('Delete this bug?')) return;
  post('BUG_DELETE', { id: S.detailBug.id, pageKey: S.detailBug.pageKey });
});
$('btn-edit').addEventListener('click', () => {
  const bug     = S.detailBug;
  S.editing     = true;
  S.pending     = { ...bug };
  S.screenshot  = bug.screenshot || null;
  $('f-desc').value     = bug.description || '';
  $('f-assignee').value = bug.assignee    || '';
  $('f-severity').value = bug.severity    || 'medium';
  $('f-status').value   = bug.status      || 'backlog';
  $('f-tags').value     = (bug.tags||[]).join(', ');
  $('f-char').textContent = $('f-desc').value.length;
  $('btn-create').textContent = '💾 Save Changes';
  applyHeader(S.domain, bug.pageTitle || bug.pageKey || S.pageKey);
  applyScreenshot(S.screenshot);
  showView('form');
});

function showView(name) {
  document.querySelectorAll('.bp-view').forEach(v =>
    v.classList.toggle('hidden', v.id !== `view-${name}`)
  );
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
