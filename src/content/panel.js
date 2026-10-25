const MESSAGES = {
  off: () => '',
  waiting: () => 'Waiting for audio',
  filtering: () => 'Filtering…',
  filtered: (view) => `Filtered · ${view.aheadSeconds.toFixed(0)} s ready`,
  muted: () => 'Filter works at Normal speed',
  error: (view) => `Can't filter this video: ${view.detail}`,
};
const STATES_WITH_DETAIL = new Set(['waiting', 'filtering', 'filtered']);

export function createPanel({ onToggle }) {
  const root = document.createElement('div');
  Object.assign(root.style, {
    position: 'fixed',
    top: '64px',
    left: '8px',
    zIndex: '2147483647',
    padding: '6px 8px',
    maxWidth: '320px',
    font: '12px/1.4 ui-monospace, monospace',
    background: 'rgba(10, 20, 40, 0.88)',
    color: '#cfe3ff',
    borderRadius: '6px',
  });
  const button = document.createElement('button');
  Object.assign(button.style, {
    font: 'inherit',
    padding: '4px 8px',
    cursor: 'pointer',
    background: '#13233f',
    color: '#cfe3ff',
    border: '1px solid #cfe3ff',
    borderRadius: '4px',
  });
  const status = document.createElement('div');
  root.append(button, status);

  const view = { isOn: false, state: 'off', detail: '', aheadSeconds: 0, windows: 0, originalLevel: 1 };
  const render = () => {
    button.textContent = `Music filter: ${view.isOn ? 'ON' : 'OFF'}`;
    const extra = view.detail && STATES_WITH_DETAIL.has(view.state) ? ` · ${view.detail}` : '';
    status.textContent = view.isOn ? `${MESSAGES[view.state](view)}${extra}` : '';
    Object.assign(root.dataset, {
      state: view.state,
      originalLevel: String(view.originalLevel),
      aheadSeconds: view.aheadSeconds.toFixed(1),
      windows: String(view.windows),
    });
    if (!root.isConnected) document.documentElement.append(root);
  };
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    view.isOn = !view.isOn;
    render();
    onToggle(view.isOn);
  });
  render();
  return {
    update(partial) {
      Object.assign(view, partial);
      render();
    },
  };
}
