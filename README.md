# VoiceGuard

VoiceGuard is a BetterDiscord plugin that detects sustained loud audio and applies local protection to the people you hear. Its resizable roster shows inbound levels and lets you choose a protection policy for each participant.

## Install

1. Download `VoiceGuard.plugin.js` from the [GitHub release](https://github.com/Idevelopusefulstuff/VoiceGuard/releases/tag/v1.0.0). The release includes a ZIP and SHA-256 checksums.
2. Open Discord’s BetterDiscord settings, select **Plugins**, then **Open Plugins Folder**.
3. Put `VoiceGuard.plugin.js` in that folder and enable VoiceGuard. When updating, finish your voice call first and replace the existing file.

The lower-left handle resizes the roster. Open the ellipsis menu and choose **Settings → Appearance** to change the theme, font, text size, and dimensions.

## Privacy and controls

- The detector uses audio levels from the Discord client. Mutes and volume changes apply to your local playback.
- BetterDiscord stores preferences and selected participant policies on your device. Profile images from Discord’s CDN are opt-in.
- Release verification uses simulated voice stores and an isolated Chromium profile. Live voice-call verification is pending.

For local storage, audio restoration, and vulnerability reporting, see [SECURITY.md](SECURITY.md).

## Run the tests

Run `npm test` with Node.js 22 or later. The nine offline suites exercise detection, presets, persistence, mute restoration, and resizing using mock Discord stores. The plugin is a single readable JavaScript file and needs no build step.

## License

[MIT](LICENSE)
