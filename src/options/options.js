'use strict';

const DEFAULTS = {
  defaultFormats: { pdf: false, html: true, markdown: true, json: true, eml: false },
  defaultBundle: 'zip',
  attachmentMode: 'separate',
  filenameTemplate: '{date} - {sender_name} - {subject}',
  subfolder: '',
  htmlSanitize: true,
  jsonPrettyPrint: true,
};

const FORMAT_IDS = ['pdf', 'html', 'markdown', 'json', 'eml'];

// Sample data for filename preview
const SAMPLE_TOKENS = {
  '{date}': '2026-01-15',
  '{datetime}': '2026-01-15_14-32-00',
  '{sender_name}': 'Alice Smith',
  '{sender_email}': 'alice_at_example.com',
  '{sender_domain}': 'example.com',
  '{recipient_name}': 'Bob Jones',
  '{recipient_email}': 'bob_at_company.com',
  '{recipient_domain}': 'company.com',
  '{subject}': 'Re Invoice 1234',
  '{n}': '01',
  '{thread_id}': '18abc123def456',
};

function updatePreview() {
  const template = document.getElementById('opt-template').value || DEFAULTS.filenameTemplate;
  let preview = template;
  for (const [token, value] of Object.entries(SAMPLE_TOKENS)) {
    preview = preview.replace(new RegExp(token.replace(/[{}]/g, '\\$&'), 'g'), value);
  }
  document.getElementById('filename-preview').textContent = `Preview: ${preview}.pdf`;
}

function loadOptions() {
  chrome.storage.sync.get(DEFAULTS, (data) => {
    for (const fmt of FORMAT_IDS) {
      document.getElementById(`opt-${fmt}`).checked = data.defaultFormats[fmt] === true;
    }

    const bundleRadios = document.querySelectorAll('input[name="opt-bundle"]');
    bundleRadios.forEach((r) => { r.checked = r.value === data.defaultBundle; });

    const attachRadios = document.querySelectorAll('input[name="opt-attach"]');
    attachRadios.forEach((r) => { r.checked = r.value === data.attachmentMode; });

    document.getElementById('opt-template').value = data.filenameTemplate || DEFAULTS.filenameTemplate;
    document.getElementById('opt-subfolder').value = data.subfolder || '';
    document.getElementById('opt-sanitize').checked = data.htmlSanitize === true;
    document.getElementById('opt-pretty-json').checked = data.jsonPrettyPrint !== false;

    updatePreview();
  });
}

function saveOptions() {
  const defaultFormats = {};
  for (const fmt of FORMAT_IDS) {
    defaultFormats[fmt] = document.getElementById(`opt-${fmt}`).checked;
  }

  const defaultBundle = document.querySelector('input[name="opt-bundle"]:checked')?.value || 'zip';
  const attachmentMode = document.querySelector('input[name="opt-attach"]:checked')?.value || 'inline-eml';

  const options = {
    defaultFormats,
    defaultBundle,
    attachmentMode,
    filenameTemplate: document.getElementById('opt-template').value.trim() || DEFAULTS.filenameTemplate,
    subfolder: document.getElementById('opt-subfolder').value.trim(),
    htmlSanitize: document.getElementById('opt-sanitize').checked,
    jsonPrettyPrint: document.getElementById('opt-pretty-json').checked,
  };

  chrome.storage.sync.set(options, () => {
    const msg = document.getElementById('saved-msg');
    msg.textContent = 'Saved';
    msg.classList.add('visible');
    setTimeout(() => msg.classList.remove('visible'), 2000);
  });
}

function resetOptions() {
  chrome.storage.sync.set(DEFAULTS, () => {
    loadOptions();
    const msg = document.getElementById('saved-msg');
    msg.textContent = 'Reset';
    msg.classList.add('visible');
    setTimeout(() => {
      msg.classList.remove('visible');
      msg.textContent = 'Saved';
    }, 2000);
  });
}

document.getElementById('btn-save').addEventListener('click', saveOptions);
document.getElementById('btn-reset').addEventListener('click', resetOptions);
document.getElementById('opt-template').addEventListener('input', updatePreview);

loadOptions();
