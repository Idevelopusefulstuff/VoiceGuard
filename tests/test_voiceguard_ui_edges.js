const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Pure VM: reuse only the fixture declarations, never its main scenario or any
// live Discord test. Timers, observers, stores, persistence, and network are fake.
const fixtureSource = fs.readFileSync(path.join(__dirname, "test_voiceguard_plugin.js"), "utf8").split("function main() {")[0];

function fresh() {
    const sandbox = { require, __dirname, process, console };
    vm.runInNewContext(fixtureSource + `
        const timeouts = new Map();
        const observers = [];
        let timeoutSerial = 0;
        context.setTimeout = fn => { const id = ++timeoutSerial; timeouts.set(id, fn); return id; };
        context.clearTimeout = id => timeouts.delete(id);
        context.MutationObserver = class {
            constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
            observe() { this.connected = true; }
            disconnect() { this.connected = false; }
        };
        document.querySelectorAll = () => [];
        vm.createContext(context);
        vm.runInContext(code, context, {filename: pluginPath});
        const Plugin = context.module.exports;
        const plugin = new Plugin({name: "VoiceGuard"});
        globalThis.fixture = {
            plugin, Plugin, context, stores, document, elements, listeners,
            intervals, timeouts, observers, addedStyles, dataStore, toasts,
            connection, mediaEngine, mediaActions, localMuteStates, localVolumes,
            actionMuteCalls, voiceMembers, selfId, aliceId, bobId, charlieId, channelId,
            step: (count = 1, ms = 80) => step(plugin, count, ms),
            setInbound, setNow: value => { nowMs = value; },
            setActionAppliesMute: value => { actionAppliesMute = value; },
            flushTimeouts: () => {
                for (const [id, fn] of Array.from(timeouts.entries())) {
                    timeouts.delete(id); fn();
                }
            },
            networkCalls: () => fetchCalls,
        };
    `, sandbox);
    return sandbox.fixture;
}

function actionTarget(attributes, extras = {}) {
    const target = {
        getAttribute: name => attributes[name] ?? null,
        closest: selector => selector === "[data-vg-action]" ? target : null,
        ...extras,
    };
    return target;
}

function click(f, action, attributes = {}) {
    f.plugin.panel.onclick({ target: actionTarget({ "data-vg-action": action, ...attributes }) });
}

function rowCount(f) {
    return (f.plugin.panel.innerHTML.match(/data-vg-key="user-\d+"/g) || []).length;
}

const cases = [
    ["appearance loads validated fields and persists independently of protection preferences", f => {
        f.dataStore.set("appearance", { theme: '"><img src=x>', font: "mono", textSize: 999, width: 99999, height: [] });
        assert.equal(f.plugin.loadAppearance(), true);
        assert.equal(f.plugin.appearance.theme, "discord");
        assert.equal(f.plugin.appearance.textSize, 100);
        assert.equal(f.plugin.appearance.width, 1200);
        assert.equal(f.plugin.appearance.height, null);
        const previousSettings = JSON.stringify(f.dataStore.get("settings"));
        const previousPreset = JSON.stringify(f.plugin.exportPreferencePreset());
        assert.equal(f.plugin.updateAppearance({theme:"light",font:"readable",textSize:130,width:417,height:143}), true);
        assert.equal(JSON.stringify(f.dataStore.get("settings")), previousSettings);
        assert.equal(JSON.stringify(f.plugin.exportPreferencePreset()), previousPreset);
        f.plugin.stop();
        const plugin = new f.Plugin({name:"VoiceGuard"});
        plugin.start();
        assert.equal(plugin.appearance.theme, "light");
        assert.equal(plugin.appearance.font, "readable");
        assert.equal(plugin.appearance.textSize, 130);
        assert.equal(plugin.appearance.width, 417);
        assert.equal(plugin.appearance.height, 143);
        plugin.stop();
    }],
    ["the resize grip previews within the window, cancels safely, commits once, and supports keyboard resizing", f => {
        const panel = f.plugin.panel;
        panel.getBoundingClientRect = () => ({width:340,height:145,top:52});
        panel.ownerDocument = {defaultView:{innerWidth:640,innerHeight:480}};
        panel.querySelector = selector => selector === ".vg5-roster, .vg5-empty" ? {getBoundingClientRect:()=>({height:100})} : null;
        const styles = new Map();
        panel.style.setProperty = (key, value) => styles.set(key,value);
        let captured = null;
        const grip = {closest: selector => selector === "[data-vg-resize]" ? grip : null, setPointerCapture: id => {captured=id;},
            hasPointerCapture: id => captured===id, releasePointerCapture: () => {captured=null;}, focus() {}};
        const down = {target:grip,button:0,pointerId:7,clientX:300,clientY:200};
        const move = {pointerId:7,clientX:220,clientY:241};
        panel.onpointerdown(down);
        panel.onpointermove({...move,pointerId:99});
        assert.equal(styles.get("--vg-panel-width"), undefined);
        panel.onpointermove(move);
        assert.equal(styles.get("--vg-panel-width"), "420px");
        assert.equal(styles.get("--vg-roster-height"), "141px");
        assert.equal(f.dataStore.has("appearance"), false);
        panel.onpointercancel(move);
        assert.equal(captured, null);
        assert.equal(f.dataStore.has("appearance"), false);
        panel.onpointerdown(down);
        panel.onpointermove({...move,clientX:-800,clientY:1000});
        assert.equal(styles.get("--vg-panel-width"), "620px");
        assert.equal(styles.get("--vg-roster-height"), "373px");
        panel.onpointermove(move);
        panel.onpointerup(move);
        assert.equal(f.dataStore.get("appearance").width, 420);
        assert.equal(f.dataStore.get("appearance").height, 141);
        assert.equal(captured, null);
        panel.onkeydown({target:grip,key:"ArrowLeft",shiftKey:true});
        assert.equal(f.dataStore.get("appearance").width, 364);
        panel.onkeydown({target:grip,key:"Home"});
        assert.equal(f.dataStore.get("appearance").width, null);
        assert.equal(f.dataStore.get("appearance").height, null);
    }],
    ["an isolated appearance storage failure does not pause audio protection", f => {
        const read = f.context.BdApi.Data.load;
        f.context.BdApi.Data.load = (name, key) => {
            if (key === "appearance") throw new Error("Visual settings unreadable");
            return read(name, key);
        };
        assert.equal(f.plugin.loadAppearance(), false);
        assert.equal(f.plugin.updateAppearance({theme:"midnight"}), false);
        assert.equal(f.plugin.protectionStorageReady(), true);
        assert.equal(f.dataStore.has("appearance"), false);
        f.context.BdApi.Data.load = read;
        assert.equal(f.plugin.updateAppearance({theme:"midnight"}), true);
        assert.equal(f.dataStore.get("appearance").theme, "midnight");
    }],
    ["tools and evidence open on demand while the full roster remains present", f => {
        assert.match(f.plugin.panel.innerHTML, /id="vg6-tools"[^>]* hidden/);
        assert.doesNotMatch(f.plugin.panel.innerHTML, /data-vg-action="toggle-mute"/);
        click(f, "toggle-tools");
        assert.equal(f.plugin.toolsOpen, true);
        assert.equal(rowCount(f), 2);
        click(f, "view", { "data-view": "settings" });
        assert.equal(f.plugin.toolsOpen, false);
        assert.equal(rowCount(f), 2);
        click(f, "select-participant", { "data-user-id": f.aliceId });
        assert.match(f.plugin.panel.innerHTML, /class="vg6-details"[^>]* hidden/);
        click(f, "toggle-details");
        assert.doesNotMatch(f.plugin.panel.innerHTML, /class="vg6-details"[^>]* hidden/);
        assert.equal(rowCount(f), 2);
        f.plugin.panel.onkeydown({ key: "Escape" });
        assert.match(f.plugin.panel.innerHTML, /class="vg6-details"[^>]* hidden/);
    }],
    ["all views round-trip without losing roster or settings return view", f => {
        for (const view of ["overview", "activity", "people"]) {
            f.plugin.setPanelView(view);
            assert.equal(rowCount(f), 2);
            f.plugin.setPanelView("settings");
            assert.equal(rowCount(f), 2);
            f.plugin.closePanelSettings();
            assert.equal(f.plugin.panelView, view);
        }
        f.plugin.setPanelView("people");
        assert.equal(rowCount(f), 2);
        assert.equal(f.plugin.setPanelView("unknown"), false);
    }],
    ["alert highlighting keeps every tile; display changes keep the policy menu", f => {
        f.plugin.togglePolicyMenu(f.aliceId);
        f.plugin.updateDisplaySetting("showAvatars", false);
        assert.equal(f.plugin.policyMenuUserId, f.aliceId);
        f.plugin.setPanelFilter("alerts");
        assert.equal(f.plugin.policyMenuUserId, null);
        assert.ok(!f.plugin.panel.innerHTML.includes('class="vg3-policy-menu"'));
        assert.equal(rowCount(f), 2);
        f.plugin.setPanelFilter("all");
        assert.equal(rowCount(f), 2);
    }],
    ["search highlights a match without hiding anyone and Escape clears it", f => {
        click(f, "toggle-find");
        f.plugin.togglePolicyMenu(f.aliceId);
        f.plugin.panel.oninput({ target: actionTarget({ "data-vg-action": "search" }, { value: "Bob" }) });
        assert.equal(rowCount(f), 2);
        assert.ok(f.plugin.panel.innerHTML.includes('matched" data-vg-key="user-' + f.bobId + '"'));
        assert.equal(f.plugin.policyMenuUserId, null);
        let prevented = false;
        f.plugin.panel.onkeydown({ key: "Escape", preventDefault() { prevented = true; } });
        assert.equal(f.plugin.panelSearch, "");
        assert.equal(rowCount(f), 2);
        assert.equal(prevented, true);
    }],
    ["participant departure removes stale rows, meters, and an open tray", f => {
        f.plugin.togglePolicyMenu(f.aliceId);
        f.voiceMembers.delete(f.aliceId);
        f.step(4);
        f.plugin.renderPanel(true);
        assert.equal(f.plugin.members.has(f.aliceId), false);
        assert.equal(f.plugin.signals.has(f.aliceId), false);
        assert.equal(f.plugin.policyMenuUserId, null);
        assert.equal(rowCount(f), 1);
        assert.ok(!f.plugin.panel.innerHTML.includes(`data-vg-key="user-${f.aliceId}"`));
    }],
    ["temporary membership errors preserve visible rows and expose the waiting state", f => {
        f.plugin.togglePolicyMenu(f.aliceId);
        f.stores.VoiceStateStore.getVoiceStatesForChannel = () => { throw new Error("temporarily unavailable"); };
        f.step(4);
        f.plugin.renderPanel(true);
        assert.equal(rowCount(f), 2);
        assert.equal(f.plugin.policyMenuUserId, f.aliceId);
        assert.ok(f.plugin.panel.innerHTML.includes("Updating call"));
        assert.ok(f.plugin.panel.innerHTML.includes("automatic detection is waiting"));
    }],
    ["changing channels clears the old roster and tray", f => {
        f.plugin.togglePolicyMenu(f.aliceId);
        f.stores.SelectedChannelStore.getVoiceChannelId = () => "777777777777777777";
        f.voiceMembers.clear();
        f.voiceMembers.add(f.selfId);
        f.voiceMembers.add(f.charlieId);
        f.step(4);
        f.plugin.renderPanel(true);
        assert.equal(f.plugin.policyMenuUserId, null);
        assert.equal(f.plugin.members.has(f.aliceId), false);
        assert.equal(rowCount(f), 1);
        assert.ok(f.plugin.panel.innerHTML.includes(`data-vg-key="user-${f.charlieId}"`));
    }],
    ["disconnect shows a standby state without stale participant controls", f => {
        f.stores.SelectedChannelStore.getVoiceChannelId = () => null;
        f.stores.VoiceStateStore.getCurrentClientVoiceChannelId = () => null;
        f.stores.VoiceStateStore.getUserVoiceChannelId = () => null;
        f.stores.RTCConnectionStore.getChannelId = () => null;
        f.step(4);
        f.plugin.renderPanel(true);
        assert.equal(rowCount(f), 0);
        assert.ok(f.plugin.panel.innerHTML.includes("Standing by"));
        assert.equal(f.plugin.members.size, 0);
    }],
    ["a failing primary channel getter falls through to another channel store", f => {
        f.stores.SelectedChannelStore.getVoiceChannelId = () => { throw new Error("selected channel unavailable"); };
        assert.doesNotThrow(() => f.step(4));
        f.plugin.renderPanel(true);
        assert.equal(rowCount(f), 2);
    }],
    ["missing Discord stores are a recoverable startup waiting state", f => {
        f.plugin.stop();
        f.context.BdApi.Webpack.getStore = () => null;
        assert.doesNotThrow(() => f.plugin.start());
        assert.doesNotThrow(() => f.step(4));
        assert.match(f.plugin.panel.innerHTML, /Connecting to Discord|Waiting for your Discord account/i);
    }],
    ["module-discovery exceptions are a recoverable startup waiting state", f => {
        f.plugin.stop();
        f.context.BdApi.Webpack.getStore = () => { throw new Error("webpack updating"); };
        assert.doesNotThrow(() => f.plugin.start());
        f.step(4);
        assert.match(f.plugin.panel.innerHTML, /Connecting to Discord|Waiting for your Discord account/i);
    }],
    ["failed profile lookups fall back to user IDs without crashing the UI", f => {
        f.stores.UserStore.getUser = () => { throw new Error("profile unavailable"); };
        assert.doesNotThrow(() => f.step(4));
        assert.ok(f.plugin.panel.innerHTML.includes(f.aliceId));
    }],
    ["known local identity is excluded even if inbound stats contain a loud self entry", f => {
        f.setInbound({ [f.selfId]: [{ audioLevel: 0.99, audioDetected: true }], [f.aliceId]: [{ audioLevel: 0.2, audioDetected: true }] });
        f.step(60);
        assert.equal(f.actionMuteCalls.some(action => action.userId === f.selfId), false);
        assert.equal(f.plugin.members.has(f.selfId), false);
        assert.ok(!f.plugin.panel.innerHTML.includes(`data-vg-key="user-${f.selfId}"`));
    }],
    ["missing current identity fails closed against loud self stats and recovers cleanly", f => {
        const original = f.stores.UserStore.getCurrentUser;
        f.stores.UserStore.getCurrentUser = () => null;
        f.setInbound({ [f.selfId]: [{ audioLevel: 0.99, audioDetected: true }], [f.aliceId]: [{ audioLevel: 0.9, audioDetected: true }] });
        assert.doesNotThrow(() => f.step(60));
        assert.equal(f.actionMuteCalls.length, 0, "Unknown identity must not allow automatic mute actions, including the local self");
        f.stores.UserStore.getCurrentUser = original;
        f.step(4);
        assert.equal(f.actionMuteCalls.some(action => action.userId === f.selfId), false);
        assert.equal(f.plugin.members.has(f.selfId), false);
        assert.ok(!f.plugin.panel.innerHTML.includes(`data-vg-key="user-${f.selfId}"`));
        f.step(50);
        assert.ok(f.actionMuteCalls.some(action => action.userId === f.aliceId && action.muted), "Normal detection should recover after identity returns");
    }],
    ["an absent UserStore fails closed while channel and voice stores remain available", f => {
        delete f.stores.UserStore;
        f.plugin.storeCache.delete("UserStore");
        f.setInbound({ [f.selfId]: [{ audioLevel: 0.99, audioDetected: true }] });
        assert.doesNotThrow(() => f.step(60));
        assert.equal(f.actionMuteCalls.length, 0, "Missing UserStore must not allow self-muting");
    }],
    ["a throwing current-user getter is safe at cold startup and recovers", f => {
        const original = f.stores.UserStore.getCurrentUser;
        f.stores.UserStore.getCurrentUser = () => { throw new Error("current-user cache updating at startup"); };
        f.setInbound({ [f.selfId]: [{ audioLevel: 0.99, audioDetected: true }] });
        assert.doesNotThrow(() => f.plugin.start());
        assert.equal(f.intervals.size, 1);
        assert.doesNotThrow(() => f.step(40));
        assert.equal(f.actionMuteCalls.length, 0);
        f.stores.UserStore.getCurrentUser = original;
        assert.doesNotThrow(() => f.step(4));
        assert.equal(f.plugin.members.has(f.selfId), false);
    }, { cold: true }],
    ["a transient current-user getter exception does not escape tick", f => {
        const original = f.stores.UserStore.getCurrentUser;
        f.stores.UserStore.getCurrentUser = () => { throw new Error("current-user cache updating"); };
        f.setInbound({ [f.selfId]: [{ audioLevel: 0.99, audioDetected: true }] });
        assert.doesNotThrow(() => f.step(4));
        assert.match(f.plugin.panel.innerHTML, /Connecting to Discord|Waiting for your Discord account/i);
        assert.equal(f.actionMuteCalls.length, 0);
        f.stores.UserStore.getCurrentUser = original;
        assert.doesNotThrow(() => f.step(45));
        assert.equal(f.actionMuteCalls.some(action => action.userId === f.selfId), false);
    }],
    ["identity loss hides participant controls, overlays, and snapshot rows", f => {
        const target = { style: {}, children: [], isConnected: true, appendChild(node) { this.children.push(node); } };
        f.plugin.attachOverlay(target, f.aliceId);
        assert.equal(f.plugin.overlays.size, 1);
        f.stores.UserStore.getCurrentUser = () => null;
        f.step(4);
        f.plugin.renderPanel(true);
        f.plugin.discoverOverlays();
        assert.equal(rowCount(f), 0, "Unknown self identity must not expose actionable participant rows");
        assert.equal(f.plugin.overlays.size, 0);
        assert.equal(f.plugin.snapshot().users.length, 0);
        for (const view of ["people", "overview"]) {
            f.plugin.setPanelView(view);
            const html = f.plugin.panel.innerHTML;
            assert.match(html, /CONNECTING TO DISCORD|Waiting for account/i, `${view}: unknown identity needs an explicit account waiting state`);
            assert.doesNotMatch(html, /Join (?:a )?(?:Discord )?(?:voice )?(?:channel|call)|Ready when you are/i, `${view}: account loss must not be mislabeled as a voice-channel standby state`);
        }
    }],
    ["identity loss preserves owned manual mutes but discards uncommitted evidence", f => {
        const original = f.stores.UserStore.getCurrentUser;
        f.plugin.manualMute(f.bobId);
        const ownership = f.plugin.ownedMutes.get(f.bobId);
        assert.ok(ownership);
        f.setInbound({ [f.selfId]: [{ audioLevel: 0.99, audioDetected: true }], [f.aliceId]: [{ audioLevel: 0.9, audioDetected: true }] });
        f.step(25);
        assert.ok(f.plugin.blastWindows.get(f.aliceId)?.length);
        assert.equal(f.plugin.members.get(f.aliceId).autoMutedAt, 0);
        const callsBeforeLoss = f.actionMuteCalls.length;
        f.stores.UserStore.getCurrentUser = () => null;
        f.step(70);
        assert.equal(f.localMuteStates.get(f.bobId), true, "Existing manual mute must remain muted");
        assert.equal(f.plugin.ownedMutes.get(f.bobId), ownership, "Do not misinterpret identity loss as a disconnect or give away mute ownership");
        assert.ok(f.plugin.members.get(f.bobId).manualMutedAt);
        assert.equal(f.actionMuteCalls.length, callsBeforeLoss, "Identity loss cannot create fresh mute/unmute actions");
        assert.equal(f.plugin.blastWindows.size, 0, "Unknown identity must discard incomplete blast evidence");
        f.stores.UserStore.getCurrentUser = original;
        f.step(5);
        assert.equal(f.plugin.members.get(f.aliceId).autoMutedAt, 0, "Recovery must collect fresh evidence instead of using pre-loss samples");
        f.step(40);
        assert.ok(f.plugin.members.get(f.aliceId).autoMutedAt, "Normal automatic protection must recover");
        assert.equal(f.localMuteStates.get(f.bobId), true);
        assert.equal(f.actionMuteCalls.some(action => action.userId === f.selfId), false);
    }],
    ["a scheduled Soft release continues while current identity is unavailable", f => {
        f.plugin.setUserPolicy(f.aliceId, "soft:10");
        f.setInbound({ [f.aliceId]: [{ audioLevel: 0.9, audioDetected: true }] });
        f.step(40);
        assert.ok(f.plugin.members.get(f.aliceId).softUnmuteAt);
        assert.equal(f.localMuteStates.get(f.aliceId), true);
        f.stores.UserStore.getCurrentUser = () => null;
        f.step(140);
        assert.equal(f.localMuteStates.get(f.aliceId), false, "Identity guard must not freeze a known owned Soft release");
        assert.equal(f.plugin.ownedMutes.has(f.aliceId), false);
    }],
    ["pending audio recovery continues while current identity is unavailable", f => {
        f.setNow(5000);
        assert.equal(f.plugin.applyAutoMute(f.aliceId, f.plugin.members.get(f.aliceId), "Known automatic mute before identity loss", 5000, false, f.plugin.signals.get(f.aliceId).blast), true);
        f.setActionAppliesMute(false);
        f.plugin.setTrusted(f.aliceId, true);
        assert.equal(f.plugin.pendingRestores.has(f.aliceId), true);
        f.stores.UserStore.getCurrentUser = () => null;
        f.setActionAppliesMute(true);
        f.step(30);
        assert.equal(f.localMuteStates.get(f.aliceId), false);
        assert.equal(f.plugin.pendingRestores.has(f.aliceId), false);
        assert.equal(f.plugin.ownedMutes.has(f.aliceId), false);
    }],
    ["non-string profile display names degrade to a safe label", f => {
        f.stores.UserStore.getUser = id => ({ id, globalName: { unexpected: true }, username: 123 });
        assert.doesNotThrow(() => f.step(4));
        assert.equal(rowCount(f), 2);
    }],
    ["profile markup is escaped in roster, search, and activity views", f => {
        f.stores.UserStore.getUser = id => ({ id, username: '<img src=x onerror="unsafe()">' });
        f.plugin.panelSearch = '" onfocus="unsafe()';
        f.plugin.renderPanel(true);
        assert.ok(!f.plugin.panel.innerHTML.includes('value="" onfocus="unsafe()'));
        f.plugin.panelSearch = "";
        f.plugin.renderPanel(true);
        assert.ok(f.plugin.panel.innerHTML.includes("&lt;img"));
        assert.ok(!f.plugin.panel.innerHTML.includes('<img src=x'));
        f.plugin.recordActivity("manual-mute", f.aliceId, '<svg onload="unsafe()">', '<b>detail</b>');
        f.plugin.setPanelView("activity");
        assert.ok(!f.plugin.panel.innerHTML.includes('<svg onload="unsafe()">'));
        assert.ok(f.plugin.panel.innerHTML.includes("&lt;svg"));
    }],
    ["mute clicks consult current state rather than a stale data-muted attribute", f => {
        f.plugin.manualMute(f.aliceId);
        assert.equal(f.localMuteStates.get(f.aliceId), true);
        click(f, "toggle-mute", { "data-user-id": f.aliceId, "data-muted": "false" });
        assert.equal(f.localMuteStates.get(f.aliceId), false);
        assert.ok(f.plugin.members.get(f.aliceId).manualUnmuteUntil > 0);
    }],
    ["keyboard checkbox and slider events persist without requiring a click", f => {
        const checkbox = actionTarget({ "data-vg-setting": "showPeakLevel" }, { type: "checkbox", checked: false });
        f.plugin.panel.oninput({ target: checkbox });
        assert.equal(f.plugin.settings.showPeakLevel, false);
        f.plugin.panel.onchange({ target: checkbox });
        assert.equal(f.dataStore.get("settings").showPeakLevel, false);
        const slider = actionTarget({ "data-vg-setting": "loudThreshold" }, { type: "range", value: "0.73" });
        f.plugin.panel.oninput({ target: slider });
        assert.equal(f.plugin.settings.loudThreshold, 0.73);
        f.plugin.panel.onchange({ target: slider });
        assert.equal(f.dataStore.get("settings").loudThreshold, 0.73);
    }],
    ["Escape first closes a display group, then returns to the previous view", f => {
        f.plugin.setPanelView("activity");
        f.plugin.setPanelView("settings");
        click(f, "settings-tab", { "data-tab": "display" });
        f.plugin.settingsGroup = "audio";
        f.plugin.panel.onkeydown({ key: "Escape" });
        assert.equal(f.plugin.settingsGroup, null);
        assert.equal(f.plugin.panelView, "settings");
        f.plugin.panel.onkeydown({ key: "Escape" });
        assert.equal(f.plugin.panelView, "activity");
    }],
    ["collapsed controls are inert and a reopened drawer restores its search state", f => {
        f.plugin.panelSearch = "Alice";
        f.plugin.togglePolicyMenu(f.aliceId);
        f.plugin.toggleDrawer();
        assert.equal(f.plugin.policyMenuUserId, null);
        assert.ok(f.plugin.panel.innerHTML.includes('inert aria-hidden="true"'));
        f.plugin.toggleDrawer();
        assert.equal(f.plugin.panelSearch, "Alice");
        assert.equal(rowCount(f), 2);
        assert.ok(f.plugin.panel.innerHTML.includes('matched" data-vg-key="user-' + f.aliceId + '"'));
    }],
    ["fifty rows remain unique and alphabetically stable while levels change", f => {
        const names = new Map();
        f.voiceMembers.clear();
        f.voiceMembers.add(f.selfId);
        const inbound = {};
        for (let i = 0; i < 50; i++) {
            const id = String(800000000000000000n + BigInt(i));
            f.voiceMembers.add(id);
            names.set(id, `Person ${String(49 - i).padStart(2, "0")}`);
            inbound[id] = [{ audioLevel: i % 2 ? 0.42 : 0.03, audioDetected: true }];
        }
        f.stores.UserStore.getUser = id => ({ id, username: names.get(id) || "You" });
        f.setInbound(inbound);
        f.step(4);
        f.plugin.renderPanel(true);
        assert.equal(rowCount(f), 50);
        const order = () => Array.from(f.plugin.panel.innerHTML.matchAll(/data-vg-key="user-(\d+)"/g), m => m[1]);
        const before = order();
        assert.equal(new Set(before).size, 50);
        assert.equal(names.get(before[0]), "Person 00");
        for (const value of Object.values(inbound)) value[0].audioLevel = value[0].audioLevel === 0.42 ? 0.03 : 0.42;
        f.step(4);
        f.plugin.renderPanel(true);
        assert.deepEqual(order(), before);
    }],
    ["discovery requests coalesce and disabled tile meters do not recreate overlays", f => {
        assert.equal(f.timeouts.size, 1);
        for (let i = 0; i < 20; i++) f.plugin.scheduleDiscovery(i % 2 === 0);
        assert.equal(f.timeouts.size, 1);
        f.plugin.updateDisplaySetting("tileMeters", false);
        f.flushTimeouts();
        assert.equal(f.plugin.overlays.size, 0);
        assert.equal(f.timeouts.size, 0);
    }],
    ["detached overlays are removed and temporary positioning is restored", f => {
        const target = { style: {}, children: [], isConnected: true, appendChild(node) { this.children.push(node); } };
        f.plugin.attachOverlay(target, f.aliceId);
        assert.equal(target.style.position, "relative");
        assert.equal(f.plugin.overlays.size, 1);
        target.isConnected = false;
        f.plugin.paintOverlays();
        assert.equal(f.plugin.overlays.size, 0);
        assert.equal(target.style.position, "");
    }],
    ["repeated start-stop cycles leave one sampler and no orphaned observers or listeners", f => {
        for (let i = 0; i < 10; i++) {
            assert.equal(f.intervals.size, 1);
            assert.equal(f.listeners.size, 4);
            assert.equal(f.observers.filter(observer => observer.connected).length, 1);
            f.plugin.stop();
            assert.equal(f.intervals.size, 0);
            assert.equal(f.timeouts.size, 0);
            assert.equal(f.listeners.size, 0);
            assert.equal(f.observers.some(observer => observer.connected), false);
            assert.equal(f.elements.has("vg-rtp-panel"), false);
            assert.equal(f.addedStyles.size, 0);
            assert.equal(f.context.window.voiceGuardV2Debug, undefined);
            f.plugin.start();
        }
    }],
    ["persistence failures do not stop rendered controls or lifecycle cleanup", f => {
        f.plugin.stop();
        f.context.BdApi.Data.load = () => { throw new Error("fixture read rejected"); };
        f.context.BdApi.Data.save = () => { throw new Error("fixture write rejected"); };
        assert.doesNotThrow(() => f.plugin.start());
        assert.doesNotThrow(() => f.plugin.toggleDrawer());
        assert.doesNotThrow(() => f.plugin.toggleDrawer());
        assert.doesNotThrow(() => f.plugin.updateDisplaySetting("compactRows", true));
        assert.ok(f.plugin.panel.innerHTML.includes("VoiceGuard"));
    }],
];

let failures = 0;
for (const [name, test, options] of cases) {
    const fixture = fresh();
    try {
        if (!options?.cold) fixture.plugin.start();
        test(fixture);
        assert.equal(fixture.networkCalls(), 0, "UI tests must make no network requests");
        console.log("PASS " + name);
    } catch (error) {
        failures++;
        console.error("FAIL " + name + "\n" + error.stack);
    } finally {
        try { fixture.plugin.stop(); }
        catch (error) { failures++; console.error("FAIL cleanup: " + error.stack); }
    }
}
console.log(`UI edge cases: ${cases.length - failures}/${cases.length} passed. Pure VM; no browser, live Discord, network, or real settings.`);
process.exitCode = failures ? 1 : 0;
