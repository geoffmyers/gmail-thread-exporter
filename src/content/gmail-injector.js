'use strict';

/**
 * Main content script: injects Export button into Gmail's toolbar,
 * monitors selection changes, handles SPA navigation, and forwards
 * progress messages from the service worker to the modal.
 */

(function gmailInjector() {
  const BUTTON_ID = 'gme-export-btn-container';
  const CHECK_INTERVAL = 1000; // Check every second

  let selectionObserver = null;

  // ─── Export Button ──────────────────────────────────────────────────────────

  function createExportButton() {
    const container = document.createElement('div');
    container.id = BUTTON_ID;
    container.className = 'G-Ni J-J5-Ji';
    container.style.cssText = 'display:inline-flex;align-items:center;margin-left:4px;';

    const btn = document.createElement('button');
    btn.id = 'gme-export-btn';
    btn.className = 'gme-toolbar-btn';
    btn.disabled = true;
    btn.title = 'Select threads to export';

    // Build button content with safe DOM methods
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'currentColor');
    svg.style.marginRight = '4px';
    const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path1.setAttribute('d', 'M8 12l-4-4h2.5V3h3v5H12L8 12z');
    const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path2.setAttribute('d', 'M2 13h12v1H2z');
    svg.appendChild(path1);
    svg.appendChild(path2);

    const label = document.createElement('span');
    label.textContent = 'Export';

    btn.appendChild(svg);
    btn.appendChild(label);
    btn.addEventListener('click', onExportClick);
    container.appendChild(btn);
    return container;
  }

  function isButtonVisible() {
    const el = document.getElementById(BUTTON_ID);
    return el && el.getBoundingClientRect().width > 0;
  }

  function ensureButton() {
    // Already visible in the current toolbar — nothing to do
    if (isButtonVisible()) return;

    // Remove any button stuck in a hidden (old view) toolbar
    const existing = document.getElementById(BUTTON_ID);
    if (existing) existing.remove();

    // Find the visible toolbar and inject
    const toolbar = GmailDOM.findToolbar();
    if (!toolbar) return;

    toolbar.appendChild(createExportButton());
    updateButtonState();
    startSelectionObserver();
  }

  function updateButtonState() {
    const container = document.getElementById(BUTTON_ID);
    if (!container || container.getBoundingClientRect().width === 0) return;
    const btn = container.querySelector('#gme-export-btn');
    if (!btn) return;

    const count = GmailDOM.getSelectedCount();
    if (count > 0) {
      btn.disabled = false;
      btn.title = `Export ${count} thread${count !== 1 ? 's' : ''}`;
      btn.querySelector('span').textContent = `Export ${count} thread${count !== 1 ? 's' : ''}`;
    } else {
      btn.disabled = true;
      btn.title = 'Select threads to export';
      btn.querySelector('span').textContent = 'Export';
    }
  }

  function onExportClick() {
    const threadIds = GmailDOM.getSelectedThreadIds();
    if (threadIds.length === 0) return;
    ExportModal.show(threadIds.length);
  }

  // ─── Selection Observer ─────────────────────────────────────────────────────

  function startSelectionObserver() {
    if (selectionObserver) selectionObserver.disconnect();

    selectionObserver = new MutationObserver(() => {
      updateButtonState();
    });

    // Watch the entire thread list for aria-checked changes
    const threadList = document.querySelector('div[role="main"]') || document.body;
    selectionObserver.observe(threadList, {
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-checked'],
    });
  }

  // ─── Progress Message Handler ───────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'export-progress') {
      ExportModal.updateProgress(msg);
    }
  });

  // ─── Initialization ─────────────────────────────────────────────────────────

  // Simple periodic check handles all cases: initial load, SPA navigation,
  // and toolbar re-renders. Gmail keeps old view DOMs hidden, so we must
  // continuously verify the button is in a visible toolbar.
  setInterval(ensureButton, CHECK_INTERVAL);

  // Also run immediately
  ensureButton();
})();
