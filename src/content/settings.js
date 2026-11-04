const ENABLED = 'enabled';
const KEEP_OTHER_SOUNDS = 'keepOtherSounds';
const DEFAULTS = { [ENABLED]: true, [KEEP_OTHER_SOUNDS]: false };

async function read(local, key) {
  try {
    const values = await local.get(key);
    return values[key] ?? DEFAULTS[key];
  } catch {
    return DEFAULTS[key];
  }
}

export function createSettings({ local, onChanged }) {
  return {
    readEnabled: () => read(local, ENABLED),
    writeEnabled(on) {
      return local.set({ [ENABLED]: on });
    },
    watchEnabled(callback) {
      const listener = (changes, area) => {
        if (area === 'local' && ENABLED in changes) callback(changes[ENABLED].newValue ?? DEFAULTS[ENABLED]);
      };
      onChanged.addListener(listener);
      return () => onChanged.removeListener(listener);
    },
    readKeepOtherSounds: () => read(local, KEEP_OTHER_SOUNDS),
    writeKeepOtherSounds(on) {
      return local.set({ [KEEP_OTHER_SOUNDS]: on });
    },
  };
}

export const extensionApi = () => globalThis.browser ?? globalThis.chrome;
