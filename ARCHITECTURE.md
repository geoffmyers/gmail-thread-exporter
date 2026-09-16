# Architecture

A Manifest V3 Chrome extension that exports Gmail threads in bulk. It reads your
own mailbox through Google's authorised APIs and writes files locally; no thread
content leaves the browser.

## Layout

| Path | What lives there |
|---|---|
| `manifest.json` | MV3 manifest, including the `identity` permission used for OAuth. |
| `src/` | `background/` (service worker and OAuth), `content/` (Gmail page integration), `offscreen/` (DOM work the worker cannot do), `options/`. |
| `vendor/` | Bundled Turndown and JSZip, committed so the extension loads unpacked. |
| `assets/` | Icons. |
| `tests/` | Playwright tests: helpers, HTML and EML generation, and the extension loaded against a mock Gmail page. |

## Export pipeline

1. Authorise with `chrome.identity.launchWebAuthFlow`, which is independent of the
   Google account Chrome itself is signed in to.
2. Fetch the selected threads.
3. Convert: HTML and PDF for presentation, **Turndown** for Markdown, structured
   JSON, and raw EML for archival fidelity.
4. Name each file from the template tokens, and pack with **JSZip** for bulk runs.

## Notes

- An **offscreen document** is used because a Manifest V3 service worker has no DOM, and the HTML/PDF conversion needs one.

- EML is the format to keep if fidelity matters — it preserves headers the other
  formats drop.
- The filename template is user-configurable; the token list is in the README.
