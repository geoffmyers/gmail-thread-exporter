'use strict';

/**
 * Offscreen document: handles ZIP creation and HTML-to-Markdown conversion.
 *
 * Uses a dedicated port connection (not runtime.sendMessage) to avoid
 * message routing conflicts in MV3.
 *
 * Message types:
 *   'html-to-markdown' — Convert HTML string to Markdown via Turndown
 *   'create-zip'       — Bundle files into a ZIP archive and return a blob URL (legacy, small exports)
 *   'zip-start'        — Begin incremental ZIP building
 *   'zip-add-file'     — Add a single file to the in-progress ZIP
 *   'zip-finish'       — Finalize the ZIP, return a blob URL
 *   'revoke-blob-url'  — Free a blob URL's memory
 */

// Map blob URLs to their underlying Blob objects so createZip can access
// them directly without fetch() (which doesn't support blob: URLs reliably).
const blobUrlMap = new Map();

// In-progress JSZip instance for incremental builds
let pendingZip = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen') return;

  port.onMessage.addListener(async (msg) => {
    try {
      if (msg.type === 'html-to-markdown') {
        const td = new TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced',
          bulletListMarker: '-',
        });
        td.use(turndownPluginGfm.gfm);
        td.remove(['script', 'style', 'head', 'meta', 'link']);
        const markdown = td.turndown(msg.html || '');
        port.postMessage({ id: msg.id, markdown });
        return;
      }

      if (msg.type === 'sanitize-html') {
        const parser = new DOMParser();
        const doc = parser.parseFromString(msg.html || '', 'text/html');
        // Remove dangerous elements
        for (const tag of ['script', 'object', 'embed', 'iframe']) {
          for (const el of doc.querySelectorAll(tag)) {
            el.remove();
          }
        }
        // Remove inline event handlers (onclick, onload, etc.)
        for (const el of doc.querySelectorAll('*')) {
          for (const attr of [...el.attributes]) {
            if (attr.name.toLowerCase().startsWith('on')) {
              el.removeAttribute(attr.name);
            }
          }
        }
        // Remove javascript: href/src attributes
        for (const el of doc.querySelectorAll('[href],[src]')) {
          for (const attrName of ['href', 'src']) {
            const val = (el.getAttribute(attrName) || '').toLowerCase().trimStart();
            if (val.startsWith('javascript:')) {
              el.removeAttribute(attrName);
            }
          }
        }
        port.postMessage({ id: msg.id, html: doc.body.innerHTML });
        return;
      }

      // Legacy single-message ZIP (kept for backward compatibility)
      if (msg.type === 'create-zip') {
        const blobUrl = await createZip(msg.files);
        port.postMessage({ id: msg.id, blobUrl });
        return;
      }

      // ── Incremental ZIP: start / add / finish ─────────────────────────
      if (msg.type === 'zip-start') {
        pendingZip = new JSZip();
        port.postMessage({ id: msg.id, ok: true });
        return;
      }

      if (msg.type === 'zip-add-file') {
        if (!pendingZip) throw new Error('No ZIP in progress — call zip-start first');
        addFileToZip(pendingZip, msg.filename, msg.data, msg.fileType);
        port.postMessage({ id: msg.id, ok: true });
        return;
      }

      if (msg.type === 'zip-finish') {
        if (!pendingZip) throw new Error('No ZIP in progress — call zip-start first');
        const zipBlob = await pendingZip.generateAsync({ type: 'blob' });
        const blobUrl = URL.createObjectURL(zipBlob);
        blobUrlMap.set(blobUrl, zipBlob);
        pendingZip = null;
        port.postMessage({ id: msg.id, blobUrl });
        return;
      }

      if (msg.type === 'revoke-blob-url') {
        URL.revokeObjectURL(msg.blobUrl);
        blobUrlMap.delete(msg.blobUrl);
        port.postMessage({ id: msg.id, ok: true });
        return;
      }
    } catch (err) {
      port.postMessage({ id: msg.id, error: err.message });
    }
  });
});

// ─── ZIP Helpers ──────────────────────────────────────────────────────────────

function addFileToZip(zip, filename, data, type) {
  if (type === 'text') {
    zip.file(filename, data);
  } else if (type === 'base64') {
    // Normalize base64url to standard base64
    const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
    zip.file(filename, normalized, { base64: true });
  } else if (type === 'blob-url') {
    const blob = blobUrlMap.get(data);
    if (!blob) {
      throw new Error(`Blob not found for URL: ${data}`);
    }
    zip.file(filename, blob);
  }
}

async function createZip(files) {
  const zip = new JSZip();
  for (const file of files) {
    addFileToZip(zip, file.filename, file.data, file.type);
  }
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const blobUrl = URL.createObjectURL(zipBlob);
  blobUrlMap.set(blobUrl, zipBlob);
  return blobUrl;
}
