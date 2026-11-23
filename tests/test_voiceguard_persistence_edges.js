"use strict";

// Isolated persistence/action contract tests. This fixture never opens Discord,
// reads user configuration, writes plugin data to disk, or permits network I/O.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const sourcePath = process.argv[2] || path.join(__dirname, "..", "VoiceGuard.plugin.js");
const fixturePrefix = fs.readFileSync(path.join(__dirname, "test_voiceguard_plugin.js"), "utf8").split("function main() {")[0];
const sourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
let checks = 0;
let failures = 0;

function fixture(options = {}) {
    const sandbox = {require, __dirname, console, URL, options, process: {argv: [process.argv[0], __filename, sourcePath]}};
    vm.runInNewContext(fixturePrefix + `
        dataStore.clear();
        dataStore.set("settings", {detectorProfile: "rolling-v1", autoMute: true, loudThreshold: 0.77, establishedLoudSeconds: 3});
        dataStore.set("trustedUsers", {[aliceId]: {trustedAt: 1000, name: "Alice"}});
        dataStore.set("offenses", {[bobId]: {count: 2, quickLeaves: 0, lastOffenseAt: 1000, lastReason: "Synthetic history", rememberedMute: false, detectorVersion: "rolling-v1"}});
        dataStore.set("softVoicebans", {[charlieId]: {durationSeconds: 1, enabledAt: 1000, name: "Charlie"}});
        dataStore.set("audioRestores", []);
        for (const [key, value] of Object.entries(options.saved || {})) dataStore.set(key, value);
        const failedKeys = new Set(options.fail || []);
        const reads = [], writes = [], timeouts = new Map();
        let timeoutSerial = 0;
        context.URL = URL;
        context.setTimeout = (fn, delay = 0) => {
            const id = ++timeoutSerial;
            timeouts.set(id, {fn, due: nowMs + Math.max(0, Number(delay) || 0)});
            return id;
        };
        context.clearTimeout = id => timeouts.delete(id);
        context.BdApi.Data.load = (_name, key) => {
            const failed = failedKeys.has(key);
            reads.push({key, at: nowMs, failed});
            if (failed) throw new Error("Synthetic transient storage read failure");
            return dataStore.get(key) || null;
        };
        context.BdApi.Data.save = (_name, key, value) => {
            const clean = JSON.parse(JSON.stringify(value));
            writes.push({key, at: nowMs, value: clean});
            dataStore.set(key, clean);
        };
        if (options.identity === "missing") stores.UserStore.getCurrentUser = () => null;
        if (options.identity === "throwing") stores.UserStore.getCurrentUser = () => {throw new Error("Synthetic account store failure");};
        vm.createContext(context);
        vm.runInContext(code, context, {filename: pluginPath});
        const Plugin = context.module.exports;
        let plugin = new Plugin({name: "VoiceGuard"});
        const runDue = () => {
            let rounds = 0;
            while (true) {
                const due = [...timeouts].filter(([, timer]) => timer.due <= nowMs).sort((a, b) => a[1].due - b[1].due);
                if (!due.length) break;
                if (++rounds > 1000) throw new Error("Unbounded synthetic timer loop");
                for (const [id, timer] of due) {
                    if (!timeouts.delete(id)) continue;
                    timer.fn();
                }
            }
        };
        globalThis.result = {
            get plugin() {return plugin;}, stores, dataStore, reads, writes, localMuteStates, localVolumes,
            actionMuteCalls, actionVolumeCalls, nativeVolumeCalls, muteCalls, voiceMembers,
            aliceId, bobId, charlieId, selfId, channelId,
            block: key => failedKeys.add(key), unblock: key => failedKeys.delete(key),
            start: () => plugin.start(),
            stop: () => plugin.stop(),
            replace: () => {plugin = new Plugin({name: "VoiceGuard"});},
            identity: mode => {stores.UserStore.getCurrentUser = mode === "missing" ? () => null : mode === "throwing" ? () => {throw new Error("Synthetic account store failure");} : () => ({id: selfId});},
            setInbound,
            setNow: value => {nowMs = value;},
            now: () => nowMs,
            advance: (duration, quantum = 80) => {
                const end = nowMs + duration;
                while (nowMs < end) {
                    nowMs = Math.min(end, nowMs + quantum);
                    runDue();
                    plugin.tick();
                    runDue();
                }
            },
            resources: () => ({fetchCalls, intervals: intervals.size, listeners: listeners.size, timeouts: timeouts.size})
        };
    `, sandbox);
    return sandbox.result;
}

function test(name, run, options) {
    checks++;
    const f = fixture(options);
    try {
        run(f);
        console.log("PASS " + name);
    } catch (error) {
        failures++;
        console.error("FAIL " + name + ": " + error.message);
    } finally {
        try {
            f.stop();
            assert.equal(f.resources().fetchCalls, 0, "fixture attempted network access");
            assert.equal(f.resources().intervals, 0, "stop left a sampling interval");
            assert.equal(f.resources().listeners, 0, "stop left a store listener");
            assert.equal(f.resources().timeouts, 0, "stop left a retry/discovery timer");
        } catch (error) {
            failures++;
            console.error("FAIL cleanup " + name + ": " + error.message);
        }
    }
}

const loaders = [
    ["settings", "loadSettings"], ["trustedUsers", "loadTrustedUsers"],
    ["offenses", "loadOffenses"], ["softVoicebans", "loadSoftVoicebans"],
    ["audioRestores", "loadAudioRestores"]
];

function memory(f, key) {
    if (key !== "audioRestores") return clone(f.plugin[key === "settings" ? "settings" : key]);
    return clone({
        owners: [...f.plugin.ownedMutes].map(([id, target]) => [id, target?.context]),
        volumes: [...f.plugin.volumeBeforeMute], forced: [...f.plugin.forcedZeroUsers], pending: [...f.plugin.pendingRestores]
    });
}

for (const [key, method] of loaders) {
    test(key + " failed startup read cannot overwrite its original saved records, including on stop", f => {
        const original = clone(f.dataStore.get(key));
        f.start();
        f.advance(2400);
        f.stop();
        assert.deepEqual(clone(f.dataStore.get(key)), original, "saved " + key + " changed while unreadable");
        assert.equal(f.writes.filter(write => write.key === key).length, 0, "unreadable " + key + " was persisted");
    }, {fail: [key], saved: key === "audioRestores" ? {audioRestores: [{userId: "222222222222222222", ownerAccountId: "111111111111111111", context: "default", forcedZero: true, volume: 0.731}]} : {}});

    test(key + " failed reload preserves established in-memory state and makes no save", f => {
        f.plugin[method]();
        const before = memory(f, key);
        const saved = clone(f.dataStore.get(key));
        const writes = f.writes.filter(write => write.key === key).length;
        f.block(key);
        f.plugin[method]();
        assert.deepEqual(memory(f, key), before, "prior in-memory " + key + " was replaced");
        assert.deepEqual(clone(f.dataStore.get(key)), saved);
        assert.equal(f.writes.filter(write => write.key === key).length, writes);
    }, {saved: key === "audioRestores" ? {audioRestores: [{userId: "222222222222222222", ownerAccountId: "111111111111111111", context: "default", forcedZero: true, volume: 0.731}]} : {}});
}

function loud(f, ...ids) {
    f.setInbound(Object.fromEntries(ids.map(id => [id, [{audioLevel: 0.82, audioDetected: true}]])));
}

function autoMutesFor(f, userId) {
    return f.actionMuteCalls.filter(call => call.userId === userId && call.muted);
}

function waitForSuccessfulRead(f, key, maximum = 20000) {
    const initial = f.reads.filter(read => read.key === key && !read.failed).length;
    const end = f.now() + maximum;
    while (f.now() < end && f.reads.filter(read => read.key === key && !read.failed).length === initial) f.advance(80);
    assert.ok(f.reads.filter(read => read.key === key && !read.failed).length > initial, "no automatic recovery read within " + maximum + "ms");
}

test("unknown startup trust blocks new automatic mutes without rewriting saved trust", f => {
    const original = clone(f.dataStore.get("trustedUsers"));
    f.start();
    loud(f, f.aliceId, f.bobId);
    f.advance(10000);
    assert.equal(f.actionMuteCalls.filter(call => call.muted).length, 0, "automatic mute occurred before trust could be read");
    assert.equal(f.plugin.ownedMutes.size, 0);
    assert.deepEqual(clone(f.dataStore.get("trustedUsers")), original);
}, {fail: ["trustedUsers"]});

test("unknown trust preserves an existing manual mute while blocking other new automatic decisions", f => {
    f.start();
    assert.equal(f.plugin.manualMute(f.aliceId), true);
    f.block("trustedUsers");
    f.plugin.loadTrustedUsers();
    loud(f, f.bobId);
    f.advance(10000);
    assert.equal(f.plugin.ownedMutes.has(f.aliceId), true);
    assert.equal(f.localMuteStates.get(f.aliceId), true);
    assert.ok(f.plugin.members.get(f.aliceId).manualMutedAt);
    assert.equal(autoMutesFor(f, f.bobId).length, 0);
});

test("unknown trust permits an established Soft release timer without new automatic mutes", f => {
    f.start();
    f.plugin.setUserPolicy(f.aliceId, "soft:10");
    f.setNow(5000);
    const member = f.plugin.members.get(f.aliceId);
    assert.equal(f.plugin.applyAutoMute(f.aliceId, member, "Synthetic Soft", f.now(), true, {type: "rolling", score: 1}), true);
    f.block("trustedUsers");
    f.plugin.loadTrustedUsers();
    loud(f, f.bobId);
    f.advance(10500);
    assert.equal(f.plugin.ownedMutes.has(f.aliceId), false);
    assert.equal(f.localMuteStates.get(f.aliceId), false);
    assert.equal(member.softUnmuteAt, 0);
    assert.equal(autoMutesFor(f, f.bobId).length, 0);
});

test("unknown trust permits established pending audio recovery", f => {
    f.start();
    f.plugin.manualMute(f.aliceId);
    f.plugin.pendingRestores.set(f.aliceId, 0);
    f.block("trustedUsers");
    f.plugin.loadTrustedUsers();
    f.advance(80);
    assert.equal(f.plugin.ownedMutes.has(f.aliceId), false);
    assert.equal(f.localMuteStates.get(f.aliceId), false);
});

test("failed persistence reads retry automatically with bounded cadence", f => {
    f.start();
    f.advance(2400);
    const attempts = f.reads.filter(read => read.key === "trustedUsers").length;
    assert.ok(attempts >= 1 && attempts <= 6, "failed read was retried excessively: " + attempts);
    f.unblock("trustedUsers");
    waitForSuccessfulRead(f, "trustedUsers");
    assert.equal(f.plugin.isTrusted(f.aliceId), true);
}, {fail: ["trustedUsers"]});

test("trust read recovery restores valid choices and starts fresh evidence instead of accruing unknown time", f => {
    f.start();
    loud(f, f.aliceId, f.bobId);
    f.advance(10000);
    assert.equal(autoMutesFor(f, f.bobId).length, 0);
    f.unblock("trustedUsers");
    waitForSuccessfulRead(f, "trustedUsers");
    assert.equal(f.plugin.isTrusted(f.aliceId), true);
    assert.equal(autoMutesFor(f, f.bobId).length, 0, "pre-recovery evidence caused an immediate mute");
    f.advance(1500);
    assert.equal(autoMutesFor(f, f.bobId).length, 0, "detector reused evidence from unreadable trust time");
    f.advance(5000);
    assert.ok(autoMutesFor(f, f.bobId).length > 0, "fresh sustained evidence never resumed protection");
    assert.equal(autoMutesFor(f, f.aliceId).length, 0, "recovered trusted person was muted");
}, {fail: ["trustedUsers"]});

test("explicit Auto pause survives settings read recovery without replacing unread saved tuning", f => {
    const initial = clone(f.dataStore.get("settings"));
    f.start();
    assert.equal(f.plugin.settings.autoMute, true, "fixture expects the normal enabled default before user pause");
    assert.equal(f.plugin.toggleAutoMute(), false);
    assert.deepEqual(clone(f.dataStore.get("settings")), initial, "pausing overwrote settings that had not been read");
    f.unblock("settings");
    waitForSuccessfulRead(f, "settings");
    f.advance(2400);
    assert.equal(f.plugin.settings.autoMute, false, "settings retry re-enabled Auto against the explicit pause");
    assert.equal(f.plugin.settings.loudThreshold, initial.loudThreshold, "valid saved tuning did not recover");
    assert.equal(f.dataStore.get("settings").autoMute, false, "pause did not persist after successful recovery");
}, {fail: ["settings"]});

for (const identity of ["missing", "throwing"]) {
    test("persisted authority loaded with " + identity + " identity cannot act on self after identity resolves", f => {
        f.localMuteStates.set(f.selfId, true);
        f.localVolumes.set(f.selfId, 0);
        f.start();
        f.advance(2400);
        assert.equal(f.actionMuteCalls.filter(call => call.userId === f.selfId).length, 0);
        assert.equal(f.actionVolumeCalls.filter(call => call.userId === f.selfId).length, 0);
        f.identity("known");
        f.advance(2400);
        assert.equal(f.actionMuteCalls.filter(call => call.userId === f.selfId).length, 0, "resolved self was unmuted by saved authority");
        assert.equal(f.actionVolumeCalls.filter(call => call.userId === f.selfId).length, 0, "resolved self volume was changed by saved authority");
        assert.equal(f.localMuteStates.get(f.selfId), true);
        assert.equal(f.localVolumes.get(f.selfId), 0);
    }, {identity, saved: {audioRestores: [{userId: "111111111111111111", ownerAccountId: "111111111111111111", context: "default", forcedZero: true, volume: 0.731}]}});
}

test("established remote recovery still works through later identity loss", f => {
    f.start();
    f.plugin.manualMute(f.aliceId);
    f.plugin.pendingRestores.set(f.aliceId, 0);
    f.identity("missing");
    f.advance(80);
    assert.equal(f.localMuteStates.get(f.aliceId), false);
    assert.equal(f.plugin.ownedMutes.has(f.aliceId), false);
    assert.equal(f.actionMuteCalls.filter(call => call.userId === f.selfId).length, 0);
});

test("stop and reload preserve unverified valid remote recovery until identity is available", f => {
    f.localMuteStates.set(f.aliceId, true);
    f.localVolumes.set(f.aliceId, 0);
    f.start();
    f.advance(1600);
    assert.equal(f.actionMuteCalls.length, 0, "unverified authority acted before identity resolved");
    f.stop();
    assert.equal(f.actionMuteCalls.length, 0, "stop acted on unverified authority");
    const pending = clone(f.dataStore.get("audioRestores"));
    assert.equal(pending.length, 1);
    assert.equal(pending[0].userId, f.aliceId);
    assert.equal(pending[0].forcedZero, true);
    assert.equal(pending[0].volume, 0.731);
    f.replace();
    f.start();
    f.advance(800);
    assert.equal(f.actionMuteCalls.length, 0);
    f.identity("known");
    f.advance(5000);
    assert.equal(f.localMuteStates.get(f.aliceId), false);
    assert.equal(f.localVolumes.get(f.aliceId), 0.731, "exact saved volume was not restored");
    assert.equal(f.dataStore.get("audioRestores").length, 0);
}, {identity: "missing", saved: {audioRestores: [{userId: "222222222222222222", ownerAccountId: "111111111111111111", context: "default", forcedZero: true, volume: 0.731}]}});

console.log(JSON.stringify({suite: "VoiceGuard isolated persistence and delayed-identity recovery", sourceSha256, checks, failures, liveChanges: 0, networkCalls: 0}));
process.exitCode = failures ? 1 : 0;
