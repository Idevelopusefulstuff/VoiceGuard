const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Reuse the existing isolated Discord fixture without running its scenario.
const fixtureSource = fs.readFileSync(path.join(__dirname, "test_voiceguard_plugin.js"), "utf8").split("function main() {")[0];
function fresh() {
    const sandbox = { require, __dirname, process, console };
    vm.runInNewContext(fixtureSource + `
        vm.createContext(context);
        vm.runInContext(code, context, {filename: pluginPath});
        const Plugin = context.module.exports;
        const plugin = new Plugin({name: "VoiceGuard"});
        plugin.start();
        globalThis.fixture = {
            plugin, Plugin, stores, connection, mediaEngine, mediaActions, localVolumes, localMuteStates,
            voiceMembers, dataStore, actionMuteCalls, actionVolumeCalls, nativeVolumeCalls,
            aliceId, bobId, selfId, channelId,
            step: (count = 1, ms = 80) => step(plugin, count, ms),
            setInbound, setNow: value => { nowMs = value; },
            setActionAppliesMute: value => { actionAppliesMute = value; }
        };
    `, sandbox);
    return sandbox.fixture;
}

const cases = {
    "display switches independently remove their optional elements"(f) {
        f.plugin.togglePolicyMenu(f.aliceId);
        const options = [
            ["showLevelMeter", 'class="vg3-track-wrap"'],
            ["showLevelValue", 'data-vg-metric="current"'],
            ["showPeakLevel", 'data-vg-metric="peak"'],
            ["showDbfs", 'data-vg-metric="dbfs"'],
            ["showBlastScore", 'data-vg-metric="blast"'],
            ["showAvatars", 'class="vg3-avatar"'],
            ["showStatusLabels", 'class="vg3-warning"'],
            ["showQuickPolicies", 'class="vg3-policy-chips"'],
            ["showCallSummary", 'class="vg3-summary"'],
            ["showConnectionDetails", 'class="vg5-coverage"'],
            ["showThresholdMarker", 'class="vg3-threshold"'],
            ["showPeakMarker", 'class="vg3-peak"']
        ];
        for (const [key, marker] of options) {
            assert.ok(f.plugin.panel.innerHTML.includes(marker), key + " should start visible");
            assert.equal(f.plugin.updateDisplaySetting(key, false), true);
            assert.ok(!f.plugin.panel.innerHTML.includes(marker), key + " was not hidden");
            assert.equal(f.dataStore.get("settings")[key], false);
            f.plugin.updateDisplaySetting(key, true);
            assert.ok(f.plugin.panel.innerHTML.includes(marker), key + " did not return");
        }
    },
    "hidden audio levels do not reset evidence or disable auto-muting"(f) {
        assert.equal(f.plugin.selectParticipant(f.aliceId), true);
        f.setInbound({[f.aliceId]: [{audioLevel: 0.9, audioDetected: true}]});
        f.step(5);
        const samples = f.plugin.blastWindows.get(f.aliceId);
        f.plugin.updatePanelSetting("showAudioLevels", false);
        assert.equal(f.plugin.blastWindows.get(f.aliceId), samples);
        assert.equal(f.plugin.settings.autoMute, true);
        assert.ok(!f.plugin.panel.innerHTML.includes('data-vg-metric="current"'));
        assert.ok(!f.plugin.panel.innerHTML.includes('class="vg3-track-wrap"'));
        f.step(45);
        assert.ok(f.plugin.members.get(f.aliceId).autoMutedAt);
        assert.ok(f.plugin.panel.innerHTML.includes("Unmute"));
    },
    "level formats display percent raw values or decibels without duplicate dBFS"(f) {
        assert.equal(f.plugin.selectParticipant(f.aliceId), true);
        f.plugin.updateDisplaySetting("levelDisplayFormat", "raw");
        assert.ok(f.plugin.panel.innerHTML.includes('data-vg-metric="current">0.620'));
        assert.equal(f.dataStore.get("settings").levelDisplayFormat, "raw");
        f.plugin.updateDisplaySetting("levelDisplayFormat", "dbfs");
        assert.ok(f.plugin.panel.innerHTML.includes('data-vg-metric="current">-4.2 dBFS'));
        assert.ok(!f.plugin.panel.innerHTML.includes('data-vg-metric="dbfs"'));
        f.plugin.updateDisplaySetting("levelDisplayFormat", "percent");
        assert.ok(f.plugin.panel.innerHTML.includes('data-vg-metric="current">62%'));
        assert.equal(f.plugin.updateDisplaySetting("levelDisplayFormat", "invalid"), false);
        assert.equal(f.plugin.updateDisplaySetting("showLevelMeter", "false"), false);
        assert.equal(f.plugin.updateDisplaySetting("autoMute", false), false);
    },
    "display presets and reset preserve protection and detector evidence"(f) {
        assert.equal(f.plugin.selectParticipant(f.aliceId), true);
        f.plugin.settings.autoMute = false;
        f.plugin.setTrusted(f.bobId, true);
        f.plugin.updateDisplaySetting("tileMeters", false);
        f.plugin.updateDisplaySetting("reducePanelMotion", true);
        const samples = f.plugin.blastWindows.get(f.aliceId);
        f.plugin.applyDisplayPreset("minimal");
        assert.equal(f.plugin.selectedDisplayPreset(), "minimal");
        assert.ok(f.plugin.panel.className.includes("vg3-compact"));
        assert.ok(f.plugin.panel.className.includes("vg3-still"));
        assert.ok(!f.plugin.panel.innerHTML.includes('class="vg3-metrics"'));
        assert.ok(f.plugin.panel.innerHTML.includes('data-vg-action="toggle-mute"'));
        assert.ok(f.plugin.panel.innerHTML.includes('data-vg-action="toggle-policy-menu"'));
        assert.equal(f.plugin.settings.autoMute, false);
        assert.equal(f.plugin.isTrusted(f.bobId), true);
        assert.equal(f.plugin.settings.tileMeters, false);
        assert.equal(f.plugin.settings.reducePanelMotion, true);
        assert.equal(f.plugin.blastWindows.get(f.aliceId), samples);
        assert.equal(f.plugin.applyDisplayPreset("__proto__"), false);
        f.plugin.applyDisplayPreset("balanced");
        assert.equal(f.plugin.selectedDisplayPreset(), "balanced");
        f.plugin.resetDisplaySettings();
        assert.equal(f.plugin.selectedDisplayPreset(), "detailed");
        assert.equal(f.plugin.settings.autoMute, false);
        assert.equal(f.plugin.isTrusted(f.bobId), true);
        assert.equal(f.plugin.blastWindows.get(f.aliceId), samples);
    },
    "audio visibility preserves child preferences and reloads saved choices"(f) {
        f.plugin.updateDisplaySetting("showPeakLevel", false);
        f.plugin.updateDisplaySetting("showAudioLevels", false);
        f.plugin.updateDisplaySetting("showAudioLevels", true);
        assert.equal(f.plugin.settings.showPeakLevel, false);
        f.plugin.updateDisplaySetting("compactRows", true);
        f.plugin.updateDisplaySetting("levelDisplayFormat", "raw");
        f.plugin.stop();
        const reloaded = new f.Plugin({name: "VoiceGuard"});
        reloaded.start();
        assert.equal(reloaded.settings.showPeakLevel, false);
        assert.equal(reloaded.settings.compactRows, true);
        assert.equal(reloaded.settings.levelDisplayFormat, "raw");
        assert.equal(reloaded.selectParticipant(f.aliceId), true);
        assert.ok(reloaded.panel.innerHTML.includes('data-vg-metric="current">0.620'));
        reloaded.stop();
    },
    "display preferences never hide connection problems or action errors"(f) {
        f.plugin.applyDisplayPreset("minimal");
        f.connection.stats.rtp.inbound = null;
        f.step(3);
        assert.ok(f.plugin.panel.innerHTML.includes("inbound RTP stats unavailable"));
        f.plugin.members.get(f.aliceId).muteError = "Audio restore failed";
        f.plugin.renderPanel(true);
        assert.ok(f.plugin.panel.innerHTML.includes("Audio restore failed"));
        assert.ok(f.plugin.panel.innerHTML.includes("Audio action failed"));
    },
    "display settings are exposed in drawer native settings and diagnostics"(f) {
        f.plugin.setPanelView("settings");
        assert.ok(f.plugin.panel.innerHTML.includes("VoiceGuard settings"));
        f.plugin.settingsTab = "display";
        f.plugin.renderPanel(true);
        assert.ok(f.plugin.panel.innerHTML.includes('data-group="audio"'));
        f.plugin.settingsGroup = "audio";
        f.plugin.renderPanel(true);
        assert.ok(f.plugin.panel.innerHTML.includes('data-vg-setting="showAudioLevels"'));
        assert.ok(f.plugin.panel.innerHTML.includes('data-vg-action="display-preset"'));
        assert.equal(f.plugin.snapshot().ui.display.format, "percent");
        const native = f.plugin.getSettingsPanel();
        const text = node => [node.textContent || "", ...(node.children || []).map(text)].join(" ");
        assert.ok(text(native).includes("Show audio levels"));
        assert.ok(text(native).includes("Reduce panel motion"));
    },
    "direct Discord unmute is respected with a fresh grace period"(f) {
        f.plugin.manualMute(f.aliceId);
        f.localMuteStates.set(f.aliceId, false);
        f.step();
        const member = f.plugin.members.get(f.aliceId);
        assert.equal(f.plugin.isUserMuted(f.aliceId), false);
        assert.equal(f.plugin.ownedMutes.has(f.aliceId), false);
        assert.ok(member.manualUnmuteUntil > 1000);
        assert.equal(member.rememberedMuteDismissed, true);
        assert.equal(f.plugin.activity[0].message, "Unmuted in Discord");
    },
    "a Discord unmute also restores a previously forced-zero volume"(f) {
        f.setActionAppliesMute(false);
        f.localVolumes.set(f.aliceId, 0.73);
        f.plugin.manualMute(f.aliceId);
        f.localMuteStates.set(f.aliceId, true);
        f.step();
        assert.equal(f.plugin.members.get(f.aliceId).muteVerified, true);
        f.localMuteStates.set(f.aliceId, false);
        f.step();
        assert.equal(f.localVolumes.get(f.aliceId), 0.73);
        assert.equal(f.plugin.forcedZeroUsers.has(f.aliceId), false);
        assert.equal(f.plugin.ownedMutes.has(f.aliceId), false);
    },
    "a later manual mute cancels pending automatic restoration"(f) {
        f.setNow(5000);
        const member = f.plugin.members.get(f.aliceId);
        assert.equal(f.plugin.applyAutoMute(f.aliceId, member, "Test blast", 5000, false), true);
        f.setActionAppliesMute(false);
        f.plugin.setTrusted(f.aliceId, true);
        assert.equal(f.plugin.pendingRestores.has(f.aliceId), true);
        assert.equal(f.plugin.manualMute(f.aliceId), true);
        assert.equal(f.plugin.pendingRestores.has(f.aliceId), false);
        f.step(1, 3000);
        assert.equal(f.plugin.isUserMuted(f.aliceId), true);
        assert.equal(f.localMuteStates.get(f.aliceId), true);
        f.setActionAppliesMute(true);
    },
    "shutdown retries recovery even during the retry backoff"(f) {
        f.setActionAppliesMute(false);
        f.localVolumes.set(f.aliceId, 0.73);
        f.plugin.manualMute(f.aliceId);
        const actionVolume = f.mediaActions.setLocalVolume;
        const nativeVolume = f.plugin.ownedMutes.get(f.aliceId).volumeFn;
        f.mediaActions.setLocalVolume = () => false;
        f.plugin.ownedMutes.get(f.aliceId).volumeFn = () => false;
        f.voiceMembers.delete(f.aliceId);
        f.step();
        assert.equal(f.plugin.pendingRestores.has(f.aliceId), true);
        f.mediaActions.setLocalVolume = actionVolume;
        f.plugin.ownedMutes.get(f.aliceId).volumeFn = nativeVolume;
        f.plugin.stop();
        assert.equal(f.localVolumes.get(f.aliceId), 0.73);
        assert.equal(f.dataStore.get("audioRestores").length, 0);
    },
    "newer volume choices in Discord survive fallback restoration"(f) {
        f.setActionAppliesMute(false);
        f.localVolumes.set(f.aliceId, 0.73);
        f.plugin.manualMute(f.aliceId);
        f.localVolumes.set(f.aliceId, 0.42);
        assert.equal(f.plugin.manualUnmute(f.aliceId), true);
        assert.equal(f.localVolumes.get(f.aliceId), 0.42);
    },
    "temporary membership failures preserve state and pause detection"(f) {
        f.plugin.manualMute(f.aliceId);
        const member = f.plugin.members.get(f.aliceId);
        const readMembers = f.stores.VoiceStateStore.getVoiceStatesForChannel;
        f.stores.VoiceStateStore.getVoiceStatesForChannel = () => { throw new Error("Store refreshing"); };
        f.setInbound({[f.aliceId]: [{audioLevel: 0, audioDetected: false}], [f.bobId]: [{audioLevel: 1, audioDetected: true}]});
        f.step(80);
        assert.equal(f.plugin.members.get(f.aliceId), member);
        assert.equal(f.plugin.ownedMutes.has(f.aliceId), true);
        assert.equal(f.plugin.members.get(f.bobId).autoMutedAt, 0);
        assert.equal(f.plugin.snapshot().telemetry.membershipUnavailable, true);
        assert.ok(f.plugin.panel.innerHTML.includes("Updating call"));
        f.stores.VoiceStateStore.getVoiceStatesForChannel = readMembers;
        f.step();
        assert.equal(f.plugin.members.get(f.aliceId), member);
        assert.equal(f.plugin.membershipUnavailable, false);
    },
    "ticks without elapsed time cannot manufacture blast evidence"(f) {
        f.setInbound({[f.aliceId]: [{audioLevel: 1, audioDetected: true}]});
        for (let i = 0; i < 200; i++) f.plugin.tick();
        assert.equal(f.actionMuteCalls.length, 0);
        assert.ok(f.plugin.blastWindows.get(f.aliceId).length <= 1);
    },
    "invalid saved tuning falls back to safe defaults"(f) {
        f.plugin.settings.loudThreshold = null;
        f.plugin.settings.newcomerLoudSeconds = "broken";
        f.plugin.settings.autoMute = "false";
        f.plugin.normalizeSettings();
        assert.equal(f.plugin.settings.loudThreshold, f.plugin.defaultSettings.loudThreshold);
        assert.equal(f.plugin.settings.newcomerLoudSeconds, f.plugin.defaultSettings.newcomerLoudSeconds);
        assert.equal(f.plugin.settings.autoMute, f.plugin.defaultSettings.autoMute);
    },
    "malformed policy records and arrays cannot break persistence"(f) {
        f.dataStore.set("softVoicebans", {[f.aliceId]: "broken", [f.bobId]: {durationSeconds: 10}, bad: {durationSeconds: 20}});
        f.plugin.loadSoftVoicebans();
        assert.equal(f.plugin.softVoicebanFor(f.aliceId), null);
        assert.equal(f.plugin.softVoicebanFor(f.bobId).durationSeconds, 10);
        assert.equal(f.plugin.softVoicebans.bad, undefined);
        f.dataStore.set("softVoicebans", []);
        f.plugin.loadSoftVoicebans();
        f.plugin.setUserPolicy(f.aliceId, "soft:30");
        assert.equal(f.dataStore.get("softVoicebans")[f.aliceId].durationSeconds, 30);
        assert.equal(Array.isArray(f.dataStore.get("softVoicebans")), false);
    },
    "activity undo restores audio once and grants manual grace"(f) {
        f.setNow(5000);
        const member = f.plugin.members.get(f.aliceId);
        f.plugin.applyAutoMute(f.aliceId, member, "Test blast", 5000, false);
        const event = f.plugin.activity.find(entry => entry.type === "auto-mute");
        assert.ok(event);
        assert.equal(f.plugin.undoActivityMute(event.id), true);
        assert.equal(f.localMuteStates.get(f.aliceId), false);
        assert.equal(member.manualUnmuteUntil, 20000);
        assert.equal(f.plugin.undoActivityMute(event.id), false);
    },
    "an old activity action cannot undo a newer manual mute"(f) {
        f.setNow(5000);
        f.plugin.applyAutoMute(f.aliceId, f.plugin.members.get(f.aliceId), "Test blast", 5000, false);
        const event = f.plugin.activity.find(entry => entry.type === "auto-mute");
        f.plugin.manualMute(f.aliceId);
        assert.equal(f.plugin.undoActivityMute(event.id), false);
        assert.equal(f.localMuteStates.get(f.aliceId), true);
    },
    "activity stays bounded and view switches reject unknown values"(f) {
        for (let i = 0; i < 100; i++) f.plugin.recordActivity("settings", null, "Event " + i);
        assert.equal(f.plugin.activity.length, 60);
        assert.equal(f.plugin.activity[0].message, "Event 99");
        assert.equal(f.plugin.setPanelView("activity"), true);
        assert.ok(f.plugin.panel.innerHTML.includes("Recent activity"));
        assert.equal(f.plugin.setPanelView("invalid"), false);
        assert.equal(f.plugin.panelView, "activity");
    },
    "drawer tuning previews immediately and persists on commit"(f) {
        const initial = f.dataStore.get("settings").loudThreshold;
        assert.equal(f.plugin.updatePanelSetting("loudThreshold", 0.8, false), true);
        assert.equal(f.plugin.settings.loudThreshold, 0.8);
        assert.equal(f.dataStore.get("settings").loudThreshold, initial);
        assert.equal(f.plugin.updatePanelSetting("loudThreshold", 0.8), true);
        assert.equal(f.dataStore.get("settings").loudThreshold, 0.8);
        assert.equal(f.plugin.updatePanelSetting("autoMute", false), false);
        assert.equal(f.plugin.updatePanelSetting("loudThreshold", NaN), false);
    },
    "resetting drawer sliders preserves trust and the pause switch"(f) {
        f.plugin.settings.autoMute = false;
        f.plugin.setTrusted(f.bobId, true);
        f.plugin.updatePanelSetting("loudThreshold", 0.8);
        f.plugin.resetPanelTuning();
        assert.equal(f.plugin.settings.loudThreshold, f.plugin.defaultSettings.loudThreshold);
        assert.equal(f.plugin.settings.autoMute, false);
        assert.equal(f.plugin.isTrusted(f.bobId), true);
    },
    "departure restores the exact fallback volume"(f) {
        f.localVolumes.set(f.aliceId, 0.37);
        f.setActionAppliesMute(false);
        assert.equal(f.plugin.manualMute(f.aliceId), true);
        assert.equal(f.localVolumes.get(f.aliceId), 0);
        f.voiceMembers.delete(f.aliceId);
        f.step();
        assert.equal(f.localVolumes.get(f.aliceId), 0.37);
        assert.equal(f.plugin.forcedZeroUsers.size, 0);
        assert.equal(f.plugin.ownedMutes.size, 0);
    },
    "disconnect releases plugin mutes even after membership is lost"(f) {
        f.plugin.manualMute(f.aliceId);
        f.plugin.currentVoiceChannelId = () => null;
        f.step();
        assert.equal(f.localMuteStates.get(f.aliceId), false);
        assert.equal(f.plugin.members.size, 0);
        assert.equal(f.plugin.ownedMutes.size, 0);
    },
    "failed restores survive reload and restore the original volume"(f) {
        f.setActionAppliesMute(false);
        f.localVolumes.set(f.aliceId, 0.73);
        f.plugin.manualMute(f.aliceId);
        const actionVolume = f.mediaActions.setLocalVolume;
        const nativeVolume = f.connection.setLocalVolume;
        f.mediaActions.setLocalVolume = () => false;
        f.connection.setLocalVolume = () => false;
        f.plugin.ownedMutes.get(f.aliceId).volumeFn = () => false;
        f.voiceMembers.delete(f.aliceId);
        f.step();
        assert.equal(f.plugin.pendingRestores.has(f.aliceId), true);
        f.plugin.stop();
        assert.equal(f.dataStore.get("audioRestores")[0].volume, 0.73);
        f.mediaActions.setLocalVolume = actionVolume;
        f.connection.setLocalVolume = nativeVolume;
        const reloaded = new f.Plugin({name: "VoiceGuard"});
        reloaded.start();
        assert.equal(f.localVolumes.get(f.aliceId), 0.73);
        assert.equal(f.dataStore.get("audioRestores").length, 0);
        reloaded.stop();
    },
    "existing Discord mutes are not claimed or released by VoiceGuard"(f) {
        f.localMuteStates.set(f.aliceId, true);
        f.setInbound({[f.aliceId]: [{audioLevel: 1, audioDetected: true}]});
        f.step(70);
        assert.equal(f.plugin.members.get(f.aliceId).externalMuted, true);
        assert.equal(f.plugin.ownedMutes.has(f.aliceId), false);
        assert.equal(f.plugin.offenseFor(f.aliceId), null);
        f.plugin.stop();
        assert.equal(f.localMuteStates.get(f.aliceId), true);
    },
    "a rejected unmute cannot clear mute tracking"(f) {
        f.plugin.manualMute(f.aliceId);
        f.setActionAppliesMute(false);
        assert.equal(f.plugin.manualUnmute(f.aliceId), false);
        assert.equal(f.plugin.isUserMuted(f.aliceId), true);
        assert.equal(f.plugin.ownedMutes.has(f.aliceId), true);
        f.setActionAppliesMute(true);
    },
    "unknown volume never becomes a guessed zero-volume fallback"(f) {
        f.setActionAppliesMute(false);
        f.stores.MediaEngineStore.getLocalVolume = () => null;
        assert.equal(f.plugin.localVolume(f.aliceId, null), null);
        assert.equal(f.plugin.manualMute(f.aliceId), false);
        assert.equal(f.actionVolumeCalls.length, 0);
        assert.equal(f.plugin.volumeBeforeMute.size, 0);
    },
    "disconnected RTC samples cannot trigger a mute"(f) {
        f.connection.connectionState = "DISCONNECTED";
        f.setInbound({[f.aliceId]: [{audioLevel: 1, audioDetected: true}]});
        f.step(90);
        assert.equal(f.actionMuteCalls.length, 0);
        assert.equal(f.plugin.signals.get(f.aliceId).mapped, false);
        assert.equal(f.plugin.telemetry.inbound, false);
        assert.ok(f.plugin.panel.innerHTML.includes("NO LEVELS"));
        assert.ok(!f.plugin.panel.innerHTML.includes("LEVELS LIVE"));
    },
    "boolean speaking metadata is not a mapped audio level"(f) {
        for (const audioLevel of [null, undefined, "", true, false, "invalid"]) {
            f.setInbound({[f.aliceId]: [{audioLevel, audioDetected: true}]});
            f.step(3);
            assert.equal(f.plugin.signals.get(f.aliceId).mapped, false);
            assert.equal(f.plugin.blastWindows.has(f.aliceId), false);
        }
        f.setInbound({[f.aliceId]: [{audioLevel: 0, audioDetected: false}]});
        f.step(3);
        assert.equal(f.plugin.signals.get(f.aliceId).mapped, true);
    },
    "meters continue to update while the pointer is over the panel"(f) {
        assert.equal(f.plugin.selectParticipant(f.aliceId), true);
        f.plugin.panelInteracting = true;
        f.setInbound({[f.aliceId]: [{audioLevel: 0.31, audioDetected: true}]});
        f.step(3);
        assert.ok(f.plugin.panel.innerHTML.includes('data-vg-metric="current">31%'));
        assert.ok(f.plugin.panel.innerHTML.includes('title="Alice · LIVE · Level 31%"'));
    },
    "configured evidence duration always fits the analysis window"(f) {
        f.plugin.settings.establishedLoudSeconds = 10;
        f.plugin.settings.analysisWindowSeconds = 3;
        f.plugin.normalizeSettings();
        assert.ok(f.plugin.settings.analysisWindowSeconds >= 10);
        let metrics;
        for (let i = 0; i < 150; i++) metrics = f.plugin.updateBlastWindow(f.bobId, 0.9, true, 10000 + i * 80, 80);
        assert.ok(metrics.durationMs <= 10000);
        assert.ok(metrics.loudMs >= 10000);
    },
    "Soft keeps the selected duration when using its quick chip"(f) {
        f.plugin.setUserPolicy(f.bobId, "soft:10");
        f.plugin.togglePolicyMenu(f.bobId);
        assert.ok(/class="vg3-policy-chip selected"[^>]+data-policy="soft:10"/.test(f.plugin.panel.innerHTML));
        assert.ok(!/class="vg3-policy-chip[^"]*"[^>]+data-user-id="333333333333333333"[^>]+data-policy="soft:20"/.test(f.plugin.panel.innerHTML));
    },
    "resuming auto-mute discards evidence gathered while paused"(f) {
        f.plugin.toggleAutoMute();
        f.setInbound({[f.aliceId]: [{audioLevel: 0.9, audioDetected: true}]});
        f.step(60);
        assert.equal(f.actionMuteCalls.length, 0);
        f.plugin.toggleAutoMute();
        f.step();
        assert.equal(f.actionMuteCalls.length, 0);
    },
    "preference export contains only portable display and detection fields"(f) {
        f.plugin.setTrusted(f.bobId, true);
        f.plugin.manualMute(f.aliceId);
        const preset = JSON.parse(f.plugin.exportPreferencePreset());
        assert.equal(preset.format, "voiceguard-preferences");
        assert.equal(preset.version, 1);
        assert.deepEqual(Object.keys(preset).sort(), ["format", "preferences", "version"]);
        assert.equal(Object.keys(preset.preferences).length, 21);
        for (const key of ["autoMute", "trustedUsers", "offenses", "ownedMutes", "rememberOffenders", "muteRememberedOnRejoin", "panelCollapsed"]) {
            assert.equal(Object.prototype.hasOwnProperty.call(preset.preferences, key), false, key);
        }
        assert.equal(f.plugin.validatePreferencePreset(JSON.stringify(preset)).ok, true);
    },
    "valid preference import preserves pause policies history and active mute ownership"(f) {
        f.plugin.settings.autoMute = false;
        f.plugin.setTrusted(f.bobId, true);
        f.plugin.manualMute(f.aliceId);
        const owner = f.plugin.ownedMutes.get(f.aliceId);
        const trusts = f.plugin.trustedUsers;
        const offenses = f.plugin.offenses;
        const history = JSON.stringify(f.plugin.offenses);
        const member = f.plugin.members.get(f.aliceId);
        const manuallyMutedAt = member.manualMutedAt;
        const actionCount = f.actionMuteCalls.length;
        const result = f.plugin.importPreferencePreset(JSON.stringify({ format: "voiceguard-preferences", version: 1, preferences: { loudThreshold: 0.75, newcomerLoudSeconds: 3, establishedLoudSeconds: 4.5, softRearmGraceSeconds: 5, compactRows: true, levelDisplayFormat: "raw" } }));
        assert.equal(result.ok, true);
        assert.equal(f.plugin.settings.loudThreshold, 0.75);
        assert.equal(f.dataStore.get("settings").compactRows, true);
        assert.equal(f.plugin.settings.autoMute, false);
        assert.equal(f.plugin.trustedUsers, trusts);
        assert.equal(f.plugin.offenses, offenses);
        assert.equal(JSON.stringify(f.plugin.offenses), history);
        assert.equal(f.plugin.ownedMutes.get(f.aliceId), owner);
        assert.equal(f.plugin.members.get(f.aliceId), member);
        assert.equal(member.manualMutedAt, manuallyMutedAt);
        assert.equal(f.plugin.isUserMuted(f.aliceId), true);
        assert.equal(f.actionMuteCalls.length, actionCount);
    },
    "invalid presets cannot partially apply preferences or import protected state"(f) {
        const before = JSON.stringify(f.plugin.settings);
        const bad = [
            "not JSON", "null", "[]",
            '{"format":"voiceguard-preferences","version":2,"preferences":{"compactRows":true}}',
            '{"format":"voiceguard-preferences","version":1,"preferences":{}}',
            '{"format":"voiceguard-preferences","version":1,"autoMute":true,"preferences":{"compactRows":true}}',
            ...["autoMute", "trustedUsers", "offenses", "rememberOffenders", "__proto__", "constructor"].map(key => '{"format":"voiceguard-preferences","version":1,"preferences":{"compactRows":true,"' + key + '":true}}'),
            ...[0, 1.1, "0.7", true, null].map(value => JSON.stringify({format: "voiceguard-preferences", version: 1, preferences: {compactRows: true, loudThreshold: value}})),
            '{"format":"voiceguard-preferences","version":1,"preferences":{"loudThreshold":1e999}}',
            '{"format":"voiceguard-preferences","version":1,"preferences":{"showAudioLevels":"false"}}',
            '{"format":"voiceguard-preferences","version":1,"preferences":{"levelDisplayFormat":"loud"}}'
        ];
        for (const text of bad) {
            assert.equal(f.plugin.importPreferencePreset(text).ok, false, text);
            assert.equal(JSON.stringify(f.plugin.settings), before);
        }
    },
    "preset size limit counts UTF-8 bytes and rejects oversized files before parsing"(f) {
        assert.match(f.plugin.validatePreferencePreset(" ".repeat(16385)).error, /16 KiB/);
        const unicode = JSON.stringify({format: "voiceguard-preferences", version: 1, preferences: {['é'.repeat(9000)]: true}});
        assert.ok(unicode.length < 16384);
        assert.match(f.plugin.validatePreferencePreset(unicode).error, /16 KiB/);
    },
    "display-only imports preserve evidence while changed detection restarts evidence"(f) {
        f.step(5);
        const samples = f.plugin.blastWindows.get(f.aliceId);
        assert.ok(samples);
        const preset = preferences => JSON.stringify({format: "voiceguard-preferences", version: 1, preferences});
        assert.equal(f.plugin.importPreferencePreset(preset({showPeakLevel: false})).ok, true);
        assert.equal(f.plugin.blastWindows.get(f.aliceId), samples);
        assert.equal(f.plugin.importPreferencePreset(preset({loudThreshold: f.plugin.settings.loudThreshold})).ok, true);
        assert.equal(f.plugin.blastWindows.get(f.aliceId), samples);
        assert.equal(f.plugin.importPreferencePreset(preset({loudThreshold: 0.74})).ok, true);
        assert.equal(f.plugin.blastWindows.has(f.aliceId), false);
        assert.equal(f.plugin.signals.get(f.aliceId).blast.loudMs, 0);
    },
    "quick protection profiles change only tuning and preserve user state"(f) {
        f.plugin.settings.autoMute = false;
        f.plugin.setTrusted(f.bobId, true);
        f.plugin.manualMute(f.aliceId);
        const owned = f.plugin.ownedMutes.get(f.aliceId);
        assert.equal(f.plugin.applyProtectionProfile("__proto__"), false);
        for (const name of ["balanced", "cautious", "responsive"]) {
            assert.equal(f.plugin.applyProtectionProfile(name), true);
            assert.equal(f.plugin.selectedProtectionProfile(), name);
            assert.equal(f.plugin.settings.autoMute, false);
            assert.equal(f.plugin.isTrusted(f.bobId), true);
            assert.equal(f.plugin.ownedMutes.get(f.aliceId), owned);
        }
        f.plugin.settings.loudThreshold = 0.71;
        assert.equal(f.plugin.selectedProtectionProfile(), "custom");
    },
    "Studio overview and profile controls show actual readiness and preset boundaries"(f) {
        assert.equal(f.plugin.setPanelView("overview"), true);
        assert.ok(!f.plugin.panel.innerHTML.includes("Gather evidence"));
        assert.ok(f.plugin.panel.innerHTML.includes("Signal coverage"));
        assert.ok(f.plugin.panel.innerHTML.includes('data-vg-action="open-profiles"'));
        f.connection.stats.rtp.inbound = null;
        f.step(3);
        assert.ok(f.plugin.panel.innerHTML.includes("Waiting for audio data."));
        assert.ok(!f.plugin.panel.innerHTML.includes("All participant levels connected"));
        f.plugin.setPanelView("settings");
        f.plugin.settingsTab = "profiles";
        f.plugin.renderPanel(true);
        assert.ok(f.plugin.panel.innerHTML.includes('data-vg-preset-file="true"'));
        assert.ok(f.plugin.panel.innerHTML.includes('data-vg-action="export-preset"'));
        assert.ok(f.plugin.panel.innerHTML.includes("Trust lists, history, existing mutes"));
        const native = f.plugin.getSettingsPanel();
        const text = node => [node.textContent || "", ...(node.children || []).map(text)].join(" ");
        assert.ok(text(native).includes("Preference presets"));
        assert.ok(text(native).includes("Export preference preset"));
    },
    "saved Probe 1s policies survive reload without becoming ordinary Soft"(f) {
        const saved = {durationSeconds: 1, enabledAt: 700, name: "Alice"};
        f.dataStore.set("softVoicebans", {[f.aliceId]: saved});
        f.plugin.stop();
        const reloaded = new f.Plugin({name: "VoiceGuard"});
        reloaded.start();
        assert.equal(reloaded.softVoicebanFor(f.aliceId).durationSeconds, 1);
        assert.equal(reloaded.policyValueFor(f.aliceId), "soft:1");
        assert.equal(f.dataStore.get("softVoicebans")[f.aliceId].durationSeconds, 1);
        assert.equal(reloaded.requiredHoldMs(f.aliceId, reloaded.members.get(f.aliceId)), 500);
        assert.ok(reloaded.policyOptions().some(option => option.value === "soft:1" && option.label === "Probe 1s"));
        reloaded.stop();
    },
    "three close Probe hits escalate to a remembered hard mute after timed releases"(f) {
        assert.equal(f.plugin.setUserPolicy(f.aliceId, "soft:1"), true);
        const member = f.plugin.members.get(f.aliceId);
        const evidence = {type: "rolling", score: 1, rms: 0.9, loudRatio: 1, activeRatio: 1, loudMs: 560, durationMs: 560};
        for (const [at, count] of [[5000, 1], [9500, 2]]) {
            f.setNow(at);
            assert.equal(f.plugin.applyAutoMute(f.aliceId, member, "Probe fixture", at, true, evidence), true);
            assert.equal(member.softStrikeCount, count);
            assert.equal(member.softUnmuteAt, at + 1000);
            assert.equal(f.plugin.offenseFor(f.aliceId), null);
            f.setNow(at + 1000);
            f.plugin.processSoftUnmutes(at + 1000);
            assert.equal(f.plugin.isUserMuted(f.aliceId), false);
            assert.equal(member.manualUnmuteUntil, at + 4000);
        }
        f.setNow(14000);
        assert.equal(f.plugin.applyAutoMute(f.aliceId, member, "Probe fixture", 14000, true, evidence), true);
        assert.equal(member.softStrikeCount, 3);
        assert.equal(member.softEscalatedAt, 14000);
        assert.equal(member.softUnmuteAt, 0);
        assert.equal(f.plugin.softVoicebanFor(f.aliceId), null);
        assert.equal(f.plugin.policyValueFor(f.aliceId), "guarded");
        assert.equal(f.plugin.isUserMuted(f.aliceId), true);
        assert.equal(f.plugin.offenseFor(f.aliceId).rememberedMute, true);
        assert.match(member.muteReason, /3 probe strikes escalated to hard mute/);
    },
    "Probe hits at the five-second boundary mark trusted without another mute"(f) {
        f.plugin.setUserPolicy(f.aliceId, "soft:1");
        const member = f.plugin.members.get(f.aliceId);
        const evidence = {type: "rolling", score: 1};
        f.setNow(5000);
        assert.equal(f.plugin.applyAutoMute(f.aliceId, member, "Probe fixture", 5000, true, evidence), true);
        f.setNow(6000);
        f.plugin.processSoftUnmutes(6000);
        const muteCalls = f.actionMuteCalls.length;
        f.setNow(10000);
        assert.equal(f.plugin.applyAutoMute(f.aliceId, member, "Probe fixture", 10000, true, evidence), false);
        assert.equal(f.plugin.isTrusted(f.aliceId), true);
        assert.equal(member.softStrikeCount, 0);
        assert.equal(member.softTrustedAt, 10000);
        assert.equal(f.plugin.softVoicebanFor(f.aliceId), null);
        assert.equal(f.plugin.offenseFor(f.aliceId), null);
        assert.equal(f.plugin.isUserMuted(f.aliceId), false);
        assert.equal(f.actionMuteCalls.length, muteCalls);
    },
    "Probe compatibility honors configured hit counts and gap boundaries"(f) {
        f.plugin.settings.softEscalateCount = 2;
        f.plugin.settings.softFalsePositiveGapSeconds = 8;
        f.plugin.normalizeSettings();
        const member = f.plugin.members.get(f.aliceId);
        assert.equal(f.plugin.softMuteDecision(f.aliceId, member, 5000).mode, "soft");
        assert.equal(f.plugin.softMuteDecision(f.aliceId, member, 9000).mode, "hard");
        const other = f.plugin.members.get(f.bobId);
        assert.equal(f.plugin.softMuteDecision(f.bobId, other, 5000).mode, "soft");
        assert.equal(f.plugin.softMuteDecision(f.bobId, other, 13000).mode, "trust");
        assert.equal(other.softTrustedAt, 13000);
    },
    "ordinary Soft policies never inherit Probe evidence escalation or auto-trust"(f) {
        f.plugin.setUserPolicy(f.aliceId, "soft:10");
        const member = f.plugin.members.get(f.aliceId);
        assert.equal(f.plugin.requiredHoldMs(f.aliceId, member), 3000);
        const evidence = {type: "rolling", score: 1};
        for (const at of [5000, 19000, 33000]) {
            f.setNow(at);
            assert.equal(f.plugin.applyAutoMute(f.aliceId, member, "Soft fixture", at, true, evidence), true);
            assert.equal(member.softUnmuteAt, at + 10000);
            assert.equal(member.softStrikeCount, 0);
            assert.equal(member.softLastMutedAt, 0);
            f.setNow(at + 10000);
            f.plugin.processSoftUnmutes(at + 10000);
            assert.equal(f.plugin.isUserMuted(f.aliceId), false);
            assert.equal(f.plugin.isTrusted(f.aliceId), false);
            assert.equal(f.plugin.policyValueFor(f.aliceId), "soft:10");
            assert.equal(f.plugin.offenseFor(f.aliceId), null);
        }
    },
    "malformed saved durations cannot enable the advanced Probe policy"(f) {
        for (const value of [true, false, [1], ["1"], {duration: 1}, {}, null, "1"]) {
            assert.notEqual(f.plugin.normalizedSoftDuration(value), 1);
            f.dataStore.set("softVoicebans", {[f.bobId]: {durationSeconds: value, enabledAt: 700}});
            f.plugin.loadSoftVoicebans();
            assert.notEqual(f.plugin.softVoicebanFor(f.bobId).durationSeconds, 1);
            assert.notEqual(f.dataStore.get("softVoicebans")[f.bobId].durationSeconds, 1);
            assert.equal(f.plugin.requiredHoldMs(f.bobId, f.plugin.members.get(f.bobId)), 3000);
        }
        let coerced = false;
        assert.notEqual(f.plugin.normalizedSoftDuration({valueOf() { coerced = true; return 1; }}), 1);
        assert.equal(coerced, false);
        assert.equal(f.plugin.normalizedSoftDuration(1), 1);
        assert.equal(f.plugin.normalizedSoftDuration("10"), 10);
        assert.equal(f.plugin.setUserPolicy(f.bobId, "soft:1"), true);
        assert.equal(f.plugin.policyValueFor(f.bobId), "soft:1");
    },
    "compact participant controls retain one updating current value and the full policy picker"(f) {
        const row = () => {
            const signal = f.plugin.signals.get(f.aliceId);
            const member = f.plugin.members.get(f.aliceId);
            return f.plugin.renderParticipant({userId: f.aliceId, name: "Alice", avatar: null, signal, member, muted: f.plugin.isUserMuted(f.aliceId), warning: f.plugin.warningFor(signal, f.aliceId), policy: f.plugin.policyValueFor(f.aliceId), attention: false});
        };
        let html = row();
        assert.equal((html.match(/data-vg-metric="current"/g) || []).length, 1);
        assert.ok(html.includes('data-vg-metric="current">62%'));
        assert.ok(!html.includes("Now 62%"));
        assert.equal((html.match(/data-vg-action="toggle-policy-menu"/g) || []).length, 1);
        assert.ok(html.includes('aria-label="Mute Alice"'));
        assert.ok(!html.includes('class="vg3-policy-chips"'));
        f.setInbound({[f.aliceId]: [{audioLevel: 0.31, audioDetected: true}]});
        f.step(3);
        html = row();
        assert.ok(html.includes('data-vg-metric="current">31%'));
        assert.equal((html.match(/data-vg-metric="current"/g) || []).length, 1);
        f.plugin.updateDisplaySetting("showLevelMeter", false);
        html = row();
        assert.ok(html.includes('data-vg-metric="current">Now 31%'));
        assert.equal((html.match(/data-vg-metric="current"/g) || []).length, 1);
        f.plugin.updateDisplaySetting("showLevelMeter", true);
        f.plugin.updateDisplaySetting("showAvatars", false);
        f.plugin.updateDisplaySetting("compactRows", true);
        f.plugin.togglePolicyMenu(f.aliceId);
        html = row();
        assert.ok(!html.includes('class="vg3-avatar"'));
        assert.equal((html.match(/data-vg-action="set-policy"/g) || []).length, 7);
        assert.ok(html.includes('class="vg3-policy-chips"'));
        assert.ok(html.includes("Probe 1s"));
        f.plugin.updateDisplaySetting("showQuickPolicies", false);
        html = row();
        assert.ok(!html.includes('class="vg3-policy-chips"'));
        assert.equal((html.match(/class="vg3-policy-option /g) || []).length, 7);
    }
};

let failures = 0;
for (const [name, test] of Object.entries(cases)) {
    const fixture = fresh();
    try { test(fixture); console.log("PASS " + name); }
    catch (error) { failures++; console.error("FAIL " + name + "\n" + error.stack); }
    finally { fixture.plugin.stop(); }
}
process.exitCode = failures ? 1 : 0;
