# Release checklist

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
| Chrome Web Store | Developer account, one-time $5 fee, 2-step verification on the Google account | `music-filter-chromium-<version>.zip` | Copy and answers in `listing.md`. Screenshot `chrome-1-overview.png`, promo tile `promo-440x280.png`. |
| Edge Add-ons | Partner Center account, free | Same zip | Same copy |
| Firefox Add-ons | addons.mozilla.org account, free | `music-filter-firefox-<version>.zip` plus `music-filter-source-<version>.zip` as the source | Same copy, reviewer notes in `listing.md` |
| Apple App Store | Apple Developer Program, $99 a year | Archive in Xcode and upload, see below | App Store Connect record, copy in `listing.md`, iPhone and iPad screenshots (not made yet) |

## Firefox steps

First submitted 2026-11-01 (0.0.1).

1. Sign in at https://addons.mozilla.org/developers/ and click **Submit a New Add-on**.
2. Where to host: **On this site**.
3. Upload `music-filter-firefox-<version>.zip`. Tick Firefox and Firefox for Android.
4. Do you need to submit source code: **Yes**, upload `music-filter-source-<version>.zip`.
5. Describe Add-on, from `listing.md`:
   - Name, summary and description from the shared copy. Leave experimental and payment unticked.
   - Category: Photos, Music & Videos.
   - Support email: empty, so no address is public. Support website: the issues link.
   - License: Apache License 2.0. Privacy policy: unticked, since nothing is collected.
   - Notes to reviewer from the Firefox section, including the build steps.
6. **Submit Version**. Status becomes Awaiting Review.
7. The listing shows a puzzle piece until you add an icon. Edit Product Page › Images: upload `extension/icons/icon-128.png` and the screenshot `chrome-1-overview.png`.

For a new version: My Add-ons › Music Filter › New Version, then steps 3, 4 and 6.

## Chrome steps

First submitted 2026-11-01 (0.0.1).

1. Sign in at https://chrome.google.com/webstore/devconsole. First visit: accept the agreement, pay $5, turn on 2-Step Verification.
2. Trader declaration: non-trader, since the extension is free and not run as a business. It can be changed later in Settings.
3. Settings: publisher display name `HighWatersDev`, then a contact email, verified through the link Google sends.
4. Items › New item › upload `music-filter-chromium-<version>.zip`. Title and summary come from the manifest.
5. Store listing, from `listing.md`:
   - Description from the shared copy. Category: Accessibility. Language: English.
   - Store icon `extension/icons/icon-128.png`, screenshot `chrome-1-overview.png`, small promo tile `promo-440x280.png`.
   - Official URL: None. Homepage: the repo. Support: the issues link. Mature content: off.
6. Privacy: single purpose and the two permission justifications from `listing.md`. Remote code: No. No data types ticked, all three statements ticked. Privacy policy URL.
7. Distribution: free, Public, all regions.
8. Test instructions: no login, plus the test steps from the Firefox reviewer notes and the repo link.
9. Submit for review. "Publish automatically after it has passed review" is ticked by default. Untick it to publish by hand within 30 days of approval.

For a new version: the item's Package tab › Upload new package, then Submit for review.

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

Read-ahead decodes Opus only. When YouTube serves AAC (`mp4a.40.2`), the extension shows "Can't filter this video: unsupported audio type" and the video stays muted. The iPhone simulator always got Opus. The iPad simulator got AAC once while its video codecs were restricted. Whether real iPhones and iPads get AAC is unknown. Desktop live mode is not affected because it filters the element's output whatever the codec.

## Apple screenshots

None exist yet. Apple needs iPhone 6.9" and iPad 13" screenshots, plus Mac ones (at least 1280×800) for the Mac app. Make them before the Apple submission.

## Review risks

- **YouTube content in screenshots.** The Chrome and Edge screenshot is a designed banner (`design/store-banner.html`) with no YouTube interface or video. Apple screenshots should follow the same rule.
- **Apple guideline 4.2 (minimum functionality).** The app is a container for a Safari extension, which Apple accepts when the extension does real work. Review notes explain how to test it.
- **Apple guideline 5.2.2 (third-party content).** The extension changes how YouTube audio plays. Ad blockers and YouTube enhancers on the store do the same. If App Review objects, reply that the extension only changes playback on the user's device and never downloads or redistributes content.
