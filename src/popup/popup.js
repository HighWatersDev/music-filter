import { createSettings, extensionApi } from '../content/settings.js';

const STATUS_POLL_MS = 1000;
const api = extensionApi();
const settings = createSettings(api.storage);
const toggle = document.getElementById('enabled');
const status = document.getElementById('status');

async function activeTabStatus() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    return await api.tabs.sendMessage(tab.id, { type: 'music-filter:status' });
  } catch {
    return null;
  }
}

async function showStatus() {
  const current = await activeTabStatus();
  if (!current) {
    status.textContent = 'Open a YouTube video to use Music Filter.';
    return;
  }
  if (!current.isOn) {
    status.textContent = 'Off. YouTube plays the original audio.';
    return;
  }
  status.textContent = current.text || 'On';
}

toggle.addEventListener('change', async () => {
  await settings.writeEnabled(toggle.checked);
  showStatus();
});
settings.watchEnabled((on) => {
  toggle.checked = on;
});

toggle.checked = await settings.readEnabled();
toggle.disabled = false;
showStatus();
setInterval(showStatus, STATUS_POLL_MS);
