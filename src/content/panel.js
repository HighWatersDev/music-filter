import { iconLook, isIconVisible, problemMessage, statusText } from './controls-policy.js';
import { createSettings, extensionApi } from './settings.js';

const SVG = 'http://www.w3.org/2000/svg';
const REFRESH_MS = 250;
const TOGGLE_MESSAGE_SECONDS = 1.5;
const ACCENT = '#2f6fed';
const AMBER = '#f5a524';
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'touchstart', 'keydown'];
// Stops a tap on the icon from also reaching YouTube's player, which would pause or show its controls.
const SWALLOWED_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'dblclick', 'keydown'];

function svgElement(name, attributes) {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

// Built with DOM calls because YouTube enforces Trusted Types, which blocks innerHTML.
function createGlyph() {
  const svg = svgElement('svg', {
    viewBox: '0 0 24 24',
    width: '20',
    height: '20',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
  const slash = svgElement('line', { x1: '3', y1: '3', x2: '21', y2: '21' });
  svg.append(
    svgElement('path', { d: 'M9 17V6l10-2v11' }),
    svgElement('circle', { cx: '6.5', cy: '17', r: '2.5', fill: 'currentColor' }),
    svgElement('circle', { cx: '16.5', cy: '15', r: '2.5', fill: 'currentColor' }),
    slash,
  );
  return { svg, slash };
}

function findPlayer() {
  const video = document.querySelector('#movie_player video.html5-main-video') ?? document.querySelector('video');
  // On m.youtube.com the controls are a sibling of the player and stack above it, so the icon goes in
  // the container that holds both.
  return { video, player: video?.closest('#player-container-id') ?? video?.closest('.html5-video-player') ?? null };
}

export function createPanel({ onToggle, mode = 'read-ahead', api = extensionApi() }) {
  const settings = createSettings(api.storage);
  const size = matchMedia('(pointer: coarse)').matches ? 40 : 36;

  const root = document.createElement('div');
  root.id = 'music-filter';
  Object.assign(root.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    zIndex: '2147483647',
    pointerEvents: 'none',
    font: '13px/1.3 system-ui, -apple-system, sans-serif',
  });

  const button = document.createElement('button');
  button.type = 'button';
  Object.assign(button.style, {
    position: 'relative',
    display: 'grid',
    placeItems: 'center',
    flex: 'none',
    width: `${size}px`,
    height: `${size}px`,
    margin: '0',
    padding: '0',
    border: 'none',
    borderRadius: '50%',
    color: '#fff',
    cursor: 'pointer',
    boxSizing: 'border-box',
    transition: 'opacity 0.2s, background-color 0.2s',
  });
  const { svg, slash } = createGlyph();
  const ring = document.createElement('span');
  Object.assign(ring.style, {
    position: 'absolute',
    inset: '0',
    borderRadius: '50%',
    borderWidth: '2px',
    borderStyle: 'solid',
    boxSizing: 'border-box',
    pointerEvents: 'none',
  });
  ring.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 1000, iterations: Infinity });
  button.append(svg, ring);

  const message = document.createElement('span');
  message.setAttribute('role', 'status');
  Object.assign(message.style, {
    maxWidth: '260px',
    padding: '6px 12px',
    borderRadius: '16px',
    background: 'rgba(0, 0, 0, 0.75)',
    color: '#fff',
    opacity: '0',
    transition: 'opacity 0.2s',
  });
  root.append(button, message);

  const view = {
    mode,
    isOn: false,
    state: 'off',
    detail: '',
    aheadSeconds: 0,
    windows: 0,
    originalLevel: 1,
    stats: null,
    model: null,
    engine: null,
  };
  let lastActivityAt = -Infinity;
  let messageUntil = 0;
  let mountedIn;

  const showMessage = (text, seconds) => {
    message.textContent = text;
    messageUntil = performance.now() + seconds * 1000;
  };

  const mount = (player) => {
    if (mountedIn === player && root.isConnected) return;
    mountedIn = player;
    Object.assign(root.style, player ? { position: 'absolute', top: '12px', left: '12px' } : { position: 'fixed', top: '64px', left: '8px' });
    (player ?? document.documentElement).append(root);
  };

  const render = () => {
    const { video, player } = findPlayer();
    mount(player);
    const look = view.isOn ? iconLook(view.state) : 'off';
    const isVisible = isIconVisible({
      state: view.isOn ? view.state : 'off',
      isPaused: video?.paused ?? true,
      secondsSinceActivity: (performance.now() - lastActivityAt) / 1000,
    });
    const status = statusText(view);
    button.setAttribute('aria-label', `Music filter: ${view.isOn ? 'on' : 'off'}${status ? `. ${status}` : ''}`);
    button.setAttribute('aria-pressed', String(view.isOn));
    button.title = status || `Music filter is ${view.isOn ? 'on' : 'off'}`;
    button.style.opacity = isVisible ? '1' : '0';
    button.style.pointerEvents = isVisible ? 'auto' : 'none';
    button.style.background = look === 'on' || look === 'busy' ? ACCENT : 'rgba(0, 0, 0, 0.6)';
    button.style.color = look === 'problem' ? AMBER : '#fff';
    slash.style.display = view.isOn ? '' : 'none';
    ring.style.display = look === 'busy' || look === 'problem' ? '' : 'none';
    ring.style.borderColor = look === 'busy' ? 'rgba(255, 255, 255, 0.9)' : AMBER;
    if (look === 'busy') ring.style.borderTopColor = 'transparent';
    message.style.opacity = performance.now() < messageUntil ? '1' : '0';

    Object.assign(root.dataset, {
      state: view.state,
      originalLevel: String(view.originalLevel),
      aheadSeconds: view.aheadSeconds.toFixed(1),
      windows: String(view.windows),
      status,
    });
    if (view.stats) root.dataset.stats = JSON.stringify(view.stats);
    if (view.model) root.dataset.model = view.model;
    if (view.engine) root.dataset.engine = JSON.stringify(view.engine);
  };

  const setOn = (on, { announce }) => {
    if (on === view.isOn) return;
    view.isOn = on;
    if (announce) showMessage(`Music filter ${on ? 'on' : 'off'}`, TOGGLE_MESSAGE_SECONDS);
    render();
    onToggle(on);
  };

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const on = !view.isOn;
    setOn(on, { announce: true });
    settings.writeEnabled(on).catch(() => {});
  });
  for (const type of SWALLOWED_EVENTS) {
    button.addEventListener(type, (event) => {
      if (type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      event.stopPropagation();
    });
  }

  const handleActivity = (event) => {
    const isOutsidePlayer = mountedIn && !mountedIn.contains(event.target);
    if (!isOutsidePlayer) lastActivityAt = performance.now();
    else if (event.pointerType === 'mouse') lastActivityAt = -Infinity;
    render();
  };
  for (const type of ACTIVITY_EVENTS) document.addEventListener(type, handleActivity, { capture: true, passive: true });

  settings.watchEnabled((on) => setOn(on, { announce: true }));
  settings.readEnabled().then((on) => {
    setOn(on, { announce: false });
    root.dataset.ready = 'true';
  });

  api.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.type !== 'music-filter:status') return;
    sendResponse({ isOn: view.isOn, state: view.state, text: statusText(view) });
  });

  render();
  setInterval(render, REFRESH_MS);
  return {
    update(partial) {
      const previous = { ...view };
      Object.assign(view, partial);
      const problem = problemMessage(previous, view);
      if (problem) showMessage(problem.text, problem.seconds);
      render();
    },
  };
}
