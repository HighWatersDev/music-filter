const RAMP_SECONDS = 0.03;

export function createOriginalAudio(video, context, { mode }) {
  if (mode === 'graph') {
    const source = context.createMediaElementSource(video);
    const gain = new GainNode(context, { gain: 1 });
    source.connect(gain).connect(context.destination);
    let level = 1;
    return {
      mode,
      setLevel(next) {
        if (next === level) return;
        level = next;
        const now = context.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(next, now + RAMP_SECONDS);
      },
      currentLevel: () => level,
      userVolume: () => (video.muted ? 0 : video.volume),
      dispose() {
        this.setLevel(1);
      },
    };
  }

  let level = 1;
  let isUserMuted = video.muted;
  const onVolumeChange = () => {
    if (level === 1) {
      isUserMuted = video.muted;
      return;
    }
    if (!video.muted) {
      isUserMuted = false;
      video.muted = true;
    }
  };
  video.addEventListener('volumechange', onVolumeChange);
  return {
    mode,
    setLevel(next) {
      if (next === level) return;
      level = next;
      video.muted = next === 0 ? true : isUserMuted;
    },
    currentLevel: () => level,
    userVolume: () => (isUserMuted ? 0 : video.volume),
    dispose() {
      this.setLevel(1);
      video.removeEventListener('volumechange', onVolumeChange);
    },
  };
}
