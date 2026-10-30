const ENABLED = 'enabled';
const DEFAULT_ENABLED = true;

export function createSettings({ local, onChanged }) {
  return {
    async readEnabled() {
      try {
        const values = await local.get(ENABLED);
        return values[ENABLED] ?? DEFAULT_ENABLED;
      } catch {
        return DEFAULT_ENABLED;
      }
    },
    writeEnabled(on) {
      return local.set({ [ENABLED]: on });
    },
    watchEnabled(callback) {
      const listener = (changes, area) => {
        if (area === 'local' && ENABLED in changes) callback(changes[ENABLED].newValue ?? DEFAULT_ENABLED);
      };
      onChanged.addListener(listener);
      return () => onChanged.removeListener(listener);
    },
  };
}

export const extensionApi = () => globalThis.browser ?? globalThis.chrome;
