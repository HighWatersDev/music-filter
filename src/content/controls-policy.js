const ACTIVITY_SECONDS = 3;
const PROBLEM_SECONDS = 5;
const BUSY_STATES = new Set(['waiting', 'starting', 'filtering']);
const PROBLEM_STATES = new Set(['error', 'muted', 'too-slow']);
const STATES_WITH_DETAIL = new Set(['waiting', 'starting', 'filtering', 'filtered']);

const MESSAGES = {
  off: () => '',
  waiting: () => 'Waiting for audio',
  starting: () => 'Starting filter…',
  filtering: () => 'Filtering…',
  filtered: (view) => (view.mode === 'live' ? 'Filtered' : `Filtered · ${view.aheadSeconds.toFixed(0)} s ready`),
  muted: () => 'Filter works at Normal speed',
  'too-slow': () => 'This device is too slow to filter live',
  error: (view) => `Can't filter this video: ${view.detail}`,
};

export function statusText(view) {
  if (!view.isOn) return '';
  const extra = view.detail && STATES_WITH_DETAIL.has(view.state) ? ` · ${view.detail}` : '';
  return `${MESSAGES[view.state](view)}${extra}`;
}

export function iconLook(state) {
  if (state === 'filtered') return 'on';
  if (BUSY_STATES.has(state)) return 'busy';
  if (PROBLEM_STATES.has(state)) return 'problem';
  return 'off';
}

// Mirrors when YouTube shows its own controls, so the icon never sits over a playing video on its own.
export function isIconVisible({ state, isPaused, secondsSinceActivity }) {
  return isPaused || BUSY_STATES.has(state) || secondsSinceActivity < ACTIVITY_SECONDS;
}

export function problemMessage(previous, next) {
  if (!next.isOn || !PROBLEM_STATES.has(next.state)) return null;
  if (previous.state === next.state && previous.detail === next.detail) return null;
  return { text: statusText(next), seconds: PROBLEM_SECONDS };
}
