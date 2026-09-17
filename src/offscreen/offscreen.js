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
        port.postMessage({ id: msg.id, html: sanitizeHtmlFragment(msg.html || '') });
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

// ─── HTML Sanitization ──────────────────────────────────────────────────────
//
// Runs on each message body before it is embedded in the generated HTML/PDF
// archive. This sanitizes a fragment (doc.body.innerHTML back out), not a
// full document — there is no page-supplied <base>, meta refresh or
// top-level <html>/<head> to worry about here the way webpage-archiver's
// serializeHtml() has to — but a message body can still carry an inline
// handler, a javascript:/vbscript:/data:text/html URL (some obfuscated with
// whitespace), or the elements those rely on (script, object, embed,
// iframe). A standalone function (rather than inline in the message
// handler above) so tests/extension.spec.js can extract and call the real
// function instead of a reimplementation.

const SANITIZE_REMOVE_SELECTOR = ['script', 'object', 'embed', 'iframe', 'noscript'].join(', ');

// Attributes that can carry a javascript:/vbscript:/data:text/html URL.
const SANITIZE_URL_ATTRS = ['href', 'src', 'action', 'formaction', 'xlink:href'];

function isDangerousHtmlUrl(value) {
  if (!value) return false;
  // DOM attribute values are already entity-decoded, so this only has to
  // cope with whitespace/control-character obfuscation of the scheme
  // (e.g. "java\tscript:").
  const normalized = String(value).replace(/[\x00-\x20]+/g, '').toLowerCase();
  return /^(javascript|vbscript):/.test(normalized) || /^data:text\/html/.test(normalized);
}

function sanitizeHtmlFragment(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html || '', 'text/html');

  // Remove elements that can run code outright.
  for (const el of doc.querySelectorAll(SANITIZE_REMOVE_SELECTOR)) {
    el.remove();
  }

  for (const el of doc.querySelectorAll('*')) {
    // Snapshot the attribute list first: removeAttribute() during iteration
    // over the live NamedNodeMap skips entries as indices shift.
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if (name === 'srcdoc') {
        el.removeAttribute(attr.name);
      } else if (SANITIZE_URL_ATTRS.includes(name) && isDangerousHtmlUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }

  return doc.body.innerHTML;
}

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
