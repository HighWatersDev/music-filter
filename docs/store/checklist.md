# Release checklist, 1.0.0

## Build the packages

```bash
npm run fetch:models && npm run build:dpdf   # only when the models or the Rust crate change
npm run build && npm test
npm run render:icons                         # only when design/icon.svg changes
npm run package                              # build/store/*.zip and safari-extension/
npm run package:safari                       # build/store/safari/Music Filter/*.xcodeproj
```

Commit before `npm run package`. The Firefox source zip is cut from HEAD.

## What each store needs from you

| Store | Account | Upload | Listing |
|---|---|---|---|
| Chrome Web Store | Developer account, one-time $5 fee, 2-step verification on the Google account | `music-filter-chromium-1.0.0.zip` | Copy and answers in `listing.md`. Screenshot `chrome-1-filtering.png`, promo tile `promo-440x280.png`. |
| Edge Add-ons | Partner Center account, free | Same zip | Same copy |
| Firefox Add-ons | addons.mozilla.org account, free | `music-filter-firefox-1.0.0.zip` plus `music-filter-source-1.0.0.zip` as the source | Same copy, reviewer notes in `listing.md` |
| Apple App Store | Apple Developer Program, $99 a year | Archive in Xcode and upload, see below | App Store Connect record, copy in `listing.md`, screenshots `iphone-*`, `ipad-*` |

## Apple steps

1. Join the Apple Developer Program.
2. Run `TEAM_ID=<your team id> npm run package:safari`, or open the project and pick your team under Signing for all four targets.
3. In App Store Connect, create the app with bundle ID `io.github.highwatersdev.musicfilter` and platforms iOS and macOS.
4. In Xcode, Product › Archive for "Music Filter (iOS)", then Distribute App › App Store Connect. Repeat for "Music Filter (macOS)".
5. Fill in the listing from `listing.md`. App Privacy: Data Not Collected.
6. Submit iOS first. Mac needs its own screenshots (at least 1280×800), which are not made yet. You can add the Mac app in a later version.

## Before submitting

- Push the repo to github.com/HighWatersDev/music-filter so the privacy policy and support links work.
- Check the privacy policy link opens without signing in.

## Known product gap before the Safari release

Read-ahead decodes Opus only. When YouTube serves AAC (`mp4a.40.2`), the panel shows "Can't filter this video: unsupported audio type" and the video stays muted. The iPhone simulator always got Opus. The iPad simulator got AAC once while its video codecs were restricted. Whether real iPhones and iPads get AAC is unknown. Desktop live mode is not affected because it filters the element's output whatever the codec.

## Review risks

- **YouTube content in screenshots.** All screenshots use Big Buck Bunny (CC BY 3.0) with recommendations hidden. YouTube's own interface still shows.
- **Apple guideline 4.2 (minimum functionality).** The app is a container for a Safari extension, which Apple accepts when the extension does real work. Review notes explain how to test it.
- **Apple guideline 5.2.2 (third-party content).** The extension changes how YouTube audio plays. Ad blockers and YouTube enhancers on the store do the same. If App Review objects, reply that the extension only changes playback on the user's device and never downloads or redistributes content.
