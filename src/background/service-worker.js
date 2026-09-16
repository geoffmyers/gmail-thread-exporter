'use strict';

/**
 * Service worker: Gmail API integration, format generation, and download orchestration.
 *
 * Handles OAuth2 authentication, fetches threads via Gmail REST API, and generates
 * HTML, PDF, Markdown, JSON, and EML exports. Uses an offscreen document for
 * ZIP creation and HTML-to-Markdown conversion (Turndown).
 */

// ─── Gmail API ────────────────────────────────────────────────────────────────

async function getAuthToken() {
  // Check session storage first (persists across service worker restarts)
  const stored = await chrome.storage.session.get('oauthToken');
  if (stored.oauthToken) {
    console.log('[GmailExporter:SW] Using session-cached token');
    return stored.oauthToken;
  }

  const manifest = chrome.runtime.getManifest();
  const clientId = manifest.oauth2.client_id;
  const scopes = manifest.oauth2.scopes.join(' ');
  const redirectUrl = chrome.identity.getRedirectURL();

  console.log('[GmailExporter:SW] Starting OAuth flow', { clientId, redirectUrl });

  // Try silent token refresh first, fall back to interactive prompt
  let responseUrl;
  try {
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUrl);
    authUrl.searchParams.set('response_type', 'token');
    authUrl.searchParams.set('scope', scopes);

    responseUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl.toString(), interactive: false },
        (url) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(url);
          }
        }
      );
    });
    console.log('[GmailExporter:SW] Silent token refresh succeeded');
  } catch {
    console.log('[GmailExporter:SW] Silent refresh failed, prompting user');
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUrl);
    authUrl.searchParams.set('response_type', 'token');
    authUrl.searchParams.set('scope', scopes);

    responseUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl.toString(), interactive: true },
        (url) => {
          if (chrome.runtime.lastError) {
            console.error('[GmailExporter:SW] OAuth error:', chrome.runtime.lastError.message);
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            console.log('[GmailExporter:SW] Interactive OAuth flow completed');
            resolve(url);
          }
        }
      );
    });
  }

  const params = new URLSearchParams(new URL(responseUrl).hash.substring(1));
  const token = params.get('access_token');
  if (!token) throw new Error('No access token received from Google');

  console.log('[GmailExporter:SW] Token acquired successfully');
  await chrome.storage.session.set({ oauthToken: token });
  return token;
}

async function clearCachedToken() {
  await chrome.storage.session.remove('oauthToken');
}

async function gmailFetch(endpoint, token, retryCount = 0) {
  const url = `https://www.googleapis.com/gmail/v1/users/me/${endpoint}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401 && retryCount === 0) {
    // Token expired — clear cache and retry once
    await clearCachedToken();
    const newToken = await getAuthToken();
    return gmailFetch(endpoint, newToken, 1);
  }

  if (res.status === 429) {
    // Rate limited — exponential backoff
    const delay = Math.pow(2, retryCount) * 1000;
    if (retryCount < 5) {
      await new Promise((r) => setTimeout(r, delay));
      return gmailFetch(endpoint, token, retryCount + 1);
    }
    throw new Error('Gmail API rate limit exceeded. Please try again later.');
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API error ${res.status}: ${body}`);
  }

  return res.json();
}

async function fetchThread(threadId, token) {
  return gmailFetch(`threads/${threadId}?format=full`, token);
}

async function fetchAttachment(messageId, attachmentId, token) {
  return gmailFetch(`messages/${messageId}/attachments/${attachmentId}`, token);
}

// ─── Utility Helpers ──────────────────────────────────────────────────────────

function getHeader(headers, name) {
  const lower = name.toLowerCase();
  const h = headers.find((h) => h.name.toLowerCase() === lower);
  return h ? h.value : '';
}

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeBase64Url(data) {
  if (!data) return '';
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return decodeURIComponent(
      atob(normalized)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
  } catch {
    return atob(normalized);
  }
}

function decodeBase64UrlToBytes(data) {
  if (!data) return new Uint8Array(0);
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function findBodyPart(payload, mimeType) {
  if (payload.mimeType === mimeType && payload.body?.data) {
    return payload;
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const found = findBodyPart(part, mimeType);
      if (found) return found;
    }
  }
  return null;
}

function findAttachments(payload) {
  const attachments = [];
  function walk(part) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType,
        size: part.body.size,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return attachments;
}

function sanitizeFilename(str) {
  return (str || 'untitled')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80) || 'untitled';
}

function parseEmailAddress(fromHeader) {
  // "Alice Smith <alice@example.com>" → { name: "Alice Smith", email: "alice@example.com" }
  const match = (fromHeader || '').match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].replace(/"/g, '').trim(), email: match[2].trim() };
  }
  const email = (fromHeader || '').trim();
  return { name: email.split('@')[0], email };
}

function resolveFilenameTemplate(template, thread, messageIndex) {
  const firstMsg = thread.messages[0];
  const headers = firstMsg.payload.headers;
  const dateStr = getHeader(headers, 'Date');
  const subject = getHeader(headers, 'Subject') || 'No Subject';
  const from = parseEmailAddress(getHeader(headers, 'From'));
  const to = parseEmailAddress(getHeader(headers, 'To'));

  let date = '';
  let datetime = '';
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      date = d.toISOString().slice(0, 10);
      datetime = d.toISOString().slice(0, 19).replace(/:/g, '-').replace('T', '_');
    }
  } catch { /* ignore */ }

  return template
    .replace(/\{date\}/g, date)
    .replace(/\{datetime\}/g, datetime)
    .replace(/\{sender_name\}/g, sanitizeFilename(from.name))
    .replace(/\{sender_email\}/g, from.email.replace(/@/g, '_at_'))
    .replace(/\{sender_domain\}/g, from.email.split('@')[1] || '')
    .replace(/\{recipient_name\}/g, sanitizeFilename(to.name))
    .replace(/\{recipient_email\}/g, to.email.replace(/@/g, '_at_'))
    .replace(/\{recipient_domain\}/g, to.email.split('@')[1] || '')
    .replace(/\{subject\}/g, sanitizeFilename(subject))
    .replace(/\{n\}/g, messageIndex != null ? String(messageIndex + 1).padStart(2, '0') : '')
    .replace(/\{thread_id\}/g, thread.id);
}

// ─── HTML Generation — Per Thread ─────────────────────────────────────────────

async function generateThreadHTML(thread, { sanitizeBody = null } = {}) {
  const messages = thread.messages;
  const firstMessage = messages[0];
  const subject = escapeHtml(getHeader(firstMessage.payload.headers, 'subject') || 'No Subject');
  const threadId = thread.id;
  const messageCount = messages.length;

  const messageSectionParts = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const H = message.payload.headers;
    const get = (name) => escapeHtml(getHeader(H, name));
    const from = get('from');
    const to = get('to');
    const cc = get('cc');
    const date = get('date');

    const htmlPart = findBodyPart(message.payload, 'text/html');
    const textPart = findBodyPart(message.payload, 'text/plain');
    let bodyContent;
    if (htmlPart) {
      bodyContent = decodeBase64Url(htmlPart.body.data);
      if (sanitizeBody) {
        bodyContent = await sanitizeBody(bodyContent);
      }
    } else if (textPart) {
      bodyContent = `<pre style="white-space:pre-wrap;font-family:monospace">${escapeHtml(decodeBase64Url(textPart.body.data))}</pre>`;
    } else {
      bodyContent = '<p><em>(No message body)</em></p>';
    }

    messageSectionParts.push(`
      <div class="gme-message" id="gme-msg-${index}">
        <div class="gme-msg-header">
          <div class="gme-msg-from">${from}</div>
          <div class="gme-msg-meta">
            <span>To: ${to}</span>
            ${cc ? `<span>Cc: ${cc}</span>` : ''}
            <span class="gme-msg-date">${date}</span>
          </div>
          <div class="gme-msg-counter">Message ${index + 1} of ${messageCount}</div>
        </div>
        <div class="gme-msg-body">${bodyContent}</div>
      </div>`);
  }
  const messageSections = messageSectionParts.join('\n<hr class="gme-divider">\n');

  // Table of contents for large threads (10+ messages)
  let toc = '';
  if (messageCount >= 10) {
    const tocItems = messages.map((message, index) => {
      const from = escapeHtml(getHeader(message.payload.headers, 'from'));
      const date = escapeHtml(getHeader(message.payload.headers, 'date'));
      return `<li><a href="#gme-msg-${index}">${from} — ${date}</a></li>`;
    }).join('\n');
    toc = `<nav class="gme-toc"><h3>Messages</h3><ol>${tocItems}</ol></nav>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f1f3f4; }
    .gme-thread-header {
      background: #fff; border-bottom: 1px solid #e0e0e0;
      padding: 16px 24px; position: sticky; top: 0; z-index: 100;
    }
    .gme-thread-header h1 { margin: 0 0 4px; font-size: 20px; color: #202124; }
    .gme-thread-meta { font-size: 12px; color: #5f6368; }
    .gme-toc { background: #fff; margin: 12px 16px; padding: 16px 24px;
               border-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,.1); }
    .gme-toc h3 { margin: 0 0 8px; font-size: 14px; color: #202124; }
    .gme-toc ol { margin: 0; padding-left: 24px; }
    .gme-toc li { font-size: 13px; margin-bottom: 4px; }
    .gme-toc a { color: #1a73e8; text-decoration: none; }
    .gme-toc a:hover { text-decoration: underline; }
    .gme-message { background: #fff; margin: 12px 16px; padding: 20px 24px;
                   border-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,.1); }
    .gme-msg-header { margin-bottom: 12px; padding-bottom: 12px;
                      border-bottom: 1px solid #f1f3f4; }
    .gme-msg-from { font-size: 14px; font-weight: 600; color: #202124; }
    .gme-msg-meta { font-size: 12px; color: #5f6368; margin-top: 4px; }
    .gme-msg-meta span { margin-right: 12px; }
    .gme-msg-date { float: right; }
    .gme-msg-counter { font-size: 11px; color: #9aa0a6; margin-top: 4px; }
    .gme-msg-body { font-size: 14px; line-height: 1.5; }
    .gme-divider { border: none; border-top: 1px solid #e0e0e0; margin: 0; }
    .gme-footer { font-size: 11px; color: #9aa0a6; padding: 12px 24px;
                  text-align: right; margin: 0 16px; }
  </style>
</head>
<body>
  <div class="gme-thread-header">
    <h1>${subject}</h1>
    <div class="gme-thread-meta">${messageCount} message${messageCount !== 1 ? 's' : ''} &bull; Thread ID: ${threadId}</div>
  </div>
  ${toc}
  ${messageSections}
  <div class="gme-footer">Exported by Gmail Thread Exporter</div>
</body>
</html>`;
}

// ─── PDF Generation — Per Thread ──────────────────────────────────────────────

async function generateThreadPDF(thread, { sanitizeBody = null } = {}) {
  const html = await generateThreadHTML(thread, { sanitizeBody });
  const renderUrl = chrome.runtime.getURL('src/background/pdf-render.html');
  const tab = await chrome.tabs.create({ url: renderUrl, active: false });

  // Wait for the tab to finish loading
  if (tab.status !== 'complete') {
    await new Promise((resolve) => {
      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  try {
    // Use Chrome DevTools Protocol to set page content and print to PDF.
    // This avoids chrome.scripting.executeScript which requires host_permissions.
    // The HTML is generated from trusted Gmail API data by generateThreadHTML().
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');

    // Get the main frame ID for Page.setDocumentContent
    const frameTree = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      'Page.getFrameTree'
    );
    await chrome.debugger.sendCommand(
      { tabId: tab.id },
      'Page.setDocumentContent',
      { frameId: frameTree.frameTree.frame.id, html }
    );

    // Let styles render
    await new Promise((r) => setTimeout(r, 600));

    const { data } = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      'Page.printToPDF',
      { printBackground: true, preferCSSPageSize: false, format: 'Letter' }
    );
    await chrome.debugger.detach({ tabId: tab.id });
    return data; // base64-encoded PDF
  } finally {
    await chrome.tabs.remove(tab.id);
  }
}

// ─── Markdown Generation — Per Thread ─────────────────────────────────────────

async function generateThreadMarkdown(thread) {
  const messages = thread.messages;
  const firstMessage = messages[0];
  const headers = firstMessage.payload.headers;
  const subject = getHeader(headers, 'Subject') || 'No Subject';
  const messageCount = messages.length;

  // YAML frontmatter
  const frontmatter = [
    '---',
    `subject: "${subject.replace(/"/g, '\\"')}"`,
    `thread_id: "${thread.id}"`,
    `message_count: ${messageCount}`,
    `exported_at: "${new Date().toISOString()}"`,
    '---',
    '',
  ].join('\n');

  const messageSections = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const H = msg.payload.headers;
    const from = getHeader(H, 'From');
    const to = getHeader(H, 'To');
    const cc = getHeader(H, 'Cc');
    const date = getHeader(H, 'Date');

    // Get body content
    const htmlPart = findBodyPart(msg.payload, 'text/html');
    const textPart = findBodyPart(msg.payload, 'text/plain');

    let bodyText;
    if (htmlPart) {
      // Convert HTML to Markdown via offscreen document
      const htmlContent = decodeBase64Url(htmlPart.body.data);
      try {
        bodyText = await convertHtmlToMarkdown(htmlContent);
      } catch {
        bodyText = htmlContent; // fallback to raw HTML
      }
    } else if (textPart) {
      bodyText = decodeBase64Url(textPart.body.data);
    } else {
      bodyText = '*(No message body)*';
    }

    const section = [
      `## Message ${i + 1} of ${messageCount}`,
      '',
      `**From:** ${from}`,
      `**To:** ${to}`,
      cc ? `**Cc:** ${cc}` : null,
      `**Date:** ${date}`,
      '',
      bodyText,
    ].filter((line) => line !== null).join('\n');

    messageSections.push(section);
  }

  return frontmatter + messageSections.join('\n\n---\n\n') + '\n';
}

// ─── JSON Generation — Single File ───────────────────────────────────────────

function generateJSON(threads, prettyPrint = true) {
  return JSON.stringify(threads, null, prettyPrint ? 2 : 0);
}

// ─── EML Generation — Per Message ─────────────────────────────────────────────

function generateEML(message, attachmentDataMap = {}) {
  const H = message.payload.headers;
  const get = (name) => getHeader(H, name);

  // Reconstruct RFC 2822 headers
  const headerOrder = ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date', 'Message-ID', 'MIME-Version', 'Content-Type'];
  const headerLines = [];

  for (const name of headerOrder) {
    const value = get(name);
    if (value) headerLines.push(`${name}: ${value}`);
  }

  // Add any remaining headers not in the standard order
  for (const h of H) {
    if (!headerOrder.some((n) => n.toLowerCase() === h.name.toLowerCase())) {
      headerLines.push(`${h.name}: ${h.value}`);
    }
  }

  const textPart = findBodyPart(message.payload, 'text/plain');
  const htmlPart = findBodyPart(message.payload, 'text/html');
  const attachments = findAttachments(message.payload);

  // Simple single-part message
  if (!htmlPart && attachments.length === 0) {
    const body = textPart ? decodeBase64Url(textPart.body.data) : '';
    // Ensure Content-Type is set for plain text
    if (!headerLines.some((l) => l.toLowerCase().startsWith('content-type:'))) {
      headerLines.push('Content-Type: text/plain; charset=UTF-8');
    }
    if (!headerLines.some((l) => l.toLowerCase().startsWith('mime-version:'))) {
      headerLines.push('MIME-Version: 1.0');
    }
    return headerLines.join('\r\n') + '\r\n\r\n' + body;
  }

  // Multipart message
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const altBoundary = `----=_Alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  // Replace Content-Type header with multipart
  const ctIdx = headerLines.findIndex((l) => l.toLowerCase().startsWith('content-type:'));
  const mimeVersionLine = 'MIME-Version: 1.0';
  if (!headerLines.some((l) => l.toLowerCase().startsWith('mime-version:'))) {
    headerLines.push(mimeVersionLine);
  }

  const hasAttachments = attachments.length > 0 && Object.keys(attachmentDataMap).length > 0;
  if (hasAttachments) {
    const ct = `Content-Type: multipart/mixed; boundary="${boundary}"`;
    if (ctIdx >= 0) headerLines[ctIdx] = ct;
    else headerLines.push(ct);
  } else {
    const ct = htmlPart
      ? `Content-Type: multipart/alternative; boundary="${altBoundary}"`
      : 'Content-Type: text/plain; charset=UTF-8';
    if (ctIdx >= 0) headerLines[ctIdx] = ct;
    else headerLines.push(ct);
  }

  let eml = headerLines.join('\r\n') + '\r\n\r\n';

  if (hasAttachments) {
    // multipart/mixed containing multipart/alternative + attachments
    eml += `--${boundary}\r\n`;
    if (htmlPart) {
      eml += `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`;
    }
  }

  // Text/HTML alternatives
  if (htmlPart) {
    if (textPart) {
      eml += `--${altBoundary}\r\n`;
      eml += 'Content-Type: text/plain; charset=UTF-8\r\n';
      eml += 'Content-Transfer-Encoding: base64\r\n\r\n';
      eml += btoa(unescape(encodeURIComponent(decodeBase64Url(textPart.body.data)))) + '\r\n';
    }
    eml += `--${altBoundary}\r\n`;
    eml += 'Content-Type: text/html; charset=UTF-8\r\n';
    eml += 'Content-Transfer-Encoding: base64\r\n\r\n';
    eml += btoa(unescape(encodeURIComponent(decodeBase64Url(htmlPart.body.data)))) + '\r\n';
    eml += `--${altBoundary}--\r\n`;
  } else if (textPart && !hasAttachments) {
    eml += decodeBase64Url(textPart.body.data);
  }

  // Attachments
  if (hasAttachments) {
    for (const att of attachments) {
      const data = attachmentDataMap[att.attachmentId];
      if (!data) continue;
      eml += `--${boundary}\r\n`;
      eml += `Content-Type: ${att.mimeType}; name="${att.filename}"\r\n`;
      eml += `Content-Disposition: attachment; filename="${att.filename}"\r\n`;
      eml += 'Content-Transfer-Encoding: base64\r\n\r\n';
      // data is already base64url — normalize to base64
      eml += data.replace(/-/g, '+').replace(/_/g, '/') + '\r\n';
    }
    eml += `--${boundary}--\r\n`;
  }

  return eml;
}

// ─── Offscreen Document Management ────────────────────────────────────────────

let offscreenCreating = null;
let offscreenPort = null;
let msgIdCounter = 0;

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('src/offscreen/offscreen.html')],
  });

  if (existingContexts.length === 0) {
    if (offscreenCreating) {
      await offscreenCreating;
    } else {
      offscreenCreating = chrome.offscreen.createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'ZIP creation and HTML-to-Markdown conversion for email export',
      });
      await offscreenCreating;
      offscreenCreating = null;
    }
  }

  if (!offscreenPort) {
    offscreenPort = chrome.runtime.connect({ name: 'offscreen' });
    offscreenPort.onDisconnect.addListener(() => { offscreenPort = null; });
  }
}

function sendOffscreenMessage(msg) {
  return new Promise((resolve, reject) => {
    const id = ++msgIdCounter;
    const handler = (response) => {
      if (response.id !== id) return;
      offscreenPort.onMessage.removeListener(handler);
      if (response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    };
    offscreenPort.onMessage.addListener(handler);
    offscreenPort.postMessage({ ...msg, id });
  });
}

async function convertHtmlToMarkdown(html) {
  await ensureOffscreenDocument();
  const response = await sendOffscreenMessage({ type: 'html-to-markdown', html });
  return response.markdown;
}

async function sanitizeHtmlBody(html) {
  await ensureOffscreenDocument();
  const response = await sendOffscreenMessage({ type: 'sanitize-html', html });
  return response.html;
}

// ─── Download Helpers ─────────────────────────────────────────────────────────

function downloadDataUrl(dataUrl, filename, { waitForComplete = false } = {}) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename, conflictAction: 'uniquify', saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!waitForComplete) {
          resolve(downloadId);
          return;
        }
        // Wait for the download to fully complete before resolving
        const listener = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(listener);
            resolve(downloadId);
          } else if (delta.state?.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(listener);
            reject(new Error(`Download interrupted: ${delta.error?.current || 'unknown error'}`));
          }
        };
        chrome.downloads.onChanged.addListener(listener);
      }
    );
  });
}

function downloadText(text, filename, mimeType = 'text/plain') {
  const base64 = btoa(unescape(encodeURIComponent(text)));
  const dataUrl = `data:${mimeType};base64,${base64}`;
  return downloadDataUrl(dataUrl, filename);
}

// ─── Export Orchestration ─────────────────────────────────────────────────────

async function exportThreads({ threadIds, formats, bundle, attachmentMode, tabId }) {
  const token = await getAuthToken();
  const results = [];
  const files = []; // { filename, data, type: 'text'|'base64' }

  // Load settings
  const settings = await new Promise((resolve) => {
    chrome.storage.sync.get({
      filenameTemplate: '{date} - {sender_name} - {subject}',
      subfolder: '',
      jsonPrettyPrint: true,
      htmlSanitize: true,
    }, resolve);
  });

  // Step 1: Fetch all thread data
  const allThreads = [];
  for (let i = 0; i < threadIds.length; i++) {
    try {
      const thread = await fetchThread(threadIds[i], token);
      allThreads.push(thread);
    } catch (err) {
      results.push({ label: `Thread ${threadIds[i]} — fetch failed: ${err.message}`, success: false });
    }

    // Report progress
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'export-progress',
        completed: i + 1,
        total: threadIds.length,
      });
    } catch { /* tab closed */ }
  }

  if (allThreads.length === 0) {
    return { error: 'Failed to fetch any threads. Please check your connection and try again.' };
  }

  // Step 2: Generate JSON (single file, all threads)
  if (formats.json) {
    try {
      const jsonData = generateJSON(allThreads, settings.jsonPrettyPrint);
      const jsonFilename = `gmail-export-${new Date().toISOString().slice(0, 10)}.json`;
      files.push({ filename: jsonFilename, data: jsonData, type: 'text' });
      results.push({ label: `JSON \u2014 ${jsonFilename}`, success: true });
    } catch (err) {
      results.push({ label: `JSON \u2014 ${err.message}`, success: false });
    }
  }

  // Sanitizer function — only used when htmlSanitize is enabled
  const sanitizeBody = settings.htmlSanitize ? sanitizeHtmlBody : null;

  // Step 3: Generate per-thread files
  for (const thread of allThreads) {
    const basename = resolveFilenameTemplate(settings.filenameTemplate, thread);
    const folder = basename;

    // HTML
    if (formats.html) {
      try {
        const html = await generateThreadHTML(thread, { sanitizeBody });
        files.push({
          filename: `${folder}/${basename}.html`,
          data: html,
          type: 'text',
        });
        results.push({ label: `HTML \u2014 ${folder}/${basename}.html`, success: true });
      } catch (err) {
        results.push({ label: `HTML \u2014 ${folder}: ${err.message}`, success: false });
      }
    }

    // PDF
    if (formats.pdf) {
      try {
        const pdfBase64 = await generateThreadPDF(thread, { sanitizeBody });
        files.push({
          filename: `${folder}/${basename}.pdf`,
          data: pdfBase64,
          type: 'base64',
        });
        results.push({ label: `PDF \u2014 ${folder}/${basename}.pdf`, success: true });
      } catch (err) {
        results.push({ label: `PDF \u2014 ${folder}: ${err.message}`, success: false });
      }
    }

    // Markdown
    if (formats.markdown) {
      try {
        const md = await generateThreadMarkdown(thread);
        files.push({
          filename: `${folder}/${basename}.md`,
          data: md,
          type: 'text',
        });
        results.push({ label: `Markdown \u2014 ${folder}/${basename}.md`, success: true });
      } catch (err) {
        results.push({ label: `Markdown \u2014 ${folder}: ${err.message}`, success: false });
      }
    }

    // EML (per message)
    if (formats.eml) {
      for (let i = 0; i < thread.messages.length; i++) {
        const msg = thread.messages[i];
        try {
          // Fetch attachments if needed
          let attachmentDataMap = {};
          if (attachmentMode === 'inline-eml') {
            const attachments = findAttachments(msg.payload);
            for (const att of attachments) {
              try {
                const attData = await fetchAttachment(msg.id, att.attachmentId, token);
                attachmentDataMap[att.attachmentId] = attData.data;
              } catch { /* skip attachment */ }
            }
          }

          const eml = generateEML(msg, attachmentDataMap);
          const msgBasename = resolveFilenameTemplate(settings.filenameTemplate, thread, i);
          files.push({
            filename: `${folder}/${msgBasename}.eml`,
            data: eml,
            type: 'text',
          });
          results.push({ label: `EML \u2014 ${folder}/${msgBasename}.eml`, success: true });
        } catch (err) {
          results.push({ label: `EML \u2014 message ${i + 1}: ${err.message}`, success: false });
        }
      }
    }

    // Separate attachments
    if (attachmentMode === 'separate') {
      for (const msg of thread.messages) {
        const attachments = findAttachments(msg.payload);
        for (const att of attachments) {
          try {
            const attData = await fetchAttachment(msg.id, att.attachmentId, token);
            files.push({
              filename: `${folder}/attachments/${att.filename}`,
              data: attData.data, // base64url
              type: 'base64',
            });
            results.push({ label: `Attachment \u2014 ${folder}/attachments/${att.filename}`, success: true });
          } catch (err) {
            results.push({ label: `Attachment \u2014 ${att.filename}: ${err.message}`, success: false });
          }
        }
      }
    }
  }

  // Step 4: Download
  if (files.length > 0) {
    if (bundle === 'zip') {
      try {
        await ensureOffscreenDocument();

        // Build ZIP incrementally to avoid the 64MiB message-size limit.
        // Each file is added via a separate postMessage() call.
        await sendOffscreenMessage({ type: 'zip-start' });
        for (const f of files) {
          await sendOffscreenMessage({
            type: 'zip-add-file',
            filename: f.filename,
            data: f.data,
            fileType: f.type,
          });
        }
        const zipResponse = await sendOffscreenMessage({ type: 'zip-finish' });

        const zipFilename = settings.subfolder
          ? `${settings.subfolder}/gmail-export-${new Date().toISOString().slice(0, 10)}.zip`
          : `gmail-export-${new Date().toISOString().slice(0, 10)}.zip`;

        await downloadDataUrl(zipResponse.blobUrl, zipFilename, { waitForComplete: true });
        await sendOffscreenMessage({ type: 'revoke-blob-url', blobUrl: zipResponse.blobUrl });
      } catch (err) {
        results.push({ label: `ZIP \u2014 ${err.message}`, success: false });
      }
    } else {
      // Download each file individually
      for (const file of files) {
        try {
          const filename = settings.subfolder
            ? `${settings.subfolder}/${file.filename}`
            : file.filename;

          if (file.type === 'text') {
            const mimeType = file.filename.endsWith('.html') ? 'text/html'
              : file.filename.endsWith('.json') ? 'application/json'
              : file.filename.endsWith('.eml') ? 'message/rfc822'
              : 'text/markdown';
            await downloadText(file.data, filename, mimeType);
          } else if (file.type === 'base64') {
            const mime = file.filename.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
            // Normalize base64url to base64
            const normalized = file.data.replace(/-/g, '+').replace(/_/g, '/');
            await downloadDataUrl(`data:${mime};base64,${normalized}`, filename);
          }
        } catch (err) {
          const match = results.find((r) => r.label.includes(file.filename) && r.success);
          if (match) {
            match.success = false;
            match.label += ` (download failed: ${err.message})`;
          }
        }
      }
    }
  }

  return { results };
}

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'export-threads') {
    console.log('[GmailExporter:SW] Received export-threads', {
      threadIds: msg.threadIds,
      formats: msg.formats,
      bundle: msg.bundle,
    });
    exportThreads({
      threadIds: msg.threadIds,
      formats: msg.formats,
      bundle: msg.bundle,
      attachmentMode: msg.attachmentMode,
      tabId: sender.tab?.id,
    })
      .then((result) => {
        console.log('[GmailExporter:SW] Export complete', result);
        sendResponse(result);
      })
      .catch((err) => {
        console.error('[GmailExporter:SW] Export failed', err);
        sendResponse({ error: err.message });
      });
    return true; // Keep message channel open for async response
  }

  return false;
});
