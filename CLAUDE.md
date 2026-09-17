# CLAUDE.md — Gmail Thread Exporter

## Overview

Chrome extension (Manifest V3) that bulk exports Gmail threads to PDF, HTML, Markdown, JSON, and EML formats. Modeled after the companion [Webpage Archiver](https://github.com/geoffmyers/webpage-archiver) extension.

## Key Technical Decisions

### OAuth: `launchWebAuthFlow` instead of `getAuthToken`

Uses `chrome.identity.launchWebAuthFlow` (not the simpler `chrome.identity.getAuthToken`). This was a deliberate choice to avoid Chrome's sign-in account dependency — `getAuthToken` ties the token to the user's primary Chrome account, causing issues for users with multiple Google accounts. The token response is cached in `chrome.storage.session` for persistence across service worker restarts.

The OAuth client must be type **Web Application** (not Chrome Extension) to work with `launchWebAuthFlow`. The redirect URL is `chrome.identity.getRedirectURL()` (e.g., `https://<extension-id>.chromiumapp.org/`).

### PDF Generation: CDP via `chrome.debugger`

Uses Chrome DevTools Protocol (`Page.setDocumentContent` + `Page.printToPDF`) rather than `chrome.scripting.executeScript`. This avoids needing broad host permissions while still producing high-quality PDFs. The flow:

1. Open a hidden background tab pointing to `src/background/pdf-render.html`
2. Wait for the tab to load
3. Attach the debugger (`chrome.debugger.attach`)
4. Get the frame ID via `Page.getFrameTree`
5. Set the HTML content via `Page.setDocumentContent`
6. Wait 600ms for styles to render
7. Call `Page.printToPDF`
8. Detach debugger and close tab

### ZIP: Incremental via Offscreen Document

Large exports would exceed the Chrome extension message size limit (64 MiB). Solution: build the ZIP file incrementally using separate `zip-add-file` messages rather than batching all files into one message. Protocol:

1. `zip-start` — initialize a new JSZip instance
2. `zip-add-file` (one per file) — add each file to the ZIP
3. `zip-finish` — generate the ZIP blob URL and return it

The offscreen document (`src/offscreen/offscreen.js`) handles ZIP creation (JSZip) and HTML→Markdown conversion (Turndown). It connects to the service worker via a persistent port (`chrome.runtime.connect({ name: 'offscreen' })`).

### Gmail DOM Selectors

Gmail's minified class names change frequently. Stable selectors used:
- Thread rows: `tr.zA` (stable class)
- Checkboxes: `[role="checkbox"]` (ARIA, stable)
- Thread IDs: `data-legacy-thread-id` attribute on child elements (not the row itself)
- Toolbar: `div.G-Ni.J-J5-Ji` with fallback `[gh="tm"]`

The `findToolbar()` function iterates all matches and returns the first **visible** one (non-zero bounding rect), because Gmail keeps hidden old-view DOMs in the page.

### SPA Navigation Handling

Gmail is a single-page application. `MutationObserver` was initially used but proved unreliable for detecting all navigation events and toolbar re-renders. Replaced with a simple 1-second `setInterval` in `gmail-injector.js` that calls `ensureButton()` — checks if the button is visible in the current toolbar and re-injects if not.

### Per-Thread vs. Per-Message Output

- **HTML, PDF, Markdown** — one file per thread (conversation view with all messages)
- **JSON** — one file for all selected threads combined (root level in ZIP)
- **EML** — one file per message (RFC 2822 is a single-message format)

## Architecture

```
content script (gmail-dom.js, gmail-injector.js, export-modal.js)
    ↓ chrome.runtime.sendMessage('export-threads')
service worker (service-worker.js)
    ↓ Gmail REST API (threads/{id}?format=full)
    ↓ chrome.debugger → Page.printToPDF  [PDF]
    ↓ chrome.runtime.connect('offscreen')
offscreen document (offscreen.js)
    ↓ JSZip  [ZIP]
    ↓ TurndownService  [Markdown]
```

## Settings (`chrome.storage.sync`)

Defaults are defined in `src/options/options.js`:

| Key | Default | Description |
|-----|---------|-------------|
| `defaultFormats.pdf` | `false` | |
| `defaultFormats.html` | `true` | |
| `defaultFormats.markdown` | `true` | |
| `defaultFormats.json` | `true` | |
| `defaultFormats.eml` | `false` | |
| `defaultBundle` | `'zip'` | `'zip'` or `'individual'` |
| `attachmentMode` | `'separate'` | `'none'`, `'inline-eml'`, or `'separate'` |
| `filenameTemplate` | `'{date} - {sender_name} - {subject}'` | 11 tokens available |
| `subfolder` | `''` | Subfolder within Downloads |
| `htmlSanitize` | `true` | Strip scripts from HTML exports |
| `jsonPrettyPrint` | `true` | Pretty-print JSON |

## Dependencies

All vendored from `node_modules` via `build.js`:
- `jszip` — ZIP creation in offscreen document
- `turndown` + `turndown-plugin-gfm` — HTML→Markdown conversion in offscreen document

No dependency on Webpage Archiver's vendor files — this extension vendors its own copies.

## Known Issues / Gotchas

- **Chrome Debugger permission** — the `debugger` permission shows a warning banner in Chrome when the extension is loaded ("This extension can read and change all your data on websites you visit"). This is required for CDP-based PDF generation. It only activates when the debugger is actually attached (during PDF export), not continuously.

- **OAuth re-prompts** — because `launchWebAuthFlow` uses `response_type=token` (implicit flow), tokens expire after ~1 hour. The service worker attempts a silent refresh first; if that fails, it shows the interactive consent screen. This is normal.

- **Gmail selector fragility** — if Gmail updates its markup and breaks thread selection detection, the first thing to check is the `data-legacy-thread-id` attribute location and the `tr.zA` thread row selector in `src/content/gmail-dom.js`.

- **PDF generation in threads with external images** — PDFs render live at print time. External images in emails may be blocked by Chrome's print process depending on settings.

- **HTML sanitization** — when `htmlSanitize` is enabled, `<script>`, `<object>`, `<embed>`, `<iframe>` and `<noscript>` tags are removed from HTML message bodies, inline event handlers (`on*` attributes) and `srcdoc` are stripped, and `javascript:`/`vbscript:`/`data:text/html` URLs (including ones obfuscated with whitespace, e.g. `java\tscript:`) are cleared from `href`/`src`/`action`/`formaction`/`xlink:href`. Sanitization runs in the offscreen document via `DOMParser` and is applied to both HTML and PDF exports (since PDF reuses `generateThreadHTML`). The offscreen handler is `sanitize-html` in `src/offscreen/offscreen.js`, which calls the standalone `sanitizeHtmlFragment()` (pulled out of the message handler so tests can call the real function directly, the same pattern as webpage-archiver's `html-sanitizer.js`); the service worker function that invokes it is `sanitizeHtmlBody()` in `src/background/service-worker.js`.

## Google Cloud Project Setup

The extension requires a Google Cloud project with the Gmail API enabled and OAuth credentials configured. See `README.md` for step-by-step instructions.

The `oauth2.client_id` in `manifest.json` is configured with the owner's OAuth client. To use this extension with a different Google account, create your own OAuth client and replace the `client_id`.
