const RESTORE_RAMP_SECONDS = 0.03;

export function resolveUserVolume({ player, remembered }) {
  const isPlayerUsable = player && typeof player.muted === 'boolean' && Number.isFinite(player.volume);
  const source = isPlayerUsable ? player : remembered;
  return source.muted ? 0 : Math.min(1, Math.max(0, source.volume));
}

export function createOriginalAudioRegistry({ mode, readPlayerVolume = () => null }) {
  const controls = new WeakMap();
  const attached = new Set();
  return {
    attach(video, context, { level }) {
      let control = controls.get(video);
      if (!control) {
        control = createControl(video, context, { mode, level, readPlayerVolume });
        controls.set(video, control);
      }
      attached.add(control);
      control.setLevel(level);
      return control;
    },
    restoreAll() {
      for (const control of attached) control.setLevel(1);
      attached.clear();
    },
  };
}

function createControl(video, context, { mode, level, readPlayerVolume }) {
  if (mode !== 'graph') return createMuteControl(video, { level, readPlayerVolume, error: null });
  const gain = context.createGain();
  gain.gain.value = level;
  let source;
  try {
    source = context.createMediaElementSource(video);
  } catch (error) {
    return createMuteControl(video, { level, readPlayerVolume, error: `original audio could not be routed (${error.message})` });
  }
  source.connect(gain);
  gain.connect(context.destination);
  return createGraphControl(video, context, gain, level);
}

function createGraphControl(video, context, gain, initialLevel) {
  let level = initialLevel;
  return {
    mode: 'graph',
    error: null,
    setLevel(next) {
      if (next === level) return;
      level = next;
      const now = context.currentTime;
      gain.gain.cancelScheduledValues(now);
      if (next === 0) {
        gain.gain.setValueAtTime(0, now);
        return;
      }
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(next, now + RESTORE_RAMP_SECONDS);
    },
    currentLevel: () => level,
    userVolume: () => (video.muted ? 0 : video.volume),
  };
}

function createMuteControl(video, { level: initialLevel, readPlayerVolume, error }) {
  let level = 1;
  const remembered = { muted: video.muted, volume: video.volume };
  const silence = () => {
    video.muted = true;
    video.volume = 0;
  };
  video.addEventListener('volumechange', () => {
    if (level !== 0) {
      remembered.muted = video.muted;
      remembered.volume = video.volume;
      return;
    }
    if (!video.muted) remembered.muted = false;
    if (video.volume > 0) remembered.volume = video.volume;
    if (!video.muted || video.volume > 0) silence();
  });
  const control = {
    mode: 'mute',
    error,
    setLevel(next) {
      if (next === level) return;
      if (next === 0) {
        remembered.muted = video.muted;
        remembered.volume = video.volume;
        level = 0;
        silence();
        return;
      }
      level = next;
      video.volume = remembered.volume;
      video.muted = remembered.muted;
    },
    currentLevel: () => level,
    userVolume: () => resolveUserVolume({ player: readPlayerVolume(), remembered }),
  };
  control.setLevel(initialLevel);
  return control;
}
