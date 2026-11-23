"use strict";

// Defense checks against fake Discord accounts, local stores, and audio actions.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const sourcePath = path.resolve(process.argv[2] || path.join(__dirname, "..", "VoiceGuard.plugin.js"));
const source = fs.readFileSync(sourcePath);
const fixtureSource = fs.readFileSync(path.join(__dirname, "test_voiceguard_plugin.js"), "utf8").split("function main() {")[0];
const otherAccount = "888888888888888888";
const plain = value => JSON.parse(JSON.stringify(value));
let checks = 0;
let failures = 0;

function fixture() {
    const sandbox = { require, __dirname, console, URL, process: { argv: [process.execPath, __filename, sourcePath] } };
    vm.runInNewContext(fixtureSource + `
        dataStore.clear();
        context.URL = URL;
        vm.createContext(context);
        vm.runInContext(code, context, { filename: pluginPath });
        const plugin = new context.module.exports({ name: "VoiceGuard" });
        globalThis.fixture = {
            plugin, context, stores, localMuteStates, localVolumes, dataStore, connection,
            selfId, aliceId, bobId, toasts,
            identity: id => { stores.UserStore.getCurrentUser = () => id ? { id } : null; },
            step: (count = 1, ms = 80) => step(plugin, count, ms),
            muteCounts: () => [actionMuteCalls.length, muteCalls.length, actionVolumeCalls.length, nativeVolumeCalls.length],
            resources: () => ({ fetchCalls, intervals: intervals.size, listeners: listeners.size })
        };
    `, sandbox);
    return sandbox.fixture;
}

function test(name, run) {
    checks++;
    const f = fixture();
    try {
        run(f);
        console.log("PASS " + name);
    } catch (error) {
        failures++;
        console.error("FAIL " + name + ": " + error.message);
    } finally {
        f.plugin.stop();
        const { fetchCalls, intervals, listeners } = f.resources();
        assert.deepEqual([fetchCalls, intervals, listeners], [0, 0, 0]);
    }
}

function journal(f, accountId = f.selfId, userId = f.aliceId) {
    return { userId, ownerAccountId: accountId, context: "default", forcedZero: true, volume: 0.731 };
}

function protect(f, soft = false) {
    if (soft) assert.equal(f.plugin.setUserPolicy(f.aliceId, "soft:1"), true);
    f.step(1, 4000);
    const member = f.plugin.members.get(f.aliceId);
    assert.equal(f.plugin.applyAutoMute(f.aliceId, member, "Synthetic loud signal", 5200, true, { type: "rolling", score: 1 }), true);
}

test("the running plugin exposes no window debug or mute interface", f => {
    f.plugin.start();
    assert.equal(f.context.window.voiceGuardV2Debug, undefined);
    assert.equal(Object.keys(f.context.window).length, 0);
});

test("start and stop leave an existing global alone", f => {
    const sentinel = {};
    f.context.window.voiceGuardV2Debug = sentinel;
    f.plugin.start();
    assert.equal(f.context.window.voiceGuardV2Debug, sentinel);
    f.plugin.stop();
    assert.equal(f.context.window.voiceGuardV2Debug, sentinel);
});

test("fresh installs protect without writing participant history", f => {
    f.plugin.start();
    protect(f);
    assert.equal(f.localMuteStates.get(f.aliceId), true);
    assert.equal(f.plugin.settings.rememberOffenders, false);
    assert.equal(Object.keys(f.dataStore.get("offenses")).length, 0);
    assert.equal(f.dataStore.get("audioRestores")[0].ownerAccountId, f.selfId);
});

test("an existing enabled history choice remains effective", f => {
    f.dataStore.set("settings", { detectorProfile: "rolling-v1", rememberOffenders: true });
    f.plugin.start();
    protect(f);
    assert.equal(f.dataStore.get("offenses")[f.aliceId].count, 1);
});

test("saved participant policies retain identifiers and choices without names", f => {
    f.dataStore.set("trustedUsers", { [f.bobId]: { trustedAt: 100, name: "Fixture Bob" } });
    f.dataStore.set("softVoicebans", { [f.aliceId]: { durationSeconds: 1, enabledAt: 100, name: "Fixture Alice" } });
    f.plugin.start();
    assert.equal(f.plugin.isTrusted(f.bobId), true);
    assert.equal(f.plugin.policyValueFor(f.aliceId), "soft:1");
    assert.equal(f.dataStore.get("trustedUsers")[f.bobId].name, undefined);
    assert.equal(f.dataStore.get("softVoicebans")[f.aliceId].name, undefined);
    f.plugin.setUserPolicy(f.aliceId, "soft:20");
    assert.equal(f.dataStore.get("softVoicebans")[f.aliceId].name, undefined);
});

test("initials work without avatar lookup, which requires local opt-in", f => {
    let avatarLookups = 0;
    const url = "https://cdn.discordapp.com/avatars/" + f.aliceId + "/fixture.webp?size=64";
    const getUser = f.stores.UserStore.getUser;
    f.stores.UserStore.getUser = id => ({ ...getUser(id), getAvatarURL: () => { avatarLookups++; return url + "&extra=fixture#fragment"; } });
    f.plugin.start();
    f.plugin.selectParticipant(f.aliceId);
    f.plugin.detailsOpen = true;
    f.plugin.renderPanel(true);
    assert.equal(avatarLookups, 0);
    assert.match(f.plugin.panel.innerHTML, /class="vg3-avatar"/);
    assert.doesNotMatch(f.plugin.panel.innerHTML, /<img /);
    f.plugin.settings.loadProfileImages = true;
    f.plugin.saveSettings();
    f.plugin.renderPanel(true);
    assert.ok(avatarLookups > 0);
    assert.ok(f.plugin.panel.innerHTML.includes('src="' + url + '"'));
    assert.match(f.plugin.panel.innerHTML, /referrerpolicy="no-referrer"/);
    assert.doesNotMatch(f.plugin.panel.innerHTML, /extra=|#fragment/);
});

test("portable preferences cannot grant avatar network consent", f => {
    f.plugin.start();
    const request = JSON.stringify({ format: "voiceguard-preferences", version: 1, preferences: { loadProfileImages: true } });
    assert.equal(f.plugin.importPreferencePreset(request).ok, false);
    assert.equal(f.plugin.settings.loadProfileImages, false);
    assert.equal(Object.hasOwn(JSON.parse(f.plugin.exportPreferencePreset()).preferences, "loadProfileImages"), false);
});

test("foreign and legacy recovery records stay inert and retain original volume", f => {
    const foreign = journal(f, otherAccount);
    const legacy = journal(f, f.selfId, f.bobId);
    delete legacy.ownerAccountId;
    f.dataStore.set("audioRestores", [foreign, legacy]);
    f.localMuteStates.set(f.aliceId, true);
    f.localMuteStates.set(f.bobId, true);
    f.localVolumes.set(f.aliceId, 0);
    f.localVolumes.set(f.bobId, 0);
    f.plugin.start();
    f.step(5);
    assert.deepEqual(plain(f.muteCounts()), [0, 0, 0, 0]);
    assert.equal(f.plugin.ownedMutes.size, 0);
    assert.deepEqual(plain(f.dataStore.get("audioRestores")), [foreign, legacy]);
});

test("cold startup defers recovery until the matching account is confirmed", f => {
    const pending = journal(f);
    f.dataStore.set("audioRestores", [pending]);
    f.localMuteStates.set(f.aliceId, true);
    f.localVolumes.set(f.aliceId, 0);
    f.identity(null);
    f.plugin.start();
    f.step(2);
    assert.deepEqual(plain(f.muteCounts()), [0, 0, 0, 0]);
    assert.deepEqual(plain(f.dataStore.get("audioRestores")), [pending]);
    f.identity(f.selfId);
    f.step(1);
    assert.equal(f.localMuteStates.get(f.aliceId), false);
    assert.equal(f.localVolumes.get(f.aliceId), pending.volume);
    assert.equal(f.dataStore.get("audioRestores").length, 0);
});

test("an account change pauses a due Probe release and new audio actions", f => {
    f.plugin.start();
    protect(f, true);
    const before = f.muteCounts();
    f.identity(otherAccount);
    f.step(1, 2000);
    assert.deepEqual(f.muteCounts(), before);
    assert.equal(f.plugin.manualUnmute(f.aliceId), false);
    assert.equal(f.plugin.manualMute(f.bobId), false);
    assert.equal(f.plugin.setUserPolicy(f.bobId, "soft:10"), false);
    assert.equal(f.plugin.setTrusted(f.bobId), false);
    assert.match(f.plugin.panel.innerHTML, /Discord account changed/);
    assert.doesNotMatch(f.plugin.panel.innerHTML, /data-vg-action="select-participant"/);
    f.identity(null);
    f.step(1, 3000);
    assert.deepEqual(f.muteCounts(), before);
    f.identity(f.selfId);
    f.step(1);
    assert.equal(f.localMuteStates.get(f.aliceId), false);
    assert.equal(f.dataStore.get("audioRestores").length, 0);
});

test("stop after account switch saves the original journal for its owner", f => {
    f.plugin.start();
    assert.equal(f.plugin.manualMute(f.aliceId), true);
    const before = f.muteCounts();
    f.identity(otherAccount);
    f.plugin.stop();
    assert.deepEqual(f.muteCounts(), before);
    f.plugin.start();
    assert.deepEqual(f.muteCounts(), before);
    assert.equal(f.dataStore.get("audioRestores")[0].ownerAccountId, f.selfId);
    f.plugin.stop();
    f.identity(f.selfId);
    f.plugin.start();
    assert.equal(f.localMuteStates.get(f.aliceId), false);
    assert.equal(f.dataStore.get("audioRestores").length, 0);
});

test("recovering a participant preserves a second account's journal for the same person", f => {
    const foreign = { ...journal(f, otherAccount), volume: 0.492 };
    const own = journal(f);
    f.dataStore.set("audioRestores", [foreign, own]);
    f.localMuteStates.set(f.aliceId, true);
    f.localVolumes.set(f.aliceId, 0);
    f.plugin.start();
    assert.equal(f.localVolumes.get(f.aliceId), own.volume);
    assert.deepEqual(plain(f.dataStore.get("audioRestores")), [foreign]);
});

console.log(JSON.stringify({ suite: "VoiceGuard public user security", sha256: crypto.createHash("sha256").update(source).digest("hex"), checks, failures, liveChanges: 0, networkCalls: 0 }));
process.exitCode = failures ? 1 : 0;
