'use strict';

/**
 * Export options modal component.
 *
 * Shows format selection, download mode, attachment handling,
 * and a progress bar with time estimates during export.
 */

// Exports at or above this many threads fetch every message, render every
// PDF and hold every generated file in memory before the ZIP is written —
// several minutes and real memory pressure for a large label or search
// result. Confirm before starting one instead of letting a misclick or a
// "select all" run silently.
const LARGE_EXPORT_CONFIRM_THRESHOLD = 50;

class ExportProgress {
  constructor(total) {
    this.total = total;
    this.done = 0;
    this.startTime = Date.now();
  }

  update(completed) {
    this.done = completed;
    const elapsed = (Date.now() - this.startTime) / 1000;
    const avgPerThread = this.done > 0 ? elapsed / this.done : 0;
    const remaining = this.total - this.done;
    const estimatedSecs = this.done > 0 ? Math.round(avgPerThread * remaining) : 0;

    return {
      percent: Math.round((this.done / this.total) * 100),
      label: `Thread ${this.done} of ${this.total}`,
      stats: this.done > 0
        ? `${this.done} done \u2022 ${remaining} remaining \u2022 ~${ExportProgress.formatTime(estimatedSecs)} left`
        : 'Starting...',
    };
  }

  static formatTime(secs) {
    if (secs < 60) return `${secs}s`;
    return `${Math.round(secs / 60)}m`;
  }
}

const ExportModal = {
  _modal: null,
  _progress: null,
  _exporting: false,

  async show(threadCount) {
    if (this._modal) this.close();

    // Load saved settings for defaults (gracefully handle invalidated extension context)
    const defaultSettings = {
      defaultFormats: { pdf: false, html: true, markdown: true, json: true, eml: false },
      defaultBundle: 'zip',
      attachmentMode: 'separate',
    };
    let settings;
    try {
      settings = await new Promise((resolve, reject) => {
        if (!chrome?.storage?.sync) {
          reject(new Error('chrome.storage unavailable'));
          return;
        }
        chrome.storage.sync.get(defaultSettings, resolve);
      });
    } catch {
      console.warn('[GmailExporter] Could not load settings, using defaults');
      settings = defaultSettings;
    }

    const backdrop = document.createElement('div');
    backdrop.id = 'gme-modal-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && !this._exporting) this.close();
    });

    const modal = document.createElement('div');
    modal.id = 'gme-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Export Gmail Threads');

    modal.innerHTML = `
      <div class="gme-modal-header">
        <h2>Export Gmail Threads</h2>
        <button class="gme-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="gme-modal-body">
        <p class="gme-thread-count">Exporting <strong>${threadCount}</strong> thread${threadCount !== 1 ? 's' : ''}</p>

        <fieldset class="gme-fieldset">
          <legend>File Formats</legend>
          <label class="gme-checkbox-label">
            <input type="checkbox" name="gme-fmt" value="pdf" ${settings.defaultFormats.pdf ? 'checked' : ''}>
            <span>PDF <em>(rendered, great for archiving)</em></span>
          </label>
          <label class="gme-checkbox-label">
            <input type="checkbox" name="gme-fmt" value="html" ${settings.defaultFormats.html ? 'checked' : ''}>
            <span>HTML <em>(self-contained web page)</em></span>
          </label>
          <label class="gme-checkbox-label">
            <input type="checkbox" name="gme-fmt" value="markdown" ${settings.defaultFormats.markdown ? 'checked' : ''}>
            <span>Markdown <em>(plain text + metadata)</em></span>
          </label>
          <label class="gme-checkbox-label">
            <input type="checkbox" name="gme-fmt" value="json" ${settings.defaultFormats.json ? 'checked' : ''}>
            <span>JSON <em>(raw Gmail API data)</em></span>
          </label>
          <label class="gme-checkbox-label">
            <input type="checkbox" name="gme-fmt" value="eml" ${settings.defaultFormats.eml ? 'checked' : ''}>
            <span>EML <em>(importable into mail apps)</em></span>
          </label>
        </fieldset>

        <fieldset class="gme-fieldset">
          <legend>Download Options</legend>
          <label class="gme-radio-label">
            <input type="radio" name="gme-bundle" value="zip" ${settings.defaultBundle === 'zip' ? 'checked' : ''}>
            <span>Single ZIP archive</span>
          </label>
          <label class="gme-radio-label">
            <input type="radio" name="gme-bundle" value="individual" ${settings.defaultBundle === 'individual' ? 'checked' : ''}>
            <span>Download each file separately</span>
          </label>
        </fieldset>

        <fieldset class="gme-fieldset">
          <legend>Attachments</legend>
          <label class="gme-radio-label">
            <input type="radio" name="gme-attach" value="none" ${settings.attachmentMode === 'none' ? 'checked' : ''}>
            <span>Skip attachments</span>
          </label>
          <label class="gme-radio-label">
            <input type="radio" name="gme-attach" value="inline-eml" ${settings.attachmentMode === 'inline-eml' ? 'checked' : ''}>
            <span>Include in EML (inline)</span>
          </label>
          <label class="gme-radio-label">
            <input type="radio" name="gme-attach" value="separate" ${settings.attachmentMode === 'separate' ? 'checked' : ''}>
            <span>Save as separate files</span>
          </label>
        </fieldset>

        <div id="gme-progress-section" class="gme-progress-section" style="display:none;">
          <div class="gme-progress-bar-container">
            <div id="gme-progress-bar" class="gme-progress-bar" style="width:0%"></div>
          </div>
          <div id="gme-progress-label" class="gme-progress-label"></div>
          <div id="gme-progress-stats" class="gme-progress-stats"></div>
        </div>
      </div>
      <div class="gme-modal-footer">
        <a href="https://github.com/geoffmyers/gmail-thread-exporter" target="_blank" rel="noopener noreferrer" class="gme-gh-link">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path></svg>
          View source on GitHub
        </a>
        <div class="gme-modal-footer-actions">
          <button id="gme-btn-cancel" class="gme-btn gme-btn-secondary">Cancel</button>
          <button id="gme-btn-export" class="gme-btn gme-btn-primary">Export \u2193</button>
        </div>
      </div>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    this._modal = backdrop;
    this._exporting = false;

    // Event listeners
    modal.querySelector('.gme-modal-close').addEventListener('click', () => {
      if (!this._exporting) this.close();
    });

    modal.querySelector('#gme-btn-cancel').addEventListener('click', () => {
      this.close();
    });

    const exportBtn = modal.querySelector('#gme-btn-export');
    const formatCheckboxes = modal.querySelectorAll('input[name="gme-fmt"]');

    // Validate at least one format selected
    const validateFormats = () => {
      const anyChecked = Array.from(formatCheckboxes).some((cb) => cb.checked);
      exportBtn.disabled = !anyChecked;
    };
    formatCheckboxes.forEach((cb) => cb.addEventListener('change', validateFormats));
    validateFormats();

    // Force ZIP for bulk exports (10+ threads)
    if (threadCount >= 10) {
      const zipRadio = modal.querySelector('input[name="gme-bundle"][value="zip"]');
      const individualRadio = modal.querySelector('input[name="gme-bundle"][value="individual"]');
      zipRadio.checked = true;
      individualRadio.disabled = true;
      individualRadio.closest('label').title = 'ZIP archive is required for exports of 10 or more threads';
      individualRadio.closest('label').style.opacity = '0.5';
    }

    exportBtn.addEventListener('click', () => {
      if (threadCount >= LARGE_EXPORT_CONFIRM_THRESHOLD) {
        const proceed = window.confirm(
          `You're about to export ${threadCount} threads. This can take several ` +
          'minutes and use significant memory while every message and file is ' +
          'fetched and rendered. Continue?'
        );
        if (!proceed) return;
      }
      this._startExport(threadCount);
    });

    // Focus trap + Escape key
    document.addEventListener('keydown', this._keyHandler);

    // Focus the export button
    exportBtn.focus();
  },

  _keyHandler(e) {
    if (e.key === 'Escape' && !ExportModal._exporting) {
      ExportModal.close();
    }
  },

  _startExport(threadCount) {
    this._exporting = true;
    this._progress = new ExportProgress(threadCount);

    const modal = this._modal.querySelector('#gme-modal');
    const exportBtn = modal.querySelector('#gme-btn-export');
    const cancelBtn = modal.querySelector('#gme-btn-cancel');
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting...';
    cancelBtn.textContent = 'Cancel';

    // Disable format/option inputs during export
    modal.querySelectorAll('input[name="gme-fmt"], input[name="gme-bundle"], input[name="gme-attach"]')
      .forEach((el) => { el.disabled = true; });

    // Show progress
    modal.querySelector('#gme-progress-section').style.display = '';

    // Gather options
    const formats = {};
    modal.querySelectorAll('input[name="gme-fmt"]:checked').forEach((cb) => {
      formats[cb.value] = true;
    });
    const bundle = modal.querySelector('input[name="gme-bundle"]:checked')?.value || 'zip';
    const attachmentMode = modal.querySelector('input[name="gme-attach"]:checked')?.value || 'inline-eml';

    // Send export request to service worker
    const threadIds = GmailDOM.getSelectedThreadIds();
    console.log('[GmailExporter] Sending export-threads message', { threadIds, formats, bundle, attachmentMode });

    try {
      chrome.runtime.sendMessage({
        type: 'export-threads',
        threadIds,
        formats,
        bundle,
        attachmentMode,
      }, (response) => {
        console.log('[GmailExporter] Service worker response:', JSON.stringify(response));
        if (chrome.runtime.lastError) {
          console.error('[GmailExporter] sendMessage error:', chrome.runtime.lastError.message);
          this._showError(chrome.runtime.lastError.message);
          return;
        }
        if (!response) {
          console.error('[GmailExporter] No response from service worker');
          this._showError('No response from service worker. Try reloading the extension.');
          return;
        }
        if (response.error) {
          this._showError(response.error);
        } else {
          this._showComplete(response.results);
      }
      });
    } catch (err) {
      this._showError('Extension context invalidated. Please reload the Gmail page (Ctrl+Shift+R).');
    }
  },

  updateProgress(data) {
    if (!this._modal || !this._progress) return;

    const info = this._progress.update(data.completed);
    const bar = this._modal.querySelector('#gme-progress-bar');
    const label = this._modal.querySelector('#gme-progress-label');
    const stats = this._modal.querySelector('#gme-progress-stats');

    if (bar) bar.style.width = `${info.percent}%`;
    if (label) label.textContent = info.label;
    if (stats) stats.textContent = info.stats;
  },

  _showError(message) {
    this._exporting = false;
    if (!this._modal) return;

    const modal = this._modal.querySelector('#gme-modal');
    const exportBtn = modal.querySelector('#gme-btn-export');
    const cancelBtn = modal.querySelector('#gme-btn-cancel');

    exportBtn.textContent = 'Retry';
    exportBtn.disabled = false;
    cancelBtn.textContent = 'Close';

    const progressSection = modal.querySelector('#gme-progress-section');
    progressSection.innerHTML = `<div class="gme-error">Export failed: ${this._escapeHtml(message)}</div>`;
    progressSection.style.display = '';

    // Re-enable inputs
    modal.querySelectorAll('input[name="gme-fmt"], input[name="gme-bundle"], input[name="gme-attach"]')
      .forEach((el) => { el.disabled = false; });
  },

  _showComplete(results) {
    this._exporting = false;
    if (!this._modal) return;

    const successCount = results ? results.filter((r) => r.success).length : 0;
    const failCount = results ? results.filter((r) => !r.success).length : 0;

    // Close modal and show toast
    this.close();
    ExportModal.showToast(
      failCount === 0
        ? `Export complete! ${successCount} file${successCount !== 1 ? 's' : ''} downloaded.`
        : `Export done with ${failCount} error${failCount !== 1 ? 's' : ''}. ${successCount} file${successCount !== 1 ? 's' : ''} downloaded.`,
      failCount === 0 ? 'success' : 'warning'
    );
  },

  showToast(message, type = 'success') {
    // Remove existing toast
    const existing = document.getElementById('gme-notification');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'gme-notification';
    toast.className = `gme-toast gme-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => toast.classList.add('gme-toast-visible'));

    setTimeout(() => {
      toast.classList.remove('gme-toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  },

  close() {
    document.removeEventListener('keydown', this._keyHandler);
    if (this._modal) {
      this._modal.remove();
      this._modal = null;
    }
    this._progress = null;
    this._exporting = false;
  },

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};
