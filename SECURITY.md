# VoiceGuard security and privacy

## On-device protection

VoiceGuard reads the Discord voice roster and inbound audio-level statistics to apply local mutes and restore volume. The detector uses level measurements. The installed plugin is a single readable JavaScript file loaded by BetterDiscord.

## Local data

- BetterDiscord stores preferences, participant IDs for chosen protection policies, and a journal for pending audio restoration. VoiceGuard keeps recent activity in memory for the session.
- Remembering offenders across rejoins is off for fresh installations. If you enable it, the default retention is 30 days. Use Clear remembered offenders in BetterDiscord’s VoiceGuard settings to remove earlier history.
- Audio recovery records include the owning Discord account ID. Switching accounts pauses protection until you switch back or re-enable VoiceGuard. Use Discord’s audio controls to check any sound settings left by earlier releases with ownerless recovery records.
- Trusted and Soft policies and remembered history are stored at the BetterDiscord installation level. Plan account-level storage for those records if the installation is shared across people.

## Profile images and presets

VoiceGuard shows initials by default. Load profile images from Discord’s CDN is a separate opt-in in BetterDiscord’s VoiceGuard settings. The plugin limits those images to Discord avatar URLs. Portable presets include display and detection tuning and leave network consent and user policies under local control.

## Verify the download

Compare the downloaded plugin with SHA256SUMS.txt from a trusted release. The JavaScript in this ZIP is the code that runs. BetterDiscord plugins run inside the Discord client and can access client APIs. Review the source and install builds you trust.

[BetterDiscord plugin environment](https://docs.betterdiscord.app/plugins/introduction/environment)

## Report a vulnerability

Use the [private vulnerability reporting form](https://github.com/Idevelopusefulstuff/VoiceGuard/security/advisories/new). Include the affected version, steps to reproduce, and any relevant redacted logs.
