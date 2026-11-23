"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const fixturePrefix = fs.readFileSync(path.join(__dirname, "test_voiceguard_plugin.js"), "utf8").split("function main() {")[0];
const sourcePath = path.join(__dirname, "..", "VoiceGuard.plugin.js");
let failures = 0;
let checks = 0;

function fixture(overrides = {}) {
    const sandbox = { require, __dirname, process: {argv: [process.argv[0], __filename, sourcePath]}, console, URL, overrides };
    vm.runInNewContext(fixturePrefix + `
        for (const [key, value] of Object.entries(overrides)) dataStore.set(key, value);
        context.URL = URL;
        vm.createContext(context);
        vm.runInContext(code, context, {filename: pluginPath});
        const Plugin = context.module.exports;
        const plugin = new Plugin({name: "VoiceGuard"});
        globalThis.fixture = {
            plugin, context, stores, connection, mediaActions, localMuteStates, localVolumes,
            dataStore, voiceMembers, actionMuteCalls, actionVolumeCalls,
            aliceId, bobId, selfId, channelId, toasts,
            start: () => plugin.start(),
            step: (count = 1, ms = 80) => step(plugin, count, ms),
            setNow: value => { nowMs = value; },
            setInbound,
            resources: () => ({intervals: intervals.size, listeners: listeners.size, styles: addedStyles.size, fetchCalls})
        };
    `, sandbox);
    return sandbox.fixture;
}

function test(name, run, initial = {}) {
    checks++;
    const f = fixture(initial);
    try { run(f); console.log("PASS " + name); }
    catch (error) { failures++; console.error("FAIL " + name + ": " + error.message); }
    finally { f.plugin.stop(); assert.equal(f.resources().fetchCalls, 0, "Fixture attempted network access"); }
}

for (const [label, record] of [
    ["string", "broken"], ["boolean", true], ["array", []],
    ["non-scalar timestamp", {lastOffenseAt: {valueOf: null, toString: null}}]
]) {
    test("malformed offense " + label + " cannot crash startup or remain enforceable", f => {
        assert.doesNotThrow(() => f.start());
        assert.equal(f.plugin.offenseFor(f.aliceId), null);
    }, {offenses: {"222222222222222222": record}});
}

test("malformed truthy trust records do not bypass protection", f => {
    f.start();
    assert.equal(f.plugin.isTrusted(f.aliceId), false);
}, {trustedUsers: {"222222222222222222": "not a trust record"}});

test("inherited dictionary entries do not become trusted people", f => {
    f.start();
    assert.equal(f.plugin.isTrusted(f.aliceId), false);
}, {trustedUsers: Object.create({"222222222222222222": {trustedAt: 1000, name: "Alice"}})});

test("malformed recovery identifiers cannot crash startup", f => {
    assert.doesNotThrow(() => f.start());
    assert.equal(f.plugin.ownedMutes.size, 0);
}, {audioRestores: [{userId: {valueOf: null, toString: null}, forcedZero: true, volume: 0.7}]});

test("a persisted recovery entry for the current account cannot change self audio", f => {
    f.start();
    f.step(3);
    assert.equal(f.actionMuteCalls.filter(call => call.userId === f.selfId).length, 0);
    assert.equal(f.actionVolumeCalls.filter(call => call.userId === f.selfId).length, 0);
    assert.equal(f.plugin.ownedMutes.has(f.selfId), false);
}, {audioRestores: [{userId: "111111111111111111", forcedZero: true, volume: 0.7}]});

test("manual unmute rejects the current account", f => {
    f.start();
    const before = f.actionMuteCalls.length;
    assert.equal(f.plugin.manualUnmute(f.selfId), false);
    assert.equal(f.actionMuteCalls.length, before);
});

test("manual unmute without identity or owned recovery cannot act on stale controls", f => {
    f.start();
    f.stores.UserStore.getCurrentUser = () => null;
    const before = f.actionMuteCalls.length;
    assert.equal(f.plugin.manualUnmute(f.aliceId), false);
    assert.equal(f.actionMuteCalls.length, before);
});

test("stale manual mute rejects a participant who already left the voice store", f => {
    f.start();
    f.voiceMembers.delete(f.aliceId);
    const before = f.actionMuteCalls.length;
    assert.equal(f.plugin.manualMute(f.aliceId), false);
    assert.equal(f.actionMuteCalls.length, before);
    assert.equal(f.plugin.ownedMutes.has(f.aliceId), false);
});

test("malformed policy arguments cannot throw or silently remove a valid trust choice", f => {
    f.start();
    f.plugin.setTrusted(f.aliceId, true);
    assert.doesNotThrow(() => assert.equal(f.plugin.setTrusted({toString: null}, true), false));
    assert.equal(f.plugin.setTrusted(f.aliceId, "true"), false);
    assert.equal(f.plugin.isTrusted(f.aliceId), true);
    assert.doesNotThrow(() => assert.equal(f.plugin.setUserPolicy(f.aliceId, {toString: null}), false));
});

test("malformed activity undo arguments cannot throw or release a current mute", f => {
    f.start();
    f.plugin.manualMute(f.aliceId);
    const before = f.actionMuteCalls.length;
    assert.doesNotThrow(() => assert.equal(f.plugin.undoActivityMute({valueOf: null, toString: null}), false));
    assert.equal(f.actionMuteCalls.length, before);
});

for (const value of [
    "http://cdn.discordapp.com/avatars/222222222222222222/hash.webp",
    "https://tracker.invalid/portrait.png",
    "https://cdn.discordapp.com.evil.invalid/avatars/222222222222222222/hash.webp",
    "https://user:secret@cdn.discordapp.com/avatars/222222222222222222/hash.webp",
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    "javascript:alert(1)"
]) {
    test("unsafe avatar source is rejected: " + value.split(":")[0] + "/" + checks, f => {
        f.start();
        f.stores.UserStore.getUser = () => ({username: "Alice", getAvatarURL: () => value});
        assert.equal(f.plugin.userAvatar(f.aliceId), null);
    });
}

test("official HTTPS Discord avatars and default portraits remain supported", f => {
    f.start();
    for (const value of [
        "https://cdn.discordapp.com/avatars/222222222222222222/a_hash.webp?size=64",
        "https://media.discordapp.net/avatars/222222222222222222/hash.png?size=128",
        "https://cdn.discordapp.com/embed/avatars/3.png"
    ]) {
        f.stores.UserStore.getUser = () => ({username: "Alice", getAvatarURL: () => value});
        assert.equal(f.plugin.userAvatar(f.aliceId), value);
    }
});

test("unknown settings and prototype keys are not retained or reserialized", f => {
    f.start();
    assert.equal(Object.prototype.hasOwnProperty.call(f.plugin.settings, "unknownPayload"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(f.plugin.settings, "__proto__"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(f.dataStore.get("settings"), "unknownPayload"), false);
    assert.equal({}.polluted, undefined);
}, {settings: JSON.parse('{"autoMute":false,"detectorProfile":"rolling-v1","unknownPayload":{"huge":"discard"},"__proto__":{"polluted":true}}')});

function manyRecords(kind, count = 9000) {
    return Object.fromEntries(Array.from({length: count}, (_, index) => {
        const id = String(800000000000000000n + BigInt(index));
        const record = kind === "trust" ? {trustedAt: 1000, name: "Synthetic"}
            : kind === "offenses" ? {lastOffenseAt: 1000, count: 1, rememberedMute: true, detectorVersion: "rolling-v1"}
                : {durationSeconds: 1, enabledAt: 1000, name: "Synthetic"};
        return [id, record];
    }));
}
for (const [kind, field] of [["trust", "trustedUsers"], ["offenses", "offenses"], ["soft", "softVoicebans"]]) {
    test("all 9000 valid persisted " + kind + " records survive load and save", f => {
        f.start();
        assert.equal(Object.keys(f.plugin[field]).length, 9000);
        assert.equal(Object.keys(f.dataStore.get(field)).length, 9000);
        const lastId = String(800000000000000000n + 8999n);
        assert.ok(Object.prototype.hasOwnProperty.call(f.plugin[field], lastId));
        assert.ok(Object.prototype.hasOwnProperty.call(f.dataStore.get(field), lastId));
        assert.equal(f.plugin.persistenceWarnings.size, 0);
    }, {[field]: manyRecords(kind)});
}

test("recovery authority and exact volumes are never truncated by metadata limits", f => {
    f.plugin.loadAudioRestores();
    assert.equal(f.plugin.ownedMutes.size, 4250);
    assert.equal(f.plugin.pendingRestores.size, 4250);
    assert.equal(f.plugin.volumeBeforeMute.size, 4250);
    assert.equal([...f.plugin.volumeBeforeMute.values()].every(value => value === 0.731), true);
    // This is a load-boundary test. Clear only its mock maps to avoid thousands
    // of irrelevant simulated unmute operations during fixture cleanup.
    f.plugin.ownedMutes.clear();
    f.plugin.pendingRestores.clear();
    f.plugin.volumeBeforeMute.clear();
    f.plugin.forcedZeroUsers.clear();
}, {audioRestores: Array.from({length: 4250}, (_, index) => ({userId: String(700000000000000000n + BigInt(index)), ownerAccountId: "111111111111111111", forcedZero: true, volume: 0.731}))});

test("existing pending restoration continues when account identity becomes unavailable", f => {
    f.start();
    f.plugin.manualMute(f.aliceId);
    f.plugin.pendingRestores.set(f.aliceId, 0);
    f.stores.UserStore.getCurrentUser = () => null;
    f.step();
    assert.equal(f.plugin.ownedMutes.has(f.aliceId), false);
    assert.equal(f.localMuteStates.get(f.aliceId), false);
});

test("Soft and Probe release timers continue without current account identity", f => {
    f.start();
    f.plugin.setUserPolicy(f.aliceId, "soft:1");
    const member = f.plugin.members.get(f.aliceId);
    f.setNow(5000);
    assert.equal(f.plugin.applyAutoMute(f.aliceId, member, "Synthetic Probe", 5000, true, {type: "rolling", score: 1}), true);
    f.stores.UserStore.getCurrentUser = () => null;
    f.setNow(6000);
    f.plugin.tick();
    assert.equal(f.plugin.ownedMutes.has(f.aliceId), false);
    assert.equal(member.softUnmuteAt, 0);
    assert.equal(f.localMuteStates.get(f.aliceId), false);
});

test("explicit recovery remains possible after a participant leaves", f => {
    f.start();
    f.plugin.manualMute(f.aliceId);
    f.voiceMembers.delete(f.aliceId);
    assert.equal(f.plugin.manualUnmute(f.aliceId), true);
    assert.equal(f.plugin.ownedMutes.has(f.aliceId), false);
});

test("a stale Probe action cannot escalate or auto-trust a departed participant", f => {
    f.start();
    f.plugin.setUserPolicy(f.aliceId, "soft:1");
    const member = f.plugin.members.get(f.aliceId);
    member.softStrikeCount = 2;
    member.softLastMutedAt = 5000;
    f.voiceMembers.delete(f.aliceId);
    f.setNow(10000);
    assert.equal(f.plugin.applyAutoMute(f.aliceId, member, "Stale Probe", 10000, true, {type: "rolling", score: 1}), false);
    assert.equal(member.softStrikeCount, 2);
    assert.equal(f.plugin.isTrusted(f.aliceId), false);
    assert.equal(f.plugin.policyValueFor(f.aliceId), "soft:1");
});

test("participant policy storage removes names without changing valid numeric Probe choices", f => {
    f.start();
    assert.equal(f.plugin.softVoicebanFor(f.aliceId).durationSeconds, 1);
    assert.equal(f.plugin.softVoicebanFor(f.aliceId).name, undefined);
    assert.equal(f.plugin.softVoicebanFor(f.aliceId).unknownPayload, undefined);
    assert.equal(f.plugin.trustedUsers[f.bobId].name, undefined);
    assert.equal(f.plugin.trustedUsers[f.bobId].unknownPayload, undefined);
}, {softVoicebans: {"222222222222222222": {durationSeconds: 1, name: "a".repeat(5000), unknownPayload: {huge: true}}}, trustedUsers: {"333333333333333333": {trustedAt: 1000, name: "b".repeat(5000), unknownPayload: {huge: true}}}});

function failReads(f, keys) {
    const failed = new Set(keys);
    const originalLoad = f.context.BdApi.Data.load;
    const originalSave = f.context.BdApi.Data.save;
    const reads = [], writes = [];
    f.context.BdApi.Data.load = (name, key) => {
        reads.push(key);
        if (failed.has(key)) throw new Error("Synthetic unreadable store");
        return originalLoad(name, key);
    };
    f.context.BdApi.Data.save = (name, key, value) => { writes.push(key); return originalSave(name, key, value); };
    return {failed, reads, writes};
}

for (const [key, load, save, field] of [
    ["settings", "loadSettings", "saveSettings", "settings"],
    ["trustedUsers", "loadTrustedUsers", "saveTrustedUsers", "trustedUsers"],
    ["softVoicebans", "loadSoftVoicebans", "saveSoftVoicebans", "softVoicebans"],
    ["offenses", "loadOffenses", "saveOffenses", "offenses"]
]) {
    test("failed " + key + " reads preserve prior memory and cannot authorize any store overwrite", f => {
        f.start();
        const priorMemory = f.plugin[field];
        const priorSaved = JSON.stringify(f.dataStore.get(key));
        const io = failReads(f, [key]);
        assert.equal(f.plugin[load](), false);
        assert.equal(f.plugin[field], priorMemory);
        f.plugin[save]();
        assert.equal(io.writes.filter(item => item === key).length, 0);
        assert.equal(JSON.stringify(f.dataStore.get(key)), priorSaved);
        assert.equal(f.plugin.manualMute(f.aliceId), false);
    });
}

test("unread trust blocks automatic and policy actions while retries remain bounded and visible", f => {
    const io = failReads(f, ["trustedUsers"]);
    f.start();
    f.setInbound({[f.aliceId]: {audioLevel: 1, audioDetected: true}});
    f.step(50);
    assert.equal(f.actionMuteCalls.some(call => call.muted), false);
    assert.equal(f.plugin.setTrusted(f.aliceId, true), false);
    assert.equal(f.plugin.setUserPolicy(f.aliceId, "soft:1"), false);
    assert.ok(f.plugin.panel.innerHTML.includes("Waiting for saved"));
    assert.ok(io.reads.filter(key => key === "trustedUsers").length <= 6);
    io.failed.clear();
    f.step(15);
    assert.equal(f.plugin.isTrusted(f.aliceId), true);
    assert.equal(f.actionMuteCalls.some(call => call.muted), false);
}, {trustedUsers: {"222222222222222222": {trustedAt: 1000, name: "Alice"}}});

test("failed settings reads reject preference edits while an explicit Auto pause survives recovery", f => {
    const io = failReads(f, ["settings"]);
    f.start();
    assert.equal(f.plugin.toggleAutoMute(), false);
    assert.equal(f.plugin.applyProtectionProfile("responsive"), false);
    assert.equal(f.plugin.updatePanelSetting("loudThreshold", 0.2), false);
    assert.equal(f.plugin.updateDisplaySetting("compactRows", true), false);
    assert.equal(io.writes.includes("settings"), false);
    io.failed.clear();
    f.step(15);
    assert.equal(f.plugin.settings.autoMute, false);
    assert.equal(f.plugin.settings.loudThreshold, 0.83);
    assert.equal(f.dataStore.get("settings").autoMute, false);
}, {settings: {detectorProfile: "rolling-v1", autoMute: true, loudThreshold: 0.83}});

test("a successful restore during an unreadable audio store is not resurrected on retry", f => {
    f.start();
    f.plugin.manualMute(f.aliceId);
    const io = failReads(f, ["audioRestores"]);
    assert.equal(f.plugin.loadAudioRestores(), false);
    f.plugin.pendingRestores.set(f.aliceId, 0);
    f.stores.UserStore.getCurrentUser = () => null;
    f.step();
    assert.equal(f.plugin.ownedMutes.has(f.aliceId), false);
    const completedCalls = f.actionMuteCalls.length;
    assert.equal(io.writes.includes("audioRestores"), false);
    io.failed.clear();
    f.step(15);
    assert.equal(f.actionMuteCalls.length, completedCalls, "Completed authority was replayed from stale persisted data");
    assert.equal(f.plugin.ownedMutes.has(f.aliceId), false);
    assert.equal(f.dataStore.get("audioRestores").length, 0);
});

test("an active Probe timer restores verified remote audio through simultaneous identity and storage failures", f => {
    f.start();
    f.plugin.setUserPolicy(f.aliceId, "soft:1");
    const member = f.plugin.members.get(f.aliceId);
    f.setNow(5000);
    assert.equal(f.plugin.applyAutoMute(f.aliceId, member, "Synthetic Probe", 5000, true, {type: "rolling", score: 1}), true);
    const io = failReads(f, ["softVoicebans"]);
    assert.equal(f.plugin.loadSoftVoicebans(), false);
    f.stores.UserStore.getCurrentUser = () => null;
    f.setNow(6000);
    f.plugin.tick();
    assert.equal(f.plugin.ownedMutes.has(f.aliceId), false);
    assert.equal(f.localMuteStates.get(f.aliceId), false);
    assert.equal(io.writes.includes("softVoicebans"), false);
});

test("unverified saved self authority waits then quarantines without changing self audio or exact metadata", f => {
    const knownIdentity = f.stores.UserStore.getCurrentUser;
    f.stores.UserStore.getCurrentUser = () => null;
    f.localMuteStates.set(f.selfId, true);
    f.localVolumes.set(f.selfId, 0);
    f.start();
    f.step(15);
    assert.equal(f.actionMuteCalls.length, 0);
    assert.equal(f.actionVolumeCalls.length, 0);
    f.stores.UserStore.getCurrentUser = knownIdentity;
    f.step(15);
    assert.equal(f.actionMuteCalls.filter(call => call.userId === f.selfId).length, 0);
    assert.equal(f.actionVolumeCalls.filter(call => call.userId === f.selfId).length, 0);
    assert.equal(f.localVolumes.get(f.selfId), 0);
    assert.equal(f.plugin.ownedMutes.has(f.selfId), false);
    const record = f.dataStore.get("audioRestores").find(item => item.userId === f.selfId);
    assert.equal(record.volume, 0.731);
    assert.equal(record.forcedZero, true);
    assert.equal(f.plugin.unmuteLocally(f.selfId).ok, false);
}, {audioRestores: [{userId: "111111111111111111", forcedZero: true, volume: 0.731}]});

console.log(JSON.stringify({suite: "VoiceGuard isolated hardening boundaries", checks, failures, liveChanges: 0, networkCalls: 0}));
process.exitCode = failures ? 1 : 0;
