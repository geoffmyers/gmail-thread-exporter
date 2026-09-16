'use strict';

/**
 * Gmail DOM selectors and thread ID extraction.
 *
 * Strategy: prefer ARIA attributes and data-* attributes over class names —
 * these are far more stable across Gmail versions.
 */
const GmailDOM = {
  THREAD_ROW: 'tr.zA',
  THREAD_CHECKBOX: '[role="checkbox"]',
  THREAD_ID_ATTR: 'data-legacy-thread-id',
  THREAD_ID_FALLBACK: 'data-thread-id',
  TOOLBAR_SELECTOR: 'div.G-Ni.J-J5-Ji',
  TOOLBAR_FALLBACK: '[gh="tm"]',

  getSelectedThreadIds() {
    const ids = [];
    for (const row of document.querySelectorAll(this.THREAD_ROW)) {
      const cb = row.querySelector(this.THREAD_CHECKBOX);
      if (cb?.getAttribute('aria-checked') === 'true') {
        // Thread ID attributes are on a child span, not the row itself
        const idEl = row.querySelector(`[${this.THREAD_ID_ATTR}]`)
                  || row.querySelector(`[${this.THREAD_ID_FALLBACK}]`);
        const id = idEl?.getAttribute(this.THREAD_ID_ATTR)
                || idEl?.getAttribute(this.THREAD_ID_FALLBACK);
        if (id) ids.push(id);
      }
    }
    return ids;
  },

  getSelectedCount() {
    return this.getSelectedThreadIds().length;
  },

  isThreadListView() {
    return document.querySelector(this.THREAD_ROW) !== null;
  },

  findToolbar() {
    // Gmail keeps old view DOMs hidden in the page, so querySelector returns
    // the first match which may be invisible. Find the visible toolbar instead.
    for (const el of document.querySelectorAll(this.TOOLBAR_SELECTOR)) {
      if (el.getBoundingClientRect().width > 0) return el;
    }
    for (const el of document.querySelectorAll(this.TOOLBAR_FALLBACK)) {
      if (el.getBoundingClientRect().width > 0) return el;
    }
    return null;
  },
};
