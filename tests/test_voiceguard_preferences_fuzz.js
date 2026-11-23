"use strict";

// Deterministic contract/boundary tests. All Discord, storage, clocks and timers
// are the existing in-memory VM fixture. This file never opens a live client.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const pluginPath = path.resolve(process.argv[2] || path.join(__dirname, "..", "VoiceGuard.plugin.js"));
const pluginSource = fs.readFileSync(pluginPath, "utf8");
const fixtureSource = fs.readFileSync(path.join(__dirname, "test_voiceguard_plugin.js"), "utf8").split("function main() {")[0];
const seeds = [0x00c0ffee, 0x5eed1234, 0xdeadbeef, 0x1badb002];
const failures = [];
let assertions = 0;
let scenarios = 0;
let fixtures = 0;
let validPresets = 0;
let invalidPresets = 0;
let policyValues = 0;
let escapeValues = 0;

const check = {
    equal(actual, expected, message) { assertions++; assert.equal(actual, expected, message); },
    ok(value, message) { assertions++; assert.ok(value, message); },
    deep(actual, expected, message) { assertions++; assert.deepEqual(actual, expected, message); },
    noThrow(fn, message) { assertions++; assert.doesNotThrow(fn, message); }
};
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const envelope = preferences => ({format: "voiceguard-preferences", version: 1, preferences});
const boolKeys = [
    "showAudioLevels", "showLevelMeter", "showLevelValue", "showPeakLevel", "showDbfs",
    "showThresholdMarker", "showPeakMarker", "showBlastScore", "showAvatars", "showStatusLabels",
    "showQuickPolicies", "compactRows", "showCallSummary", "showConnectionDetails", "tileMeters", "reducePanelMotion"
];
const ranges = {
    loudThreshold: [0.1, 1],
    newcomerLoudSeconds: [1.5, 5],
    establishedLoudSeconds: [2, 10],
    softRearmGraceSeconds: [1, 10]
};
const formats = ["percent", "raw", "dbfs"];
const numericKeys = Object.keys(ranges);
const allowedKeys = [...numericKeys, ...boolKeys, "levelDisplayFormat"];
const forbiddenKeys = [
    "autoMute", "trustedUsers", "softVoicebans", "offenses", "ownedMutes", "pendingRestores",
    "history", "activity", "authSession", "authBaseUrl", "panelCollapsed", "debugVisuals",
    "softEscalateCount", "softFalsePositiveGapSeconds", "detectorProfile", "__proto__", "constructor", "prototype", "toString"
];
const invalidJSONValues = [null, 0, 1, -1, "", "true", "false", [], [1], {}, {toString: null}, {valueOf: null, toString: null}];

function random(seed) {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
}
const pick = (rng, values) => values[Math.floor(rng() * values.length)];
const own = (object, key, value) => Object.defineProperty(object, key, {value, enumerable: true, writable: true, configurable: true});

function fresh(start = true) {
    fixtures++;
    const sandbox = {
        require, __dirname, console,
        process: {argv: [process.execPath, __filename, pluginPath]}
    };
    vm.runInNewContext(fixtureSource + `
        vm.createContext(context);
        vm.runInContext(code, context, {filename: pluginPath});
        const Plugin = context.module.exports;
        const plugin = new Plugin({name: "VoiceGuard"});
        globalThis.fixture = {
            plugin, Plugin, context, document, stores, connection, mediaEngine, mediaActions,
            localVolumes, localMuteStates, voiceMembers, dataStore, actionMuteCalls,
            actionVolumeCalls, nativeVolumeCalls, aliceId, bobId, selfId, channelId,
            step: (count = 1, ms = 80) => step(plugin, count, ms),
            setInbound, setNow: value => { nowMs = value; },
            setActionAppliesMute: value => { actionAppliesMute = value; },
            fetchCount: () => fetchCalls, intervalCount: () => intervals.size
        };
        ${start ? "plugin.start();" : ""}
    `, sandbox, {filename: "preferences-fuzz-fixture.js", timeout: 5000});
    return sandbox.fixture;
}

function run(name, fn) {
    scenarios++;
    try { fn(); }
    catch (error) { failures.push({name, error: error.message, location: error.stack?.split("\n").slice(1, 3).join("\n")}); }
}
async function runAsync(name, fn) {
    scenarios++;
    try { await fn(); }
    catch (error) { failures.push({name, error: error.message, location: error.stack?.split("\n").slice(1, 3).join("\n")}); }
}
async function group(name, fn) {
    const f = fresh();
    try { await fn(f); }
    finally {
        run(name + ": fixture never fetched network", () => check.equal(f.fetchCount(), 0));
        f.plugin.stop();
        run(name + ": fixture timers stopped", () => check.equal(f.intervalCount(), 0));
    }
}

function protectedState(f) {
    return {
        autoMute: f.plugin.settings.autoMute,
        trustedUsers: clone(f.plugin.trustedUsers),
        softVoicebans: clone(f.plugin.softVoicebans),
        offenses: clone(f.plugin.offenses),
        members: [...f.plugin.members.entries()].map(([id, member]) => [id, clone(member)]),
        ownedIds: [...f.plugin.ownedMutes.keys()],
        forcedZeroUsers: [...f.plugin.forcedZeroUsers],
        pendingRestores: [...f.plugin.pendingRestores.entries()],
        localVolumes: [...f.localVolumes.entries()],
        localMuteStates: [...f.localMuteStates.entries()],
        audioRestores: clone(f.dataStore.get("audioRestores")),
        muteCalls: f.actionMuteCalls.length,
        volumeCalls: f.actionVolumeCalls.length,
        nativeCalls: f.nativeVolumeCalls.length
    };
}

function prepareProtectedState(f) {
    f.plugin.settings.autoMute = false;
    f.plugin.saveSettings();
    f.plugin.setUserPolicy(f.aliceId, "soft:30");
    f.plugin.setTrusted(f.bobId, true);
    f.plugin.manualMute(f.aliceId);
    f.plugin.offenses[f.aliceId] = {count: 2, detectorVersion: "rolling-v1", rememberedMute: true, lastOffenseAt: 1000};
    f.plugin.saveOffenses();
}

function validPreferences(rng) {
    const preferences = Object.create(null);
    for (const key of allowedKeys) {
        if (rng() > 0.35) continue;
        if (key in ranges) {
            const [min, max] = ranges[key];
            preferences[key] = pick(rng, [min, max, Number((min + rng() * (max - min)).toFixed(6))]);
        } else if (key === "levelDisplayFormat") preferences[key] = pick(rng, formats);
        else preferences[key] = rng() < 0.5;
    }
    if (!Object.keys(preferences).length) preferences.compactRows = rng() < 0.5;
    return preferences;
}

function assertInvalidAtomic(f, input, name) {
    invalidPresets++;
    const beforeSettings = clone(f.plugin.settings);
    const beforeData = clone([...f.dataStore.entries()]);
    const beforeProtected = protectedState(f);
    const beforeActivity = clone(f.plugin.activity);
    const beforePrototype = Object.getOwnPropertyNames(Object.prototype);
    const result = f.plugin.importPreferencePreset(input);
    check.equal(result.ok, false, name + ": invalid preset accepted");
    check.ok(typeof result.error === "string" && result.error.length > 0, name + ": missing actionable rejection");
    check.deep(clone(f.plugin.settings), beforeSettings, name + ": partially changed settings");
    check.deep(clone([...f.dataStore.entries()]), beforeData, name + ": wrote persisted state");
    check.deep(protectedState(f), beforeProtected, name + ": changed user or mute state");
    check.deep(clone(f.plugin.activity), beforeActivity, name + ": changed existing activity");
    check.deep(Object.getOwnPropertyNames(Object.prototype), beforePrototype, name + ": changed Object.prototype");
}

function assertValidImport(f, preferences, name) {
    validPresets++;
    const protectedBefore = protectedState(f);
    const owners = [...f.plugin.ownedMutes.entries()];
    const text = JSON.stringify(envelope(preferences));
    const result = f.plugin.importPreferencePreset(text);
    check.equal(result.ok, true, name + ": valid preset rejected");
    check.equal(result.changed, Object.keys(preferences).length, name + ": wrong applied key count");
    for (const [key, value] of Object.entries(preferences)) {
        check.equal(f.plugin.settings[key], value, name + ": wrong runtime preference " + key);
        check.equal(f.dataStore.get("settings")[key], value, name + ": wrong saved preference " + key);
    }
    check.deep(protectedState(f), protectedBefore, name + ": changed protected state");
    for (const [id, owner] of owners) check.equal(f.plugin.ownedMutes.get(id), owner, name + ": replaced mute ownership");
    const exported = JSON.parse(f.plugin.exportPreferencePreset());
    check.deep(Object.keys(exported).sort(), ["format", "preferences", "version"], name + ": exported private root fields");
    check.deep(Object.keys(exported.preferences).sort(), [...allowedKeys].sort(), name + ": exported private/missing preferences");
    check.equal(f.plugin.validatePreferencePreset(JSON.stringify(exported)).ok, true, name + ": export cannot be reimported");
}

async function main() {
    await group("preset contract", async f => {
        prepareProtectedState(f);
        run("export contains exactly the public preference contract", () => {
            check.deep([...f.plugin.preferencePresetKeys()].sort(), [...allowedKeys].sort());
            assertValidImport(f, {compactRows: true, loudThreshold: 0.8, levelDisplayFormat: "dbfs"}, "fixed roundtrip");
        });
        for (const [key, [min, max]] of Object.entries(ranges)) {
            for (const value of [min, max, (min + max) / 2]) run("inclusive range " + key + "=" + value, () => assertValidImport(f, {[key]: value}, key));
            for (const value of [min - 0.000001, max + 0.000001, ...invalidJSONValues.filter(value => typeof value !== "number" || value < min || value > max)]) {
                run("invalid numeric " + key + "=" + JSON.stringify(value), () => assertInvalidAtomic(f, JSON.stringify(envelope({compactRows: !f.plugin.settings.compactRows, [key]: value})), key));
            }
        }
        for (const key of boolKeys) {
            for (const value of [true, false]) run("boolean " + key + "=" + value, () => assertValidImport(f, {[key]: value}, key));
            for (const value of invalidJSONValues) run("invalid boolean " + key + "=" + JSON.stringify(value), () => assertInvalidAtomic(f, JSON.stringify(envelope({[key]: value})), key));
        }
        for (const value of [...formats, "", "DBFS", "percent ", 1, null, [], {}]) {
            run("level format " + JSON.stringify(value), () => {
                if (formats.includes(value)) assertValidImport(f, {levelDisplayFormat: value}, "format");
                else assertInvalidAtomic(f, JSON.stringify(envelope({levelDisplayFormat: value})), "format");
            });
        }
        for (const key of forbiddenKeys) {
            run("reject forbidden preference " + key, () => {
                const preferences = {compactRows: !f.plugin.settings.compactRows};
                own(preferences, key, {vgFuzzPolluted: true});
                assertInvalidAtomic(f, JSON.stringify(envelope(preferences)), key);
            });
            run("reject forbidden root " + key, () => {
                const preset = envelope({compactRows: true});
                own(preset, key, {vgFuzzPolluted: true});
                assertInvalidAtomic(f, JSON.stringify(preset), key);
            });
        }
        for (const input of [undefined, null, false, true, 1, [], {}, Buffer.from("{}"), "", "{", "null", "[]", "true", "0", "\"preset\"", "{}", "{\"format\":\"voiceguard-preferences\",\"version\":1,\"preferences\":{}}", "{\"format\":\"voiceguard-preferences\",\"version\":1,\"preferences\":{\"loudThreshold\":1e999}}", "{\"format\":\"voiceguard-preferences\",\"version\":1,\"preferences\":{\"loudThreshold\":NaN}}"]) {
            run("reject malformed envelope " + String(input).slice(0, 80), () => assertInvalidAtomic(f, input, "envelope"));
        }
    });

    for (const seed of seeds) {
        const rng = random(seed);
        await group("seed " + seed.toString(16), async f => {
            prepareProtectedState(f);
            for (let index = 0; index < 240; index++) {
                run("seed " + seed.toString(16) + " valid " + index, () => assertValidImport(f, validPreferences(rng), "seeded valid"));
            }
            for (let index = 0; index < 400; index++) {
                run("seed " + seed.toString(16) + " invalid " + index, () => {
                    const preset = envelope(validPreferences(rng));
                    const kind = Math.floor(rng() * 8);
                    if (kind === 0) preset.preferences[pick(rng, boolKeys)] = pick(rng, invalidJSONValues);
                    if (kind === 1) preset.preferences[pick(rng, numericKeys)] = pick(rng, [null, "0.7", false, true, [], [2], {}, {toString: null}]);
                    if (kind === 2) {
                        const key = pick(rng, numericKeys);
                        preset.preferences[key] = rng() < 0.5 ? ranges[key][0] - rng() - 0.000001 : ranges[key][1] + rng() + 0.000001;
                    }
                    if (kind === 3) own(preset, pick(rng, forbiddenKeys), pick(rng, invalidJSONValues));
                    if (kind === 4) own(preset.preferences, pick(rng, forbiddenKeys), pick(rng, invalidJSONValues));
                    if (kind === 5) preset.version = pick(rng, [0, 2, "1", null, [], {}]);
                    if (kind === 6) preset.preferences = pick(rng, [null, [], {}, "preferences", 1, false]);
                    if (kind === 7) preset.format = pick(rng, [null, 1, [], {}, "voiceguard", "voiceguard-preferences "]);
                    assertInvalidAtomic(f, JSON.stringify(preset), "seeded malformed");
                });
            }
            run("seed " + seed.toString(16) + " survives save/reload", () => {
                const expected = JSON.parse(f.plugin.exportPreferencePreset()).preferences;
                const expectedTrust = clone(f.plugin.trustedUsers);
                const expectedPolicies = clone(f.plugin.softVoicebans);
                f.plugin.stop();
                const reloaded = new f.Plugin({name: "VoiceGuard"});
                f.plugin = reloaded;
                reloaded.start();
                check.deep(JSON.parse(reloaded.exportPreferencePreset()).preferences, expected);
                check.equal(reloaded.settings.autoMute, false);
                check.deep(clone(reloaded.trustedUsers), expectedTrust);
                check.deep(clone(reloaded.softVoicebans), expectedPolicies);
            });
        });
    }

    await group("UTF8 and asynchronous files", async f => {
        const small = JSON.stringify(envelope({compactRows: true}));
        for (const size of [16383, 16384, 16385]) run("ASCII byte boundary " + size, () => {
            const text = small + " ".repeat(size - Buffer.byteLength(small));
            check.equal(Buffer.byteLength(text, "utf8"), size);
            if (size <= 16384) check.equal(f.plugin.validatePreferencePreset(text).ok, true);
            else assertInvalidAtomic(f, text, "ASCII oversize");
        });
        for (const character of ["é", "界", "😀", "\ud800"]) {
            const prefix = '{"format":"voiceguard-preferences","version":1,"preferences":{"compactRows":true},"notes":"';
            const suffix = '"}';
            const count = Math.floor((16384 - Buffer.byteLength(prefix + suffix)) / Buffer.byteLength(character));
            const base = prefix + character.repeat(count) + suffix;
            for (const overflow of [false, true]) run("UTF8 character " + JSON.stringify(character) + " overflow=" + overflow, () => {
                const padding = 16384 - Buffer.byteLength(base);
                const text = base + " ".repeat(padding) + (overflow ? " " : "");
                check.equal(Buffer.byteLength(text), overflow ? 16385 : 16384);
                const result = f.plugin.validatePreferencePreset(text);
                check.equal(result.ok, false);
                check.equal(result.error.includes("16 KiB"), overflow, "limit must count UTF8 bytes rather than UTF16 code units");
            });
        }
        for (const test of [
            {name: "oversize file rejected before text read", size: 16385, text: small, reads: 0, success: false},
            {name: "NaN size rejected before text read", size: NaN, text: small, reads: 0, success: false},
            {name: "infinite size rejected before text read", size: Infinity, text: small, reads: 0, success: false},
            {name: "oversize contents cannot bypass claimed file size", size: 10, text: small + " ".repeat(16384), reads: 1, success: false},
            {name: "valid asynchronous file imports", size: Buffer.byteLength(small), text: small, reads: 1, success: true}
        ]) await runAsync(test.name, async () => {
            let reads = 0;
            const before = clone(f.plugin.settings);
            await f.plugin.importPreferencePresetFile({size: test.size, text: async () => { reads++; return test.text; }});
            check.equal(reads, test.reads);
            check.equal(f.plugin.presetNotice.ok, test.success);
            if (!test.success) check.deep(clone(f.plugin.settings), before);
            else check.equal(f.plugin.settings.compactRows, true);
        });
        await runAsync("file read errors preserve all settings", async () => {
            const before = clone(f.plugin.settings);
            await f.plugin.importPreferencePresetFile({size: 10, text: async () => { throw new Error("Fixture read denied"); }});
            check.equal(f.plugin.presetNotice.ok, false);
            check.deep(clone(f.plugin.settings), before);
        });
    });

    await group("policy value boundaries", async f => {
        const probeValues = [
            {value: 1, expected: 1}, {value: "1", expected: 10}, {value: " 1 ", expected: 10},
            {value: true, expected: 20}, {value: false, expected: 20}, {value: [1], expected: 20},
            {value: [], expected: 20}, {value: {}, expected: 20}, {value: null, expected: 20},
            {value: undefined, expected: 20}, {value: NaN, expected: 20}, {value: Infinity, expected: 20},
            {value: -Infinity, expected: 20}, {value: new Number(1), expected: 20},
            {value: {toString: null, valueOf: null}, expected: 20},
            {value: 1.00000001, expected: 10}, {value: 0.99999999, expected: 10},
            ...[10, 20, 30, 60].map(value => ({value, expected: value}))
        ];
        for (const [index, test] of probeValues.entries()) run("Probe strict type case " + index, () => {
            policyValues++;
            check.equal(f.plugin.normalizedSoftDuration(test.value), test.expected);
        });
        const policyRng = random(0x50724f42);
        for (let index = 0; index < 500; index++) run("policy fuzz " + index, () => {
            policyValues++;
            const value = pick(policyRng, [policyRng() * 120 - 30, String(policyRng() * 60), ...invalidJSONValues]);
            const duration = f.plugin.normalizedSoftDuration(value);
            check.ok([1, 10, 20, 30, 60].includes(duration));
            check.equal(duration === 1, typeof value === "number" && value === 1, "only explicit numeric1 may activate Probe");
        });
        for (const [index, value] of [1, "1", true, [1], {}, {toString: null}, null, 10, 20, 30, 60].entries()) run("saved policy normalization " + index, () => {
            const saved = JSON.parse(JSON.stringify({[f.aliceId]: {durationSeconds: value}, bad: {durationSeconds: 1}, [f.bobId]: false}));
            own(saved, "__proto__", {durationSeconds: 1});
            f.dataStore.set("softVoicebans", saved);
            f.plugin.loadSoftVoicebans();
            const duration = f.plugin.softVoicebanFor(f.aliceId).durationSeconds;
            check.equal(duration === 1, typeof value === "number" && value === 1);
            check.ok([1, 10, 20, 30, 60].includes(duration));
            check.equal(Object.hasOwn(f.plugin.softVoicebans, "bad"), false);
            check.equal(Object.hasOwn(f.plugin.softVoicebans, "__proto__"), false);
            check.equal(f.plugin.softVoicebanFor(f.bobId), null);
        });
        for (const table of [null, false, 1, "broken", [], [1]]) run("malformed policy table " + JSON.stringify(table), () => {
            f.dataStore.set("softVoicebans", table);
            f.plugin.loadSoftVoicebans();
            check.equal(Array.isArray(f.plugin.softVoicebans), false);
            check.deep(Object.keys(f.plugin.softVoicebans), []);
        });
        run("saved numeric Probe remains Probe after load/save/reload", () => {
            f.dataStore.set("softVoicebans", {[f.aliceId]: {durationSeconds: 1, enabledAt: 1000, name: "Alice"}});
            f.plugin.loadSoftVoicebans();
            f.plugin.saveSoftVoicebans();
            f.plugin.loadSoftVoicebans();
            check.equal(f.plugin.softVoicebanFor(f.aliceId).durationSeconds, 1);
            check.equal(f.plugin.policyValueFor(f.aliceId), "soft:1");
            check.equal(f.dataStore.get("softVoicebans")[f.aliceId].durationSeconds, 1);
        });
    });

    await group("escaped participant and search text", async f => {
        const fixedNames = [
            '<img src=x onerror="fixture()">', '\" autofocus onfocus=\"fixture()',
            '</button><script>fixture()</script>', 'A&B <Captain> "quoted"',
            "O'Connor", "名 🦆 é", '" data-user-id="999999999999999999',
            '<svg/onload=fixture()>', '&lt;script&gt;fixture()&lt;/script&gt;'
        ];
        const rng = random(0xe5ca9e01);
        const alphabet = ['<', '>', '"', "'", '&', '/', '=', ' ', 'A', '界', '🦆', '\n', '\t', '`'];
        const names = [...fixedNames];
        for (let index = 0; index < 160; index++) names.push(Array.from({length: 8 + Math.floor(rng() * 40)}, () => pick(rng, alphabet)).join(""));
        const encode = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
        for (const [index, name] of names.entries()) run("name/search escaping " + index, () => {
            escapeValues++;
            f.stores.UserStore.getUser = id => ({id, username: id === f.aliceId ? name : "Bob"});
            f.plugin.panelSearch = "";
            f.plugin.setPanelView("people");
            check.ok(f.plugin.selectParticipant(f.aliceId), "hostile display names must still be selectable");
            const participantHtml = f.plugin.panel.innerHTML;
            check.ok(participantHtml.includes('title="' + encode(name) + '"'), "participant title escapes hostile text");
            check.ok(participantHtml.includes('aria-label="Mute ' + encode(name) + '"'), "participant action label escapes hostile text");
            check.ok(!participantHtml.includes("<script>fixture()</script>"));
            check.ok(!participantHtml.includes('<img src=x onerror="fixture()">'));
            f.plugin.panelSearch = name;
            f.plugin.renderPanel(true);
            check.ok(f.plugin.panel.innerHTML.includes('value="' + encode(name) + '"'), "search remains inside quoted value attribute");
            f.plugin.recordActivity("settings", f.aliceId, name, name);
            const activityHtml = f.plugin.renderActivity();
            check.ok(activityHtml.includes(encode(name)), "activity escapes hostile message/name");
            check.ok(!activityHtml.includes("<script>fixture()</script>"));
        });
        run("preset errors cannot inject markup", () => {
            const preferences = {};
            own(preferences, '<img src=x onerror="fixture()">', true);
            f.plugin.importPreferencePreset(JSON.stringify(envelope(preferences)));
            const html = f.plugin.renderPreferenceProfiles();
            check.ok(html.includes("&lt;img"));
            check.ok(!html.includes('<img src=x onerror="fixture()">'));
        });
    });

    // Invalid saved settings are JSON-shaped, not objects with executable methods.
    // Loading them must not prevent protection startup.
    const schemaFixture = fresh(false);
    const persistedNumericKeys = Object.entries(schemaFixture.plugin.defaultSettings).filter(([, value]) => typeof value === "number").map(([key]) => key);
    for (const key of persistedNumericKeys) {
        const f = fresh(false);
        try {
            run("malformed persisted numeric object cannot abort startup: " + key, () => {
                f.dataStore.set("settings", JSON.parse(JSON.stringify({detectorProfile: "rolling-v1", [key]: {toString: null, valueOf: null}})));
                check.noThrow(() => f.plugin.start(), "saved numeric object crashed plugin startup");
                check.ok(Number.isFinite(f.plugin.settings[key]), "normalized persisted tuning must be finite");
            });
        } finally { f.plugin.stop(); }
    }

    for (const profile of [undefined, "legacy-short-peaks"]) {
        for (const key of ["newcomerLoudSeconds", "establishedLoudSeconds", "repeatLoudSeconds", "extremeHoldSeconds"]) {
            const f = fresh(false);
            try {
                run("malformed legacy tuning survives migration: " + key + " profile=" + String(profile), () => {
                    const saved = {[key]: {toString: null, valueOf: null}};
                    if (profile !== undefined) saved.detectorProfile = profile;
                    f.dataStore.set("settings", JSON.parse(JSON.stringify(saved)));
                    check.noThrow(() => f.plugin.start(), "legacy migration coerced an object before validating saved tuning");
                    check.ok(Number.isFinite(f.plugin.settings[key]));
                });
            } finally { f.plugin.stop(); }
        }
    }

    const summary = {
        suite: "voiceguard-preferences-fuzz",
        plugin: path.basename(pluginPath),
        plugin_sha256: crypto.createHash("sha256").update(pluginSource).digest("hex"),
        seeds: seeds.map(seed => "0x" + seed.toString(16).padStart(8, "0")),
        extra_seeds: ["0x50724f42 (policy)", "0xe5ca9e01 (escaping)"],
        fixtures, scenarios, assertions, validPresets, invalidPresets, policyValues, escapeValues,
        failed: failures.length,
        failures: failures.slice(0, 30)
    };
    console.log(JSON.stringify(summary, null, 2));
    if (failures.length) process.exitCode = 1;
}

main().catch(error => {
    console.error(JSON.stringify({suite: "voiceguard-preferences-fuzz", fatal: error.message, stack: error.stack}, null, 2));
    process.exitCode = 1;
});
