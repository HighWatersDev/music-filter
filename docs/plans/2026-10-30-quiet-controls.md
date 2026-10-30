# Quiet controls

**Goal:** replace the floating "Music filter: ON" card, which covers part of the video on phones, with controls that stay out of the way.

**Why:** the card sits over the top left of the page on every YouTube page, even with the filter off. The on/off choice is also forgotten on every page load, so the card has to be tapped for each video.

## Design

- **Remembered setting.** `chrome.storage.local` holds `enabled`, on by default. The player icon and the toolbar popup both write it. Every YouTube tab follows `storage.onChanged`. This needs the `storage` permission, which shows no install warning.
- **Player icon.** A 36 px round button in the top left of the player, inside the player element so it also shows in fullscreen.
  - Visible while the video is paused, for 3 s after pointer or touch activity over the player, and while the filter is busy or has a problem. Otherwise it fades out and stops taking taps, so a tap there reaches the video.
  - Shows a music note when off, and a crossed-out note on an accent background when on. A ring spins while the filter is busy, such as during a read-ahead hold. An amber ring shows a problem.
  - Its accessible name carries the state and the status line, for example "Music filter: on. Filtered · 28 s ready".
  - It's built with DOM calls and inline styles only, because YouTube enforces Trusted Types.
- **Short message.** A pill next to the icon. It shows "Music filter on" or "off" for 1.5 s after a toggle, and the problem text for 5 s on entering an error, the wrong speed, or too slow.
- **Toolbar popup.** A switch, plus the status line of the active tab, read from the content script every second. On other sites it says to open a YouTube video. On phones it sits in the browser menu.
- **Starting without a tap.** With the setting remembered, filtering can start before any user gesture. Read-ahead no longer fails when the page has no video yet, and waits for one instead. A `play` listener on the document attaches a new video before it is heard. Both modes resume their AudioContext on the first pointer, touch or key event, which Safari needs.

## Tests first

- `controls-policy.js`: icon visibility, message on a state change, status text.
- `settings.js`: default on, read, write, change events, with a fake storage.
- e2e: the harness turns the filter off on first load, then toggles through the icon as before. The status element keeps `data-state` and gets the id `music-filter`.
