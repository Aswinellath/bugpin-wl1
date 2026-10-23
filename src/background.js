// BugPin — Background Service Worker
// 1) Capture the visible tab when the content script asks.
// 2) Open the full-size issue list tab on request.
// 3) When the toolbar icon is clicked, tell the content script to
//    toggle its sidebar (the extension has no popup).

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === 'CAPTURE_SCREENSHOT') {
    chrome.tabs.captureVisibleTab(
      sender.tab.windowId,
      { format: 'png', quality: 90 },
      dataUrl => {
        if (chrome.runtime.lastError) respond({ error: chrome.runtime.lastError.message });
        else respond({ dataUrl });
      }
    );
    return true; // async
  }

  // Sidebar → "View all issues": open (or focus) the full-size list in a tab.
  if (msg.type === 'OPEN_VIEWER') {
    const url = chrome.runtime.getURL('src/viewer.html') +
      (msg.domain ? '?domain=' + encodeURIComponent(msg.domain) : '');
    chrome.tabs.query({ url: chrome.runtime.getURL('src/viewer.html') + '*' }, tabs => {
      const existing = (tabs || []).find(t => t.url === url);
      if (existing) {
        chrome.tabs.update(existing.id, { active: true });
        chrome.windows.update(existing.windowId, { focused: true });
      } else {
        chrome.tabs.create({ url });
      }
    });
    respond({ ok: true });
    return true;
  }
});

// Toolbar icon → open/close the sidebar on the active tab.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url?.startsWith('http')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' });
  } catch (_) {
    // Content script not there yet — inject then retry.
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/peerjs.min.js', 'src/content.js'] });
      await new Promise(r => setTimeout(r, 250));
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' });
    } catch (e) { console.error('[BugPin] could not open sidebar:', e); }
  }
});
