// The fixture uses fake Discord stores, a fake clock and an in-memory settings store.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "test_voiceguard_ui_edges.js"), "utf8").split("const cases = [")[0];
const sandbox = { require, __dirname, process: { argv: [process.execPath, __filename] }, console, module: { exports: {} } };
vm.runInNewContext(source + "\nmodule.exports = fresh;", sandbox);
const fresh = sandbox.module.exports;
const copy = value => JSON.stringify(value);

function geometry(fixture, { width, roster, viewportWidth, viewportHeight, top = 8, chrome = 45 }) {
    const panel = fixture.plugin.panel;
    const gutter = viewportWidth <= 360 ? 6 : 10;
    const height = roster + chrome;
    panel.getBoundingClientRect = () => ({ width, height, top, right: viewportWidth - gutter });
    panel.ownerDocument = { defaultView: {
        innerWidth: viewportWidth, innerHeight: viewportHeight,
        getComputedStyle: () => ({ maxHeight: (viewportHeight - top - gutter) + "px" })
    } };
    panel.querySelector = selector => selector === ".vg5-roster, .vg5-empty"
        ? { getBoundingClientRect: () => ({ height: roster }) } : null;
    return panel;
}

function pointer(panel, x = 150, y = 130) {
    let captured = null;
    const grip = {
        closest: selector => selector === "[data-vg-resize]" ? grip : null,
        setPointerCapture: id => { captured = id; },
        hasPointerCapture: id => captured === id,
        releasePointerCapture: () => { captured = null; },
        focus() {}
    };
    const event = (dx = 0, dy = 0, id = 12) => ({target:grip,button:0,pointerId:id,clientX:x+dx,clientY:y+dy});
    return { grip, event, captured: () => captured, down: () => panel.onpointerdown(event()) };
}

function numberField(key, committed, value) {
    const attributes = new Map([["data-vg-appearance", key], ["value", String(committed)]]);
    return {
        value: String(value), getAttribute: key => attributes.get(key) ?? null,
        setAttribute: (key, value) => attributes.set(key, String(value))
    };
}

const regressions = [
    ["a height-only drag in a narrow window retains the remembered width", f => {
        f.plugin.updateAppearance({ width: 560, height: 180 });
        const panel = geometry(f, { width: 308, roster: 180, viewportWidth: 320, viewportHeight: 260 });
        const p = pointer(panel);
        p.down();
        panel.onpointermove(p.event(0, -26));
        panel.onpointerup(p.event(0, -26));
        assert.equal(f.plugin.appearance.height, 154);
        assert.equal(f.plugin.appearance.width, 560);
    }],
    ["a width-only drag in a short window retains the remembered height", f => {
        f.plugin.updateAppearance({ width: 420, height: 380 });
        const panel = geometry(f, { width: 420, roster: 200, viewportWidth: 700, viewportHeight: 260 });
        const p = pointer(panel);
        p.down();
        panel.onpointermove(p.event(-42, 0));
        panel.onpointerup(p.event(-42, 0));
        assert.equal(f.plugin.appearance.width, 462);
        assert.equal(f.plugin.appearance.height, 380);
    }],
    ["no-op drags and keyboard steps at the window edge preserve a larger preferred size", f => {
        f.plugin.updateAppearance({ width: 560, height: 180 });
        const panel = geometry(f, { width: 308, roster: 180, viewportWidth: 320, viewportHeight: 260 });
        const p = pointer(panel);
        p.down();
        panel.onpointermove(p.event());
        panel.onpointerup(p.event());
        assert.equal(f.plugin.appearance.width, 560, "pointer movement without a delta overwrote the preference");
        panel.onkeydown({target:p.grip,key:"ArrowLeft"});
        assert.equal(f.plugin.appearance.width, 560, "a keyboard step beyond the edge overwrote the preference");
    }],
    ["the release position is respected even when there was no preceding move event", f => {
        const panel = geometry(f, { width: 340, roster: 100, viewportWidth: 1280, viewportHeight: 720, top: 52 });
        const p = pointer(panel);
        p.down();
        panel.onpointerup(p.event(-75, 39));
        assert.equal(f.plugin.appearance.width, 415);
        assert.equal(f.plugin.appearance.height, 139);
        assert.equal(p.captured(), null);
    }],
    ["Escape from an unfinished size edit discards the draft before focus leaves", f => {
        f.plugin.updateAppearance({ width: 435 });
        f.plugin.setPanelView("settings");
        const input = numberField("width", 435, 500);
        f.plugin.panel.onkeydown({target:input,key:"Escape"});
        assert.equal(input.value, "435");
        assert.equal(f.plugin.panelView, "settings");
        // Simulate the eventual blur after the user has canceled the edit.
        f.plugin.appearanceFieldChanged(input);
        assert.equal(f.plugin.appearance.width, 435);
    }],
    ["a failed save rolls a resize preview back without affecting audio protection", f => {
        f.plugin.updateAppearance({ width: 420, height: 117 });
        const baseline = copy(f.dataStore.get("appearance"));
        const panel = geometry(f, { width: 420, roster: 117, viewportWidth: 1280, viewportHeight: 720, top: 52 });
        const style = new Map();
        panel.style.setProperty = (key, value) => style.set(key, value);
        const save = f.context.BdApi.Data.save;
        f.context.BdApi.Data.save = (name, key, value) => {
            if (key === "appearance") throw new Error("Preference store unavailable");
            return save(name, key, value);
        };
        const p = pointer(panel);
        p.down();
        panel.onpointermove(p.event(-60, 42));
        assert.equal(style.get("--vg-panel-width"), "480px");
        panel.onpointerup(p.event(-60, 42));
        assert.equal(style.get("--vg-panel-width"), "420px");
        assert.equal(style.get("--vg-roster-height"), "117px");
        assert.equal(copy(f.dataStore.get("appearance")), baseline);
        assert.equal(f.plugin.protectionStorageReady(), true);
    }],
    ["collapsing or stopping the plugin during a drag releases capture and discards the preview", f => {
        f.plugin.updateAppearance({ width: 420, height: 117 });
        const baseline = copy(f.dataStore.get("appearance"));
        const panel = geometry(f, { width: 420, roster: 117, viewportWidth: 1280, viewportHeight: 720, top: 52 });
        const p = pointer(panel);
        p.down();
        panel.onpointermove(p.event(-60, 42));
        f.plugin.toggleDrawer();
        assert.equal(p.captured(), null);
        assert.equal(f.plugin.resizeDrag, null);
        f.plugin.toggleDrawer();
        p.down();
        panel.onpointermove(p.event(-60, 42));
        f.plugin.stop();
        assert.equal(p.captured(), null);
        assert.equal(f.plugin.resizeDrag, null);
        assert.equal(copy(f.dataStore.get("appearance")), baseline);
        assert.equal(f.intervals.size, 0);
    }]
];

let failures = 0;
for (const [name, test] of regressions) {
    const fixture = fresh();
    fixture.plugin.start();
    try {
        test(fixture);
        console.log("PASS " + name);
    } catch (error) {
        failures++;
        console.error("FAIL " + name + "\n" + error.message);
    } finally { fixture.plugin.stop(); }
}

function soak() {
    const f = fresh();
    f.plugin.start();
    let seed = 0x7bf40ab9;
    const random = n => {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        return (seed >>> 0) % n;
    };
    const axes = ["width", "height"];
    const styles = ["discord", "graphite", "midnight", "light", "contrast"];
    const fontStyles = ["discord", "system", "readable", "mono"];
    const text = [85,100,115,130,145];
    const protectedSettings = copy(f.dataStore.get("settings"));
    const portable = copy(f.plugin.exportPreferencePreset());
    let committed = 0;
    let canceled = 0;
    let noOp = 0;
    const attempts = 2400;
    try {
        for (let index = 0; index < attempts; index++) {
            const viewportWidth = [280,320,360,480,640,1280,1920][random(7)];
            const viewportHeight = [240,260,320,540,720,1040][random(6)];
            const preferred = {
                theme:styles[random(styles.length)],font:fontStyles[random(fontStyles.length)],textSize:text[random(text.length)],
                width:240+random(961),height:22+random(699)
            };
            f.plugin.updateAppearance(preferred);
            const baseline = copy(f.dataStore.get("appearance"));
            const gutter = viewportWidth <= 360 ? 12 : 20;
            const top = viewportHeight <= 540 ? 8 : 52;
            const width = Math.min(preferred.width, viewportWidth - gutter);
            const roster = Math.min(preferred.height, viewportHeight - top - 57);
            const panel = geometry(f, {width,roster,viewportWidth,viewportHeight,top});
            const p = pointer(panel);
            const axis = axes[random(2)];
            const delta = (random(2) ? 1 : -1) * (6 + random(150));
            const ending = random(6);
            const motion = axis === "width" ? p.event(delta,0) : p.event(0,delta);
            assert.equal(f.plugin.resizeDrag, null);
            p.down();
            assert.equal(p.captured(), 12);
            panel.onpointermove({...motion,pointerId:19});
            assert.equal(copy(f.dataStore.get("appearance")), baseline);
            if (ending === 0) {
                panel.onpointermove(motion);
                panel.onpointercancel(motion);
                canceled++;
            } else if (ending === 1) {
                panel.onpointermove(motion);
                panel.onlostpointercapture(motion);
                canceled++;
            } else if (ending === 2) {
                panel.onpointermove(motion);
                panel.onkeydown({target:p.grip,key:"Escape"});
                canceled++;
            } else if (ending === 3) {
                panel.onpointerup(p.event());
                noOp++;
            } else {
                if (ending === 4) panel.onpointermove(motion);
                assert.equal(copy(f.dataStore.get("appearance")), baseline);
                panel.onpointerup(motion);
                committed++;
            }
            assert.equal(f.plugin.resizeDrag, null);
            assert.equal(p.captured(), null);
            const saved = f.dataStore.get("appearance");
            if (ending < 4) assert.equal(copy(saved), baseline, "cancel or no-op changed a stored preference");
            assert.equal(saved[axis === "width" ? "height" : "width"], preferred[axis === "width" ? "height" : "width"]);
            for (const key of ["theme","font","textSize"]) assert.equal(saved[key], preferred[key]);
            assert.ok(saved.width===null||(saved.width>=240&&saved.width<=1200&&Number.isInteger(saved.width)));
            assert.ok(saved.height===null||(saved.height>=22&&saved.height<=720&&Number.isInteger(saved.height)));
            assert.equal(copy(f.dataStore.get("settings")), protectedSettings);
            assert.equal(copy(f.plugin.exportPreferencePreset()), portable);
            assert.equal(f.networkCalls(), 0);
            if (index % 40 === 0) {
                f.step(3);
                assert.ok(f.elements.has("vg-rtp-panel"));
                assert.equal(f.intervals.size, 1);
            }
        }
    } finally { f.plugin.stop(); }
    assert.equal(f.intervals.size, 0);
    assert.equal(f.elements.has("vg-rtp-panel"), false);
    console.log(JSON.stringify({ suite:"resize resilience soak", attempts, committed, canceled, noOp, seed:"0x7bf40ab9", failures:0 }));
}

if (!failures && process.argv.includes("--stress")) soak();
console.log(JSON.stringify({ suite:"resize regressions", cases:regressions.length, failures }));
process.exitCode = failures ? 1 : 0;
