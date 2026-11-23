"use strict";

// Background-only stress tests. All Discord stores, audio state, DOM, timers,
// persistence, and network access are confined to the existing VM fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");

const sourcePath = path.join(__dirname, "..", "VoiceGuard.plugin.js");
const fixturePrefix = fs.readFileSync(path.join(__dirname, "test_voiceguard_plugin.js"), "utf8").split("function main() {")[0];
const defaultSeeds = [0x1badb002, 0xc0ffee, 0x5eed1234, 0x31415926, 0x9e3779b9, 0x12345678, 0xdecafbad, 0x51a7e123, 0xa11ce001, 0xb0b00002, 0x600df00d, 0x20261110, 0x76543210, 0xf00d1234, 0xabcdef01, 0x13579bdf];
const seedOption = process.argv.find(value => value.startsWith("--seeds="));
const stepOption = process.argv.find(value => value.startsWith("--steps="));
const seedOnly = process.argv.includes("--seed-only");
const seeds = seedOption ? seedOption.slice(8).split(",").map(value => Number(value) >>> 0) : defaultSeeds;
const randomSteps = stepOption ? Number(stepOption.slice(8)) : 8000;
if (!seeds.length || seeds.some(seed => seed === 0) || !Number.isInteger(randomSteps) || randomSteps < 1 || randomSteps > 100000) throw new Error("Use nonzero numeric seeds and 1-100000 steps.");

let backgroundPriorityApplied = false;
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); backgroundPriorityApplied = true; } catch (_) {}

const stats = { assertions: 0, explicitTicks: 0, simulatedTickElapsedMs: 0, lifecycleCycles: 0, fixtures: 0, networkCalls: 0, groupsPassed: 0, failures: [] };
function check(condition, message, details) {
    stats.assertions++;
    assert.ok(condition, message + (details ? " " + JSON.stringify(details) : ""));
}
function equal(actual, expected, message) { stats.assertions++; assert.equal(actual, expected, message); }
function rng(seed) {
    let state = seed >>> 0;
    return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
}

function fresh() {
    stats.fixtures++;
    // A controlled argv prevents stress-test flags from becoming plugin paths.
    const sandbox = { require, __dirname, process: { argv: [process.argv[0], __filename, sourcePath] }, console };
    vm.runInNewContext(fixturePrefix + `
        let activeChannel = channelId;
        let membershipUnavailable = false;
        stores.SelectedChannelStore.getVoiceChannelId = () => activeChannel;
        stores.VoiceStateStore.getCurrentClientVoiceChannelId = () => activeChannel;
        stores.VoiceStateStore.getUserVoiceChannelId = () => activeChannel;
        stores.RTCConnectionStore.getChannelId = () => activeChannel;
        stores.VoiceStateStore.getVoiceStatesForChannel = () => {
            if (membershipUnavailable) throw new Error("Synthetic membership refresh");
            return new Map(Array.from(voiceMembers, id => [id, {userId: id}]));
        };
        vm.createContext(context);
        vm.runInContext(code, context, {filename: pluginPath});
        const Plugin = context.module.exports;
        const plugin = new Plugin({name: "VoiceGuard"});
        plugin.start();
        globalThis.fixture = {
            plugin, Plugin, connection, decoyConnection, mediaEngine, mediaActions, stores,
            voiceMembers, localVolumes, localMuteStates, actionMuteCalls, actionVolumeCalls,
            nativeVolumeCalls, dataStore, selfId, aliceId, bobId, charlieId, daveId,
            ids: [aliceId, bobId, charlieId, daveId], channelId,
            step: (count = 1, ms = 80) => step(plugin, count, ms),
            now: () => nowMs,
            setNow: value => { nowMs = value; },
            setInbound,
            setChannel: value => { activeChannel = value; },
            getChannel: () => activeChannel,
            setMembershipUnavailable: value => { membershipUnavailable = value; },
            membershipUnavailable: () => membershipUnavailable,
            setActionAppliesMute: value => { actionAppliesMute = value; },
            resources: () => ({intervals: intervals.size, listeners: listeners.size, styles: addedStyles.size, panel: !!elements.get("vg-rtp-panel")}),
            networkCalls: () => fetchCalls
        };
    `, sandbox);
    const f = sandbox.fixture;
    const originalStep = f.step;
    f.step = (count = 1, ms = 80) => {
        stats.explicitTicks += count;
        stats.simulatedTickElapsedMs += count * ms;
        originalStep(count, ms);
    };
    return f;
}

function invariants(f) {
    const p = f.plugin;
    check(p.activity.length <= 60, "Activity grew beyond its session bound");
    check(p.members.size <= f.ids.length, "Participant state leaked beyond known fixture people");
    check(p.signals.size <= f.ids.length, "Signal state leaked beyond known fixture people");
    check(p.ownedMutes.size <= f.ids.length, "Mute ownership leaked beyond fixture people");
    for (const id of p.pendingRestores.keys()) check(p.ownedMutes.has(id), "Pending restore lost its mute owner");
    for (const id of p.forcedZeroUsers) {
        check(p.ownedMutes.has(id), "Forced-zero state lost its mute owner");
        check(Number.isFinite(p.volumeBeforeMute.get(id)), "Forced-zero state lost the exact prior volume");
    }
    for (const signal of p.signals.values()) {
        for (const key of ["raw", "level", "peak"]) check(Number.isFinite(signal[key]) && signal[key] >= 0 && signal[key] <= 1, "Invalid signal value", {key, value: signal[key]});
        check(Number.isFinite(signal.blast.score) && signal.blast.score >= 0 && signal.blast.score <= 1, "Invalid detector score");
        check(signal.blast.durationMs <= p.settings.analysisWindowSeconds * 1000 + 0.001, "Evidence duration escaped its rolling window");
    }
    for (const samples of p.blastWindows.values()) check(samples.length <= Math.ceil(p.settings.analysisWindowSeconds * 1000 / 10) + 2, "Evidence sample storage grew beyond a bounded 10ms-tick window");
    equal(f.networkCalls(), 0, "Plugin attempted network access");
}

function cleanup(f) {
    f.setMembershipUnavailable(false);
    f.connection.connectionState = "CONNECTED";
    f.plugin.stop();
    const resources = f.resources();
    equal(resources.intervals, 0, "Plugin left a sampling interval after stop");
    equal(resources.listeners, 0, "Plugin left store listeners after stop");
    equal(resources.styles, 0, "Plugin left a style registration after stop");
    equal(resources.panel, false, "Plugin left a panel after stop");
    stats.networkCalls += f.networkCalls();
}

function run(name, test, details = {}) {
    if (seedOnly && details.seed === undefined) return;
    let f;
    try {
        f = fresh();
        test(f);
        stats.groupsPassed++;
        console.log("PASS " + name);
    } catch (error) {
        stats.failures.push({name, ...details, message: error.message, stack: error.stack.split("\n").slice(0, 5)});
        console.error("FAIL " + name + ": " + error.message);
    } finally {
        if (f) {
            try { cleanup(f); }
            catch (error) { stats.failures.push({name: name + " / cleanup", message: error.message}); }
        }
    }
}

run("1000 repeated start/stop cycles release owned audio and remove every fixture resource", f => {
    f.plugin.settings.autoMute = false;
    for (let cycle = 0; cycle < 1000; cycle++) {
        if (cycle) f.plugin.start();
        stats.lifecycleCycles++;
        const resources = f.resources();
        equal(resources.intervals, 1, "Start duplicated the sampling interval");
        equal(resources.listeners, 4, "Start duplicated or omitted store listeners");
        equal(resources.styles, 1, "Start duplicated style registration");
        const volume = (cycle % 101 + 1) / 100;
        f.localVolumes.set(f.aliceId, volume);
        f.setActionAppliesMute(cycle % 2 === 0);
        equal(f.plugin.manualMute(f.aliceId), true, "Fixture manual mute failed");
        f.step(2);
        f.plugin.stop();
        equal(f.plugin.ownedMutes.size, 0, "Stop did not release owned mutes");
        equal(f.localVolumes.get(f.aliceId), volume, "Stop changed the original volume");
        equal(f.localMuteStates.get(f.aliceId) === true, false, "Stop left a local mute behind");
        equal(f.resources().intervals, 0, "Repeated stop left an interval");
        equal(f.resources().listeners, 0, "Repeated stop left listeners");
        equal(f.resources().styles, 0, "Repeated stop left styles");
    }
});

run("20000 quiet/speech-peak ticks never manufacture a blast decision", f => {
    for (let tick = 0; tick < 20000; tick++) {
        const level = tick % 25 === 0 ? 0.98 : tick % 7 === 0 ? 0.42 : 0.04;
        f.setInbound({[f.aliceId]: [{audioLevel: level, audioDetected: level > 0.1}], [f.bobId]: [{audioLevel: 0, audioDetected: false}]});
        f.step();
        if (tick % 25 === 0) invariants(f);
    }
    equal(f.actionMuteCalls.filter(call => call.muted).length, 0, "Ordinary separated speech peaks caused automatic muting");
});

run("20000 continuous-loud ticks yield one owned mute without repeated enforcement", f => {
    f.setInbound({[f.aliceId]: [{audioLevel: 0.90, audioDetected: true}]});
    f.step(20000);
    equal(f.actionMuteCalls.filter(call => call.userId === f.aliceId && call.muted).length, 1, "Continuous audio repeatedly applied an existing mute");
    check(f.plugin.members.get(f.aliceId).autoMutedAt > 0, "Continuous sustained audio never muted");
    check(f.plugin.ownedMutes.has(f.aliceId), "Automatic mute has no owned restoration state");
    invariants(f);
});

run("20000 Auto-off and trusted-loud ticks never issue an automatic mute", f => {
    f.plugin.toggleAutoMute();
    f.setInbound({[f.aliceId]: [{audioLevel: 1, audioDetected: true}], [f.bobId]: [{audioLevel: 0.97, audioDetected: true}]});
    f.step(10000);
    equal(f.actionMuteCalls.filter(call => call.muted).length, 0, "Auto off issued an automatic mute");
    f.plugin.setTrusted(f.aliceId, true);
    f.plugin.setTrusted(f.bobId, true);
    f.plugin.toggleAutoMute();
    f.step(10000);
    equal(f.actionMuteCalls.filter(call => call.muted).length, 0, "Trusted loud participants were automatically muted");
    invariants(f);
});

run("400 fallback restores preserve exact volumes and newer user volume choices", f => {
    f.plugin.settings.autoMute = false;
    f.setActionAppliesMute(false);
    for (let iteration = 0; iteration < 400; iteration++) {
        const volume = (iteration % 137 + 1) / 97;
        f.localVolumes.set(f.aliceId, volume);
        equal(f.plugin.manualMute(f.aliceId), true, "Fallback mute failed");
        check(f.plugin.forcedZeroUsers.has(f.aliceId), "Fallback did not track zero-volume ownership");
        const expected = iteration % 2 ? volume + 0.123 : volume;
        if (iteration % 2) f.localVolumes.set(f.aliceId, expected);
        equal(f.plugin.manualUnmute(f.aliceId), true, "Fallback unmute failed");
        equal(f.localVolumes.get(f.aliceId), expected, "Restoration replaced the exact/latest volume");
        equal(f.plugin.ownedMutes.size, 0, "Completed restoration leaked ownership");
        equal(f.plugin.volumeBeforeMute.size, 0, "Completed restoration leaked a volume record");
        invariants(f);
    }
});

run("100 disconnect/reconnect cycles preserve external mutes and release only owned audio", f => {
    f.plugin.settings.autoMute = false;
    f.localMuteStates.set(f.bobId, true);
    for (let cycle = 0; cycle < 100; cycle++) {
        f.setChannel(f.channelId);
        f.connection.connectionState = "CONNECTED";
        f.step();
        f.plugin.manualMute(f.aliceId);
        f.setChannel(null);
        f.connection.connectionState = "DISCONNECTED";
        f.step();
        equal(f.plugin.ownedMutes.size, 0, "Disconnect retained an owned mute with working restore methods");
        equal(f.plugin.members.size, 0, "Disconnect retained participant state");
        equal(f.plugin.signals.size, 0, "Disconnect retained signal state");
        equal(f.localMuteStates.get(f.bobId), true, "Disconnect released a mute owned by Discord/user");
    }
    equal(f.actionMuteCalls.filter(call => call.userId === f.bobId && call.muted === false).length, 0, "External mute received an unmute action");
});

run("failed volume restoration survives disconnect and recovers once methods return", f => {
    f.setActionAppliesMute(false);
    f.localVolumes.set(f.aliceId, 0.731);
    f.plugin.manualMute(f.aliceId);
    const target = f.plugin.ownedMutes.get(f.aliceId);
    const originalAction = f.mediaActions.setLocalVolume;
    const originalNative = target.volumeFn;
    f.mediaActions.setLocalVolume = () => { throw new Error("Synthetic restore rejection"); };
    target.volumeFn = () => false;
    f.setChannel(null);
    f.step();
    check(f.plugin.pendingRestores.has(f.aliceId), "Failed restoration was not retained");
    check(f.plugin.ownedMutes.has(f.aliceId), "Failed restoration lost ownership");
    equal(f.plugin.volumeBeforeMute.get(f.aliceId), 0.731, "Failed restoration lost prior volume");
    f.step(500);
    invariants(f);
    f.mediaActions.setLocalVolume = originalAction;
    target.volumeFn = originalNative;
    f.step(30);
    equal(f.localVolumes.get(f.aliceId), 0.731, "Recovered restoration changed prior volume");
    equal(f.plugin.pendingRestores.size, 0, "Recovered restoration remained pending");
    equal(f.plugin.ownedMutes.size, 0, "Recovered restoration retained ownership");
});

run("Probe burst escalation, exact gap trust, and ordinary Soft stay isolated over 100 cycles", f => {
    const evidence = {type: "rolling", score: 1, rms: 0.95, activeRatio: 1, loudRatio: 1, loudMs: 560, durationMs: 560};
    for (let cycle = 0; cycle < 100; cycle++) {
        const id = cycle % 2 ? f.aliceId : f.bobId;
        f.plugin.setTrusted(id, false);
        f.plugin.manualUnmute(id);
        f.plugin.setUserPolicy(id, "soft:1");
        const member = f.plugin.members.get(id);
        member.softLastMutedAt = 0;
        member.softStrikeCount = 0;
        let now = f.now() + 16000;
        for (let hit = 0; hit < 2; hit++) {
            f.setNow(now);
            equal(f.plugin.applyAutoMute(id, member, "Synthetic Probe", now, true, evidence), true, "Probe hit was not muted");
            equal(member.softUnmuteAt, now + 1000, "Probe duration changed");
            f.setNow(now + 1000);
            f.plugin.processSoftUnmutes(now + 1000);
            now += 4500;
        }
        f.setNow(now);
        equal(f.plugin.applyAutoMute(id, member, "Synthetic Probe", now, true, evidence), true, "Close Probe burst did not escalate");
        equal(member.softUnmuteAt, 0, "Escalated mute remained temporary");
        equal(f.plugin.policyValueFor(id), "guarded", "Escalation retained Probe policy");
        f.plugin.manualUnmute(id);
        f.plugin.setUserPolicy(id, "soft:1");
        member.softLastMutedAt = 0;
        member.softStrikeCount = 0;
        now += 16000;
        f.setNow(now);
        equal(f.plugin.applyAutoMute(id, member, "Synthetic Probe", now, true, evidence), true);
        f.setNow(now + 1000);
        f.plugin.processSoftUnmutes(now + 1000);
        f.setNow(now + 5000);
        equal(f.plugin.applyAutoMute(id, member, "Synthetic Probe", now + 5000, true, evidence), false);
        equal(f.plugin.isTrusted(id), true, "Five-second Probe gap did not mark trusted");
        invariants(f);
    }
});

const malformedLevels = [
    ["null", null], ["undefined", undefined], ["empty-string", ""], ["boolean-true", true], ["boolean-false", false],
    ["nonnumeric-string", "not a level"], ["NaN", NaN], ["Infinity", Infinity], ["negative-Infinity", -Infinity],
    ["empty-array", []], ["array-one", [1]], ["coercible-object", {valueOf() { return 1; }}]
];
for (const [label, value] of malformedLevels) {
    run("malformed audioLevel / " + label + " is not mapped or enforced", f => {
        f.setInbound({[f.aliceId]: [{audioLevel: value, audioDetected: true}]});
        f.step(100);
        equal(f.actionMuteCalls.filter(call => call.userId === f.aliceId && call.muted).length, 0, "Malformed audioLevel caused an automatic mute");
        equal(f.plugin.signals.get(f.aliceId).mapped, false, "Malformed audioLevel was accepted as a mapped numeric signal");
    }, {reproducer: "Set one inbound audioLevel to " + label + "; tick 100 times at 80ms with audioDetected:true."});
}

for (const seed of seeds) {
    const trace = [];
    run("seeded connection/policy/lifecycle churn " + seed, f => {
        const random = rng(seed);
        const pick = list => list[Math.floor(random() * list.length)];
        const originalMembersRead = f.stores.VoiceStateStore.getVoiceStatesForChannel;
        const externalMutes = new Set();
        for (let index = 0; index < randomSteps; index++) {
            const id = pick(f.ids);
            const operation = Math.floor(random() * 18);
            trace.push({index, operation, person: f.ids.indexOf(id)});
            if (trace.length > 14) trace.shift();
            if (operation === 0) f.voiceMembers.has(id) ? f.voiceMembers.delete(id) : f.voiceMembers.add(id);
            else if (operation === 1) f.setChannel(pick([null, f.channelId, "777777777777777777"]));
            else if (operation === 2) f.connection.connectionState = pick(["CONNECTED", "DISCONNECTED", "CONNECTING"]);
            else if (operation === 3) f.setMembershipUnavailable(random() < 0.2);
            else if (operation === 4) f.plugin.toggleAutoMute();
            else if (operation === 5 && f.getChannel() && f.voiceMembers.has(id)) f.plugin.setTrusted(id, random() < 0.5);
            else if (operation === 6 && f.getChannel() && f.voiceMembers.has(id)) f.plugin.setUserPolicy(id, pick(["guarded", "soft:1", "soft:10", "soft:20", "trusted"]));
            else if (operation === 7 && f.getChannel() && f.voiceMembers.has(id)) f.plugin.manualMute(id);
            else if (operation === 8 && f.getChannel() && f.voiceMembers.has(id)) { f.plugin.manualUnmute(id); externalMutes.delete(id); }
            else if (operation === 9) {
                if (!f.plugin.ownedMutes.has(id)) externalMutes.add(id);
                f.localMuteStates.set(id, true);
            } else if (operation === 10) { f.localMuteStates.set(id, false); externalMutes.delete(id); }
            else if (operation === 11) f.plugin.applyDisplayPreset(pick(["minimal", "balanced", "detailed"]));
            else if (operation === 12) f.plugin.setPanelView(pick(["overview", "people", "activity", "settings"]));
            else if (operation === 13) f.plugin.applyProtectionProfile(pick(["balanced", "cautious", "responsive"]));
            else if (operation === 14) {
                f.plugin.stop();
                equal(f.resources().intervals, 0, "Random restart leaked an interval");
                f.plugin.start();
                stats.lifecycleCycles++;
            }
            const values = Object.fromEntries(f.ids.map(person => [person, [{audioLevel: pick([0, 0.03, 0.25, 0.62, 0.9, 1, null, true, "invalid"]), audioDetected: random() < 0.7}]]));
            if (random() < 0.03) f.setInbound(null);
            else if (random() < 0.2) f.setInbound(new Map(Object.entries(values)));
            else f.setInbound(values);
            const before = f.actionMuteCalls.length;
            const paused = !f.plugin.settings.autoMute;
            const allowedExternal = new Set([...externalMutes].filter(person => !f.plugin.ownedMutes.has(person)));
            f.step(1, pick([0, 10, 40, 80, 80, 80, 120, 500, 2000]));
            const newActions = f.actionMuteCalls.slice(before);
            if (paused) check(newActions.every(call => call.muted !== true), "Auto-off tick issued a mute", {seed, index, trace});
            for (const call of newActions) {
                check(call.userId !== f.selfId, "Plugin acted on the current user", {seed, index});
                if (call.muted === false) check(!allowedExternal.has(call.userId), "Tick released an unowned external mute", {seed, index, trace});
            }
            check(!f.plugin.telemetry.reason.startsWith("Sampler error:"), "Plain malformed/churning telemetry caused a sampler error", {seed, index, reason: f.plugin.telemetry.reason, trace});
            if (index % 10 === 0) invariants(f);
        }
        f.stores.VoiceStateStore.getVoiceStatesForChannel = originalMembersRead;
    }, {seed, randomSteps, get trace() { return trace; }});
}

console.log(JSON.stringify({
    suite: "VoiceGuard compact candidate deterministic VM stress",
    source: path.basename(sourcePath),
    backgroundPriorityApplied,
    seeds,
    randomStepsPerSeed: randomSteps,
    ...stats,
    simulatedTickElapsedHours: Number((stats.simulatedTickElapsedMs / 3600000).toFixed(3)),
    scope: "Synthetic stores only; no live Discord, browser, installed files, credentials, or external network."
}, null, 2));
process.exitCode = stats.failures.length ? 1 : 0;
