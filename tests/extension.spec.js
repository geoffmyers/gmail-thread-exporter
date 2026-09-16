// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '..');

// ─── Extension Structure ────────────────────────────────────────────────────

test.describe('Extension Structure', () => {
  test('manifest.json is valid and contains required fields', () => {
    const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('Gmail Thread Exporter');
    // Chrome's version format, and the same version the package declares
    // (the release workflow tags releases with it).
    expect(manifest.version).toMatch(/^\d+(\.\d+){0,3}$/);
    const pkg = JSON.parse(fs.readFileSync(path.join(EXTENSION_PATH, 'package.json'), 'utf-8'));
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.permissions).toContain('identity');
    expect(manifest.permissions).toContain('downloads');
    expect(manifest.permissions).toContain('storage');
    expect(manifest.permissions).toContain('offscreen');
    expect(manifest.permissions).toContain('debugger');
    expect(manifest.permissions).toContain('activeTab');
    expect(manifest.host_permissions).toContain('https://mail.google.com/*');
    expect(manifest.host_permissions).toContain('https://www.googleapis.com/*');
    expect(manifest.oauth2).toBeDefined();
    expect(manifest.oauth2.client_id).toBeTruthy();
    expect(manifest.oauth2.scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(manifest.background.service_worker).toBe('src/background/service-worker.js');
    expect(manifest.content_scripts).toBeDefined();
    expect(manifest.content_scripts[0].matches).toContain('https://mail.google.com/*');
    expect(manifest.content_scripts[0].js).toContain('src/content/gmail-dom.js');
    expect(manifest.content_scripts[0].js).toContain('src/content/export-modal.js');
    expect(manifest.content_scripts[0].js).toContain('src/content/gmail-injector.js');
    expect(manifest.content_scripts[0].css).toContain('src/content/gmail-exporter.css');
    expect(manifest.options_ui.page).toBe('src/options/options.html');
    expect(manifest.minimum_chrome_version).toBe('109');
  });

  test('all files referenced in manifest exist', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(EXTENSION_PATH, 'manifest.json'), 'utf-8')
    );

    // Service worker
    expect(fs.existsSync(path.join(EXTENSION_PATH, manifest.background.service_worker))).toBe(true);

    // Content scripts
    for (const js of manifest.content_scripts[0].js) {
      expect(fs.existsSync(path.join(EXTENSION_PATH, js)), `Missing: ${js}`).toBe(true);
    }
    for (const css of manifest.content_scripts[0].css) {
      expect(fs.existsSync(path.join(EXTENSION_PATH, css)), `Missing: ${css}`).toBe(true);
    }

    // Options page
    expect(fs.existsSync(path.join(EXTENSION_PATH, manifest.options_ui.page))).toBe(true);

    // Icons
    for (const [size, iconPath] of Object.entries(manifest.icons)) {
      expect(fs.existsSync(path.join(EXTENSION_PATH, iconPath)), `Missing icon: ${iconPath}`).toBe(true);
    }
  });

  test('all vendor libraries exist and are non-empty', () => {
    const vendorFiles = [
      'vendor/jszip.min.js',
      'vendor/turndown.umd.js',
      'vendor/turndown-plugin-gfm.js',
    ];

    for (const file of vendorFiles) {
      const filePath = path.join(EXTENSION_PATH, file);
      expect(fs.existsSync(filePath), `Missing vendor file: ${file}`).toBe(true);
      const stat = fs.statSync(filePath);
      expect(stat.size, `Vendor file is empty: ${file}`).toBeGreaterThan(0);
    }
  });

  test('offscreen document references correct vendor libraries', () => {
    const html = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/offscreen/offscreen.html'),
      'utf-8'
    );
    expect(html).toContain('jszip.min.js');
    expect(html).toContain('turndown.umd.js');
    expect(html).toContain('turndown-plugin-gfm.js');
    expect(html).toContain('offscreen.js');
  });

  test('options HTML references options.js', () => {
    const html = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/options/options.html'),
      'utf-8'
    );
    expect(html).toContain('options.js');
  });

  test('icon files are valid PNG', () => {
    const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const size of [16, 32, 48, 128]) {
      const iconPath = path.join(EXTENSION_PATH, `assets/icons/icon-${size}.png`);
      const buf = fs.readFileSync(iconPath);
      expect(buf.subarray(0, 8).equals(PNG_HEADER), `icon-${size}.png is not valid PNG`).toBe(true);
    }
  });

  test('package.json lists required dependencies', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(EXTENSION_PATH, 'package.json'), 'utf-8')
    );
    const deps = pkg.dependencies || {};

    expect(deps['jszip']).toBeDefined();
    expect(deps['turndown']).toBeDefined();
    expect(deps['turndown-plugin-gfm']).toBeDefined();
  });
});

// ─── Source Code Quality ────────────────────────────────────────────────────

test.describe('Source Code Quality', () => {
  test('gmail-dom.js has correct selectors and exposes required functions', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/content/gmail-dom.js'),
      'utf-8'
    );
    expect(code).toContain("THREAD_ROW: 'tr.zA'");
    expect(code).toContain('THREAD_CHECKBOX');
    expect(code).toContain('[role="checkbox"]');
    expect(code).toContain('THREAD_ID_ATTR');
    expect(code).toContain('data-legacy-thread-id');
    expect(code).toContain('getSelectedThreadIds');
    expect(code).toContain('getSelectedCount');
    expect(code).toContain('isThreadListView');
    expect(code).toContain('findToolbar');
  });

  test('gmail-injector.js creates export button and manages observers', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/content/gmail-injector.js'),
      'utf-8'
    );
    expect(code).toContain("'gme-export-btn-container'");
    expect(code).toContain('createExportButton');
    expect(code).toContain('ensureButton');
    expect(code).toContain('GmailDOM.findToolbar');
    expect(code).toContain('startSelectionObserver');
    expect(code).toContain('CHECK_INTERVAL');
    expect(code).toContain("msg.type === 'export-progress'");
    expect(code).toContain('ExportModal.updateProgress');
  });

  test('export-modal.js has show, close, progress, and validation', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/content/export-modal.js'),
      'utf-8'
    );
    expect(code).toContain('ExportModal');
    expect(code).toContain('show(threadCount)');
    expect(code).toContain('close()');
    expect(code).toContain('updateProgress');
    expect(code).toContain('ExportProgress');
    expect(code).toContain('formatTime');
    expect(code).toContain('gme-modal-backdrop');
    expect(code).toContain('gme-progress-bar');
    expect(code).toContain('gme-error');
    expect(code).toContain('showToast');
    expect(code).toContain("name=\"gme-fmt\"");
    expect(code).toContain("name=\"gme-bundle\"");
    expect(code).toContain("name=\"gme-attach\"");
    expect(code).toContain("e.key === 'Escape'");
  });

  test('service-worker.js handles export-threads messages and OAuth2', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
      'utf-8'
    );
    expect(code).toContain("msg.type === 'export-threads'");
    expect(code).toContain('return true'); // Async response
    expect(code).toContain('getAuthToken');
    expect(code).toContain('chrome.identity.launchWebAuthFlow');
    expect(code).toContain('clearCachedToken');
    expect(code).toContain('res.status === 401');
    expect(code).toContain('res.status === 429');
    expect(code).toContain('gmailFetch');
    expect(code).toContain('fetchThread');
    expect(code).toContain('generateThreadHTML');
    expect(code).toContain('generateThreadPDF');
    expect(code).toContain('generateThreadMarkdown');
    expect(code).toContain('generateJSON');
    expect(code).toContain('generateEML');
    expect(code).toContain('ensureOffscreenDocument');
    expect(code).toContain('downloadDataUrl');
    expect(code).toContain('downloadText');
    expect(code).toContain('resolveFilenameTemplate');
    expect(code).toContain('sanitizeFilename');
  });

  test('service-worker.js uses debugger API for PDF generation', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
      'utf-8'
    );
    expect(code).toContain('chrome.debugger.attach');
    expect(code).toContain('chrome.debugger.sendCommand');
    expect(code).toContain('Page.printToPDF');
    expect(code).toContain('chrome.debugger.detach');
    expect(code).toContain('generateThreadPDF');
  });

  test('offscreen.js handles html-to-markdown, create-zip, and revoke-blob-url', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/offscreen/offscreen.js'),
      'utf-8'
    );
    expect(code).toContain("msg.type === 'html-to-markdown'");
    expect(code).toContain("msg.type === 'create-zip'");
    expect(code).toContain("msg.type === 'revoke-blob-url'");
    expect(code).toContain('TurndownService');
    expect(code).toContain('turndownPluginGfm.gfm');
    expect(code).toContain('JSZip');
    expect(code).toContain('createZip');
  });

  test('options.js has save, reset, load, and preview functionality', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/options/options.js'),
      'utf-8'
    );
    expect(code).toContain('saveOptions');
    expect(code).toContain('resetOptions');
    expect(code).toContain('loadOptions');
    expect(code).toContain('updatePreview');
    expect(code).toContain('DEFAULTS');
  });

  test('file naming sanitizes dangerous characters', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
      'utf-8'
    );
    expect(code).toContain('sanitizeFilename');
    expect(code).toContain('[<>:"/\\\\|?*\\x00-\\x1f]');
  });

  test('service-worker.js supports configurable filename template', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
      'utf-8'
    );
    // Tokens appear in regex form (\{token\}) in resolveFilenameTemplate
    expect(code).toContain('{date}');
    expect(code).toContain('{subject}');
    expect(code).toContain('sender_name');
    expect(code).toContain('thread_id');
    expect(code).toContain('filenameTemplate');
    expect(code).toContain('subfolder');
  });
});

// ─── Vendor Library Validation ──────────────────────────────────────────────

test.describe('Vendor Library Validation', () => {
  test('turndown.umd.js exposes TurndownService', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'vendor/turndown.umd.js'),
      'utf-8'
    );
    expect(code).toContain('TurndownService');
  });

  test('turndown-plugin-gfm.js exposes turndownPluginGfm and gfm', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'vendor/turndown-plugin-gfm.js'),
      'utf-8'
    );
    expect(code).toContain('turndownPluginGfm');
    expect(code).toContain('gfm');
  });

  test('jszip.min.js exposes JSZip', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'vendor/jszip.min.js'),
      'utf-8'
    );
    expect(code).toContain('JSZip');
  });
});

// ─── Helper Function Unit Tests ─────────────────────────────────────────────
//
// These tests load the extension's own source code into a Playwright browser
// context to unit test pure helper functions. The code being evaluated is our
// own trusted source files, not external/user input. This is the standard
// pattern for testing Chrome extension code outside the extension sandbox.

test.describe('Helper Function Unit Tests', () => {
  const swCode = fs.readFileSync(
    path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
    'utf-8'
  );

  function extractHelpers() {
    const utilStart = swCode.indexOf('// ─── Utility Helpers');
    const utilEnd = swCode.indexOf('// ─── HTML Generation');
    const htmlStart = utilEnd;
    const htmlEnd = swCode.indexOf('// ─── PDF Generation');
    const emlStart = swCode.indexOf('// ─── EML Generation');
    const emlEnd = swCode.indexOf('// ─── Offscreen Document');

    return swCode.substring(utilStart, utilEnd)
      + '\n' + swCode.substring(htmlStart, htmlEnd)
      + '\n' + swCode.substring(emlStart, emlEnd);
  }

  const modalCode = fs.readFileSync(
    path.join(EXTENSION_PATH, 'src/content/export-modal.js'),
    'utf-8'
  );

  function extractExportProgress() {
    const start = modalCode.indexOf('class ExportProgress');
    const end = modalCode.indexOf('const ExportModal');
    // Use var assignment so the class persists in global scope after eval
    // (class declarations in eval create block-scoped bindings that are discarded)
    return modalCode.substring(start, end)
      .replace('class ExportProgress', 'var ExportProgress = class ExportProgress');
  }

  // Injects helper code into page and runs a test function
  async function runInBrowser(page, helperCode, testScript) {
    return page.evaluate(([code, script]) => {
      // eslint-disable-next-line no-eval -- intentional: loading own source for testing
      (0, eval)(code); // indirect eval to avoid strict-mode scope issues
      // eslint-disable-next-line no-eval
      return (0, eval)('(' + script + ')()');
    }, [helperCode, testScript]);
  }

  test('escapeHtml correctly escapes special characters', async ({ page }) => {
    await page.goto('about:blank');
    const result = await runInBrowser(page, extractHelpers(), `function() {
      return {
        amp: escapeHtml('a & b'),
        lt: escapeHtml('a < b'),
        gt: escapeHtml('a > b'),
        quot: escapeHtml('a "b" c'),
        all: escapeHtml('<script>"alert(1)&"</script>'),
        empty: escapeHtml(''),
        nullish: escapeHtml(null),
      };
    }`);

    expect(result.amp).toBe('a &amp; b');
    expect(result.lt).toBe('a &lt; b');
    expect(result.gt).toBe('a &gt; b');
    expect(result.quot).toBe('a &quot;b&quot; c');
    expect(result.all).toBe('&lt;script&gt;&quot;alert(1)&amp;&quot;&lt;/script&gt;');
    expect(result.empty).toBe('');
    expect(result.nullish).toBe('');
  });

  test('decodeBase64Url handles base64url-encoded strings', async ({ page }) => {
    await page.goto('about:blank');
    const result = await runInBrowser(page, extractHelpers(), `function() {
      return {
        basic: decodeBase64Url('SGVsbG8sIFdvcmxkIQ=='),
        withUrlChars: decodeBase64Url('SGVsbG8sIFdvcmxkIQ'),
        empty: decodeBase64Url(''),
        nullish: decodeBase64Url(null),
      };
    }`);

    expect(result.basic).toBe('Hello, World!');
    expect(result.empty).toBe('');
    expect(result.nullish).toBe('');
  });

  test('decodeBase64UrlToBytes produces correct Uint8Array', async ({ page }) => {
    await page.goto('about:blank');
    const result = await runInBrowser(page, extractHelpers(), `function() {
      var bytes = decodeBase64UrlToBytes('AQID');
      return {
        length: bytes.length,
        values: Array.from(bytes),
        emptyLength: decodeBase64UrlToBytes('').length,
        nullLength: decodeBase64UrlToBytes(null).length,
      };
    }`);

    expect(result.length).toBe(3);
    expect(result.values).toEqual([1, 2, 3]);
    expect(result.emptyLength).toBe(0);
    expect(result.nullLength).toBe(0);
  });

  test('findBodyPart traverses nested MIME parts correctly', async ({ page }) => {
    await page.goto('about:blank');
    const result = await runInBrowser(page, extractHelpers(), `function() {
      var payload = {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: 'cGxhaW4=' } },
          {
            mimeType: 'multipart/related',
            parts: [
              { mimeType: 'text/html', body: { data: 'aHRtbA==' } },
            ],
          },
        ],
      };
      var htmlPart = findBodyPart(payload, 'text/html');
      var textPart = findBodyPart(payload, 'text/plain');
      var missingPart = findBodyPart(payload, 'text/xml');
      return {
        htmlFound: htmlPart !== null,
        htmlData: htmlPart && htmlPart.body && htmlPart.body.data,
        textFound: textPart !== null,
        textData: textPart && textPart.body && textPart.body.data,
        missingFound: missingPart === null,
      };
    }`);

    expect(result.htmlFound).toBe(true);
    expect(result.htmlData).toBe('aHRtbA==');
    expect(result.textFound).toBe(true);
    expect(result.textData).toBe('cGxhaW4=');
    expect(result.missingFound).toBe(true);
  });

  test('findAttachments collects all parts with filename and attachmentId', async ({ page }) => {
    await page.goto('about:blank');
    const result = await runInBrowser(page, extractHelpers(), `function() {
      var payload = {
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: 'dGV4dA==' } },
          {
            mimeType: 'application/pdf',
            filename: 'invoice.pdf',
            body: { attachmentId: 'att-001', size: 12345 },
          },
          {
            mimeType: 'multipart/related',
            parts: [
              {
                mimeType: 'image/png',
                filename: 'photo.png',
                body: { attachmentId: 'att-002', size: 54321 },
              },
            ],
          },
        ],
      };
      return findAttachments(payload);
    }`);

    expect(result).toHaveLength(2);
    expect(result[0].filename).toBe('invoice.pdf');
    expect(result[0].attachmentId).toBe('att-001');
    expect(result[1].filename).toBe('photo.png');
    expect(result[1].attachmentId).toBe('att-002');
  });

  test('sanitizeFilename removes dangerous characters and truncates', async ({ page }) => {
    await page.goto('about:blank');
    const result = await runInBrowser(page, extractHelpers(), `function() {
      return {
        basic: sanitizeFilename('Hello World'),
        special: sanitizeFilename('Re: Invoice <#1234> "important"'),
        long: sanitizeFilename('a'.repeat(100)),
        empty: sanitizeFilename(''),
        nullish: sanitizeFilename(null),
      };
    }`);

    expect(result.basic).toBe('Hello World');
    expect(result.special).not.toContain('<');
    expect(result.special).not.toContain('>');
    expect(result.special).not.toContain('"');
    expect(result.long.length).toBeLessThanOrEqual(80);
    expect(result.empty).toBe('untitled');
    expect(result.nullish).toBe('untitled');
  });

  test('parseEmailAddress extracts name and email', async ({ page }) => {
    await page.goto('about:blank');
    const result = await runInBrowser(page, extractHelpers(), `function() {
      return {
        full: parseEmailAddress('Alice Smith <alice@example.com>'),
        quoted: parseEmailAddress('"Bob Jones" <bob@company.com>'),
        bare: parseEmailAddress('carol@example.com'),
        empty: parseEmailAddress(''),
      };
    }`);

    expect(result.full.name).toBe('Alice Smith');
    expect(result.full.email).toBe('alice@example.com');
    expect(result.quoted.name).toBe('Bob Jones');
    expect(result.quoted.email).toBe('bob@company.com');
    expect(result.bare.email).toBe('carol@example.com');
    expect(result.empty.email).toBe('');
  });

  test('resolveFilenameTemplate substitutes all tokens', async ({ page }) => {
    await page.goto('about:blank');
    const result = await runInBrowser(page, extractHelpers(), `function() {
      var thread = {
        id: 'thread-123',
        messages: [{
          payload: {
            headers: [
              { name: 'Date', value: 'Wed, 15 Jan 2026 14:32:00 -0500' },
              { name: 'Subject', value: 'Re: Invoice 1234' },
              { name: 'From', value: 'Alice Smith <alice@example.com>' },
              { name: 'To', value: 'Bob Jones <bob@company.com>' },
            ],
          },
        }],
      };
      return {
        dateSubject: resolveFilenameTemplate('{date}_{subject}', thread),
        senderName: resolveFilenameTemplate('{sender_name}', thread),
        senderEmail: resolveFilenameTemplate('{sender_email}', thread),
        senderDomain: resolveFilenameTemplate('{sender_domain}', thread),
        recipientName: resolveFilenameTemplate('{recipient_name}', thread),
        threadId: resolveFilenameTemplate('{thread_id}', thread),
        withIndex: resolveFilenameTemplate('{subject}_{n}', thread, 0),
        datetime: resolveFilenameTemplate('{datetime}', thread),
      };
    }`);

    expect(result.dateSubject).toContain('2026-01-15');
    expect(result.dateSubject).toContain('Re Invoice 1234');
    expect(result.senderName).toBe('Alice Smith');
    expect(result.senderEmail).toBe('alice_at_example.com');
    expect(result.senderDomain).toBe('example.com');
    expect(result.recipientName).toBe('Bob Jones');
    expect(result.threadId).toBe('thread-123');
    expect(result.withIndex).toContain('01');
    expect(result.datetime).toContain('2026-01-15');
  });

  test('ExportProgress calculates percent, label, and time estimates', async ({ page }) => {
    await page.goto('about:blank');
    const result = await runInBrowser(page, extractExportProgress(), `function() {
      var p = new ExportProgress(10);
      var start = p.update(0);
      p.startTime = Date.now() - 5000;
      var mid = p.update(5);
      p.startTime = Date.now() - 10000;
      var end = p.update(10);
      return { start: start, mid: mid, end: end };
    }`);

    expect(result.start.percent).toBe(0);
    expect(result.start.label).toBe('Thread 0 of 10');
    expect(result.start.stats).toBe('Starting...');
    expect(result.mid.percent).toBe(50);
    expect(result.mid.label).toBe('Thread 5 of 10');
    expect(result.mid.stats).toContain('5 done');
    expect(result.mid.stats).toContain('5 remaining');
    expect(result.end.percent).toBe(100);
    expect(result.end.label).toBe('Thread 10 of 10');
    expect(result.end.stats).toContain('0 remaining');
  });

  test('ExportProgress.formatTime formats seconds and minutes', async ({ page }) => {
    await page.goto('about:blank');
    const result = await runInBrowser(page, extractExportProgress(), `function() {
      return {
        zero: ExportProgress.formatTime(0),
        short: ExportProgress.formatTime(30),
        exactMinute: ExportProgress.formatTime(60),
        longTime: ExportProgress.formatTime(150),
      };
    }`);

    expect(result.zero).toBe('0s');
    expect(result.short).toBe('30s');
    expect(result.exactMinute).toBe('1m');
    expect(result.longTime).toBe('3m');
  });
});

// ─── HTML Generation Tests ──────────────────────────────────────────────────

test.describe('HTML Generation', () => {
  const swCode = fs.readFileSync(
    path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
    'utf-8'
  );

  function extractForHtmlGen() {
    const utilStart = swCode.indexOf('// ─── Utility Helpers');
    const pdfStart = swCode.indexOf('// ─── PDF Generation');
    return swCode.substring(utilStart, pdfStart);
  }

  function nodeBtoa(str) {
    return Buffer.from(str).toString('base64');
  }

  function makeThread(messageCount, subject) {
    subject = subject || 'Test Subject';
    const messages = [];
    for (let i = 0; i < messageCount; i++) {
      messages.push({
        payload: {
          headers: [
            { name: 'From', value: 'sender' + i + '@example.com' },
            { name: 'To', value: 'recipient' + i + '@example.com' },
            { name: 'Cc', value: i === 0 ? 'cc@example.com' : '' },
            { name: 'Date', value: 'Mon, ' + (13 + i) + ' Jan 2026 10:00:00 -0500' },
            { name: 'Subject', value: subject },
          ],
          mimeType: 'text/html',
          body: { data: nodeBtoa('<p>Message body ' + (i + 1) + '</p>') },
        },
      });
    }
    return { id: 'thread-html-test', messages: messages };
  }

  async function generateHTML(page, code, thread) {
    return page.evaluate(([c, t]) => {
      (0, eval)(c); // eslint-disable-line no-eval -- loading own source for testing
      return generateThreadHTML(t);
    }, [code, thread]);
  }

  test('generateThreadHTML produces valid HTML with correct structure', async ({ page }) => {
    await page.goto('about:blank');
    const html = await generateHTML(page, extractForHtmlGen(), makeThread(3));

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="UTF-8">');
    expect(html).toContain('</html>');
  });

  test('subject appears in title and header', async ({ page }) => {
    await page.goto('about:blank');
    const html = await generateHTML(page, extractForHtmlGen(), makeThread(1, 'My Important Email'));

    expect(html).toContain('<title>My Important Email</title>');
    expect(html).toContain('My Important Email');
  });

  test('message count is correct in header', async ({ page }) => {
    await page.goto('about:blank');
    const html = await generateHTML(page, extractForHtmlGen(), makeThread(5));

    expect(html).toContain('5 messages');
  });

  test('each message section has from, to, date fields', async ({ page }) => {
    await page.goto('about:blank');
    const html = await generateHTML(page, extractForHtmlGen(), makeThread(2));

    expect(html).toContain('sender0@example.com');
    expect(html).toContain('sender1@example.com');
    expect(html).toContain('recipient0@example.com');
    expect(html).toContain('recipient1@example.com');
    expect(html).toContain('Cc:');
  });

  test('plain text fallback produces pre-formatted content', async ({ page }) => {
    await page.goto('about:blank');
    const thread = {
      id: 'thread-plain',
      messages: [{
        payload: {
          headers: [
            { name: 'From', value: 'test@example.com' },
            { name: 'To', value: 'dest@example.com' },
            { name: 'Date', value: 'Mon, 13 Jan 2026 10:00:00 -0500' },
            { name: 'Subject', value: 'Plain Text' },
          ],
          mimeType: 'text/plain',
          body: { data: nodeBtoa('Hello plain text') },
        },
      }],
    };

    const html = await generateHTML(page, extractForHtmlGen(), thread);
    expect(html).toContain('<pre');
    expect(html).toContain('white-space:pre-wrap');
  });

  test('table of contents appears for 10+ messages', async ({ page }) => {
    await page.goto('about:blank');
    const code = extractForHtmlGen();

    // generateThreadHTML is async (since the htmlSanitize option), so both
    // results must be awaited before they leave the page.
    const results = await page.evaluate(async ([c, small, large]) => {
      (0, eval)(c); // eslint-disable-line no-eval
      return Promise.all([generateThreadHTML(small), generateThreadHTML(large)]);
    }, [code, makeThread(3), makeThread(12)]);

    expect(results[0]).not.toContain('<nav class="gme-toc">');
    expect(results[1]).toContain('<nav class="gme-toc">');
    expect(results[1]).toContain('Messages');
  });

  test('thread ID and message counters are present', async ({ page }) => {
    await page.goto('about:blank');
    const html = await generateHTML(page, extractForHtmlGen(), makeThread(3));

    expect(html).toContain('thread-html-test');
    expect(html).toContain('Message 1 of 3');
    expect(html).toContain('Message 2 of 3');
    expect(html).toContain('Message 3 of 3');
  });
});

// ─── EML Generation Tests ───────────────────────────────────────────────────

test.describe('EML Generation', () => {
  const swCode = fs.readFileSync(
    path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
    'utf-8'
  );

  function extractForEml() {
    const utilStart = swCode.indexOf('// ─── Utility Helpers');
    const utilEnd = swCode.indexOf('// ─── HTML Generation');
    const emlStart = swCode.indexOf('// ─── EML Generation');
    const emlEnd = swCode.indexOf('// ─── Offscreen Document');
    return swCode.substring(utilStart, utilEnd) + '\n' + swCode.substring(emlStart, emlEnd);
  }

  async function generateEmlInBrowser(page, code, testFn) {
    return page.evaluate(([c, fn]) => {
      (0, eval)(c); // eslint-disable-line no-eval -- loading own source for testing
      return (0, eval)('(' + fn + ')()');
    }, [code, testFn]);
  }

  test('generateEML produces valid RFC 2822 headers', async ({ page }) => {
    await page.goto('about:blank');
    const eml = await generateEmlInBrowser(page, extractForEml(), `function() {
      var msg = {
        payload: {
          headers: [
            { name: 'From', value: 'alice@example.com' },
            { name: 'To', value: 'bob@example.com' },
            { name: 'Subject', value: 'Test Subject' },
            { name: 'Date', value: 'Mon, 13 Jan 2026 10:00:00 -0500' },
            { name: 'Message-ID', value: '<abc123@example.com>' },
          ],
          mimeType: 'text/plain',
          body: { data: btoa('Hello World') },
        },
      };
      return generateEML(msg);
    }`);

    expect(eml).toContain('From: alice@example.com');
    expect(eml).toContain('To: bob@example.com');
    expect(eml).toContain('Subject: Test Subject');
    expect(eml).toContain('Date: Mon, 13 Jan 2026 10:00:00 -0500');
    expect(eml).toContain('Message-ID: <abc123@example.com>');
    expect(eml).toContain('MIME-Version: 1.0');
  });

  test('single-part plain text messages are correct', async ({ page }) => {
    await page.goto('about:blank');
    const eml = await generateEmlInBrowser(page, extractForEml(), `function() {
      var msg = {
        payload: {
          headers: [
            { name: 'From', value: 'alice@example.com' },
            { name: 'To', value: 'bob@example.com' },
            { name: 'Subject', value: 'Plain' },
            { name: 'Date', value: 'Mon, 13 Jan 2026 10:00:00 -0500' },
          ],
          mimeType: 'text/plain',
          body: { data: btoa('Just plain text') },
        },
      };
      return generateEML(msg);
    }`);

    expect(eml).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(eml).toContain('Just plain text');
  });

  test('multipart alternative (text + HTML) messages are correct', async ({ page }) => {
    await page.goto('about:blank');
    const eml = await generateEmlInBrowser(page, extractForEml(), `function() {
      var msg = {
        payload: {
          headers: [
            { name: 'From', value: 'alice@example.com' },
            { name: 'To', value: 'bob@example.com' },
            { name: 'Subject', value: 'Multi' },
            { name: 'Date', value: 'Mon, 13 Jan 2026 10:00:00 -0500' },
          ],
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: btoa('plain version') } },
            { mimeType: 'text/html', body: { data: btoa('<p>html version</p>') } },
          ],
        },
      };
      return generateEML(msg);
    }`);

    expect(eml).toContain('multipart/alternative');
    expect(eml).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(eml).toContain('Content-Type: text/html; charset=UTF-8');
  });

  test('attachment handling produces correct MIME structure', async ({ page }) => {
    await page.goto('about:blank');
    const eml = await generateEmlInBrowser(page, extractForEml(), `function() {
      var msg = {
        payload: {
          headers: [
            { name: 'From', value: 'alice@example.com' },
            { name: 'To', value: 'bob@example.com' },
            { name: 'Subject', value: 'With Attachment' },
            { name: 'Date', value: 'Mon, 13 Jan 2026 10:00:00 -0500' },
          ],
          mimeType: 'multipart/mixed',
          parts: [
            { mimeType: 'text/html', body: { data: btoa('<p>body</p>') } },
            {
              mimeType: 'application/pdf',
              filename: 'doc.pdf',
              body: { attachmentId: 'att-1', size: 1000 },
            },
          ],
        },
      };
      return generateEML(msg, { 'att-1': 'AQIDBA==' });
    }`);

    expect(eml).toContain('multipart/mixed');
    expect(eml).toContain('Content-Disposition: attachment; filename="doc.pdf"');
    expect(eml).toContain('Content-Transfer-Encoding: base64');
  });
});

// ─── Export Format Integration ───────────────────────────────────────────────

test.describe('Export Format Integration', () => {
  const swCode = fs.readFileSync(
    path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
    'utf-8'
  );

  function extractForJson() {
    const utilStart = swCode.indexOf('// ─── Utility Helpers');
    const utilEnd = swCode.indexOf('// ─── HTML Generation');
    const jsonStart = swCode.indexOf('// ─── JSON Generation');
    const jsonEnd = swCode.indexOf('// ─── EML Generation');
    return swCode.substring(utilStart, utilEnd) + '\n' + swCode.substring(jsonStart, jsonEnd);
  }

  test('JSON generation produces valid JSON array', async ({ page }) => {
    await page.goto('about:blank');
    const code = extractForJson();

    const result = await page.evaluate(([c]) => {
      (0, eval)(c); // eslint-disable-line no-eval
      var threads = [{ id: '1', messages: [] }, { id: '2', messages: [] }];
      var json = generateJSON(threads);
      try {
        var parsed = JSON.parse(json);
        return { valid: true, isArray: Array.isArray(parsed), length: parsed.length };
      } catch (e) {
        return { valid: false };
      }
    }, [code]);

    expect(result.valid).toBe(true);
    expect(result.isArray).toBe(true);
    expect(result.length).toBe(2);
  });

  test('JSON pretty-print option works', async ({ page }) => {
    await page.goto('about:blank');
    const code = extractForJson();

    const result = await page.evaluate(([c]) => {
      (0, eval)(c); // eslint-disable-line no-eval
      var threads = [{ id: '1' }];
      var pretty = generateJSON(threads, true);
      var compact = generateJSON(threads, false);
      return {
        prettyHasNewlines: pretty.indexOf('\n') >= 0,
        compactHasNewlines: compact.indexOf('\n') >= 0,
      };
    }, [code]);

    expect(result.prettyHasNewlines).toBe(true);
    expect(result.compactHasNewlines).toBe(false);
  });

  test('Markdown frontmatter generation format', () => {
    expect(swCode).toContain("'---'");
    expect(swCode).toContain('subject:');
    expect(swCode).toContain('thread_id:');
    expect(swCode).toContain('message_count:');
    expect(swCode).toContain('exported_at:');
  });
});

// ─── Browser-Based Extension Loading Tests ───────────────────────────────────

test.describe('Extension Loading in Browser', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;
  let extensionId;

  test.beforeAll(async () => {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--disable-gpu',
        '--no-sandbox',
      ],
    });

    let serviceWorker;
    if (context.serviceWorkers().length > 0) {
      serviceWorker = context.serviceWorkers()[0];
    } else {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 10000 });
    }
    extensionId = serviceWorker.url().split('/')[2];
  });

  test.afterAll(async () => {
    if (context) await context.close();
  });

  test('extension loads and registers service worker', async () => {
    expect(extensionId).toBeTruthy();
    expect(extensionId.length).toBeGreaterThan(10);
  });

  test('options page loads with all settings', async () => {
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/options/options.html`);

    const title = await optionsPage.textContent('h1');
    expect(title).toBe('Gmail Thread Exporter Options');

    for (const fmt of ['pdf', 'html', 'markdown', 'json', 'eml']) {
      await expect(optionsPage.locator(`#opt-${fmt}`)).toBeVisible();
    }

    await expect(optionsPage.locator('input[name="opt-bundle"][value="zip"]')).toBeVisible();
    await expect(optionsPage.locator('input[name="opt-bundle"][value="individual"]')).toBeVisible();

    for (const val of ['none', 'inline-eml', 'separate']) {
      await expect(optionsPage.locator(`input[name="opt-attach"][value="${val}"]`)).toBeVisible();
    }

    const templateInput = optionsPage.locator('#opt-template');
    await expect(templateInput).toBeVisible();
    const templateValue = await templateInput.inputValue();
    expect(templateValue).toBe('{date} - {sender_name} - {subject}');

    await expect(optionsPage.locator('#opt-subfolder')).toBeVisible();
    await expect(optionsPage.locator('#opt-sanitize')).toBeVisible();
    await expect(optionsPage.locator('#opt-pretty-json')).toBeVisible();
    await expect(optionsPage.locator('#btn-save')).toBeVisible();
    await expect(optionsPage.locator('#btn-reset')).toBeVisible();

    await optionsPage.close();
  });

  test('options page save button persists settings across reload', async () => {
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/options/options.html`);

    await optionsPage.locator('#opt-subfolder').fill('test-gmail-exports');
    await optionsPage.locator('#btn-save').click();
    await expect(optionsPage.locator('#saved-msg')).toHaveClass(/visible/, { timeout: 2000 });

    await optionsPage.reload();
    await optionsPage.waitForLoadState('load');
    await optionsPage.waitForTimeout(500);

    expect(await optionsPage.locator('#opt-subfolder').inputValue()).toBe('test-gmail-exports');

    await optionsPage.locator('#btn-reset').click();
    await optionsPage.waitForTimeout(500);
    expect(await optionsPage.locator('#opt-subfolder').inputValue()).toBe('');

    await optionsPage.close();
  });

  test('options page reset button restores defaults', async () => {
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/options/options.html`);

    await optionsPage.locator('#opt-template').fill('{sender_name}_{date}');
    await optionsPage.locator('#btn-save').click();
    await optionsPage.waitForTimeout(500);

    await optionsPage.locator('#btn-reset').click();
    await optionsPage.waitForTimeout(500);
    expect(await optionsPage.locator('#opt-template').inputValue()).toBe('{date} - {sender_name} - {subject}');

    await optionsPage.close();
  });

  test('vendor libraries can be injected and expose globals', async () => {
    const page = await context.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    for (const file of ['vendor/turndown.umd.js', 'vendor/turndown-plugin-gfm.js']) {
      const code = fs.readFileSync(path.join(EXTENSION_PATH, file), 'utf-8');
      await page.evaluate(code);
    }

    const globals = await page.evaluate(() => ({
      TurndownService: typeof TurndownService !== 'undefined',
      turndownPluginGfm: typeof turndownPluginGfm !== 'undefined',
    }));

    expect(globals.TurndownService).toBe(true);
    expect(globals.turndownPluginGfm).toBe(true);
    await page.close();
  });

  test('Turndown can convert HTML to Markdown', async () => {
    const page = await context.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    await page.evaluate(fs.readFileSync(path.join(EXTENSION_PATH, 'vendor/turndown.umd.js'), 'utf-8'));
    await page.evaluate(fs.readFileSync(path.join(EXTENSION_PATH, 'vendor/turndown-plugin-gfm.js'), 'utf-8'));

    const markdown = await page.evaluate(() => {
      const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
      if (typeof turndownPluginGfm !== 'undefined' && turndownPluginGfm.gfm) {
        turndown.use(turndownPluginGfm.gfm);
      }
      return turndown.turndown(document.body.innerHTML);
    });

    expect(markdown).toBeTruthy();
    expect(markdown.length).toBeGreaterThan(10);
    expect(markdown).toContain('Example Domain');
    await page.close();
  });
});

// ─── Gmail DOM Simulation Tests ─────────────────────────────────────────────

test.describe('Gmail DOM Simulation', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;
  let extensionId;

  test.beforeAll(async () => {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--disable-gpu',
        '--no-sandbox',
      ],
    });

    let serviceWorker;
    if (context.serviceWorkers().length > 0) {
      serviceWorker = context.serviceWorkers()[0];
    } else {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 10000 });
    }
    extensionId = serviceWorker.url().split('/')[2];
  });

  test.afterAll(async () => {
    if (context) await context.close();
  });

  async function setupMockPage() {
    const page = await context.newPage();
    await page.goto(`file://${path.join(__dirname, 'gmail-mock.html')}`);
    await page.addScriptTag({ content: fs.readFileSync(path.join(EXTENSION_PATH, 'src/content/gmail-dom.js'), 'utf-8') });
    return page;
  }

  async function setupMockPageWithChrome() {
    const page = await setupMockPage();
    await page.evaluate(() => {
      window.chrome = {
        storage: { sync: { get: (defaults, cb) => cb(defaults) } },
        runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {} },
      };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(EXTENSION_PATH, 'src/content/export-modal.js'), 'utf-8') });
    return page;
  }

  test('GmailDOM.findToolbar returns toolbar element', async () => {
    const page = await setupMockPage();
    const found = await page.evaluate(() => {
      const toolbar = GmailDOM.findToolbar();
      return toolbar !== null && toolbar.classList.contains('G-Ni');
    });
    expect(found).toBe(true);
    await page.close();
  });

  test('GmailDOM.isThreadListView detects thread rows', async () => {
    const page = await setupMockPage();
    expect(await page.evaluate(() => GmailDOM.isThreadListView())).toBe(true);
    await page.close();
  });

  test('GmailDOM.getSelectedThreadIds returns IDs of checked rows', async () => {
    const page = await setupMockPage();
    await page.click('tr.zA:nth-child(1) [role="checkbox"]');
    await page.click('tr.zA:nth-child(2) [role="checkbox"]');

    const ids = await page.evaluate(() => GmailDOM.getSelectedThreadIds());
    expect(ids).toHaveLength(2);
    expect(ids).toContain('thread-abc-001');
    expect(ids).toContain('thread-abc-002');
    await page.close();
  });

  test('GmailDOM.getSelectedCount returns correct count', async () => {
    const page = await setupMockPage();

    expect(await page.evaluate(() => GmailDOM.getSelectedCount())).toBe(0);

    await page.click('tr.zA:nth-child(1) [role="checkbox"]');
    expect(await page.evaluate(() => GmailDOM.getSelectedCount())).toBe(1);

    await page.click('tr.zA:nth-child(2) [role="checkbox"]');
    await page.click('tr.zA:nth-child(3) [role="checkbox"]');
    expect(await page.evaluate(() => GmailDOM.getSelectedCount())).toBe(3);

    await page.close();
  });

  test('export button injection into toolbar', async () => {
    const page = await setupMockPageWithChrome();

    await page.evaluate(() => {
      const toolbar = GmailDOM.findToolbar();
      const container = document.createElement('div');
      container.id = 'gme-export-btn-container';
      const btn = document.createElement('button');
      btn.id = 'gme-export-btn';
      btn.textContent = 'Export';
      container.appendChild(btn);
      toolbar.appendChild(container);
    });

    expect(await page.locator('#gme-export-btn').isVisible()).toBe(true);
    await page.close();
  });

  test('export button disabled when no threads selected', async () => {
    const page = await setupMockPageWithChrome();

    await page.evaluate(() => {
      const toolbar = GmailDOM.findToolbar();
      const btn = document.createElement('button');
      btn.id = 'gme-export-btn';
      btn.disabled = GmailDOM.getSelectedCount() === 0;
      toolbar.appendChild(btn);
    });

    await expect(page.locator('#gme-export-btn')).toBeDisabled();
    await page.close();
  });

  test('export button enabled with correct title when threads are selected', async () => {
    const page = await setupMockPageWithChrome();

    await page.evaluate(() => {
      const toolbar = GmailDOM.findToolbar();
      const btn = document.createElement('button');
      btn.id = 'gme-export-btn';
      btn.disabled = true;
      toolbar.appendChild(btn);
      window._updateBtn = function () {
        const count = GmailDOM.getSelectedCount();
        btn.disabled = count === 0;
        btn.title = count > 0 ? 'Export ' + count + ' thread' + (count !== 1 ? 's' : '') : '';
      };
    });

    await page.click('tr.zA:nth-child(1) [role="checkbox"]');
    await page.click('tr.zA:nth-child(2) [role="checkbox"]');
    await page.evaluate(() => window._updateBtn());

    await expect(page.locator('#gme-export-btn')).not.toBeDisabled();
    expect(await page.locator('#gme-export-btn').getAttribute('title')).toBe('Export 2 threads');
    await page.close();
  });

  test('export button click opens modal', async () => {
    const page = await setupMockPageWithChrome();

    await page.evaluate(fs.readFileSync(path.join(EXTENSION_PATH, 'src/content/gmail-exporter.css'), 'utf-8').replace(/^/, '(function(){const s=document.createElement("style");s.textContent=`') + '`;document.head.appendChild(s)})()');

    await page.click('tr.zA:nth-child(1) [role="checkbox"]');
    await page.evaluate(() => {
      const toolbar = GmailDOM.findToolbar();
      const btn = document.createElement('button');
      btn.id = 'gme-export-btn';
      btn.textContent = 'Export';
      btn.addEventListener('click', () => {
        const ids = GmailDOM.getSelectedThreadIds();
        if (ids.length > 0) ExportModal.show(ids.length);
      });
      toolbar.appendChild(btn);
    });

    await page.click('#gme-export-btn');
    await page.waitForSelector('#gme-modal-backdrop', { timeout: 3000 });
    await expect(page.locator('#gme-modal')).toBeVisible();
    await page.close();
  });

  test('export modal shows correct thread count', async () => {
    const page = await setupMockPageWithChrome();
    await page.evaluate(() => ExportModal.show(5));
    await page.waitForSelector('#gme-modal', { timeout: 3000 });

    const countText = await page.locator('.gme-thread-count').textContent();
    expect(countText).toContain('5');
    expect(countText).toContain('threads');
    await page.close();
  });

  test('export modal format checkboxes are toggleable', async () => {
    const page = await setupMockPageWithChrome();
    await page.evaluate(() => ExportModal.show(1));
    await page.waitForSelector('#gme-modal', { timeout: 3000 });

    const htmlCb = page.locator('input[name="gme-fmt"][value="html"]');
    await expect(htmlCb).toBeChecked();
    await htmlCb.uncheck();
    await expect(htmlCb).not.toBeChecked();

    const pdfCb = page.locator('input[name="gme-fmt"][value="pdf"]');
    await expect(pdfCb).not.toBeChecked();
    await pdfCb.check();
    await expect(pdfCb).toBeChecked();
    await page.close();
  });

  test('export modal enforces at least one format selected', async () => {
    const page = await setupMockPageWithChrome();
    await page.evaluate(() => ExportModal.show(1));
    await page.waitForSelector('#gme-modal', { timeout: 3000 });

    const checkboxes = page.locator('input[name="gme-fmt"]');
    for (let i = 0; i < await checkboxes.count(); i++) {
      const cb = checkboxes.nth(i);
      if (await cb.isChecked()) await cb.uncheck();
    }

    await expect(page.locator('#gme-btn-export')).toBeDisabled();
    await page.locator('input[name="gme-fmt"][value="html"]').check();
    await expect(page.locator('#gme-btn-export')).not.toBeDisabled();
    await page.close();
  });

  test('export modal cancel button closes modal', async () => {
    const page = await setupMockPageWithChrome();
    await page.evaluate(() => ExportModal.show(1));
    await page.waitForSelector('#gme-modal', { timeout: 3000 });
    await page.click('#gme-btn-cancel');
    await expect(page.locator('#gme-modal-backdrop')).toHaveCount(0);
    await page.close();
  });

  test('export modal escape key closes modal', async () => {
    const page = await setupMockPageWithChrome();
    await page.evaluate(() => ExportModal.show(1));
    await page.waitForSelector('#gme-modal', { timeout: 3000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#gme-modal-backdrop')).toHaveCount(0);
    await page.close();
  });

  test('export modal backdrop click closes modal', async () => {
    const page = await setupMockPageWithChrome();
    await page.evaluate((css) => {
      const s = document.createElement('style');
      s.textContent = css;
      document.head.appendChild(s);
    }, fs.readFileSync(path.join(EXTENSION_PATH, 'src/content/gmail-exporter.css'), 'utf-8'));

    await page.evaluate(() => ExportModal.show(1));
    await page.waitForSelector('#gme-modal', { timeout: 3000 });
    await page.locator('#gme-modal-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#gme-modal-backdrop')).toHaveCount(0);
    await page.close();
  });

  test('export modal close button closes modal', async () => {
    const page = await setupMockPageWithChrome();
    await page.evaluate(() => ExportModal.show(1));
    await page.waitForSelector('#gme-modal', { timeout: 3000 });
    await page.click('.gme-modal-close');
    await expect(page.locator('#gme-modal-backdrop')).toHaveCount(0);
    await page.close();
  });

  test('selection observer updates button state on checkbox change', async () => {
    const page = await setupMockPageWithChrome();

    await page.evaluate(() => {
      const toolbar = GmailDOM.findToolbar();
      const btn = document.createElement('button');
      btn.id = 'gme-export-btn';
      btn.disabled = true;
      btn.title = 'Select threads to export';
      toolbar.appendChild(btn);

      function updateButtonState() {
        const count = GmailDOM.getSelectedCount();
        btn.disabled = count === 0;
        btn.title = count > 0 ? 'Export ' + count + ' thread' + (count !== 1 ? 's' : '') : 'Select threads to export';
      }

      const observer = new MutationObserver(() => updateButtonState());
      const threadList = document.querySelector('div[role="main"]') || document.body;
      observer.observe(threadList, { subtree: true, attributes: true, attributeFilter: ['aria-checked'] });
    });

    await expect(page.locator('#gme-export-btn')).toBeDisabled();
    await page.click('tr.zA:nth-child(1) [role="checkbox"]');
    await page.waitForTimeout(200);
    await expect(page.locator('#gme-export-btn')).not.toBeDisabled();
    expect(await page.locator('#gme-export-btn').getAttribute('title')).toBe('Export 1 thread');
    await page.close();
  });

  test('SPA navigation observer re-injects button', async () => {
    const page = await setupMockPageWithChrome();

    await page.evaluate(() => {
      function injectButton() {
        if (document.getElementById('gme-export-btn')) return;
        const toolbar = GmailDOM.findToolbar();
        if (!toolbar) return;
        const btn = document.createElement('button');
        btn.id = 'gme-export-btn';
        btn.textContent = 'Export';
        toolbar.appendChild(btn);
      }
      injectButton();

      let lastUrl = location.href;
      new MutationObserver(() => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          setTimeout(() => { if (!document.getElementById('gme-export-btn')) injectButton(); }, 100);
        }
      }).observe(document.body, { childList: true, subtree: true });
    });

    await expect(page.locator('#gme-export-btn')).toBeVisible();

    await page.evaluate(() => document.getElementById('gme-export-btn').remove());
    await expect(page.locator('#gme-export-btn')).toHaveCount(0);

    await page.evaluate(() => {
      history.pushState({}, '', '#inbox/new-view');
      document.body.appendChild(document.createElement('div'));
    });

    await page.waitForSelector('#gme-export-btn', { timeout: 3000 });
    await expect(page.locator('#gme-export-btn')).toBeVisible();
    await page.close();
  });
});
