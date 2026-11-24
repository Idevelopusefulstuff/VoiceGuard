const fs = require("fs");
const path = require("path");
const vm = require("vm");

const pluginPath = process.argv[2] || path.join(__dirname, "..", "VoiceGuard.plugin.js");
const code = fs.readFileSync(pluginPath, "utf8");
const releaseVersion = code.match(/@version\s+(\S+)/)?.[1];

class Element {
    constructor(tag) {
        this.tag = tag;
        this.style = {};
        this.children = [];
        this.innerHTML = "";
        this.textContent = "";
        this.id = "";
        this.className = "";
    }

    appendChild(child) {
        this.children.push(child);
        if (child.id) elements.set(child.id, child);
        return child;
    }

    append(...children) {
        for (const child of children) {
            if (child && typeof child === "object") this.appendChild(child);
        }
    }

    remove() {
        if (this.id) elements.delete(this.id);
    }
}

const elements = new Map();
const document = {
    body: new Element("body"),
    head: new Element("head"),
    createElement: tag => new Element(tag),
    getElementById: id => elements.get(id) || null
};

const listeners = new Map();
const makeStore = extra => ({
    addChangeListener(fn) { listeners.set(this, fn); },
    removeChangeListener(fn) { if (listeners.get(this) === fn) listeners.delete(this); },
    ...extra
});

const selfId = "111111111111111111";
const aliceId = "222222222222222222";
const bobId = "333333333333333333";
const charlieId = "555555555555555555";
const daveId = "666666666666666666";
const channelId = "444444444444444444";
let nowMs = 1000;
const voiceMembers = new Set([selfId, aliceId, bobId]);

class FakeDate extends Date {
    static now() { return nowMs; }
}

let inbound = {
    [aliceId]: [{audioLevel: 0.62, audioDetected: true}],
    [bobId]: [{audioLevel: 0, audioDetected: false}]
};
const localMuteStates = new Map();
const actionMuteCalls = [];
const actionVolumeCalls = [];
const nativeVolumeCalls = [];
const localVolumes = new Map();
let actionAppliesMute = true;
const mediaActions = {
    setLocalMute(userId, muted, mediaContext) {
        actionMuteCalls.push({userId, muted, mediaContext, at: nowMs});
        if (actionAppliesMute) localMuteStates.set(userId, muted);
    },
    setLocalVolume(userId, volume, mediaContext) {
        actionVolumeCalls.push({userId, volume, mediaContext, at: nowMs});
        localVolumes.set(userId, volume);
    }
};
const connection = {
    connectionState: "CONNECTED",
    context: "default",
    stats: {rtp: {inbound}},
    setLocalMute(userId, muted) { muteCalls.push({userId, muted, at: nowMs}); },
    setLocalVolume(userId, volume) {
        nativeVolumeCalls.push({userId, volume, at: nowMs});
        localVolumes.set(userId, volume);
    }
};
const decoyMuteCalls = [];
const decoyConnection = {
    connectionState: "CONNECTED",
    context: "stream",
    stats: {rtp: {inbound: {}}},
    setLocalMute(userId, muted) { decoyMuteCalls.push({userId, muted, at: nowMs}); },
    setLocalVolume() {}
};
const mediaEngine = {connections: new Map([["voice", connection]])};
const stores = {
    UserStore: makeStore({
        getCurrentUser: () => ({id: selfId}),
        getUser: id => ({id, username: id === aliceId ? "Alice" : id === bobId ? "Bob" : "Charlie"})
    }),
    SelectedChannelStore: makeStore({getVoiceChannelId: () => channelId}),
    VoiceStateStore: makeStore({
        getCurrentClientVoiceChannelId: () => channelId,
        getUserVoiceChannelId: () => channelId,
        getVoiceStatesForChannel: () => new Map(Array.from(voiceMembers, id => [id, {userId: id}]))
    }),
    RTCConnectionStore: makeStore({getChannelId: () => channelId}),
    MediaEngineStore: makeStore({
        getMediaEngine: () => mediaEngine,
        isLocalMute: userId => localMuteStates.get(userId) === true,
        getLocalVolume: userId => localVolumes.get(userId) ?? 1
    }),
    SpeakingStore: makeStore({isSpeaking: () => true})
};

let intervalId = 0;
const intervals = new Map();
let fetchCalls = 0;
const muteCalls = [];
const dataStore = new Map();
dataStore.set("settings", {
    rememberOffenders: true,
    newcomerLoudSeconds: 1.2,
    establishedLoudSeconds: 3,
    repeatLoudSeconds: 0.65,
    extremeHoldSeconds: 0.45
});
dataStore.set("offenses", {
    [aliceId]: {
        count: 3,
        quickLeaves: 0,
        lastOffenseAt: nowMs,
        lastReason: "legacy short peak",
        rememberedMute: true
    }
});
const toasts = [];
const addedStyles = new Set();
const context = {
    module: {exports: {}},
    exports: {},
    window: {},
    document,
    fetch: async () => { fetchCalls += 1; throw new Error("network fetch must not be used"); },
    setInterval: fn => { const id = ++intervalId; intervals.set(id, fn); return id; },
    clearInterval: id => intervals.delete(id),
    BdApi: {
        Data: {
            load: (_name, key) => dataStore.get(key) || null,
            save: (_name, key, value) => dataStore.set(key, JSON.parse(JSON.stringify(value)))
        },
        Webpack: {
            getStore: name => stores[name] || null,
            getByKeys: (...keys) => keys.includes("setLocalVolume") ? mediaActions : null,
            Filters: {byKeys: (...keys) => value => keys.every(key => key in value)},
            getModule: filter => filter(mediaActions) ? mediaActions : null
        },
        UI: {showToast: message => toasts.push(message)},
        DOM: {
            addStyle: key => addedStyles.add(key),
            removeStyle: key => addedStyles.delete(key)
        }
    },
    console,
    Date: FakeDate,
    Map,
    Set,
    Object,
    Array,
    String,
    Number,
    Math,
    RegExp,
    Promise
};

const expect = (condition, message) => {
    if (!condition) throw new Error(message);
};

function step(plugin, count = 1, ms = 80) {
    for (let index = 0; index < count; index += 1) {
        nowMs += ms;
        plugin.tick();
    }
}

function setInbound(value) {
    inbound = value;
    connection.stats.rtp.inbound = inbound;
}

function elementText(element) {
    return [element?.textContent || "", ...(element?.children || []).map(elementText)].join(" ");
}

function main() {
    expect(!code.includes("127.0.0.1:8766"), "legacy Windows meter endpoint remains");
    expect(!code.includes("fetch("), "plugin still performs network fetches");
    vm.createContext(context);
    vm.runInContext(code, context, {filename: pluginPath});
    const Plugin = context.module.exports;
    const plugin = new Plugin({name: "VoiceGuard"});
    plugin.start();

    expect(releaseVersion && dataStore.get("runtimeStatus")?.version === releaseVersion, "runtime status version was not recorded");
    expect(dataStore.get("runtimeStatus")?.detectorProfile === "rolling-v1", "rolling detector profile was not recorded");
    expect(dataStore.get("runtimeStatus")?.legacyOffensesRetired === 1, "legacy offense retirement was not recorded");
    expect(plugin.offenseFor(aliceId) === null, "legacy peak offense still affects enforcement");
    expect(dataStore.get("offenses")?.[aliceId]?.rememberedMute === false, "legacy peak offense was not retired");
    expect(plugin.settings.newcomerLoudSeconds >= 2, "unsafe newcomer hold survived detector migration");
    expect(plugin.settings.repeatLoudSeconds >= 1.5, "unsafe repeat hold survived detector migration");
    expect(plugin.settings.extremeHoldSeconds >= 2, "unsafe clipping hold survived detector migration");
    expect(dataStore.get("settings")?.panelCollapsed === false, "drawer default was not persisted at startup");
    expect(dataStore.get("settings")?.softRearmGraceSeconds === 3, "soft re-arm grace was not persisted at startup");
    expect(dataStore.get("runtimeStatus")?.panelPresent === true, "runtime status did not confirm the panel");
    expect(dataStore.get("runtimeStatus")?.rosterCount === 3, "runtime status did not count the full call including self");
    expect(dataStore.get("runtimeStatus")?.controlsRendered === 0, "a mute control appeared before a person was selected");
    expect(dataStore.get("runtimeStatus")?.policyControlsRendered === 0, "a policy control appeared before a person was selected");
    expect(dataStore.get("runtimeStatus")?.panelCollapsed === false, "runtime status drawer state is incorrect");
    expect(plugin.panel.innerHTML.includes("Incoming levels live"), "live audio status did not initialize");
    expect(plugin.panel.innerHTML.includes("Alice"), "Alice row missing");
    expect(plugin.panel.innerHTML.includes("Bob"), "silent participant controls are missing");
    expect(plugin.panel.innerHTML.includes("vg3-summary"), "call summary is missing");
    expect(plugin.panel.innerHTML.includes("vg3-guard-strip"), "guard state strip is missing");
    expect(plugin.selectParticipant(aliceId), "Alice could not be inspected");
    expect(plugin.panel.innerHTML.includes("vg3-track-wrap"), "readable level track is missing");
    expect(!plugin.panel.innerHTML.includes('class="vg3-policy-chips"'), "closed policy picker duplicates quick controls");
    expect(plugin.panel.innerHTML.includes("Auto on"), "auto-mute state is not visible");
    expect(plugin.panel.innerHTML.includes("vg3-avatar"), "participant avatars are missing");
    expect(plugin.panel.innerHTML.includes("vg5-tile") && plugin.panel.innerHTML.includes("vg5-inspector"), "roster and single person controls are missing");
    expect(plugin.panel.innerHTML.includes('data-vg-action="toggle-mute"'), "manual mute controls are missing");
    expect(plugin.panel.innerHTML.includes('data-vg-action="toggle-policy-menu"'), "interactive policy triggers are missing");
    expect(!plugin.panel.innerHTML.includes("<select"), "native policy dropdown is still rendered");
    expect(plugin.togglePolicyMenu(aliceId) === true, "interactive policy tray did not open");
    expect(plugin.panel.innerHTML.includes("vg3-policy-menu"), "interactive policy tray is missing");
    expect((plugin.panel.innerHTML.match(/data-vg-action="set-policy"/g) || []).length === 7, "interactive policy tray does not show each option once");
    expect((plugin.panel.innerHTML.match(/class="vg3-policy-chip/g) || []).length >= 3, "quick policy chips are missing");
    expect(plugin.panel.innerHTML.includes("Full auto protection"), "guarded policy behavior is not visible");
    expect(plugin.panel.innerHTML.includes("Never auto-mute"), "trusted policy behavior is not visible");
    plugin.panel.onkeydown({key: "Escape"});
    expect(plugin.policyMenuUserId === null && !plugin.panel.innerHTML.includes("vg3-policy-menu"), "Escape did not close the policy tray");
    expect(plugin.togglePolicyMenu(aliceId) === true, "policy tray did not reopen");
    expect(plugin.togglePolicyMenu(aliceId) === false, "policy tray did not close from its trigger");
    expect(plugin.togglePolicyMenu("invalid") === false, "invalid user opened a policy tray");
    expect(plugin.panel.innerHTML.includes('data-vg-action="toggle-drawer"'), "drawer control is missing");
    expect(plugin.panel.innerHTML.includes('data-vg-action="toggle-auto-mute"'), "master auto-mute switch is missing");
    expect(plugin.panel.innerHTML.includes('data-vg-action="filter"'), "participant filters are missing");
    expect(plugin.toggleAutoMute() === false, "master auto-mute switch did not pause enforcement");
    expect(dataStore.get("settings")?.autoMute === false, "paused auto-mute state was not persisted");
    expect(plugin.panel.innerHTML.includes('aria-checked="false"'), "paused auto-mute switch did not update visually");
    expect(plugin.toggleAutoMute() === true, "master auto-mute switch did not restore enforcement");
    expect(plugin.setPanelFilter("alerts"), "alerts filter could not be selected");
    expect(dataStore.get("uiState")?.panelFilter === "alerts", "participant filter was not persisted");
    expect(!plugin.panel.innerHTML.includes(" matched"), "alerts highlighted a quiet person");
    expect(plugin.panel.innerHTML.includes("Alice") && plugin.panel.innerHTML.includes("Bob"), "alerts hid part of the call");
    expect(plugin.setPanelFilter("all"), "all-participants filter could not be restored");
    expect(plugin.panel.innerHTML.includes("Alice") && plugin.panel.innerHTML.includes("Bob"), "all-participants filter did not restore users");
    expect(plugin.setPanelFilter("invalid") === false, "invalid participant filter was accepted");
    expect(plugin.toggleDrawer() === true, "drawer did not collapse");
    expect(plugin.panel.className.includes("vg3-collapsed"), "collapsed drawer class is missing");
    expect(dataStore.get("settings")?.panelCollapsed === true, "collapsed drawer state was not persisted");
    expect(dataStore.get("uiState")?.panelCollapsed === true, "dedicated drawer UI state was not persisted");
    expect(plugin.toggleDrawer() === false, "drawer did not reopen");
    expect(!plugin.panel.className.includes("vg3-collapsed"), "drawer remained collapsed after reopening");
    const settingsPanel = plugin.getSettingsPanel();
    const settingsText = elementText(settingsPanel);
    expect(!settingsText.includes(releaseVersion) && !settingsText.includes("VoiceGuard V2"), "settings show a legacy brand or release label");
    expect(!plugin.panel.innerHTML.includes("VoiceGuard V2"), "roster title contains the legacy brand");
    expect(settingsText.includes("Interface"), "production settings interface section is missing");
    expect(settingsText.includes("Detection"), "production settings detection section is missing");
    expect(settingsText.includes("Soft Voiceban"), "production settings soft voiceban section is missing");
    expect(settingsText.includes("History"), "production settings history section is missing");
    expect(settingsText.includes("Clear soft policies"), "soft policy reset control is missing");
    expect(plugin.panel.innerHTML.includes('data-vg-metric="current">62%'), "Alice readable level missing");
    expect(plugin.panel.innerHTML.includes("-4.2 dBFS"), "Alice dBFS conversion incorrect");

    setInbound(new Map([
        [aliceId, [{audioLevel: 0.62, audioDetected: true}]],
        [bobId, [{audioLevel: 0.18, audioDetected: true}]]
    ]));
    mediaEngine.connections = new Set([connection]);
    step(plugin, 3);
    expect(plugin.panel.innerHTML.includes('data-vg-metric="current">62%'), "Alice distinct level disappeared");
    expect(plugin.panel.innerHTML.includes('title="Bob · LIVE · Level 18%"'), "Bob distinct roster level missing");
    expect(plugin.panel.innerHTML.includes("2 live"), "two real RTP speakers not counted");

    setInbound({
        [aliceId]: [{audioLevel: 0, audioDetected: false}],
        [bobId]: [{audioLevel: 0, audioDetected: false}]
    });
    mediaEngine.connections = {voice: connection};
    step(plugin, 8);
    expect(plugin.panel.innerHTML.includes("0 live"), "always-true SpeakingStore fabricated activity");
    expect(!plugin.panel.innerHTML.includes("LIVE</span>"), "silent users still marked live");
    expect(plugin.panel.innerHTML.includes("SILENT"), "silent participant status missing");

    voiceMembers.add(daveId);
    setInbound({
        [aliceId]: [{audioLevel: 0, audioDetected: false}],
        [bobId]: [{audioLevel: 0, audioDetected: false}],
        [daveId]: [{audioLevel: 0.64, audioDetected: true}]
    });
    step(plugin, 8);
    expect(muteCalls.length === 0, "below-threshold newcomer was falsely muted");
    voiceMembers.delete(daveId);
    setInbound({
        [aliceId]: [{audioLevel: 0, audioDetected: false}],
        [bobId]: [{audioLevel: 0, audioDetected: false}]
    });
    plugin.tick();
    expect(!dataStore.get("offenses")?.[daveId], "quiet quick-leaver was falsely remembered");

    plugin.setTrusted(daveId, true);
    expect(plugin.isTrusted(daveId), "trusted user was not stored");
    expect(dataStore.get("trustedUsers")?.[daveId], "trusted user was not persisted");
    voiceMembers.add(daveId);
    setInbound({
        [aliceId]: [{audioLevel: 0, audioDetected: false}],
        [bobId]: [{audioLevel: 0, audioDetected: false}],
        [daveId]: [{audioLevel: 1, audioDetected: true}]
    });
    step(plugin, 8);
    expect(muteCalls.length === 0, "trusted loud user was auto-muted");
    expect(plugin.panel.innerHTML.includes("TRUSTED"), "trusted status was not rendered");
    expect(plugin.setPanelFilter("managed"), "managed-users filter could not be selected");
    expect(plugin.panel.innerHTML.includes('matched" data-vg-key="user-' + daveId + '"'), "managed-users filter did not highlight the trusted participant");
    expect(plugin.panel.innerHTML.includes('data-vg-key="user-' + aliceId + '"'), "managed-users filter hid a guarded participant");
    expect(plugin.setPanelFilter("all"), "all-participants filter could not be restored after managed view");
    voiceMembers.delete(daveId);
    setInbound({
        [aliceId]: [{audioLevel: 0, audioDetected: false}],
        [bobId]: [{audioLevel: 0, audioDetected: false}]
    });
    plugin.tick();
    expect(!dataStore.get("offenses")?.[daveId], "trusted quick-leaver was remembered as an offender");

    for (let index = 0; index < 64; index += 1) {
        const phase = index % 8;
        const level = phase < 2 ? 0.98 : phase < 6 ? 0.35 : 0;
        setInbound({
            [aliceId]: [{audioLevel: level, audioDetected: level > 0}],
            [bobId]: [{audioLevel: 0, audioDetected: false}]
        });
        step(plugin, 1);
    }
    expect(muteCalls.length === 0, "normal speech with brief high peaks was falsely muted");
    expect((plugin.signals.get(aliceId)?.blast?.score || 0) < 1, "normal speech reached blast confidence");

    setInbound({
        [aliceId]: [{audioLevel: 1, audioDetected: true}],
        [bobId]: [{audioLevel: 0, audioDetected: false}]
    });
    step(plugin, 4, 500);
    expect(muteCalls.length === 0, "renderer stalls were counted as continuous clipping evidence");

    voiceMembers.add(charlieId);
    mediaEngine.connections = new Set([decoyConnection, connection]);
    setInbound({
        [aliceId]: [{audioLevel: 0, audioDetected: false}],
        [bobId]: [{audioLevel: 0, audioDetected: false}],
        [charlieId]: [{audioLevel: 0.90, audioDetected: true}]
    });
    step(plugin, 28);
    expect(plugin.selectParticipant(charlieId), "the automatically muted newcomer could not be inspected");
    expect(plugin.panel.innerHTML.includes('data-vg-metric="current">90%'), "blast level missing");
    expect(plugin.panel.innerHTML.includes("MUTED"), "newcomer was not marked muted");
    expect(plugin.panel.innerHTML.includes("Blast 100%"), "muted row did not retain its blast evidence score");
    expect(plugin.panel.innerHTML.includes("-0.9 dBFS"), "blast dBFS display incorrect");
    expect(actionMuteCalls.length === 1 && actionMuteCalls[0].mediaContext === "default", "Discord media action mute was not called for the voice context");
    expect(muteCalls.length === 1 && muteCalls[0].userId === charlieId && muteCalls[0].muted === true, "newcomer local mute was not called");
    expect(actionVolumeCalls.length === 0 && nativeVolumeCalls.length === 0, "verified mute unnecessarily forced volume to zero");
    expect(decoyMuteCalls.length === 0, "local mute targeted the wrong RTC connection");
    expect(dataStore.get("offenses")?.[charlieId]?.count === 1, "newcomer offense was not remembered");
    expect(dataStore.get("offenses")?.[charlieId]?.detectorVersion === "rolling-v1", "new offense did not record the rolling detector");
    expect(dataStore.get("offenses")?.[charlieId]?.lastEvidence?.type === "rolling", "rolling blast evidence was not persisted");
    expect(plugin.members.get(charlieId)?.muteReason?.includes("rolling blast"), "mute reason did not identify rolling blast evidence");

    nowMs += 10000;
    voiceMembers.delete(charlieId);
    setInbound({
        [aliceId]: [{audioLevel: 0, audioDetected: false}],
        [bobId]: [{audioLevel: 0, audioDetected: false}]
    });
    plugin.tick();
    expect(dataStore.get("offenses")?.[charlieId]?.quickLeaves === 1, "quick-leave behavior was not recorded");

    voiceMembers.add(charlieId);
    setInbound({
        [aliceId]: [{audioLevel: 0, audioDetected: false}],
        [bobId]: [{audioLevel: 0, audioDetected: false}],
        [charlieId]: [{audioLevel: 0, audioDetected: false}]
    });
    step(plugin, 2);
    expect(muteCalls.filter(call => call.muted).length === 2 && muteCalls.at(-1).userId === charlieId, "remembered offender was not muted on rejoin");

    const beforeManualMute = actionMuteCalls.length;
    expect(plugin.selectParticipant(aliceId), "the manually muted person could not be inspected");
    expect(plugin.manualMute(aliceId), "manual mute failed");
    expect(actionMuteCalls.length === beforeManualMute + 1, "manual mute did not call the Discord media action");
    expect(actionMuteCalls.at(-1).userId === aliceId && actionMuteCalls.at(-1).muted === true, "manual mute used the wrong Discord action");
    expect(plugin.members.get(aliceId)?.manualMutedAt > 0, "manual mute state was not recorded");
    expect(plugin.panel.innerHTML.includes("Unmute"), "manual unmute control did not render");

    expect(plugin.manualUnmute(aliceId), "manual unmute failed");
    expect(actionMuteCalls.at(-1).userId === aliceId && actionMuteCalls.at(-1).muted === false, "manual unmute did not call the Discord media action");
    expect(localMuteStates.get(aliceId) === false, "Discord local mute state was not cleared");
    expect(plugin.members.get(aliceId)?.manualUnmuteUntil > nowMs, "manual unmute grace period was not set");
    const afterManualUnmute = actionMuteCalls.length;
    setInbound({
        [aliceId]: [{audioLevel: 1, audioDetected: true}],
        [bobId]: [{audioLevel: 0, audioDetected: false}],
        [charlieId]: [{audioLevel: 0, audioDetected: false}]
    });
    step(plugin, 6);
    expect(actionMuteCalls.length === afterManualUnmute, "manual unmute grace period allowed an immediate auto-mute");

    const snapshot = plugin.snapshot();
    expect(snapshot.version === releaseVersion, "debug snapshot version mismatch");
    expect(snapshot.detectorProfile === "rolling-v1", "debug snapshot detector profile mismatch");
    expect(snapshot.ui?.collapsed === false && snapshot.ui?.filter === "all", "debug snapshot UI state mismatch");
    expect(snapshot.telemetry.mappedUsers === 3, "per-user map count incorrect");
    expect(snapshot.users.every(user => user.mapped === true), "mapped state missing from snapshot");
    expect(snapshot.users.find(user => user.id === charlieId)?.warning === "MUTED", "snapshot mute state missing");
    expect(snapshot.users.find(user => user.id === charlieId)?.priorOffenses === 1, "snapshot offense history missing");
    expect(snapshot.users.find(user => user.id === charlieId)?.quickLeaves === 1, "snapshot quick-leave history missing");
    expect(snapshot.users.find(user => user.id === charlieId)?.muteVerified === true, "verified mute state missing from snapshot");
    expect(snapshot.users.find(user => user.id === charlieId)?.volumeFallback === false, "verified mute incorrectly reported volume fallback");
    expect(snapshot.users.find(user => user.id === aliceId)?.manualUnmuteGraceMs > 0, "manual unmute grace is missing from the snapshot");
    expect(snapshot.autoMute.trustedUsers === 1, "trusted-user count is missing from the snapshot");
    expect(snapshot.autoMute.rememberedOffenders === 1, "legacy offenses were counted as enforceable");
    expect(snapshot.autoMute.legacyOffensesRetired === 1, "snapshot legacy retirement count is missing");
    expect(snapshot.autoMute.support.connectionCount === 2, "multiple RTC connections were not detected");
    expect(snapshot.autoMute.support.directConnectionMethods === 2, "local mute support was not detected across RTC connections");
    expect(snapshot.autoMute.support.actionMute === true, "high-level Discord mute action was not detected");
    expect(snapshot.autoMute.support.actionVolume === true, "high-level Discord volume action was not detected");
    expect(snapshot.autoMute.support.storeVerification === true, "Discord mute-state verification was not detected");
    expect(Math.abs(plugin.levelToDb(0.5) + 6.020599913) < 0.0001, "dBFS formula incorrect");

    expect(plugin.manualUnmute(charlieId), "manual unmute of a remembered offender failed");
    expect(plugin.members.get(charlieId)?.rememberedMuteDismissed === true, "manual unmute did not dismiss the remembered instant mute");
    const trueMutesAfterRememberedUnmute = actionMuteCalls.filter(call => call.muted === true).length;
    nowMs += 16000;
    setInbound({
        [aliceId]: [{audioLevel: 0, audioDetected: false}],
        [bobId]: [{audioLevel: 0, audioDetected: false}],
        [charlieId]: [{audioLevel: 0, audioDetected: false}]
    });
    step(plugin, 1);
    expect(actionMuteCalls.filter(call => call.muted === true).length === trueMutesAfterRememberedUnmute, "remembered offender was silently re-muted after manual unmute");

    actionAppliesMute = false;
    localMuteStates.set(bobId, false);
    localVolumes.set(bobId, 0.73);
    const fallbackResult = plugin.muteLocally(bobId);
    expect(fallbackResult.ok && fallbackResult.volumeFallback, "zero-volume fallback did not engage after an unverified mute");
    expect(actionVolumeCalls.some(call => call.userId === bobId && call.volume === 0), "Discord media action did not force fallback volume to zero");
    expect(nativeVolumeCalls.some(call => call.userId === bobId && call.volume === 0), "native connection did not force fallback volume to zero");
    const unmuteFallbackResult = plugin.unmuteLocally(bobId);
    expect(unmuteFallbackResult.ok && unmuteFallbackResult.volumeRestored, "fallback unmute did not restore volume");
    expect(actionVolumeCalls.some(call => call.userId === bobId && call.volume === 0.73), "Discord media action did not restore the prior volume");
    expect(nativeVolumeCalls.some(call => call.userId === bobId && call.volume === 0.73), "native connection did not restore the prior volume");
    expect(!plugin.forcedZeroUsers.has(bobId), "fallback zero-volume state was not cleared after unmute");

    actionAppliesMute = true;
    expect(plugin.togglePolicyMenu(bobId), "Bob policy tray did not open before selection");
    expect(plugin.setUserPolicy(bobId, "trusted"), "trusted policy could not be selected from the policy menu");
    expect(plugin.policyMenuUserId === null, "policy tray stayed open after a selection");
    expect(plugin.policyValueFor(bobId) === "trusted", "trusted policy did not take effect");
    expect(plugin.setUserPolicy(bobId, "soft:10"), "soft voiceban policy could not be selected");
    expect(plugin.policyValueFor(bobId) === "soft:10", "soft voiceban policy did not persist");
    expect(!plugin.isTrusted(bobId), "soft policy did not replace the conflicting trusted policy");
    expect(dataStore.get("softVoicebans")?.[bobId]?.durationSeconds === 10, "soft voiceban duration was not saved");
    const lateBlastStartedAt = nowMs;
    for (let index = 0; index < 72 && !plugin.members.get(bobId)?.autoMutedAt; index += 1) {
        const level = index % 4 === 3 ? 0.25 : 0.90;
        setInbound({
            [aliceId]: [{audioLevel: 0, audioDetected: false}],
            [bobId]: [{audioLevel: level, audioDetected: true}],
            [charlieId]: [{audioLevel: 0, audioDetected: false}]
        });
        step(plugin, 1);
    }
    expect(plugin.members.get(bobId)?.confirmedJoin === false, "late-blast test user was incorrectly treated as a newcomer");
    expect(plugin.members.get(bobId)?.autoMutedAt > lateBlastStartedAt, "established caller's later intermittent blast was not muted");
    expect(plugin.members.get(bobId)?.lastBlast?.type === "rolling", "late intermittent blast did not use rolling evidence");
    expect(plugin.members.get(bobId)?.lastBlast?.loudRatio >= 0.60, "late blast loud-duty evidence is missing");
    expect(plugin.members.get(bobId)?.muteReason?.includes("rolling blast"), "late blast mute reason is incorrect");
    expect(plugin.members.get(bobId)?.softMutedAt > 0, "soft voiceban did not mark the detector mute as temporary");
    expect(plugin.members.get(bobId)?.softUnmuteAt > nowMs, "soft voiceban release deadline is missing");
    expect(plugin.panel.innerHTML.includes("SOFT 10s"), "soft voiceban countdown is not rendered");
    expect(!dataStore.get("offenses")?.[bobId], "soft voiceban incorrectly created permanent offender history");

    const softMuteAt = plugin.members.get(bobId).softMutedAt;
    step(plugin, 1, 10000);
    expect(!plugin.members.get(bobId)?.autoMutedAt, "soft voiceban did not automatically unmute");
    expect(localMuteStates.get(bobId) === false, "soft voiceban did not clear Discord's local mute state");
    expect(plugin.members.get(bobId)?.manualUnmuteUntil > nowMs, "soft voiceban release grace was not armed");
    expect(plugin.policyValueFor(bobId) === "soft:10", "soft voiceban policy disappeared after release");
    expect(plugin.members.get(bobId)?.softMutedAt !== softMuteAt, "soft mute state was not cleared after release");

    connection.stats.rtp.inbound = null;
    decoyConnection.stats.rtp.inbound = null;
    step(plugin, 3);
    expect(plugin.panel.innerHTML.includes("inbound RTP stats unavailable"), "missing-inbound state not visible");
    expect(fetchCalls === 0, "plugin made a network request");
    expect(listeners.size === 4, "expected four lightweight store listeners");
    expect(intervals.size === 1, "expected one RTP sampling interval");
    expect(addedStyles.has("voiceguard-rtp-v3"), "plugin style was not installed");

    plugin.stop();
    expect(listeners.size === 0, "store listeners leaked");
    expect(intervals.size === 0, "sampling interval leaked");
    expect(!elements.has("vg-rtp-panel"), "panel leaked");
    expect(!addedStyles.has("voiceguard-rtp-v3"), "plugin style leaked");
    expect(!context.window.voiceGuardV2Debug, "debug helper leaked");

    console.log(JSON.stringify({
        syntax: "ok",
        source: "MediaEngineStore.stats.rtp.inbound",
        perUserLevels: "ok",
        dbfs: "ok",
        speakingStoreIgnored: true,
        legacyPeakOffensesRetired: true,
        normalSpeechPeaksIgnored: true,
        rendererStallsDoNotCreateEvidence: true,
        lateIntermittentBlastMuted: true,
        allCallMonitoring: true,
        discordStyleControlPanel: true,
        participantFilters: true,
        masterAutoMuteSwitch: true,
        animatedDrawerPersistence: true,
        interactivePolicyTray: true,
        softVoicebanAutoRelease: true,
        softVoicebanNoPermanentOffense: true,
        quietQuickLeaverIgnored: true,
        multipleRtcConnections: true,
        verifiedMediaActionMute: true,
        zeroVolumeFallback: true,
        exactVolumeRestore: true,
        manualMuteUnmute: true,
        manualUnmuteGrace: true,
        rememberedMuteDismissedByManualUnmute: true,
        trustedBypass: true,
        newcomerAutoMute: true,
        quickLeaveRemembered: true,
        repeatRejoinMute: true,
        networkFetches: fetchCalls,
        listenersCleaned: true,
        intervalCleaned: true
    }));
}

try {
    main();
    process.exit(0);
} catch (error) {
    console.error(error.stack || error);
    process.exit(1);
}
