import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettings } from '../src/content/settings.js';

function fakeStorage(initial = {}) {
  const values = { ...initial };
  const listeners = new Set();
  return {
    local: {
      async get(key) {
        return key in values ? { [key]: values[key] } : {};
      },
      async set(entries) {
        const changes = {};
        for (const [key, newValue] of Object.entries(entries)) {
          changes[key] = { oldValue: values[key], newValue };
          values[key] = newValue;
        }
        for (const listener of listeners) listener(changes, 'local');
      },
    },
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
    emit: (changes, area) => {
      for (const listener of listeners) listener(changes, area);
    },
  };
}

test('the filter is on until the user turns it off', async () => {
  assert.equal(await createSettings(fakeStorage()).readEnabled(), true);
  assert.equal(await createSettings(fakeStorage({ enabled: false })).readEnabled(), false);
});

test('a storage failure reads as the default instead of throwing', async () => {
  const storage = fakeStorage();
  storage.local.get = async () => {
    throw new Error('storage unavailable');
  };
  assert.equal(await createSettings(storage).readEnabled(), true);
});

test('writeEnabled stores the choice and watchers in every tab hear it', async () => {
  const storage = fakeStorage();
  const settings = createSettings(storage);
  const heard = [];
  settings.watchEnabled((on) => heard.push(on));
  await settings.writeEnabled(false);
  assert.equal(await settings.readEnabled(), false);
  assert.deepEqual(heard, [false]);
});

test('watchEnabled ignores other keys and other storage areas, and stops when asked', () => {
  const storage = fakeStorage();
  const heard = [];
  const stop = createSettings(storage).watchEnabled((on) => heard.push(on));
  storage.emit({ other: { newValue: 1 } }, 'local');
  storage.emit({ enabled: { newValue: false } }, 'sync');
  storage.emit({ enabled: { oldValue: false } }, 'local');
  stop();
  storage.emit({ enabled: { newValue: false } }, 'local');
  assert.deepEqual(heard, [true]);
});
