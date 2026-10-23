// ============================================================
// BugPin v6 — Content Script
// Annotation works as an OVERLAY on the live page
// ============================================================
(() => {
  if (window.__bugpin6) return;
  window.__bugpin6 = true;

  // ── Page identity ──────────────────────────────────────────
  const PAGE_URL   = location.href;
  const DOMAIN     = (() => { try { return new URL(PAGE_URL).hostname; } catch { return PAGE_URL; } })();
  const PAGE_KEY   = (() => { try { const u = new URL(PAGE_URL); return u.pathname + u.search; } catch { return PAGE_URL; } })();
  const PAGE_TITLE = document.title || PAGE_KEY;

  // ── State ──────────────────────────────────────────────────
  let active      = false;   // click-to-pin mode
  let sidebarOpen = false;
  let pins        = [];
  let sidebarEl   = null;
  let modalBgEl   = null;
  let modalEl     = null;
  let tabEl       = null;
  let pendingCtx  = null;    // click context before modal opens

  let showAllSizes  = false; // when true, ignore the band filter

  // ── Annotation state ───────────────────────────────────────
  const ANN = {
    open:      false,
    mode:      'pen',      // pen | rect | arrow | text | crop
    color:     '#ef4444',
    stroke:    3,
    drawing:   false,
    startX:    0, startY: 0,
    history:   [],          // ImageData snapshots for undo
    cropRect:  null,        // { x,y,w,h } in viewport coords
    onDone:    null,        // callback(annotatedDataUrl | null)
    scrollLock: null,       // saved scroll/overflow to restore on close
  };

  let annOverlay  = null;   // #bp-ann-overlay div
  let annCanvas   = null;   // <canvas>
  let annCtx      = null;
  let annToolbar  = null;   // floating toolbar
  let cropSelEl   = null;   // #bp-crop-select div
  let baseDataUrl = null;   // original screenshot before annotation

  // ── Boot ───────────────────────────────────────────────────
  (async () => {
    const stored = await stor(['activeMode']);
    // Pins are only drawn while BugPin is activated on this tab (Reading B) —
    // they don't render on a plain page load, and they're re-drawn from
    // storage each time the user activates, not created once and hidden.
    if (sessionStorage.getItem('bp-activated') === '1') {
      const bugs = await getPageBugs(DOMAIN, PAGE_KEY);
      bugs.forEach(placePin);
      buildTab();
      updateTabCount(bugs.length);
    }
    if (stored.activeMode) enableMode();
    LIVE.resume();   // rejoin a live session that was running before this page loaded
  })();

  // React immediately when bug-reporting mode is toggled elsewhere
  // (e.g. the sidebar's "Report Bug" button), so it works without a refresh.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.activeMode) return;
    const on = changes.activeMode.newValue;
    if (on && !active) enableMode();
    else if (!on && active) disableMode();
  });

  // ── Message handler ────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    switch (msg.type) {
      case 'PING':
        respond({ alive: true });
        return false;
      case 'TOGGLE_MODE':
        if (active) disableMode(); else enableMode();
        respond({ active });
        return false;
      case 'OPEN_SIDEBAR':
        openSidebar();
        respond({ ok: true });
        return false;
      case 'TOGGLE_SIDEBAR':
        // The toolbar icon activates or deactivates BugPin on this tab.
        if (tabEl) {
          // Already active → remove the tab and close the sidebar.
          deactivate();
        } else {
          // Not active → show the tab and open the sidebar.
          activate();
        }
        respond({ ok: true });
        return false;

      default:
        return false;
    }
  });

  // ── Window messages (iframes → page) ──────────────────────
  window.addEventListener('message', async e => {
    const { type, payload } = e.data || {};

    // From modal iframe
    if (e.source === modalEl?.contentWindow) {
      if (type === 'MODAL_CLOSE') { closeModal(); return; }

      // Modal asks to open annotation overlay on this page
      if (type === 'OPEN_ANNOTATOR') {
        // Preserve context BEFORE closeModal clears pendingCtx
        const savedCtx = { ...pendingCtx };
        modalBgEl?.classList.add('bp-hide'); // hide modal without clearing pendingCtx
        openAnnotationOverlay(payload.dataUrl, (annotated) => {
          // Restore context with the annotated screenshot
          pendingCtx = { ...savedCtx, screenshot: annotated || payload.dataUrl };
          modalBgEl?.classList.remove('bp-hide'); // show modal again
          // The modal iframe was only hidden, so the form fields the user
          // typed are still intact. Update ONLY the screenshot — a full
          // MODAL_INIT here would reset the form and wipe their input.
          sendToModal('MODAL_UPDATE_SS', { dataUrl: pendingCtx.screenshot });
        });
        return;
      }

      if (type === 'BUG_SUBMIT') {
        const bug = { ...pendingCtx, ...payload, id: 'bp_' + Date.now() };
        const projects = await addBug(DOMAIN, PAGE_KEY, PAGE_TITLE, bug);
        closeModal();
        placePin(bug);
        const pageBugs = projects[DOMAIN]?.pages?.[PAGE_KEY]?.bugs || [];
        updateTabCount(pageBugs.length);
        postSidebar('PROJECTS_UPDATE', { projects, domain: DOMAIN, pageKey: PAGE_KEY });
        LIVE.broadcast({ kind: 'upsert', pageKey: PAGE_KEY, pageTitle: PAGE_TITLE, bug });
      }
      if (type === 'BUG_UPDATE') {
        const projects = await updateBugStore(DOMAIN, payload.pageKey || PAGE_KEY, payload.id, payload);
        closeModal(); refreshPin(payload);
        postSidebar('PROJECTS_UPDATE', { projects, domain: DOMAIN, pageKey: PAGE_KEY });
        const updated = projects[DOMAIN]?.pages?.[payload.pageKey || PAGE_KEY]?.bugs?.find(b => b.id === payload.id);
        if (updated) LIVE.broadcast({ kind: 'upsert', pageKey: payload.pageKey || PAGE_KEY, bug: updated });
      }
      if (type === 'BUG_DELETE') {
        const projects = await deleteBugStore(DOMAIN, payload.pageKey || PAGE_KEY, payload.id);
        closeModal(); removePin(payload.id);
        const pageBugs = projects[DOMAIN]?.pages?.[PAGE_KEY]?.bugs || [];
        updateTabCount(pageBugs.length);
        postSidebar('PROJECTS_UPDATE', { projects, domain: DOMAIN, pageKey: PAGE_KEY });
        LIVE.broadcast({ kind: 'delete', pageKey: payload.pageKey || PAGE_KEY, id: payload.id });
      }
      if (type === 'BUG_COMMENT') {
        const pk = payload.pageKey || PAGE_KEY;
        const { projects, comments } = await addCommentStore(DOMAIN, pk, payload.id, payload.comment);
        sendToModal('COMMENTS_UPDATE', { bugId: payload.id, comments });
        postSidebar('PROJECTS_UPDATE', { projects, domain: DOMAIN, pageKey: PAGE_KEY });
        LIVE.broadcast({ kind: 'comment', pageKey: pk, bugId: payload.id, comment: payload.comment });
      }
    }

    // From sidebar iframe
    if (e.source === sidebarEl?.contentWindow) {
      if (type === 'SIDEBAR_CLOSE') { closeSidebar(); return; }
      if (type === 'TOGGLE_SHOW_ALL') { setShowAllSizes(payload.showAll); return; }
      if (type === 'OPEN_BUG_DETAIL') {
        if (payload.pageKey === PAGE_KEY) scrollToPin(payload.bugId);
        openModal({ view: 'detail', bugId: payload.bugId, pageKey: payload.pageKey });
      }
      if (type === 'BUG_STATUS_TOGGLE') {
        const projects = await updateBugStore(DOMAIN, payload.pageKey, payload.bugId, { status: payload.status });
        postSidebar('PROJECTS_UPDATE', { projects, domain: DOMAIN, pageKey: PAGE_KEY });
        const updated = projects[DOMAIN]?.pages?.[payload.pageKey]?.bugs?.find(b => b.id === payload.bugId);
        if (updated) LIVE.broadcast({ kind: 'upsert', pageKey: payload.pageKey, bug: updated });
      }
      if (type === 'LIVE_START') { LIVE.startHost(); return; }
      if (type === 'LIVE_JOIN')  { LIVE.join(payload.code); return; }
      if (type === 'LIVE_LEAVE') { LIVE.leave(); return; }
      if (type === 'CLEAR_BUGS') {
        const scope = payload.scope === 'site' ? 'site' : 'page';
        const projects = await loadProjects();
        const project = projects[DOMAIN];
        let clearedCount = 0;
        const deleted = [];   // { pageKey, id } — for broadcasting to live peers
        if (project) {
          if (scope === 'page') {
            const page = project.pages?.[PAGE_KEY];
            if (page) {
              clearedCount = page.bugs.length;
              page.bugs.forEach(b => deleted.push({ pageKey: PAGE_KEY, id: b.id }));
              page.bugs = [];
            }
          } else {
            for (const [pk, page] of Object.entries(project.pages || {})) {
              clearedCount += page.bugs.length;
              page.bugs.forEach(b => deleted.push({ pageKey: pk, id: b.id }));
              page.bugs = [];
            }
          }
          await saveProjects(projects);
        }
        clearOwnPins();               // this page's pins are gone either way
        updateTabCount(0);
        postSidebar('PROJECTS_UPDATE', { projects, domain: DOMAIN, pageKey: PAGE_KEY });
        postSidebar('CLEAR_DONE', { count: clearedCount, scope });
        deleted.forEach(d => LIVE.broadcast({ kind: 'delete', pageKey: d.pageKey, id: d.id }));
        return;
      }
    }
  });

  // ── Mode ───────────────────────────────────────────────────
  function enableMode() {
    active = true;
    chrome.storage.local.set({ activeMode: true });
    document.body.classList.add('bp-mode');
    document.addEventListener('click', onPageClick, true);
    if (tabEl) tabEl.classList.add('mode-active');
    updateModeBtn();
  }
  function disableMode() {
    active = false;
    chrome.storage.local.set({ activeMode: false });
    document.body.classList.remove('bp-mode');
    document.removeEventListener('click', onPageClick, true);
    if (tabEl) tabEl.classList.remove('mode-active');
    updateModeBtn();
  }

  // ── Page click → capture + open modal ─────────────────────
  function onPageClick(e) {
    if (isOurEl(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    // Anchor the pin to the clicked element so it can be re-found later,
    // even at a different window size or after the page reflows.
    const anchor = computeAnchor(e.target, e.clientX, e.clientY);
    // Set context immediately — don't wait for screenshot
    pendingCtx = {
      x: e.pageX, y: e.pageY,
      anchor,                                   // { selector, relX, relY }
      element:   describeEl(e.target),
      url:       PAGE_URL, pageKey: PAGE_KEY, pageTitle: PAGE_TITLE,
      browser:   getBrowser(),
      viewport:  `${window.innerWidth}×${window.innerHeight}`,
      band:      currentBand(),                 // responsive tier at capture
      timestamp: new Date().toISOString(),
      screenshot: null,
    };
    openModal({ view: 'form' });
    // Capture screenshot in background — update modal when ready
    captureScreenshot().then(ss => {
      if (ss && pendingCtx) {
        pendingCtx.screenshot = ss;
        sendToModal('MODAL_UPDATE_SS', { dataUrl: ss });
      }
    });
  }

  // ── Activation (driven by the toolbar icon) ────────────────
  // "Active" = pins are drawn on the page and the floating tab exists.
  // Persisted for the tab session so it survives in-site navigation.
  async function activate() {
    buildTab();
    sessionStorage.setItem('bp-activated', '1');
    const bugs = await getPageBugs(DOMAIN, PAGE_KEY);
    if (!pins.length) bugs.forEach(placePin);   // draw pins if not already drawn
    updateTabCount(bugs.length);
    openSidebar();
  }
  function deactivate() {
    closeSidebar();
    if (active) disableMode();     // also leave pin mode if it was on
    removeTab();
    clearOwnPins();                // pins hide until reactivated; data is untouched
    sessionStorage.removeItem('bp-activated');
  }
  function clearOwnPins() {
    pins.forEach(p => p.el.remove());
    pins = [];
  }
  function removeTab() {
    tabEl?.remove();
    tabEl = null;
  }

  // ── Tab ────────────────────────────────────────────────────
  function buildTab() {
    if (document.getElementById('bp-tab')) return;
    tabEl = document.createElement('div');
    tabEl.id = 'bp-tab';
    tabEl.innerHTML = `
      <button class="bp-tab-btn" id="bp-open-sb" title="Open BugPin">📌</button>
      <span id="bp-tab-count">0</span>
      <button class="bp-tab-btn" id="bp-mode-btn"></button>
    `;
    document.body.appendChild(tabEl);
    // While active, the tab button is a handle that opens/closes the sidebar.
    document.getElementById('bp-open-sb').onclick = () => sidebarOpen ? closeSidebar() : openSidebar();
    // Start / stop Report Bug mode without opening the sidebar.
    document.getElementById('bp-mode-btn').onclick = () => active ? disableMode() : enableMode();
    if (active) tabEl.classList.add('mode-active');
    updateModeBtn();
  }
  // Keeps the tab's mode button in step with whether Report Bug mode is on.
  function updateModeBtn() {
    const b = document.getElementById('bp-mode-btn');
    if (!b) return;
    b.textContent = active ? '⏹' : '✚';
    b.title = active ? 'Stop reporting bugs' : 'Start reporting bugs';
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  function updateTabCount(n) {
    const el = document.getElementById('bp-tab-count');
    if (el) el.textContent = n;
  }

  // ── Sidebar ────────────────────────────────────────────────
  function openSidebar() {
    sidebarOpen = true;
    if (!sidebarEl) {
      sidebarEl = document.createElement('iframe');
      sidebarEl.id  = 'bp-sidebar';
      sidebarEl.src = chrome.runtime.getURL('src/sidebar.html');
      document.body.appendChild(sidebarEl);
      sidebarEl.addEventListener('load', async () => {
        const projects = await loadProjects();
        postSidebar('INIT', { projects, domain: DOMAIN, pageKey: PAGE_KEY });
        pushViewportInfo();
        LIVE.pushStatus();
      });
    } else {
      sidebarEl.classList.remove('bp-hide');
      loadProjects().then(p => postSidebar('PROJECTS_UPDATE', { projects: p, domain: DOMAIN, pageKey: PAGE_KEY }));
      pushViewportInfo();
    }
  }
  function closeSidebar() {
    sidebarOpen = false;
    sidebarEl?.classList.add('bp-hide');
  }
  function postSidebar(type, payload) {
    sidebarEl?.contentWindow?.postMessage({ type, payload }, '*');
  }

  // ── Modal ──────────────────────────────────────────────────
  function openModal(initData) {
    if (!modalBgEl) {
      modalBgEl = document.createElement('div');
      modalBgEl.id = 'bp-modal-bg';
      // Start hidden — revealed after current event loop tick clears,
      // so the triggering click doesn't immediately close it via the
      // modalBgEl click handler below.
      modalBgEl.classList.add('bp-hide');
      modalEl = document.createElement('iframe');
      modalEl.id  = 'bp-modal';
      modalEl.src = chrome.runtime.getURL('src/modal.html');
      modalBgEl.appendChild(modalEl);
      document.body.appendChild(modalBgEl);
      // Only close when clicking the dark backdrop itself, not the iframe
      modalBgEl.addEventListener('click', e => { if (e.target === modalBgEl) closeModal(); });
      modalEl.addEventListener('load', () => {
        sendToModal('MODAL_INIT', buildModalPayload(initData));
        // Show after iframe has loaded — the triggering click is long gone
        modalBgEl.classList.remove('bp-hide');
      });
    } else {
      // Snapshot payload now (pendingCtx may change by timeout tick)
      const payload = buildModalPayload(initData);
      // Defer reveal by one tick so the triggering click finishes propagating
      // before the backdrop becomes interactive
      setTimeout(() => {
        modalBgEl.classList.remove('bp-hide');
        sendToModal('MODAL_INIT', payload);
      }, 50);
    }
  }
  function buildModalPayload(initData) {
    return {
      ...initData,
      pending: pendingCtx,
      domain: DOMAIN,
      pageKey: PAGE_KEY,
    };
  }
  function closeModal() {
    modalBgEl?.classList.add('bp-hide');
    pendingCtx = null;
  }
  function sendToModal(type, payload) {
    modalEl?.contentWindow?.postMessage({ type, payload }, '*');
  }

  // ============================================================
  // ANNOTATION OVERLAY — draws directly on the live page
  // ============================================================
  function openAnnotationOverlay(screenshotDataUrl, onDone) {
    ANN.open    = true;
    ANN.onDone  = onDone;
    ANN.history = [];
    ANN.cropRect = null;
    ANN.mode    = 'pen';
    baseDataUrl = screenshotDataUrl;

    // ── Overlay div ─────────────────────────────────────────
    annOverlay = document.createElement('div');
    annOverlay.id = 'bp-ann-overlay';
    annOverlay.classList.add('active');

    // Freeze the page: lock scroll and remember where we were so the
    // frozen screenshot lines up and nothing shifts underneath.
    ANN.scrollLock = { x: window.scrollX, y: window.scrollY, overflow: document.documentElement.style.overflow, bodyOverflow: document.body.style.overflow };
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';

    // The captured screenshot, fully opaque — you're editing the frozen
    // capture, so the live page must not show through.
    const bgImg = document.createElement('img');
    bgImg.src = screenshotDataUrl;
    bgImg.style.cssText = `
      position:fixed;top:0;left:0;
      width:${window.innerWidth}px;height:${window.innerHeight}px;
      object-fit:cover;opacity:1;pointer-events:none;
    `;
    annOverlay.appendChild(bgImg);

    // ── Canvas ──────────────────────────────────────────────
    annCanvas = document.createElement('canvas');
    annCanvas.id = 'bp-ann-canvas';
    annCanvas.width  = window.innerWidth;
    annCanvas.height = window.innerHeight;
    annCanvas.style.cssText = 'position:fixed;top:0;left:0;';
    // Force crosshair on both overlay and canvas regardless of bp-mode class
    annOverlay.style.cursor = 'crosshair';
    annCanvas.style.cursor  = 'crosshair';
    annCtx = annCanvas.getContext('2d');
    annOverlay.appendChild(annCanvas);
    document.body.appendChild(annOverlay);

    // ── Crop selection div ──────────────────────────────────
    cropSelEl = document.createElement('div');
    cropSelEl.id = 'bp-crop-select';
    document.body.appendChild(cropSelEl);

    // ── Canvas events ───────────────────────────────────────
    // Pointer events cover mouse, touch and pen; touch-action:none stops the
    // browser from scrolling/zooming while a finger is drawing.
    annCanvas.style.touchAction = 'none';
    annCanvas.addEventListener('pointerdown',   annMouseDown);
    annCanvas.addEventListener('pointermove',   annMouseMove);
    annCanvas.addEventListener('pointerup',     annMouseUp);
    annCanvas.addEventListener('pointercancel', annMouseUp);

    saveHistory();
    buildToolbar();
  }

  function closeAnnotationOverlay(save) {
    ANN.open = false;
    hideCropHint();
    document.getElementById('bp-crop-hint')?.remove();

    // Unfreeze the page — restore overflow and scroll position.
    if (ANN.scrollLock) {
      document.documentElement.style.overflow = ANN.scrollLock.overflow || '';
      document.body.style.overflow = ANN.scrollLock.bodyOverflow || '';
      window.scrollTo(ANN.scrollLock.x, ANN.scrollLock.y);
      ANN.scrollLock = null;
    }

    if (!save) {
      // Teardown immediately
      annOverlay?.remove();  annOverlay = null;
      annToolbar?.remove();  annToolbar = null;
      cropSelEl?.remove();   cropSelEl  = null;
      annCanvas = null; annCtx = null;
      ANN.onDone?.(null);
      return;
    }

    // ── Capture canvas data NOW before teardown ──────────────
    const canvasSnapshot = annCanvas
      ? annCanvas.toDataURL('image/png')   // full drawing layer as PNG
      : null;
    const cropRect  = ANN.cropRect && ANN.cropRect.w > 10 && ANN.cropRect.h > 10
      ? { ...ANN.cropRect }
      : null;
    const vw        = window.innerWidth;
    const vh        = window.innerHeight;
    const onDoneCb  = ANN.onDone;

    // Remove any floating text inputs left by the text tool
    document.querySelectorAll('input[placeholder="Type\u2026"]').forEach(el => el.remove());
    // Teardown DOM elements first
    annOverlay?.remove();  annOverlay = null;
    annToolbar?.remove();  annToolbar = null;
    cropSelEl?.remove();   cropSelEl  = null;
    document.getElementById('bp-crop-hint')?.remove();
    annCanvas = null; annCtx = null;

    // Now do async merge with the already-captured data
    const baseImg = new Image();
    baseImg.onload = () => {
      const mergeCanvas = document.createElement('canvas');
      const mCtx = mergeCanvas.getContext('2d');

      if (cropRect) {
        // Crop mode: extract selected region from original screenshot
        const scaleX = baseImg.naturalWidth  / vw;
        const scaleY = baseImg.naturalHeight / vh;
        mergeCanvas.width  = cropRect.w;
        mergeCanvas.height = cropRect.h;
        mCtx.drawImage(baseImg,
          cropRect.x * scaleX, cropRect.y * scaleY,
          cropRect.w * scaleX, cropRect.h * scaleY,
          0, 0, cropRect.w, cropRect.h
        );
        // Overlay the drawing layer (crop region only)
        if (canvasSnapshot) {
          const drawImg = new Image();
          drawImg.onload = () => {
            mCtx.drawImage(drawImg, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, cropRect.w, cropRect.h);
            onDoneCb?.(mergeCanvas.toDataURL('image/png'));
          };
          drawImg.src = canvasSnapshot;
        } else {
          onDoneCb?.(mergeCanvas.toDataURL('image/png'));
        }
      } else {
        // Full viewport: screenshot + drawing layer
        mergeCanvas.width  = vw;
        mergeCanvas.height = vh;
        mCtx.drawImage(baseImg, 0, 0, vw, vh);
        if (canvasSnapshot) {
          const drawImg = new Image();
          drawImg.onload = () => {
            mCtx.drawImage(drawImg, 0, 0);
            onDoneCb?.(mergeCanvas.toDataURL('image/png'));
          };
          drawImg.src = canvasSnapshot;
        } else {
          onDoneCb?.(mergeCanvas.toDataURL('image/png'));
        }
      }
    };
    baseImg.onerror = () => onDoneCb?.(canvasSnapshot); // fallback
    baseImg.src = baseDataUrl;
  }

  // ── Toolbar ────────────────────────────────────────────────
  function buildToolbar() {
    annToolbar = document.createElement('div');
    annToolbar.id = 'bp-ann-toolbar';
    annToolbar.innerHTML = `
      <button class="bp-tb-btn bp-tb-toggle" id="bp-tb-toggle" aria-expanded="false">✏️ Pen ▾</button>
      <div class="bp-tb-tools">
        <button class="bp-tb-btn active" data-tool="pen"  >✏️ Pen</button>
        <button class="bp-tb-btn"        data-tool="rect" >⬜ Rect</button>
        <button class="bp-tb-btn"        data-tool="arrow">↗ Arrow</button>
        <button class="bp-tb-btn"        data-tool="text" >T Text</button>
        <button class="bp-tb-btn"        data-tool="crop" >✂️ Crop</button>
        <div class="bp-tb-sep"></div>
        <div class="bp-color active" style="background:#ef4444" data-color="#ef4444" title="Red"></div>
        <div class="bp-color"        style="background:#f97316" data-color="#f97316" title="Orange"></div>
        <div class="bp-color"        style="background:#eab308" data-color="#eab308" title="Yellow"></div>
        <div class="bp-color"        style="background:#22c55e" data-color="#22c55e" title="Green"></div>
        <div class="bp-color"        style="background:#6366f1" data-color="#6366f1" title="Purple"></div>
        <div class="bp-color"        style="background:#fff"    data-color="#ffffff" title="White"></div>
        <div class="bp-tb-sep"></div>
        <div class="bp-stroke-wrap">
          <input type="range" id="bp-stroke" min="1" max="16" value="3"/>
          <span class="bp-stroke-lbl" id="bp-sw">3</span>
        </div>
        <div class="bp-tb-sep"></div>
        <button class="bp-tb-btn" id="bp-undo">↩ Undo</button>
        <button class="bp-tb-btn" id="bp-clear-ann">🗑</button>
      </div>
      <div class="bp-tb-actions">
        <div class="bp-tb-sep"></div>
        <button class="bp-tb-btn bp-confirm" id="bp-ann-confirm">✓ Done</button>
        <button class="bp-tb-btn bp-cancel-ann" id="bp-ann-cancel">✕ Cancel</button>
      </div>
    `;
    document.body.appendChild(annToolbar);

    // Compact layout: the Tools button opens/closes the tool panel.
    const tbToggle = annToolbar.querySelector('#bp-tb-toggle');
    tbToggle.addEventListener('click', () => {
      const open = annToolbar.classList.toggle('open');
      tbToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // Tool buttons
    annToolbar.querySelectorAll('[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        ANN.mode = btn.dataset.tool;
        annToolbar.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Compact (narrow-screen) layout: show the active tool on the Tools
        // button and fold the panel away so the canvas has the room.
        annToolbar.querySelector('#bp-tb-toggle').textContent = btn.textContent.trim() + ' ▾';
        collapseToolbarIfCompact();
        // Show/hide crop hint
        const cur = ANN.mode === 'text' ? 'text' : 'crosshair';
        annCanvas.style.cursor  = cur;
        annOverlay.style.cursor = cur;
        if (ANN.mode === 'crop') showCropHint();
        else hideCropHint();
      });
    });

    // Colors
    annToolbar.querySelectorAll('.bp-color').forEach(d => {
      d.addEventListener('click', () => {
        ANN.color = d.dataset.color;
        annToolbar.querySelectorAll('.bp-color').forEach(x => x.classList.remove('active'));
        d.classList.add('active');
      });
    });

    // Stroke
    const strokeEl = annToolbar.querySelector('#bp-stroke');
    strokeEl.addEventListener('input', () => {
      ANN.stroke = +strokeEl.value;
      annToolbar.querySelector('#bp-sw').textContent = ANN.stroke;
    });

    // Undo
    annToolbar.querySelector('#bp-undo').addEventListener('click', () => {
      if (ANN.history.length > 1) {
        ANN.history.pop();
        annCtx.putImageData(ANN.history[ANN.history.length - 1], 0, 0);
      }
    });

    // Clear
    annToolbar.querySelector('#bp-clear-ann').addEventListener('click', () => {
      annCtx.clearRect(0, 0, annCanvas.width, annCanvas.height);
      ANN.history = [];
      saveHistory();
    });

    // Confirm
    annToolbar.querySelector('#bp-ann-confirm').addEventListener('click', () => {
      closeAnnotationOverlay(true);
    });

    // Cancel
    annToolbar.querySelector('#bp-ann-cancel').addEventListener('click', () => {
      closeAnnotationOverlay(false);
    });
  }

  function collapseToolbarIfCompact() {
    if (!annToolbar) return;
    if (window.matchMedia('(max-width: 920px)').matches) {
      annToolbar.classList.remove('open');
      annToolbar.querySelector('#bp-tb-toggle')?.setAttribute('aria-expanded', 'false');
    }
  }

  function showCropHint() {
    let hint = document.getElementById('bp-crop-hint');
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'bp-crop-hint';
      hint.style.cssText = `
        position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
        max-width:calc(100vw - 24px);text-align:center;
        background:rgba(99,102,241,.9);color:#fff;
        padding:7px 18px;border-radius:99px;font-size:12px;font-weight:600;
        font-family:-apple-system,sans-serif;z-index:2147483646;
        pointer-events:none;
      `;
      hint.textContent = '✂️ Drag to select a region — click ✓ Done to crop & save';
      document.body.appendChild(hint);
    }
  }
  function hideCropHint() {
    document.getElementById('bp-crop-hint')?.remove();
  }

  // ── Canvas drawing ─────────────────────────────────────────
  function annMouseDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { annCanvas.setPointerCapture(e.pointerId); } catch (_) {}
    collapseToolbarIfCompact();
    ANN.drawing = true;
    const [x, y] = canvasPos(e);
    ANN.startX = x; ANN.startY = y;

    if (ANN.mode === 'pen') {
      annCtx.beginPath();
      annCtx.moveTo(x, y);
    }
    if (ANN.mode === 'text') {
      ANN.drawing = false;
      // Use viewport coords (clientX/Y) for the fixed-position input overlay,
      // but canvas-relative coords (x,y) for drawing the text onto the canvas
      placeTextInput(e.clientX, e.clientY, x, y);
    }
    if (ANN.mode === 'crop') {
      ANN.cropRect = null;
      // Clear canvas back to last annotation snapshot (removes previous dim)
      if (ANN.history.length) {
        annCtx.putImageData(ANN.history[ANN.history.length - 1], 0, 0);
      }
    }
  }

  function annMouseMove(e) {
    if (!ANN.drawing) return;
    const [x, y] = canvasPos(e);

    if (ANN.mode === 'pen') {
      annCtx.strokeStyle = ANN.color;
      annCtx.lineWidth   = ANN.stroke;
      annCtx.lineCap     = 'round';
      annCtx.lineJoin    = 'round';
      annCtx.lineTo(x, y);
      annCtx.stroke();
      return;
    }

    if (ANN.mode === 'crop') {
      drawCropDim(ANN.startX, ANN.startY, x, y);
      return;
    }

    // For rect/arrow: restore snapshot then draw preview
    if (ANN.history.length) {
      annCtx.putImageData(ANN.history[ANN.history.length - 1], 0, 0);
    }
    drawShape(ANN.mode, ANN.startX, ANN.startY, x, y, true);
  }

  function annMouseUp(e) {
    if (!ANN.drawing) return;
    ANN.drawing = false;
    const [x, y] = canvasPos(e);

    if (ANN.mode === 'crop') {
      ANN.cropRect = normRect(ANN.startX, ANN.startY, x, y);
      drawCropDim(ANN.startX, ANN.startY, x, y); // keep dim visible
      return;
    }

    if (ANN.mode !== 'pen') {
      if (ANN.history.length) {
        annCtx.putImageData(ANN.history[ANN.history.length - 1], 0, 0);
      }
      drawShape(ANN.mode, ANN.startX, ANN.startY, x, y, false);
    }
    saveHistory();
  }

  function drawShape(tool, x1, y1, x2, y2, preview) {
    annCtx.save();
    annCtx.strokeStyle = ANN.color;
    annCtx.fillStyle   = ANN.color;
    annCtx.lineWidth   = ANN.stroke;
    annCtx.setLineDash(preview ? [5, 3] : []);

    if (tool === 'rect') {
      annCtx.strokeRect(Math.min(x1,x2), Math.min(y1,y2), Math.abs(x2-x1), Math.abs(y2-y1));
    }
    if (tool === 'arrow') {
      const angle = Math.atan2(y2-y1, x2-x1);
      const hl    = Math.max(10, ANN.stroke * 4);
      annCtx.beginPath(); annCtx.moveTo(x1,y1); annCtx.lineTo(x2,y2); annCtx.stroke();
      annCtx.setLineDash([]);
      annCtx.beginPath();
      annCtx.moveTo(x2, y2);
      annCtx.lineTo(x2 - hl*Math.cos(angle-Math.PI/6), y2 - hl*Math.sin(angle-Math.PI/6));
      annCtx.lineTo(x2 - hl*Math.cos(angle+Math.PI/6), y2 - hl*Math.sin(angle+Math.PI/6));
      annCtx.closePath(); annCtx.fill();
    }
    annCtx.restore();
  }

  function placeTextInput(viewX, viewY, canvasX, canvasY) {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'Type…';
    const fontSize = Math.max(13, ANN.stroke * 3);
    inp.style.cssText = `
      position:fixed;
      left:${Math.max(8, Math.min(viewX, window.innerWidth - 160))}px;
      top:${Math.max(8, viewY - fontSize - 4)}px;
      max-width:calc(100vw - 16px);
      z-index:2147483646;
      background:rgba(0,0,0,.78);
      border:1.5px solid ${ANN.color};
      color:#fff;
      font-size:${fontSize}px;
      padding:3px 8px;
      border-radius:5px;
      outline:none;
      min-width:140px;
      font-family:-apple-system,sans-serif;
      pointer-events:auto;
    `;
    document.body.appendChild(inp);
    inp.focus();
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && inp.value.trim()) {
        annCtx.save();
        annCtx.fillStyle = ANN.color;
        annCtx.font = `${Math.max(15, ANN.stroke * 4)}px -apple-system,sans-serif`;
        annCtx.fillText(inp.value.trim(), canvasX, canvasY);
        annCtx.restore();
        saveHistory();
        inp.remove();
      }
      if (ev.key === 'Escape') inp.remove();
    });
    // Also remove on outside click
    const onOut = ev => { if (!inp.contains(ev.target)) { inp.remove(); document.removeEventListener('pointerdown', onOut, true); } };
    setTimeout(() => document.addEventListener('pointerdown', onOut, true), 100);
  }

  function saveHistory() {
    if (!annCtx) return;
    ANN.history.push(annCtx.getImageData(0, 0, annCanvas.width, annCanvas.height));
    if (ANN.history.length > 30) ANN.history.shift();
  }

  function canvasPos(e) {
    const r = annCanvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function normRect(x1, y1, x2, y2) {
    return { x: Math.min(x1,x2), y: Math.min(y1,y2), w: Math.abs(x2-x1), h: Math.abs(y2-y1) };
  }

  // Draw crop dim: dark overlay outside selection, bright border around it
  function drawCropDim(x1, y1, x2, y2) {
    if (!annCtx) return;
    const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
    const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
    const W  = annCanvas.width, H = annCanvas.height;

    // Restore the last annotation snapshot (so dims don't stack)
    if (ANN.history.length) {
      annCtx.putImageData(ANN.history[ANN.history.length - 1], 0, 0);
    }

    // Dim the four surrounding regions
    annCtx.save();
    annCtx.fillStyle = 'rgba(0,0,0,0.55)';
    annCtx.fillRect(0,   0,   W,   ry);          // top
    annCtx.fillRect(0,   ry+rh, W,  H-ry-rh);   // bottom
    annCtx.fillRect(0,   ry,   rx,  rh);          // left
    annCtx.fillRect(rx+rw, ry, W-rx-rw, rh);     // right

    // Bright dashed border around selection
    annCtx.strokeStyle = '#6366f1';
    annCtx.lineWidth   = 2;
    annCtx.setLineDash([6, 3]);
    annCtx.strokeRect(rx, ry, rw, rh);

    // Corner size labels
    if (rw > 60 && rh > 30) {
      annCtx.setLineDash([]);
      annCtx.fillStyle = 'rgba(99,102,241,0.9)';
      annCtx.font = '11px -apple-system,sans-serif';
      const label = rw + ' × ' + rh;
      const tw = annCtx.measureText(label).width;
      annCtx.fillRect(rx + rw/2 - tw/2 - 5, ry + rh/2 - 9, tw + 10, 18);
      annCtx.fillStyle = '#fff';
      annCtx.fillText(label, rx + rw/2 - tw/2, ry + rh/2 + 4);
    }

    annCtx.restore();
  }

  // ── Pins ──────────────────────────────────────────────────
  function placePin(bug) {
    const el = document.createElement('div');
    el.className  = `bp-pin sev-${bug.severity || 'medium'}`;
    el.dataset.id = bug.id;
    el.dataset.band = bugBand(bug);
    el.style.left = bug.x + 'px';
    el.style.top  = bug.y + 'px';
    el.innerHTML  = `<span>${bug.num}</span>`;
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      openModal({ view: 'detail', bugId: bug.id, pageKey: PAGE_KEY });
    });
    // Hidden unless its band matches the current window (or show-all is on).
    if (!showAllSizes && el.dataset.band !== currentBand()) el.style.display = 'none';
    document.body.appendChild(el);
    pins.push({ el, bugId: bug.id });
  }
  function refreshPin(bug) {
    const p = pins.find(p => p.el.dataset.id === bug.id);
    if (p) p.el.className = `bp-pin sev-${bug.severity || 'medium'}`;
  }
  function removePin(id) {
    const i = pins.findIndex(p => p.el.dataset.id === id);
    if (i > -1) { pins[i].el.remove(); pins.splice(i, 1); }
  }
  function scrollToPin(id) {
    document.querySelector(`.bp-pin[data-id="${id}"]`)?.scrollIntoView({ behavior:'smooth', block:'center' });
  }



  // ── Helpers ────────────────────────────────────────────────

  // ── Responsive bands ───────────────────────────────────────
  // A pin shows only when the current window's band matches the band it was
  // marked at. Standard breakpoints; forgiving of exact-pixel differences.
  const BANDS = [
    { id: 'mobile',  label: 'Mobile',  icon: '📱', max: 480 },
    { id: 'tablet',  label: 'Tablet',  icon: '📄', max: 1024 },
    { id: 'desktop', label: 'Desktop', icon: '🖥', max: Infinity },
  ];
  function bandForWidth(w) {
    return (BANDS.find(b => w <= b.max) || BANDS[BANDS.length - 1]).id;
  }
  // Pull the width out of a "1920×969" viewport string; fall back to a bug's
  // own band field if present.
  function bugBand(bug) {
    if (bug.band) return bug.band;
    const w = parseInt(String(bug.viewport || '').split(/[x×]/)[0], 10);
    return Number.isFinite(w) ? bandForWidth(w) : 'desktop';
  }
  function currentBand() { return bandForWidth(window.innerWidth); }
  function bandMeta(id) { return BANDS.find(b => b.id === id) || BANDS[2]; }

  function isOurEl(el) { return !!el?.closest?.('#bp-tab,#bp-sidebar,#bp-modal-bg,#bp-ann-overlay,#bp-ann-toolbar,#bp-crop-select,.bp-pin'); }
  function stor(k) { return new Promise(r => chrome.storage.local.get(k, r)); }
  function describeEl(el) {
    if (!el) return '';
    const tag = el.tagName?.toLowerCase()||'';
    const id  = el.id ? `#${el.id}` : '';
    const cls = typeof el.className==='string' ? '.'+el.className.trim().split(/\s+/).slice(0,2).join('.') : '';
    const txt = el.textContent?.trim().slice(0,40);
    return `${tag}${id}${cls}${txt?` "${txt}"`:''}`; 
  }
  function getBrowser() { const m=navigator.userAgent.match(/Chrome\/([\d.]+)/); return m?`Chrome ${m[1]}`:navigator.userAgent.slice(0,40); }
  async function captureScreenshot() {
    return new Promise(r => {
      // Timeout so we never hang if service worker is sleeping
      const timer = setTimeout(() => r(null), 3000);
      try {
        chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, res => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) { r(null); return; }
          r(res?.dataUrl || null);
        });
      } catch (_) { clearTimeout(timer); r(null); }
    });
  }
  // Storage
  function loadProjects() { return new Promise(r => chrome.storage.local.get('projects', d => r(d.projects||{}))); }
  function saveProjects(p) { return new Promise(r => chrome.storage.local.set({projects:p}, r)); }
  async function getPageBugs(domain, pageKey) { const p=await loadProjects(); return p[domain]?.pages?.[pageKey]?.bugs||[]; }
  async function addBug(domain, pageKey, pageTitle, bug) {
    const projects=await loadProjects();
    if (!projects[domain]) projects[domain]={name:domain, createdAt:new Date().toISOString(), pages:{}};
    if (!projects[domain].pages[pageKey]) projects[domain].pages[pageKey]={title:pageTitle, bugs:[]};
    const page=projects[domain].pages[pageKey];
    bug.num=page.bugs.length+1; page.bugs.push(bug);
    await saveProjects(projects); return projects;
  }
  async function updateBugStore(domain, pageKey, bugId, updates) {
    const projects=await loadProjects();
    const page=projects[domain]?.pages?.[pageKey];
    if (page) { const i=page.bugs.findIndex(b=>b.id===bugId); if(i>-1) page.bugs[i]={...page.bugs[i],...updates}; }
    await saveProjects(projects); return projects;
  }
  // Appends a comment to a bug, deduped by the comment's own id — needed
  // because live sync can deliver the same comment via more than one path
  // (e.g. relayed through a host to several peers).
  async function addCommentStore(domain, pageKey, bugId, comment) {
    const projects = await loadProjects();
    const bug = projects[domain]?.pages?.[pageKey]?.bugs?.find(b => b.id === bugId);
    let comments = [];
    if (bug) {
      if (!bug.comments) bug.comments = [];
      if (!bug.comments.find(c => c.id === comment.id)) bug.comments.push(comment);
      comments = bug.comments;
    }
    await saveProjects(projects);
    return { projects, comments };
  }
  async function deleteBugStore(domain, pageKey, bugId) {
    const projects=await loadProjects();
    const page=projects[domain]?.pages?.[pageKey];
    if (page) {
      page.bugs=page.bugs.filter(b=>b.id!==bugId);
      if (!page.bugs.length) delete projects[domain].pages[pageKey];
      if (!Object.keys(projects[domain]?.pages||{}).length) delete projects[domain];
    }
    await saveProjects(projects); return projects;
  }
  // ============================================================
  // ANCHORING — tie a pin to an element so it can be re-found
  // ============================================================
  // Build a selector + where inside the element the click landed (0..1).
  function computeAnchor(el, clientX, clientY) {
    if (!el || el.nodeType !== 1) return null;
    const selector = cssPath(el);
    const r = el.getBoundingClientRect();
    const relX = r.width  ? (clientX - r.left) / r.width  : 0.5;
    const relY = r.height ? (clientY - r.top)  / r.height : 0.5;
    return {
      selector,
      relX: clamp01(relX),
      relY: clamp01(relY),
    };
  }

  // A reasonably stable, reasonably short CSS path. Prefers #id; otherwise
  // walks up adding :nth-of-type steps until the path is unique.
  function cssPath(el) {
    if (el.id && document.querySelectorAll(cssEscape('#' + el.id)).length === 1) {
      return '#' + cssIdent(el.id);
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + cssIdent(node.id)); break; }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter(c => c.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  // Resolve an anchor back to a viewport point. Returns { x, y, exact }.
  function resolveAnchor(bug) {
    const a = bug.anchor;
    if (a && a.selector) {
      let el = null;
      try { el = document.querySelector(a.selector); } catch (_) { el = null; }
      if (el) {
        const r = el.getBoundingClientRect();
        return {
          x: window.scrollX + r.left + a.relX * r.width,
          y: window.scrollY + r.top  + a.relY * r.height,
          exact: true,
        };
      }
    }
    // Fallback: the raw document coordinates recorded at capture time.
    return { x: bug.x ?? 0, y: bug.y ?? 0, exact: false };
  }

  function clamp01(n) { return Math.max(0, Math.min(1, n)); }
  function cssIdent(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  function cssEscape(s) { return (window.CSS && CSS.escape) ? '#' + CSS.escape(s.slice(1)) : s; }

  // Anchored pins move with their element, so re-resolve on resize.
  // (Scroll doesn't need it — pins use document coords and the page scrolls
  // under them — but resize/reflow changes element positions.)
  let bandResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(bandResizeTimer);
    bandResizeTimer = setTimeout(() => {
      applyBandFilter();                 // show/hide pins for the new width
      pushViewportInfo();                // update the sidebar readout
    }, 150);
  });

  // Show/hide every pin according to the current band,
  // unless "show all sizes" is on.
  function applyBandFilter() {
    const cur = currentBand();
    for (const p of pins) {
      const show = showAllSizes || p.el.dataset.band === cur;
      p.el.style.display = show ? '' : 'none';
    }
  }

  function setShowAllSizes(on) {
    showAllSizes = on;
    applyBandFilter();
    pushViewportInfo();
  }

  // Tell the sidebar the current width, band, and how many pins are hidden.
  function pushViewportInfo() {
    if (!sidebarEl) return;
    const cur = currentBand();
    let hidden = 0;
    for (const p of pins) if (p.el.dataset.band !== cur) hidden++;
    postSidebar('VIEWPORT_INFO', {
      width: window.innerWidth,
      band: cur,
      hidden: showAllSizes ? 0 : hidden,
      showAll: showAllSizes,
    });
  }

  // ============================================================
  // LIVE — peer-to-peer bug sharing over WebRTC (PeerJS)
  // ============================================================
  const LIVE = (() => {
    let peer = null;
    let conns = [];
    let role = null;
    let code = null;

    // ── Session persistence ──────────────────────────────────
    // A page refresh or same-site navigation unloads this script and the
    // WebRTC connections with it. The session is remembered per tab in
    // sessionStorage and rebuilt on the next page load: a host re-claims the
    // same share code, a guest keeps retrying until the host is back.
    const FLAG = 'bp-live';
    let wantLive     = false;   // true from Start/Join until the user presses Leave
    let reconnecting = false;   // true while we are trying to get back in
    let resuming     = false;   // this page load is restoring a saved session
    let joinedOnce   = false;   // guest has connected at least once
    let retryTimer   = null;
    let retryCount   = 0;
    let hostRetry    = 0;
    const MAX_RETRIES = 30;     // ~75s of trying before giving up
    const RETRY_MS    = 2500;

    const saveFlag  = () => { try { sessionStorage.setItem(FLAG, JSON.stringify({ role, code })); } catch (_) {} };
    const clearFlag = () => { try { sessionStorage.removeItem(FLAG); } catch (_) {} };
    const readFlag  = () => { try { return JSON.parse(sessionStorage.getItem(FLAG) || 'null'); } catch (_) { return null; } };

    function hostId() {
      let id = localStorage.getItem('bp-host-id');
      if (!id) { id = Math.random().toString(36).slice(2, 6); localStorage.setItem('bp-host-id', id); }
      const site = DOMAIN.replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase();
      return `bugpin-${site}-${id}`;
    }

    function ensurePeer(id) {
      if (typeof Peer === 'undefined') {
        showToast('Live sharing unavailable (PeerJS failed to load)', 'error');
        return null;
      }
      return new Peer(id, {
        config: { iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
        ]},
        debug: 1,
      });
    }

    function wireConnection(conn) {
      conn.on('open', async () => {
        if (!conns.includes(conn)) conns.push(conn);
        if (role === 'guest') {
          if (reconnecting || resuming) showToast('Live session reconnected', 'success');
          joinedOnce = true; reconnecting = false; resuming = false; retryCount = 0;
          clearTimeout(retryTimer); retryTimer = null;
        }
        pushStatus();
        // Both sides send what they have for this page; each merges by id,
        // so anything missed while disconnected is caught up.
        const bugs = await getPageBugs(DOMAIN, PAGE_KEY);
        conn.send({ t: 'full', pageKey: PAGE_KEY, pageTitle: PAGE_TITLE, bugs });
      });
      conn.on('data', (msg) => handleIncoming(msg, conn));
      const dropped = () => {
        conns = conns.filter(c => c !== conn);
        pushStatus();
        if (role === 'guest' && wantLive) scheduleRejoin();   // host refreshed / blipped
      };
      conn.on('close', dropped);
      conn.on('error', dropped);
    }

    async function handleIncoming(msg, from) {
      if (!msg || !msg.t) return;
      if (msg.t === 'full') {
        if (msg.pageKey !== PAGE_KEY) return;
        await mergeBugs(msg.bugs || [], msg.pageTitle);
      } else if (msg.t === 'op') {
        const op = msg.op;
        if (op.kind === 'upsert' && op.pageKey === PAGE_KEY) await mergeBugs([op.bug], op.pageTitle);
        else if (op.kind === 'delete' && op.pageKey === PAGE_KEY) await applyRemoteDelete(op.id);
        else if (op.kind === 'comment' && op.pageKey === PAGE_KEY) await applyRemoteComment(op.bugId, op.comment);
        if (role === 'host') relay(msg, from);
      }
    }

    async function applyRemoteComment(bugId, comment) {
      const { projects, comments } = await addCommentStore(DOMAIN, PAGE_KEY, bugId, comment);
      postSidebar('PROJECTS_UPDATE', { projects, domain: DOMAIN, pageKey: PAGE_KEY });
      // If this bug's detail is open right now, push the update live.
      sendToModal('COMMENTS_UPDATE', { bugId, comments });
    }

    function relay(msg, from) { for (const c of conns) if (c !== from && c.open) c.send(msg); }

    async function mergeBugs(incoming, pageTitle) {
      if (!incoming.length) return;
      const isActive = sessionStorage.getItem('bp-activated') === '1';
      const projects = await loadProjects();
      if (!projects[DOMAIN]) projects[DOMAIN] = { name: DOMAIN, createdAt: new Date().toISOString(), pages: {} };
      if (!projects[DOMAIN].pages[PAGE_KEY]) projects[DOMAIN].pages[PAGE_KEY] = { title: pageTitle || PAGE_TITLE, bugs: [] };
      const page = projects[DOMAIN].pages[PAGE_KEY];
      for (const bug of incoming) {
        if (!bug || !bug.id) continue;
        const i = page.bugs.findIndex(b => b.id === bug.id);
        if (i > -1) { page.bugs[i] = { ...page.bugs[i], ...bug }; if (isActive) refreshPin(bug); }
        else { page.bugs.push(bug); if (isActive) placePin(bug); }
        // If not activated, the bug is still saved — it just doesn't draw a
        // pin until the user activates BugPin on this tab (Reading B).
      }
      await saveProjects(projects);
      if (isActive) updateTabCount(page.bugs.length);
      postSidebar('PROJECTS_UPDATE', { projects, domain: DOMAIN, pageKey: PAGE_KEY });
      pushViewportInfo();
    }

    async function applyRemoteDelete(id) {
      const projects = await deleteBugStore(DOMAIN, PAGE_KEY, id);
      removePin(id);
      updateTabCount(projects[DOMAIN]?.pages?.[PAGE_KEY]?.bugs?.length || 0);
      postSidebar('PROJECTS_UPDATE', { projects, domain: DOMAIN, pageKey: PAGE_KEY });
    }

    function pushStatus() {
      postSidebar('LIVE_STATUS', {
        role, code, peers: conns.length,
        connected: conns.length > 0 || role === 'host',
        reconnecting,
      });
    }

    // ── Guest: (re)connect to the host, retrying until it is back ──
    function scheduleRejoin() {
      if (role !== 'guest' || !wantLive || retryTimer) return;
      if (retryCount >= MAX_RETRIES) {
        reconnecting = false; pushStatus();
        showToast('Lost the live session — press Join to reconnect', 'error');
        return;
      }
      reconnecting = true; pushStatus();
      retryTimer = setTimeout(() => {
        retryTimer = null; retryCount++;
        guestAttempt();
      }, retryCount === 0 ? 800 : RETRY_MS);
    }

    function guestAttempt() {
      if (role !== 'guest' || !wantLive) return;
      if (!peer || peer.destroyed) { startGuestPeer(); return; }   // its 'open' connects
      if (peer.disconnected) { try { peer.reconnect(); } catch (_) {} scheduleRejoin(); return; }
      if (!conns.length) connectToHost();
    }

    function connectToHost() {
      if (!peer || !code) return;
      const conn = peer.connect(code, { reliable: true });
      if (!conn) { scheduleRejoin(); return; }
      wireConnection(conn);
      setTimeout(() => {
        if (wantLive && role === 'guest' && !conn.open && !conns.includes(conn)) {
          try { conn.close(); } catch (_) {}
          if (!joinedOnce && !resuming) {
            showToast('Could not reach the host directly. Check you both have internet and try again.', 'error');
          }
          scheduleRejoin();
        }
      }, 8000);
    }

    function startGuestPeer() {
      const p = ensurePeer(undefined);
      if (!p) { role = null; wantLive = false; clearFlag(); return; }
      peer = p;
      p.on('open', () => { if (peer === p && !conns.length) connectToHost(); });
      p.on('error', (err) => {
        if (peer !== p) return;
        const t = err.type || '';
        if (t === 'peer-unavailable') {
          if (!joinedOnce && !resuming) {           // wrong code on a first manual join
            showToast('No active session with that code', 'error');
            api.leave();
          } else {
            scheduleRejoin();                       // host is probably mid-refresh
          }
          return;
        }
        if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(t) && wantLive) {
          try { p.destroy(); } catch (_) {}
          scheduleRejoin();
          return;
        }
        showToast('Live error: ' + (t || 'connection failed'), 'error');
        pushStatus();
      });
      p.on('disconnected', () => { if (wantLive && peer === p) { try { p.reconnect(); } catch (_) {} } });
      p.on('close', () => { if (wantLive && peer === p && role === 'guest') scheduleRejoin(); });
    }

    // ── Host: claim the stable code, re-claiming it after a refresh ──
    function startHostPeer() {
      const p = ensurePeer(code);
      if (!p) { role = null; wantLive = false; clearFlag(); return; }
      peer = p;
      p.on('open', () => {
        hostRetry = 0; reconnecting = false;
        pushStatus();
        showToast(resuming ? 'Live session resumed' : 'Live session started — share your code', 'success');
        resuming = false;
      });
      p.on('connection', (conn) => wireConnection(conn));
      p.on('error', (err) => {
        if (peer !== p) return;
        const t = err.type || '';
        const retryable = t === 'unavailable-id' ||
          ['network', 'server-error', 'socket-error', 'socket-closed'].includes(t);
        if (retryable && wantLive && hostRetry < 15) {
          // After a refresh the broker may still hold the old registration for
          // a few seconds — wait and claim the same code again.
          hostRetry++; reconnecting = true; pushStatus();
          try { p.destroy(); } catch (_) {}
          setTimeout(() => { if (wantLive && role === 'host' && (!peer || peer === p || peer.destroyed)) startHostPeer(); }, 2000);
          return;
        }
        showToast('Live error: ' + (t || err.message || 'connection failed'), 'error');
        pushStatus();
      });
      p.on('disconnected', () => { if (wantLive && peer === p) { try { p.reconnect(); } catch (_) {} } });
    }

    // Release the broker id promptly when the page goes away, so the next page
    // can re-claim the same code straight away. The saved flag is kept — only
    // an explicit Leave clears it.
    function releaseOnUnload() {
      if (!peer) return;
      try { conns.forEach(c => { try { c.close(); } catch (_) {} }); peer.destroy(); } catch (_) {}
      peer = null; conns = [];
    }
    window.addEventListener('pagehide', releaseOnUnload);
    // Restored from the back/forward cache: the peer was released above.
    window.addEventListener('pageshow', (e) => { if (e.persisted) api.resume(); });

    const api = {
      startHost() {
        if (peer) this.leave();
        wantLive = true; resuming = false; reconnecting = false; hostRetry = 0;
        role = 'host'; code = hostId();
        saveFlag();
        startHostPeer();
      },
      join(rawCode) {
        const target = String(rawCode || '').trim();
        if (!target) { showToast('Enter a session code to join', 'error'); return; }
        if (peer) this.leave();
        wantLive = true; resuming = false; reconnecting = false; joinedOnce = false; retryCount = 0;
        role = 'guest'; code = target;
        saveFlag();
        startGuestPeer();
        pushStatus();
      },
      // Called on every page load: rebuild a session that was running in this
      // tab before the page was refreshed or navigated.
      resume() {
        if (peer && !peer.destroyed) return;
        const f = readFlag();
        if (!f || !f.role || !f.code) return;
        wantLive = true; resuming = true; reconnecting = true; retryCount = 0; hostRetry = 0;
        if (f.role === 'host') { role = 'host'; code = hostId(); startHostPeer(); }
        else { role = 'guest'; code = f.code; joinedOnce = false; startGuestPeer(); }
        pushStatus();
      },
      leave() {
        wantLive = false; reconnecting = false; resuming = false;
        clearTimeout(retryTimer); retryTimer = null; retryCount = 0; hostRetry = 0;
        clearFlag();
        for (const c of conns) { try { c.close(); } catch (_) {} }
        conns = [];
        if (peer) { try { peer.destroy(); } catch (_) {} }
        peer = null; role = null; code = null;
        pushStatus();
      },
      broadcast(op) {
        if (!conns.length) return;
        const msg = { t: 'op', op };
        for (const c of conns) if (c.open) c.send(msg);
      },
      pushStatus,
      isActive() { return !!peer; },
    };
    return api;
  })();

  // ── Toast notification ────────────────────────────────────
  function showToast(msg, type = 'success') {
    const existing = document.getElementById('bp-toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.id = 'bp-toast';
    const bg = type === 'success' ? '#15803d' : type === 'error' ? '#dc2626' : '#1a56db';
    t.style.cssText = `
      position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
      background:${bg};color:#fff;
      padding:10px 20px;border-radius:10px;
      font-size:13px;font-weight:600;font-family:-apple-system,sans-serif;
      box-shadow:0 4px 16px rgba(0,0,0,.25);
      z-index:2147483647;
      animation:bpToastIn .25s ease;
      max-width:calc(100vw - 24px);text-align:center;
    `;
    t.textContent = msg;
    // Add keyframe animation via a style tag
    if (!document.getElementById('bp-toast-style')) {
      const s = document.createElement('style');
      s.id = 'bp-toast-style';
      s.textContent = '@keyframes bpToastIn{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
      document.head.appendChild(s);
    }
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(()=>t.remove(),300); }, 3000);
  }

})();
