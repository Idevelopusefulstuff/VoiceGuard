# VoiceGuard

VoiceGuard is a free, open-source BetterDiscord plugin for Discord desktop. Its resizable roster shows who's in the call, each person's incoming audio level, and which participants are muted. When someone's audio stays loud enough to meet your detection settings, VoiceGuard can mute them on your side of the call.

[Download VoiceGuard](https://github.com/Idevelopusefulstuff/VoiceGuard/releases/tag/v1.0.0) · [Project website](https://voiceguard.dev/)

[Install](#install) · [Use it in a call](#use-it-in-a-call) · [Troubleshooting](#troubleshooting)

## Install

You need **Discord desktop with BetterDiscord installed**. [Set up BetterDiscord](https://docs.betterdiscord.app/users/getting-started/installation)

1. Open the GitHub release linked above. Under **Assets**, download `VoiceGuard.plugin.js`. If you choose `VoiceGuard-BetterDiscord.zip`, extract it and use the plugin file inside.
2. Open **User Settings → BetterDiscord → Plugins** in Discord and select **Open Plugins Folder**.
3. Copy `VoiceGuard.plugin.js` into that folder.
4. Return to the **Plugins** list and turn on **VoiceGuard**.
5. Join a voice call. If the panel is collapsed, select **VG** to open it.

### Update or remove VoiceGuard

Finish your voice call first, then turn off **VoiceGuard** in BetterDiscord's **Plugins** list. To update, replace the existing `VoiceGuard.plugin.js` with the downloaded file and turn the plugin back on. To uninstall, remove the plugin file from the folder.

## Use it in a call

1. **Check your levels.** Fresh installs start with **Auto on**. Switch to **Auto off** to watch the meters and adjust detection, then turn Auto on when you're ready. Pausing Auto keeps existing mutes in place.
2. **Choose a protection policy.** Open the policy menu beside a participant's name to choose how VoiceGuard responds to that person's audio.
3. **Control playback.** Use **Mute** or **Unmute** on someone's row. Mutes and volume changes affect what you hear in Discord.
4. **Check what happened.** Open the **…** menu and choose **Signal** to check the detector, **Activity** to see recent actions, or **Find** to locate a participant.

### Protection policies

| Policy | What happens when Auto is on |
| --- | --- |
| **Guarded** | Uses your normal detection settings to decide when to mute the speaker locally. |
| **Soft 10s / 20s / 30s / 60s** | Applies a timed local mute when the detector triggers, then releases it after the selected duration. |
| **Trusted** | Exempts this participant from automatic muting. |
| **Probe 1s** | Uses short mutes to check for repeat hits. Closely spaced hits can escalate to a regular local mute, and widely spaced hits can mark the participant Trusted. |

### Customize the panel and detection

- **Resize the roster.** Drag the lower-left handle. With the **Resize VoiceGuard** handle focused, use the arrow keys, hold **Shift** for larger steps, or press **Home** to restore the **Fit** size.
- **Change how it looks.** Open **… → Settings → Appearance** to change the theme, font, and text size. The **Size** view offers **Fit**, **Compact**, and **Roomy**, along with width and height fields. Use **Display** to choose which details appear.
- **Tune protection.** Open **… → Settings → Profiles** to start with **Balanced**, **Cautious** for longer evidence windows, or **Responsive** for shorter ones. Open **Detection** to adjust the loudness threshold and how long audio must stay loud.

## Troubleshooting

- **VoiceGuard is missing from the Plugins list.** Confirm that BetterDiscord is installed for the Discord desktop client you're using. Select **Open Plugins Folder** again and check that the folder contains `VoiceGuard.plugin.js`, including the final `.js` extension.
- **The panel or meters are missing.** Join a voice call with another participant and look for **VG**. Check **Show VoiceGuard panel** in the plugin's BetterDiscord settings. If the panel opens but levels remain blank while someone speaks, check **… → Signal** and include the status in your bug report.
- **Someone is still quiet.** Select **Unmute** on their row and check their local mute and volume in Discord. For details on recovering volume after closing the plugin or switching accounts, see the [security and privacy guide](SECURITY.md#local-data).
- **Normal speech triggers too many mutes.** Pause Auto while you check the meters. In **… → Settings → Detection**, raise **Loudness threshold** or increase **New arrival evidence** and **Established caller evidence**. Use a **Soft** policy if you want a timed mute for one person.
- **The roster feels crowded.** Try **Fit** in **Appearance → Size**, drag the panel wider, or choose fewer details in **Display**.

If an issue persists, include your OS, Discord and BetterDiscord versions, the VoiceGuard release, what you expected, and the steps to reproduce it. [Open a GitHub issue](https://github.com/Idevelopusefulstuff/VoiceGuard/issues)

## Download integrity and privacy

Compare the SHA-256 hash of your downloaded file with its entry in `SHA256SUMS.txt` under the release's **Assets**. Run the command from your download folder. Use the ZIP's filename if you're checking the archive.

- **Windows PowerShell** `Get-FileHash .\VoiceGuard.plugin.js -Algorithm SHA256`
- **macOS** `shasum -a 256 VoiceGuard.plugin.js`
- **Linux** `sha256sum VoiceGuard.plugin.js`

The detector uses audio levels from the Discord client. BetterDiscord stores preferences and selected participant policies on your device. Loading profile images from Discord's CDN is opt-in. [Local data, audio recovery, and vulnerability reporting](SECURITY.md)

## Run the tests

Run `npm test` with Node.js 22 or later. The nine offline suites exercise detection, presets, persistence, mute restoration, and resizing using mock Discord stores. The plugin is a single JavaScript file that BetterDiscord loads directly.

Release verification uses simulated voice stores and an isolated Chromium profile. Live Discord voice-call verification is pending.

## License

[MIT](LICENSE)
