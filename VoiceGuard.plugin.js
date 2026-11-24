/**
 * @name VoiceGuard
 * @author VoiceGuardTeam
 * @description A resizable Discord voice roster with local protection and a customizable appearance.
 * @version 1.0.0
 */

const VG_THEMES = {
    discord: "Discord",
    graphite: "Graphite",
    midnight: "Midnight",
    light: "Light",
    contrast: "Contrast"
};
const VG_FONTS = { discord: "Discord", system: "System", readable: "Readable", mono: "Mono" };
const VG_TEXT_SIZES = [85, 100, 115, 130, 145];
const VG_SIZE_LIMITS = { width: [240, 1200], height: [22, 720] };
const VG_PANEL_SIZES = {
    fit: { width: null, height: null },
    compact: { width: 300, height: 80 },
    roomy: { width: 480, height: 176 }
};
const VG_DEFAULT_APPEARANCE = Object.freeze({ theme: "discord", font: "discord", textSize: 100, ...VG_PANEL_SIZES.fit });

module.exports = class VoiceGuard {
    constructor(meta) {
        this.meta = meta;
        this.version = "1.0.0";
        this.detectorProfile = "rolling-v1";
        this.panel = null;
        this.styleNode = null;
        this.boundStoreUpdate = null;
        this.subscribedStores = [];
        this.storeCache = new Map();
        this.mediaActionsCache = null;
        this.trustedUsers = {};
        this.softVoicebans = {};
        this.volumeBeforeMute = new Map();
        this.forcedZeroUsers = new Set();
        this.ownedMutes = new Map();
        this.pendingRestores = new Map();
        this.panelSearch = "";
        this.toolsOpen = false;
        this.findOpen = false;
        this.detailsOpen = false;
        this.panelView = "people";
        this.inspectedUserId = null;
        this.rosterFocusId = null;
        this.rosterChannelId = null;
        this.rosterIds = [];
        this.rosterLayout = null;
        this.rosterElement = null;
        this.rosterObserver = null;
        this.appearance = VG_DEFAULT_APPEARANCE;
        this.appearanceReadable = false;
        this.resizeDrag = null;
        this.appearanceSection = "style";
        this.nativeAppearanceForm = null;
        this.settingsTab = "appearance";
        this.settingsGroup = null;
        this.settingsPage = 0;
        this.settingsReturnView = "people";
        this.activity = [];
        this.activityEventId = null;
        this.activitySerial = 0;
        this.presetNotice = null;
        this.persistenceWarnings = new Set();
        this.unreadableStores = new Set();
        this.storageRetryAt = 0;
        this.pendingAutoPause = false;
        this.sessionAccountId = null;
        this.lastSeenAccountId = null;
        this.audioRestoresRead = false;
        this.quarantinedRestores = new Map();
        this.completedRestores = new Set();
        this.membershipUnavailable = false;
        this.panelInteracting = false;
        this.panelFilter = "all";
        this.policyMenuUserId = null;
        this.levelTimer = null;
        this.domObserver = null;
        this.discoveryTimer = null;
        this.lastDiscoveryAt = 0;
        this.lastTickAt = 0;
        this.lastPanelRenderAt = 0;
        this.signals = new Map();
        this.blastWindows = new Map();
        this.members = new Map();
        this.trackedChannelId = null;
        this.membershipInitialized = false;
        this.offenses = {};
        this.legacyOffensesRetired = 0;
        this.overlays = new Map();
        this.telemetry = this.emptyTelemetry("Starting");
        this.timing = { samples: 0, totalMs: 0, lastMs: 0, maxMs: 0 };
        this.settings = {
            debugVisuals: true,
            tileMeters: true,
            panelCollapsed: false,
            showAudioLevels: true,
            showLevelMeter: true,
            showLevelValue: true,
            showDbfs: true,
            showPeakLevel: true,
            showBlastScore: true,
            showAvatars: true,
            loadProfileImages: false,
            showStatusLabels: true,
            showQuickPolicies: true,
            showCallSummary: true,
            showConnectionDetails: true,
            showThresholdMarker: true,
            showPeakMarker: true,
            compactRows: false,
            reducePanelMotion: false,
            levelDisplayFormat: "percent",
            updateInterval: 80,
            threshold: 0.010,
            riseSmoothing: 0.72,
            decayMultiplier: 0.84,
            minVisibleLevel: 0.020,
            loudThreshold: 0.65,
            autoMute: true,
            newcomerWindowSeconds: 90,
            newcomerLoudSeconds: 2.0,
            establishedLoudSeconds: 3.0,
            repeatLoudSeconds: 1.5,
            analysisWindowSeconds: 5.0,
            blastActiveRatio: 0.70,
            blastLoudRatio: 0.60,
            blastRmsLevel: 0.72,
            extremeLevel: 0.92,
            extremeHoldSeconds: 2.0,
            extremeRatio: 0.60,
            extremeRmsLevel: 0.86,
            softDurationSeconds: 1,
            softEscalateCount: 3,
            softFalsePositiveGapSeconds: 5,
            softRearmGraceSeconds: 3,
            quickLeaveSeconds: 90,
            rememberOffenders: false,
            muteRememberedOnRejoin: true,
            offenseRetentionDays: 30,
            detectorProfile: this.detectorProfile
        };
        this.defaultSettings = Object.freeze({ ...this.settings });
    }

    start() {
        this.persistenceWarnings.clear();
        this.loadSettings();
        this.loadUiState();
        this.loadAppearance();
        this.loadOffenses();
        this.loadTrustedUsers();
        this.loadSoftVoicebans();
        this.loadAudioRestores();
        this.addStyles();
        this.createPanel();
        this.subscribe();
        this.startDomObserver();
        this.startLevelLoop();
        this.saveRuntimeStatus();
        const retired = this.legacyOffensesRetired ? `; ${this.legacyOffensesRetired} old flags retired` : "";
        BdApi.UI.showToast(`VoiceGuard continuous blast detector active${retired}`, { type: "success" });
        if (this.persistenceWarnings.size) BdApi.UI.showToast("VoiceGuard ignored unsupported saved metadata. Valid audio recovery records were preserved.", { type: "warning", timeout: 6000 });
    }

    stop() {
        this.unsubscribe();
        this.stopLevelLoop();
        this.stopDomObserver();
        for (const userId of this.ownedMutes.keys()) this.releaseOwnedMute(userId, Date.now(), true);
        this.saveAudioRestores();
        if (this.ownedMutes.size) {
            BdApi.UI.showToast("Some audio could not be restored. VoiceGuard will retry when enabled again.", { type: "warning" });
        }
        this.clearOverlays();
        this.disconnectRoster();
        this.finishResize(false, false);
        this.nativeAppearanceForm = null;
        if (this.panel) this.panel.remove();
        this.panel = null;
        this.removeStyles();
        this.signals.clear();
        this.blastWindows.clear();
        this.members.clear();
        this.storeCache.clear();
        this.mediaActionsCache = null;
        this.volumeBeforeMute.clear();
        this.forcedZeroUsers.clear();
        this.panelInteracting = false;
        this.policyMenuUserId = null;
        this.toolsOpen = false;
        this.findOpen = false;
        this.detailsOpen = false;
        this.inspectedUserId = null;
        this.rosterFocusId = null;
        this.rosterChannelId = null;
        this.rosterIds = [];
        this.rosterLayout = null;
        this.ownedMutes.clear();
        this.pendingRestores.clear();
        this.quarantinedRestores.clear();
        this.sessionAccountId = null;
        this.lastSeenAccountId = null;
        this.audioRestoresRead = false;
        this.trackedChannelId = null;
        this.membershipInitialized = false;
        this.membershipUnavailable = false;
        this.activity = [];
        this.activityEventId = null;
    }

    emptyTelemetry(reason) {
        return {
            mediaStore: false,
            engine: false,
            connectionCount: 0,
            connectionState: null,
            inbound: false,
            inboundEntries: 0,
            mappedUsers: 0,
            sampledAt: 0,
            reason
        };
    }

    validSnowflake(value) {
        return typeof value === "string" && /^\d{15,25}$/.test(value) ? value : null;
    }

    storedNumber(value, fallback = null) {
        const scalar = typeof value === "number" || (typeof value === "string" && value.trim() !== "");
        const number = scalar ? Number(value) : NaN;
        return Number.isFinite(number) ? number : fallback;
    }

    boundedText(value, length = 160) {
        return typeof value === "string" ? value.slice(0, length) : "";
    }

    clearDetectionEvidence() {
        this.blastWindows.clear();
        for (const id of this.signals.keys()) this.resetBlastWindow(id);
        for (const member of this.members.values()) member.violationDetectedAt = 0;
    }

    readSaved(key) {
        try {
            const value = BdApi.Data.load(this.meta.name, key);
            if (this.unreadableStores.delete(key)) this.clearDetectionEvidence();
            return { ok: true, value };
        } catch (_) {
            if (!this.unreadableStores.has(key)) this.clearDetectionEvidence();
            this.unreadableStores.add(key);
            this.storageRetryAt = Math.max(this.storageRetryAt, Date.now() + 1000);
            return { ok: false };
        }
    }

    writeSaved(key, value) {
        // A failed read never authorizes replacing the unknown saved value.
        if (this.unreadableStores.has(key)) return false;
        try { BdApi.Data.save(this.meta.name, key, value); return true; } catch (_) { return false; }
    }

    protectionStorageReady() {
        return this.audioRestoresRead && !this.accountChanged() &&
            !["settings", "trustedUsers", "softVoicebans", "offenses", "audioRestores"].some(key => this.unreadableStores.has(key));
    }

    storesWritable(...keys) {
        return keys.every(key => !this.unreadableStores.has(key));
    }

    retrySavedStores(now) {
        if (!this.unreadableStores.size || now < this.storageRetryAt) return;
        this.storageRetryAt = now + 1000;
        const failed = new Set(this.unreadableStores);
        for (const [key, load] of [
            ["settings", "loadSettings"], ["trustedUsers", "loadTrustedUsers"],
            ["offenses", "loadOffenses"], ["softVoicebans", "loadSoftVoicebans"],
            ["audioRestores", "loadAudioRestores"]
        ]) if (failed.has(key)) this[load]();
        if (failed.has("uiState") || failed.has("runtimeStatus")) this.loadUiState();
    }

    savedUserRecords(saved, label, normalize) {
        const clean = Object.create(null);
        if (!saved || typeof saved !== "object" || Array.isArray(saved)) return clean;
        for (const id in saved) {
            if (!Object.prototype.hasOwnProperty.call(saved, id)) continue;
            if (!this.validSnowflake(id)) continue;
            try {
                const record = normalize(saved[id], id);
                if (record) clean[id] = record;
            } catch (_) { this.persistenceWarnings.add(label); }
        }
        return clean;
    }

    activeRemoteParticipant(userId) {
        const id = this.validSnowflake(userId);
        const self = this.currentUserId();
        if (!id || !self || id === self || this.accountChanged()) return false;
        const channelId = this.currentVoiceChannelId(self);
        if (!channelId) return false;
        const participants = this.channelUsers(channelId);
        return !this.membershipUnavailable && participants.includes(id);
    }

    clamp(value, min = 0, max = 1) {
        const scalar = typeof value === "number" || (typeof value === "string" && value.trim() !== "");
        const number = scalar ? Number(value) : NaN;
        if (!Number.isFinite(number)) return min;
        return Math.min(max, Math.max(min, number));
    }

    normalizeSettings() {
        if (!["percent", "raw", "dbfs"].includes(this.settings.levelDisplayFormat)) this.settings.levelDisplayFormat = "percent";
        for (const [key, fallback] of Object.entries(this.defaultSettings)) {
            const value = this.settings[key];
            const numeric = typeof value === "number" || (typeof value === "string" && value.trim() !== "");
            if (typeof fallback === "number" && (!numeric || !Number.isFinite(Number(value)))) {
                this.settings[key] = fallback;
            } else if (typeof fallback === "boolean" && typeof value !== "boolean") {
                this.settings[key] = fallback;
            }
        }
        this.settings.updateInterval = Math.round(this.clamp(this.settings.updateInterval, 50, 250));
        this.settings.threshold = this.clamp(this.settings.threshold, 0.001, 0.25);
        this.settings.riseSmoothing = this.clamp(this.settings.riseSmoothing, 0.05, 1);
        this.settings.decayMultiplier = this.clamp(this.settings.decayMultiplier, 0.25, 0.99);
        this.settings.minVisibleLevel = this.clamp(this.settings.minVisibleLevel, 0, 0.2);
        this.settings.loudThreshold = this.clamp(this.settings.loudThreshold, 0.1, 1);
        this.settings.newcomerWindowSeconds = this.clamp(this.settings.newcomerWindowSeconds, 10, 300);
        this.settings.newcomerLoudSeconds = this.clamp(this.settings.newcomerLoudSeconds, 1.5, 10);
        this.settings.establishedLoudSeconds = this.clamp(this.settings.establishedLoudSeconds, 2, 15);
        this.settings.repeatLoudSeconds = this.clamp(this.settings.repeatLoudSeconds, 1, 5);
        this.settings.analysisWindowSeconds = Math.max(
            this.clamp(this.settings.analysisWindowSeconds, 3, 15),
            this.settings.newcomerLoudSeconds,
            this.settings.establishedLoudSeconds,
            this.settings.repeatLoudSeconds,
            this.clamp(this.settings.extremeHoldSeconds, 1.5, 5)
        );
        this.settings.blastActiveRatio = this.clamp(this.settings.blastActiveRatio, 0.5, 0.98);
        this.settings.blastLoudRatio = this.clamp(this.settings.blastLoudRatio, 0.4, 0.95);
        this.settings.blastRmsLevel = this.clamp(this.settings.blastRmsLevel, 0.4, 0.95);
        this.settings.extremeLevel = this.clamp(this.settings.extremeLevel, 0.5, 1);
        this.settings.extremeHoldSeconds = this.clamp(this.settings.extremeHoldSeconds, 1.5, 5);
        this.settings.extremeRatio = this.clamp(this.settings.extremeRatio, 0.3, 0.95);
        this.settings.extremeRmsLevel = this.clamp(this.settings.extremeRmsLevel, 0.5, 0.98);
        this.settings.softDurationSeconds = 1;
        this.settings.softEscalateCount = Math.round(this.clamp(this.settings.softEscalateCount, 2, 5));
        this.settings.softFalsePositiveGapSeconds = this.clamp(this.settings.softFalsePositiveGapSeconds, 3, 15);
        this.settings.quickLeaveSeconds = this.clamp(this.settings.quickLeaveSeconds, 15, 300);
        this.settings.offenseRetentionDays = this.clamp(this.settings.offenseRetentionDays, 1, 365);
        this.settings.debugVisuals = this.settings.debugVisuals !== false;
        this.settings.tileMeters = this.settings.tileMeters !== false;
        this.settings.panelCollapsed = this.settings.panelCollapsed === true;
        this.settings.autoMute = this.settings.autoMute !== false;
        this.settings.rememberOffenders = this.settings.rememberOffenders === true;
        this.settings.muteRememberedOnRejoin = this.settings.muteRememberedOnRejoin !== false;
        this.settings.softRearmGraceSeconds = this.clamp(this.settings.softRearmGraceSeconds, 1, 10);
        this.settings.detectorProfile = this.detectorProfile;
    }

    loadSettings() {
        const loaded = this.readSaved("settings");
        if (!loaded.ok) return false;
        const saved = loaded.value;
        let migrated = false;
        try {
            if (saved && typeof saved === "object" && !Array.isArray(saved)) {
                migrated = true;
                try { migrated = saved.detectorProfile !== this.detectorProfile; } catch (_) {}
                for (const key of Object.keys(this.defaultSettings)) {
                    if (!Object.prototype.hasOwnProperty.call(saved, key)) continue;
                    try { this.settings[key] = saved[key]; } catch (_) {}
                }
            }
        } catch (_) {}
        this.normalizeSettings();
        if (migrated) {
            this.settings.newcomerLoudSeconds = Math.max(2, this.settings.newcomerLoudSeconds);
            this.settings.establishedLoudSeconds = Math.max(3, this.settings.establishedLoudSeconds);
            this.settings.repeatLoudSeconds = Math.max(1.5, this.settings.repeatLoudSeconds);
            this.settings.extremeHoldSeconds = Math.max(2, this.settings.extremeHoldSeconds);
        }
        if (this.pendingAutoPause) this.settings.autoMute = false;
        this.saveSettings();
        return true;
    }

    saveSettings() {
        if (!this.storesWritable("settings")) return false;
        this.normalizeSettings();
        if (this.pendingAutoPause) this.settings.autoMute = false;
        const saved = this.writeSaved("settings", this.settings);
        if (saved) this.pendingAutoPause = false;
        return saved;
    }

    loadUiState() {
        const savedRead = this.readSaved("uiState");
        const runtimeRead = this.readSaved("runtimeStatus");
        if (!savedRead.ok || !runtimeRead.ok) return false;
        try {
            const saved = savedRead.value;
            const runtime = runtimeRead.value;
            if (typeof saved?.panelCollapsed === "boolean") this.settings.panelCollapsed = saved.panelCollapsed;
            else if (typeof runtime?.panelCollapsed === "boolean") this.settings.panelCollapsed = runtime.panelCollapsed;
            const filter = saved?.panelFilter || runtime?.panelFilter;
            if (["all", "alerts", "managed"].includes(filter)) this.panelFilter = filter;
            this.saveUiState();
        } catch (_) {}
        return true;
    }

    saveUiState() {
        try {
            this.writeSaved("uiState", {
                panelCollapsed: this.settings.panelCollapsed === true,
                panelFilter: this.panelFilter
            });
        } catch (_) {}
    }

    sizeValue(key, value) {
        const number = this.storedNumber(value);
        return number === null ? null : Math.round(this.clamp(number, ...VG_SIZE_LIMITS[key]));
    }

    normalizeAppearance(value) {
        const saved = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        const defaults = VG_DEFAULT_APPEARANCE;
        return {
            theme: typeof saved.theme === "string" && Object.hasOwn(VG_THEMES, saved.theme) ? saved.theme : defaults.theme,
            font: typeof saved.font === "string" && Object.hasOwn(VG_FONTS, saved.font) ? saved.font : defaults.font,
            textSize: VG_TEXT_SIZES.includes(saved.textSize) ? saved.textSize : defaults.textSize,
            width: this.sizeValue("width", saved.width),
            height: this.sizeValue("height", saved.height)
        };
    }

    loadAppearance() {
        try {
            // Visual preference errors have no effect on protection readiness or evidence.
            this.appearance = this.normalizeAppearance(BdApi.Data.load(this.meta.name, "appearance"));
            this.appearanceReadable = true;
            return true;
        } catch (_) {
            this.appearanceReadable = false;
            return false;
        }
    }

    updateAppearance(changes) {
        if (!this.appearanceReadable && !this.loadAppearance()) {
            BdApi.UI.showToast("Appearance preferences are temporarily unavailable.", { type: "error" });
            return false;
        }
        const next = this.normalizeAppearance({ ...this.appearance, ...changes });
        if (Object.keys(next).every(key => next[key] === this.appearance[key])) return true;
        try {
            BdApi.Data.save(this.meta.name, "appearance", next);
        } catch (_) {
            BdApi.UI.showToast("Could not save VoiceGuard appearance.", { type: "error" });
            return false;
        }
        if (next.textSize !== this.appearance.textSize || next.font !== this.appearance.font) this.rosterLayout = null;
        this.appearance = next;
        this.renderPanel(true);
        if (this.nativeAppearanceForm?.isConnected) this.syncAppearanceForm(this.nativeAppearanceForm);
        return true;
    }

    panelSize(count = this.rosterIds.length) {
        const scale = this.appearance.textSize / 100;
        const baseWidth = count <= 4 ? 266 : count <= 18 ? 340 : count <= 42 ? 452 : count <= 80 ? 560 : count <= 150 ? 654 : 740;
        const width = this.appearance.width ?? Math.round(baseWidth * Math.max(1, Math.sqrt(scale)));
        const columns = Math.max(2, Math.round(width / ((count > 50 ? 75 : 81) * Math.sqrt(scale))));
        const rowHeight = Math.round((this.settings.compactRows ? 21 : 25) * scale);
        return {
            width: this.resizeDrag?.width ?? width,
            height: this.resizeDrag?.height ?? this.appearance.height ?? Math.min(Math.round(329 * scale), Math.max(rowHeight, Math.ceil(count / columns) * rowHeight))
        };
    }

    applyPanelSize() {
        if (!this.panel) return;
        const { width, height } = this.panelSize();
        this.panel.style.setProperty?.("--vg-panel-width", width + "px");
        this.panel.style.setProperty?.("--vg-roster-height", height + "px");
        this.panel.setAttribute?.("data-vg-sized", String(this.appearance.height !== null || this.resizeDrag?.height !== undefined));
    }

    appearanceFieldChanged(input) {
        const key = input?.getAttribute?.("data-vg-appearance");
        if (!key || !Object.hasOwn(VG_DEFAULT_APPEARANCE, key)) return false;
        let value = input.value;
        if (key === "textSize") value = Number(value);
        if (Object.hasOwn(VG_SIZE_LIMITS, key)) {
            if (value === input.getAttribute("value")) return true;
            value = this.sizeValue(key, value);
            if (value === null) {
                input.value = String(this.panelSize()[key]);
                return true;
            }
        }
        this.updateAppearance({ [key]: value });
        input.value = String(this.appearance[key] ?? this.panelSize()[key]);
        if (Object.hasOwn(VG_SIZE_LIMITS, key)) input.setAttribute?.("value", input.value);
        return true;
    }

    isSizeField(input) {
        return Object.hasOwn(VG_SIZE_LIMITS, input?.getAttribute?.("data-vg-appearance"));
    }

    handleSizeFieldKey(event) {
        const input = event.target;
        if (!this.isSizeField(input)) return false;
        if (event.key === "Enter") {
            this.appearanceFieldChanged(input);
        } else if (event.key === "Escape" && input.value !== input.getAttribute("value")) {
            input.value = input.getAttribute("value") ?? "";
        } else return false;
        event.preventDefault?.();
        event.stopPropagation?.();
        return true;
    }

    sizePresetSelected(preset) {
        const size = VG_PANEL_SIZES[preset];
        return this.appearance.width === size.width && this.appearance.height === size.height;
    }

    syncAppearanceForm(form) {
        const size = this.panelSize();
        for (const field of form.querySelectorAll?.("[data-vg-appearance]") ?? []) {
            const key = field.getAttribute("data-vg-appearance");
            field.value = String(this.appearance[key] ?? size[key]);
            if (this.isSizeField(field)) field.setAttribute("value", field.value);
        }
        for (const button of form.querySelectorAll?.("[data-vg-appearance-action]") ?? []) {
            const preset = button.getAttribute("data-vg-appearance-action");
            if (Object.hasOwn(VG_PANEL_SIZES, preset)) button.setAttribute("aria-pressed", String(this.sizePresetSelected(preset)));
        }
    }

    appearanceButtonClicked(target) {
        const button = target?.closest?.("[data-vg-appearance-action]");
        const action = button?.getAttribute("data-vg-appearance-action");
        if (action === "style-section" || action === "size-section") {
            this.appearanceSection = action === "style-section" ? "style" : "size";
            this.renderPanel(true);
        } else if (action === "reset") this.updateAppearance(VG_DEFAULT_APPEARANCE);
        else if (action && Object.hasOwn(VG_PANEL_SIZES, action)) this.updateAppearance(VG_PANEL_SIZES[action]);
        else return false;
        return true;
    }

    measureResize() {
        const size = this.panelSize();
        const panel = this.panel.getBoundingClientRect?.();
        const roster = this.panel.querySelector?.(".vg5-roster, .vg5-empty")?.getBoundingClientRect?.();
        const width = Math.round(panel?.width || size.width);
        const height = Math.round(roster?.height || size.height);
        const view = this.panel.ownerDocument?.defaultView;
        const side = view && Number.isFinite(panel?.right) ? Math.max(0, view.innerWidth - panel.right) : 10;
        const maxPanelHeight = Number.parseFloat(view?.getComputedStyle?.(this.panel)?.maxHeight);
        const heightLimit = Number.isFinite(maxPanelHeight) ? maxPanelHeight : view && panel ? view.innerHeight - panel.top - 10 : null;
        return {
            width,
            height,
            maxWidth: view ? Math.max(width, Math.round(view.innerWidth - 2 * side)) : VG_SIZE_LIMITS.width[1],
            maxHeight: panel && heightLimit !== null ? Math.max(height, Math.round(heightLimit - (panel.height - height))) : VG_SIZE_LIMITS.height[1]
        };
    }

    startResize(event) {
        const grip = event.target?.closest?.("[data-vg-resize]");
        if (!grip || event.button !== 0 || event.isPrimary === false || this.resizeDrag || this.settings.panelCollapsed) return;
        try { grip.setPointerCapture(event.pointerId); } catch (_) { return; }
        this.resizeDrag = {
            grip, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
            start: this.measureResize()
        };
        this.panel.setAttribute?.("data-vg-resizing", "true");
        grip.focus({ preventScroll: true });
        event.preventDefault?.();
    }

    moveResize(event) {
        const drag = this.resizeDrag;
        if (!drag || drag.pointerId !== event.pointerId || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
        const { start } = drag;
        const dx = drag.x - event.clientX;
        const dy = event.clientY - drag.y;
        const width = this.boundResize("width", start.width + dx, start);
        const height = this.boundResize("height", start.height + dy, start);
        // A temporarily clamped axis keeps its preferred size unless it visibly moves.
        drag.width = dx && width !== start.width ? width : undefined;
        drag.height = dy && height !== start.height ? height : undefined;
        this.applyPanelSize();
        event.preventDefault?.();
    }

    boundResize(key, value, measured) {
        const available = key === "width" ? measured.maxWidth : measured.maxHeight;
        const [minimum, maximum] = VG_SIZE_LIMITS[key];
        if (available < minimum) return measured[key];
        return Math.round(this.clamp(value, minimum, Math.min(maximum, available)));
    }

    finishResize(commit, render = true) {
        const drag = this.resizeDrag;
        if (!drag) return;
        this.resizeDrag = null;
        this.panel?.removeAttribute?.("data-vg-resizing");
        if (drag.grip.hasPointerCapture?.(drag.pointerId)) drag.grip.releasePointerCapture(drag.pointerId);
        if (commit) {
            const sizes = {};
            if (drag.width !== undefined) sizes.width = drag.width;
            if (drag.height !== undefined) sizes.height = drag.height;
            if (Object.keys(sizes).length && this.updateAppearance(sizes)) return;
        }
        if (render) this.renderPanel(true);
    }

    resizeFromKey(event) {
        if (!event.target?.closest?.("[data-vg-resize]") || event.altKey || event.ctrlKey || event.metaKey) return false;
        const moves = { ArrowLeft: ["width", 1], ArrowRight: ["width", -1], ArrowUp: ["height", -1], ArrowDown: ["height", 1] };
        if (event.key === "Home") this.updateAppearance(VG_PANEL_SIZES.fit);
        else if (Object.hasOwn(moves, event.key)) {
            const [key, direction] = moves[event.key];
            const measured = this.measureResize();
            const pixels = measured[key] + direction * (event.shiftKey ? 24 : 8);
            const size = this.boundResize(key, pixels, measured);
            if (size !== measured[key]) this.updateAppearance({ [key]: size });
        } else return false;
        event.preventDefault?.();
        event.stopPropagation?.();
        return true;
    }

    loadOffenses() {
        const loaded = this.readSaved("offenses");
        if (!loaded.ok) return false;
        const saved = loaded.value;
        this.offenses = this.savedUserRecords(saved, "offense history", record => {
            if (!record || typeof record !== "object" || Array.isArray(record)) return null;
            const at = this.storedNumber(record.lastOffenseAt);
            if (at === null || at < 0) return null;
            const clean = {
                count: Math.round(this.clamp(this.storedNumber(record.count, 0), 0, 1000000)),
                quickLeaves: Math.round(this.clamp(this.storedNumber(record.quickLeaves, 0), 0, 1000000)),
                lastOffenseAt: at,
                lastReason: this.boundedText(record.lastReason, 400),
                rememberedMute: record.rememberedMute === true,
                detectorVersion: this.boundedText(record.detectorVersion, 40)
            };
            for (const key of ["lastQuickLeaveAt", "lastStaySeconds", "legacyRetiredAt"]) {
                const value = this.storedNumber(record[key]);
                if (value !== null && value >= 0) clean[key] = value;
            }
            if (record.lastEvidence && typeof record.lastEvidence === "object" && !Array.isArray(record.lastEvidence)) {
                const evidence = record.lastEvidence;
                clean.lastEvidence = {type: ["rolling", "clipping"].includes(evidence.type) ? evidence.type : null};
                for (const key of ["score", "rms", "activeRatio", "loudRatio", "extremeRatio"]) clean.lastEvidence[key] = this.clamp(this.storedNumber(evidence[key], 0));
                for (const key of ["loudMs", "extremeMs", "durationMs"]) clean.lastEvidence[key] = this.clamp(this.storedNumber(evidence[key], 0), 0, 15000);
            }
            return clean;
        });
        this.pruneOffenses();
        for (const record of Object.values(this.offenses)) {
            if (record.detectorVersion === this.detectorProfile || record.rememberedMute === false) continue;
            record.rememberedMute = false;
            record.legacyRetiredAt = Date.now();
            this.legacyOffensesRetired += 1;
        }
        this.saveOffenses();
        return true;
    }

    saveOffenses() {
        if (!this.storesWritable("offenses")) return false;
        this.pruneOffenses();
        return this.writeSaved("offenses", this.offenses);
    }

    loadTrustedUsers() {
        const loaded = this.readSaved("trustedUsers");
        if (!loaded.ok) return false;
        const saved = loaded.value;
        this.trustedUsers = this.savedUserRecords(saved, "trusted people", record => {
            // Explicit legacy true remains a trust choice; other truthy scalars do not.
            if (record === true) return {trustedAt: Date.now()};
            if (!record || typeof record !== "object" || Array.isArray(record)) return null;
            const at = this.storedNumber(record.trustedAt);
            if (at === null || at < 0) return null;
            return {trustedAt: at};
        });
        this.saveTrustedUsers();
        return true;
    }

    saveTrustedUsers() {
        return this.writeSaved("trustedUsers", this.trustedUsers);
    }

    normalizedSoftDuration(value) {
        // Preserve the installed advanced Probe policy; ordinary Soft durations
        // retain their existing normalization and never inherit Probe decisions.
        // Probe is intentionally strict: coercible booleans/arrays/objects must
        // never opt a saved record into escalation or automatic trust.
        if (typeof value === "number" && value === 1) return 1;
        const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
        const allowed = [10, 20, 30, 60];
        if (!Number.isFinite(number)) return 20;
        return allowed.reduce((best, candidate) => Math.abs(candidate - number) < Math.abs(best - number) ? candidate : best, allowed[0]);
    }

    loadSoftVoicebans() {
        const loaded = this.readSaved("softVoicebans");
        if (!loaded.ok) return false;
        const saved = loaded.value;
        this.softVoicebans = this.savedUserRecords(saved, "personal protection policies", (record, id) => {
            if (!record || typeof record !== "object" || Array.isArray(record) || (this.storesWritable("trustedUsers") && this.isTrusted(id))) return null;
            return {
                durationSeconds: this.normalizedSoftDuration(record.durationSeconds),
                enabledAt: Math.max(0, this.storedNumber(record.enabledAt, 0))
            };
        });
        this.saveSoftVoicebans();
        return true;
    }

    saveSoftVoicebans() {
        return this.writeSaved("softVoicebans", this.softVoicebans);
    }

    softVoicebanFor(userId) {
        if (this.isTrusted(userId)) return null;
        const id = this.validSnowflake(userId);
        if (!id || !Object.prototype.hasOwnProperty.call(this.softVoicebans || {}, id)) return null;
        const record = this.softVoicebans[id];
        if (!record) return null;
        const durationSeconds = this.normalizedSoftDuration(record.durationSeconds);
        return { ...record, durationSeconds };
    }

    policyValueFor(userId) {
        if (this.isTrusted(userId)) return "trusted";
        const soft = this.softVoicebanFor(userId);
        return soft ? `soft:${soft.durationSeconds}` : "guarded";
    }

    policyOptions() {
        return [
            { value: "guarded", label: "Guarded", detail: "Full auto protection", color: "var(--text-positive, #8eb79e)" },
            { value: "soft:1", label: "Probe 1s", detail: "Advanced: 0.5s evidence; " + this.settings.softEscalateCount + " close hits hard-mute; " + this.settings.softFalsePositiveGapSeconds + "s gaps become trusted", color: "var(--text-warning, #d6a45b)" },
            { value: "soft:10", label: "Soft 10s", detail: "Unmute after 10 sec", color: "var(--text-warning, #d6a45b)" },
            { value: "soft:20", label: "Soft 20s", detail: "Unmute after 20 sec", color: "var(--text-warning, #d6a45b)" },
            { value: "soft:30", label: "Soft 30s", detail: "Unmute after 30 sec", color: "var(--text-warning, #d6a45b)" },
            { value: "soft:60", label: "Soft 60s", detail: "Unmute after 60 sec", color: "var(--text-warning, #d6a45b)" },
            { value: "trusted", label: "Trusted", detail: "Never auto-mute", color: "var(--text-positive, #8eb79e)" }
        ];
    }

    togglePolicyMenu(userId) {
        const id = this.validSnowflake(userId);
        if (!id || !this.activeRemoteParticipant(id)) return false;
        this.inspectedUserId = id;
        this.policyMenuUserId = this.policyMenuUserId === id ? null : id;
        this.renderPanel(true);
        return this.policyMenuUserId === id;
    }

    setUserPolicy(userId, policy = "guarded") {
        if (!this.storesWritable("trustedUsers", "softVoicebans", "offenses")) return false;
        const id = this.validSnowflake(userId);
        const self = this.currentUserId();
        if (!id || !self || id === self || this.accountChanged() || typeof policy !== "string") return false;
        const value = policy;
        if (!this.policyOptions().some(option => option.value === value)) return false;
        this.policyMenuUserId = null;
        if (value === "trusted") return this.setTrusted(id, true);

        const member = this.members.get(id);
        if (value === "guarded") {
            delete this.trustedUsers[id];
            delete this.softVoicebans[id];
            if (member) {
                member.softMutedAt = 0;
                member.softUnmuteAt = 0;
            }
            this.saveTrustedUsers();
            this.saveSoftVoicebans();
            this.resetBlastWindow(id);
            this.recordActivity("policy", id, "Protection set to Guarded");
            BdApi.UI.showToast(`${this.userName(id)} set to guarded`, { type: "success" });
            this.renderPanel(true);
            return true;
        }

        const match = value.match(/^soft:(1|10|20|30|60)$/);
        if (!match) return false;
        const durationSeconds = Number(match[1]);
        delete this.trustedUsers[id];
        this.softVoicebans[id] = { durationSeconds, enabledAt: Date.now() };
        if (this.offenses[id]) {
            delete this.offenses[id];
            this.saveOffenses();
        }
        if (member?.autoMutedAt && !member.manualMutedAt) {
            member.softMutedAt = member.autoMutedAt;
            member.softUnmuteAt = Date.now() + durationSeconds * 1000;
        }
        this.saveTrustedUsers();
        this.saveSoftVoicebans();
        this.resetBlastWindow(id);
        const policyLabel = durationSeconds === 1 ? "Probe 1s" : `Soft ${durationSeconds}s`;
        this.recordActivity("policy", id, `Protection set to ${policyLabel}`);
        BdApi.UI.showToast(`${this.userName(id)} set to ${policyLabel.toLowerCase()}`, { type: "success" });
        this.renderPanel(true);
        return true;
    }

    toggleDrawer() {
        this.policyMenuUserId = null;
        this.toolsOpen = false;
        this.finishResize(false, false);
        this.settings.panelCollapsed = !this.settings.panelCollapsed;
        this.saveSettings();
        this.saveUiState();
        this.renderPanel(true);
        return this.settings.panelCollapsed;
    }

    setPanelFilter(value) {
        const filter = String(value || "all");
        if (!["all", "alerts", "managed"].includes(filter)) return false;
        this.policyMenuUserId = null;
        this.panelFilter = filter;
        this.saveUiState();
        this.renderPanel(true);
        return true;
    }

    toggleAutoMute() {
        return this.setAutoMute(!this.settings.autoMute);
    }

    setAutoMute(enabled) {
        if (typeof enabled !== "boolean" || (enabled && !this.storesWritable("settings"))) return false;
        // Pausing remains available during a read failure. A later successful
        // reload must not restore the older saved Auto: true over this choice.
        if (!enabled) this.pendingAutoPause = true;
        this.settings.autoMute = enabled;
        for (const userId of this.signals.keys()) this.resetBlastWindow(userId);
        this.saveSettings();
        this.recordActivity("protection", null, this.settings.autoMute ? "Automatic protection enabled" : "Automatic protection paused");
        BdApi.UI.showToast(`VoiceGuard auto-mute ${this.settings.autoMute ? "enabled" : "paused"}`, { type: "success" });
        this.renderPanel(true);
        return this.settings.autoMute;
    }

    saveRuntimeStatus() {
        try {
            const controls = this.panel?.innerHTML?.match(/data-vg-action="toggle-mute"/g)?.length || 0;
            this.writeSaved("runtimeStatus", {
                version: this.version,
                detectorProfile: this.detectorProfile,
                startedAt: Date.now(),
                panelPresent: !!this.panel,
                rosterCount: this.rosterIds.length,
                controlsRendered: controls,
                policyControlsRendered: this.panel?.innerHTML?.match(/data-vg-action="toggle-policy-menu"/g)?.length || 0,
                panelCollapsed: this.settings.panelCollapsed,
                panelFilter: this.panelFilter,
                softVoicebanUsers: Object.keys(this.softVoicebans).length,
                tickSamples: this.timing.samples,
                tickAverageMs: this.timing.samples ? this.timing.totalMs / this.timing.samples : 0,
                tickMaxMs: this.timing.maxMs,
                tickLastMs: this.timing.lastMs,
                legacyOffensesRetired: this.legacyOffensesRetired
            });
        } catch (_) {}
    }

    isTrusted(userId) {
        const id = this.validSnowflake(userId);
        return !!id && Object.prototype.hasOwnProperty.call(this.trustedUsers || {}, id) && !!this.trustedUsers[id];
    }

    pruneOffenses() {
        if (!this.storesWritable("offenses", "settings")) return;
        const cutoff = Date.now() - this.settings.offenseRetentionDays * 86400000;
        for (const [userId, record] of Object.entries(this.offenses || {})) {
            if (!record || Number(record.lastOffenseAt || 0) < cutoff) delete this.offenses[userId];
        }
    }

    store(name) {
        const cached = this.storeCache.get(name);
        if (cached) return cached;
        try {
            const found = BdApi.Webpack.getStore(name);
            if (found) this.storeCache.set(name, found);
            return found || null;
        } catch (_) {
            return null;
        }
    }

    collectionValues(value) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (value instanceof Map || value instanceof Set) return Array.from(value.values());
        if (typeof value.values === "function") {
            try { return Array.from(value.values()); } catch (_) {}
        }
        if (typeof value === "object") return Object.values(value);
        return [];
    }

    currentUserId() {
        try {
            const id = this.validSnowflake(this.store("UserStore")?.getCurrentUser?.()?.id);
            if (id) {
                this.sessionAccountId ??= id;
                this.lastSeenAccountId = id;
            }
            return id;
        } catch (_) {
            return null;
        }
    }

    accountChanged() {
        return this.sessionAccountId !== this.lastSeenAccountId;
    }

    currentVoiceChannelId(self = this.currentUserId()) {
        const selected = this.store("SelectedChannelStore");
        const voice = this.store("VoiceStateStore");
        const rtc = this.store("RTCConnectionStore");
        const reads = [
            () => selected?.getVoiceChannelId?.(),
            () => voice?.getCurrentClientVoiceChannelId?.(),
            () => self ? voice?.getUserVoiceChannelId?.(self) : null,
            () => rtc?.getChannelId?.()
        ];
        for (const read of reads) {
            try {
                const id = this.validSnowflake(read());
                if (id) return id;
            } catch (_) {}
        }
        return null;
    }

    channelUsers(channelId) {
        this.membershipUnavailable = false;
        if (!channelId) return [];
        const voice = this.store("VoiceStateStore");
        try {
            const states = voice?.getVoiceStatesForChannel?.(channelId);
            if (states === null || states === undefined) throw new Error("Voice membership unavailable");
            const ids = this.collectionValues(states)
                .map(state => String(state?.userId || state?.user?.id || ""))
                .filter(id => /^\d{15,25}$/.test(id));
            return Array.from(new Set(ids));
        } catch (_) {
            this.membershipUnavailable = true;
            return channelId === this.trackedChannelId ? Array.from(this.members.keys()) : [];
        }
    }

    userName(userId) {
        try {
            const user = this.store("UserStore")?.getUser?.(userId);
            for (const name of [user?.globalName, user?.username]) {
                if (typeof name === "string" && name.trim()) return this.boundedText(name);
            }
            return String(userId);
        } catch (_) {
            return String(userId);
        }
    }

    safeAvatarUrl(value, userId) {
        if (typeof value !== "string" || value.length > 2048 || value !== value.trim() || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
        try {
            const url = new URL(value);
            if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) return null;
            const avatar = url.pathname.match(/^\/avatars\/(\d{15,25})\/[A-Za-z0-9_]{1,128}\.(?:png|jpe?g|gif|webp)$/);
            const guildAvatar = url.pathname.match(/^\/guilds\/\d{15,25}\/users\/(\d{15,25})\/avatars\/[A-Za-z0-9_]{1,128}\.(?:png|jpe?g|gif|webp)$/);
            const fallback = /^\/embed\/avatars\/\d{1,4}\.png$/.test(url.pathname);
            if (!fallback && (!avatar || avatar[1] !== userId) && (!guildAvatar || guildAvatar[1] !== userId)) return null;
            const size = url.searchParams.get("size");
            url.search = ["16", "32", "64", "128", "256"].includes(size) ? `?size=${size}` : "";
            url.hash = "";
            return url.href;
        } catch (_) { return null; }
    }

    userAvatar(userId) {
        const id = this.validSnowflake(userId);
        if (!id) return null;
        try {
            const user = this.store("UserStore")?.getUser?.(id);
            const attempts = [
                () => user?.getAvatarURL?.(null, 64, true),
                () => user?.getAvatarURL?.(),
                () => user?.avatarURL
            ];
            for (const attempt of attempts) {
                try {
                    const value = this.safeAvatarUrl(attempt(), id);
                    if (value) return value;
                } catch (_) {}
            }
            if (typeof user?.avatar === "string" && /^[A-Za-z0-9_]{1,128}$/.test(user.avatar)) return this.safeAvatarUrl(`https://cdn.discordapp.com/avatars/${id}/${user.avatar}.webp?size=64`, id);
        } catch (_) {}
        return null;
    }

    userInitial(name) {
        const character = Array.from(String(name || "?").trim())[0] || "?";
        return character.toUpperCase();
    }

    newMemberState(joinedAt, confirmedJoin) {
        return {
            joinedAt,
            confirmedJoin,
            firstSeenAt: Date.now(),
            violationDetectedAt: 0,
            autoMutedAt: 0,
            manualMutedAt: 0,
            manualUnmuteUntil: 0,
            softMutedAt: 0,
            softUnmuteAt: 0,
            softStrikeCount: 0,
            softLastMutedAt: 0,
            softEscalatedAt: 0,
            softTrustedAt: 0,
            rememberedMuteDismissed: false,
            muteAttemptAt: 0,
            muteReason: null,
            muteMethod: null,
            muteError: null,
            muteVerified: false,
            volumeFallback: false,
            externalMuted: false,
            lastBlast: null,
            offenseRecorded: false
        };
    }

    ensureMember(userId) {
        const id = String(userId);
        if (!this.members.has(id)) this.members.set(id, this.newMemberState(0, false));
        return this.members.get(id);
    }

    clearMemberMuteState(member) {
        if (!member) return;
        member.autoMutedAt = 0;
        member.manualMutedAt = 0;
        member.softMutedAt = 0;
        member.softUnmuteAt = 0;
        member.muteAttemptAt = 0;
        member.muteReason = null;
        member.muteMethod = null;
        member.muteError = null;
        member.muteVerified = false;
        member.volumeFallback = false;
        member.externalMuted = false;
    }

    isUserMuted(userId, member = this.members.get(String(userId))) {
        return !!member?.autoMutedAt || !!member?.manualMutedAt || !!member?.externalMuted || this.forcedZeroUsers.has(String(userId));
    }

    setTrusted(userId, trusted = true) {
        if (!this.storesWritable("trustedUsers", "softVoicebans", "offenses")) return false;
        const id = this.validSnowflake(userId);
        const self = this.currentUserId();
        if (!id || !self || id === self || this.accountChanged() || typeof trusted !== "boolean") return false;
        const member = this.members.get(id);
        const enable = trusted === true;
        this.resetBlastWindow(id);

        if (enable) {
            this.trustedUsers[id] = { trustedAt: Date.now() };
            delete this.softVoicebans[id];
            if (this.offenses[id]) {
                delete this.offenses[id];
                this.saveOffenses();
            }
            if (member?.autoMutedAt && !member.manualMutedAt) {
                const result = this.unmuteLocally(id);
                if (!result.ok) {
                    member.muteError = result.error;
                    this.pendingRestores.set(id, Date.now() + 2000);
                }
                else this.clearMemberMuteState(member);
            }
            if (member) {
                member.violationDetectedAt = 0;
                member.offenseRecorded = false;
                member.manualUnmuteUntil = 0;
                member.softMutedAt = 0;
                member.softUnmuteAt = 0;
            }
        } else {
            delete this.trustedUsers[id];
        }

        this.saveTrustedUsers();
        this.saveSoftVoicebans();
        this.recordActivity("policy", id, enable ? "Marked trusted" : "Trust removed");
        BdApi.UI.showToast(`${this.userName(id)} ${enable ? "marked trusted" : "removed from trusted"}`, { type: "success" });
        this.renderPanel(true);
        return enable;
    }

    offenseFor(userId) {
        if (this.isTrusted(userId)) return null;
        if (this.softVoicebanFor(userId)) return null;
        if (!this.settings.rememberOffenders) return null;
        const record = this.offenses?.[userId];
        if (!record) return null;
        if (record.detectorVersion !== this.detectorProfile || record.rememberedMute !== true) return null;
        const maxAge = this.settings.offenseRetentionDays * 86400000;
        return Date.now() - Number(record.lastOffenseAt || 0) <= maxAge ? record : null;
    }

    syncMembership(channelId, userIds, now) {
        if (!channelId || channelId !== this.trackedChannelId) {
            for (const userId of this.ownedMutes.keys()) this.releaseOwnedMute(userId, now);
        }
        if (!channelId) {
            this.members.clear();
            this.blastWindows.clear();
            this.signals.clear();
            this.trackedChannelId = null;
            this.membershipInitialized = false;
            return;
        }
        if (channelId !== this.trackedChannelId) {
            this.members.clear();
            this.blastWindows.clear();
            this.signals.clear();
            this.trackedChannelId = channelId;
            this.membershipInitialized = false;
        }

        if (this.membershipUnavailable) return;
        const current = new Set(userIds);
        if (!this.membershipInitialized) {
            for (const userId of current) this.members.set(userId, this.newMemberState(0, false));
            this.membershipInitialized = true;
            return;
        }

        for (const [userId, member] of Array.from(this.members.entries())) {
            if (current.has(userId)) continue;
            this.handleDeparture(userId, member, now);
            this.releaseOwnedMute(userId, now);
            this.members.delete(userId);
            this.blastWindows.delete(userId);
        }
        for (const userId of current) {
            if (!this.members.has(userId)) this.members.set(userId, this.newMemberState(now, true));
        }
    }

    handleDeparture(userId, member, now) {
        if (!this.protectionStorageReady()) return;
        if (this.isTrusted(userId)) return;
        if (this.softVoicebanFor(userId)) return;
        if (!this.settings.rememberOffenders) return;
        if (!member?.confirmedJoin || !member.joinedAt) return;
        const stayedMs = now - member.joinedAt;
        const quick = stayedMs <= this.settings.quickLeaveSeconds * 1000;
        if (!quick || (!member.autoMutedAt && !member.violationDetectedAt)) return;
        const record = this.offenses[userId] || { count: 0, quickLeaves: 0 };
        record.quickLeaves = Number(record.quickLeaves || 0) + 1;
        record.lastQuickLeaveAt = now;
        record.lastStaySeconds = Math.max(0, Math.round(stayedMs / 1000));
        record.lastOffenseAt = Math.max(Number(record.lastOffenseAt || 0), now);
        this.offenses[userId] = record;
        this.saveOffenses();
    }

    recordOffense(userId, member, reason, now, evidence = null) {
        if (!this.protectionStorageReady()) return;
        if (!this.settings.rememberOffenders || this.isTrusted(userId)) return;
        if (this.softVoicebanFor(userId)) return;
        if (member.offenseRecorded) return;
        const record = this.offenses[userId] || { count: 0, quickLeaves: 0 };
        record.count = Number(record.count || 0) + 1;
        record.lastOffenseAt = now;
        record.lastReason = reason;
        record.rememberedMute = true;
        record.detectorVersion = this.detectorProfile;
        if (evidence) {
            record.lastEvidence = {
                type: evidence.type,
                score: evidence.score,
                rms: evidence.rms,
                activeRatio: evidence.activeRatio,
                loudRatio: evidence.loudRatio,
                extremeRatio: evidence.extremeRatio,
                loudMs: evidence.loudMs,
                extremeMs: evidence.extremeMs,
                durationMs: evidence.durationMs
            };
        }
        this.offenses[userId] = record;
        member.offenseRecorded = true;
        this.saveOffenses();
    }

    softMuteDecision(userId, member, now) {
        // Compatibility with the installed per-person Probe 1s policy. This
        // decision path is never used by ordinary Soft 10/20/30/60s policies.
        const last = Number(member?.softLastMutedAt || 0);
        const gapMs = last ? now - last : 0;
        const falsePositiveGapMs = this.settings.softFalsePositiveGapSeconds * 1000;
        if (last && gapMs >= falsePositiveGapMs) {
            member.softStrikeCount = 0;
            member.softTrustedAt = now;
            return { mode: "trust", gapMs };
        }
        member.softStrikeCount = Math.max(0, Number(member.softStrikeCount || 0)) + 1;
        member.softLastMutedAt = now;
        if (member.softStrikeCount >= this.settings.softEscalateCount) {
            member.softEscalatedAt = now;
            return { mode: "hard", gapMs, count: member.softStrikeCount };
        }
        return { mode: "soft", gapMs, count: member.softStrikeCount };
    }

    subscribe() {
        this.unsubscribe();
        this.boundStoreUpdate = () => {
            this.scheduleDiscovery();
            this.renderPanel();
        };
        for (const name of ["MediaEngineStore", "VoiceStateStore", "SelectedChannelStore", "RTCConnectionStore"]) {
            const store = this.store(name);
            if (!store?.addChangeListener || !store?.removeChangeListener) continue;
            try {
                store.addChangeListener(this.boundStoreUpdate);
                this.subscribedStores.push(store);
            } catch (_) {}
        }
    }

    unsubscribe() {
        if (this.boundStoreUpdate) {
            for (const store of this.subscribedStores) {
                try { store.removeChangeListener(this.boundStoreUpdate); } catch (_) {}
            }
        }
        this.subscribedStores = [];
        this.boundStoreUpdate = null;
    }

    startLevelLoop() {
        this.stopLevelLoop();
        this.lastTickAt = 0;
        this.tick();
        this.levelTimer = setInterval(() => this.tick(), this.settings.updateInterval);
    }

    stopLevelLoop() {
        if (this.levelTimer) clearInterval(this.levelTimer);
        this.levelTimer = null;
    }

    connectionValues(engine) {
        if (!engine) return [];
        let raw;
        try {
            raw = typeof engine.connections === "function" ? engine.connections() : engine.connections;
        } catch (_) {
            raw = null;
        }
        if (raw?.stats?.rtp) return [raw];
        return this.collectionValues(raw).filter(Boolean);
    }

    voiceConnectionContext() {
        let engine = null;
        try { engine = this.store("MediaEngineStore")?.getMediaEngine?.() || null; } catch (_) {}
        let connections = this.connectionValues(engine);
        if (!connections.length) {
            try {
                const rtcConnection = this.store("RTCConnectionStore")?.getRTCConnection?.();
                if (rtcConnection) connections = [rtcConnection];
            } catch (_) {}
        }
        return { engine, connections };
    }

    mediaActions() {
        if (this.mediaActionsCache) return this.mediaActionsCache;
        const webpack = BdApi.Webpack;
        const attempts = [
            () => webpack?.getByKeys?.("setLocalMute", "setLocalVolume"),
            () => webpack?.getByKeys?.("setLocalVolume"),
            () => {
                const filter = webpack?.Filters?.byKeys?.("setLocalVolume");
                return filter ? webpack.getModule?.(filter, { searchExports: true }) : null;
            }
        ];
        for (const attempt of attempts) {
            try {
                const found = attempt();
                const actions = found?.default && typeof found.default === "object" ? found.default : found;
                if (actions && (typeof actions.setLocalMute === "function" || typeof actions.setLocalVolume === "function")) {
                    this.mediaActionsCache = actions;
                    return actions;
                }
            } catch (_) {}
        }
        return null;
    }

    mediaContext(connection) {
        const candidates = [
            connection?.context,
            connection?.mediaContext,
            connection?.type,
            connection?.connection?.context,
            connection?.connection?.mediaContext,
            connection?.connection?.type
        ];
        return candidates.find(value => typeof value === "string" && value.length) || undefined;
    }

    callMediaAction(name, args, context) {
        const actions = this.mediaActions();
        const fn = actions?.[name];
        if (typeof fn !== "function") return { ok: false, error: `${name} action unavailable` };
        try {
            const result = context === undefined
                ? fn.call(actions, ...args)
                : fn.call(actions, ...args, context);
            if (result === false) return { ok: false, error: `${name} action rejected` };
            return { ok: true, method: `MediaEngineActions.${name}` };
        } catch (firstError) {
            if (context !== undefined) {
                try {
                    const result = fn.call(actions, ...args);
                    if (result !== false) return { ok: true, method: `MediaEngineActions.${name}` };
                } catch (_) {}
            }
            return { ok: false, error: String(firstError?.message || firstError) };
        }
    }

    collectionMuteState(collection, userId) {
        if (!collection) return null;
        try {
            if (collection instanceof Set) return collection.has(userId);
            if (collection instanceof Map) return collection.has(userId) ? !!collection.get(userId) : null;
            if (Array.isArray(collection)) return collection.map(String).includes(userId) ? true : null;
            if (typeof collection === "object" && Object.prototype.hasOwnProperty.call(collection, userId)) {
                return !!collection[userId];
            }
        } catch (_) {}
        return null;
    }

    localMuteState(userId, target) {
        const observed = [];
        const store = this.store("MediaEngineStore");
        const contexts = target?.context === undefined ? [undefined] : [target.context, undefined];
        for (const method of ["isLocalMute", "isLocalMuted", "getLocalMute"]) {
            if (typeof store?.[method] !== "function") continue;
            for (const context of contexts) {
                try {
                    const value = context === undefined
                        ? store[method](userId)
                        : store[method](userId, context);
                    if (typeof value === "boolean") observed.push(value);
                } catch (_) {}
            }
        }
        for (const owner of [target?.owner, target?.connection, target?.owner?.connection]) {
            const value = this.collectionMuteState(owner?.localMutes, userId);
            if (typeof value === "boolean") observed.push(value);
        }
        if (observed.includes(true)) return true;
        if (observed.includes(false)) return false;
        return null;
    }

    localVolume(userId, target) {
        const store = this.store("MediaEngineStore");
        const contexts = target?.context === undefined ? [undefined] : [target.context, undefined];
        for (const method of ["getLocalVolume", "getLocalParticipantVolume"]) {
            if (typeof store?.[method] !== "function") continue;
            for (const context of contexts) {
                try {
                    const value = context === undefined
                        ? store[method](userId)
                        : store[method](userId, context);
                    if (value === null || value === undefined || value === "" || typeof value === "boolean") continue;
                    const number = Number(value);
                    if (Number.isFinite(number) && number >= 0) return number;
                } catch (_) {}
            }
        }
        for (const owner of [target?.owner, target?.connection, target?.owner?.connection]) {
            const volumes = owner?.localVolumes;
            try {
                const value = volumes instanceof Map ? volumes.get(userId) : volumes?.[userId];
                if (value === null || value === undefined || value === "" || typeof value === "boolean") continue;
                const number = Number(value);
                if (Number.isFinite(number) && number >= 0) return number;
            } catch (_) {}
        }
        return null;
    }

    findMuteTarget(userId) {
        const { engine, connections } = this.voiceConnectionContext();
        const candidates = [];
        for (const connection of connections) {
            if (connection?.connectionState && String(connection.connectionState).toUpperCase() !== "CONNECTED") continue;
            const inbound = connection?.stats?.rtp?.inbound;
            const mapped = this.inboundEntry(inbound, userId) !== undefined;
            const connected = String(connection?.connectionState || "").toUpperCase() === "CONNECTED";
            if (typeof connection?.setLocalMute === "function") {
                candidates.push({
                    connection,
                    owner: connection,
                    fn: connection.setLocalMute,
                    volumeOwner: connection,
                    volumeFn: connection.setLocalVolume,
                    context: this.mediaContext(connection),
                    method: "connection.setLocalMute",
                    mapped,
                    connected
                });
            }
            if (typeof connection?.connection?.setLocalMute === "function") {
                candidates.push({
                    connection,
                    owner: connection.connection,
                    fn: connection.connection.setLocalMute,
                    volumeOwner: connection.connection,
                    volumeFn: connection.connection.setLocalVolume,
                    context: this.mediaContext(connection),
                    method: "connection.connection.setLocalMute",
                    mapped,
                    connected
                });
            }
        }
        candidates.sort((a, b) => Number(b.mapped) - Number(a.mapped) || Number(b.connected) - Number(a.connected));
        if (candidates.length) return candidates[0];
        if (typeof engine?.setLocalMute === "function") {
            return {
                connection: engine,
                owner: engine,
                fn: engine.setLocalMute,
                volumeOwner: engine,
                volumeFn: engine.setLocalVolume,
                context: this.mediaContext(engine),
                method: "engine.setLocalMute",
                mapped: false,
                connected: true
            };
        }
        return null;
    }

    inspectMuteSupport() {
        const { engine, connections } = this.voiceConnectionContext();
        const actions = this.mediaActions();
        const mediaStore = this.store("MediaEngineStore");
        return {
            actionMute: typeof actions?.setLocalMute === "function",
            actionVolume: typeof actions?.setLocalVolume === "function",
            storeVerification: ["isLocalMute", "isLocalMuted", "getLocalMute"].some(method => typeof mediaStore?.[method] === "function"),
            engineMethod: typeof engine?.setLocalMute === "function",
            connectionCount: connections.length,
            directConnectionMethods: connections.filter(connection => typeof connection?.setLocalMute === "function").length,
            nestedConnectionMethods: connections.filter(connection => typeof connection?.connection?.setLocalMute === "function").length
        };
    }

    loadAudioRestores() {
        const self = this.currentUserId();
        if (!this.sessionAccountId || this.accountChanged() || (!self && !this.completedRestores.size)) return false;
        const loaded = this.readSaved("audioRestores");
        if (!loaded.ok) return false;
        const saved = loaded.value;
        if (!self) {
            // During a transient identity lookup failure, retire only authority already used in this session.
            if (Array.isArray(saved)) {
                const remaining = saved.filter(record => {
                    const owner = this.validSnowflake(record?.ownerAccountId);
                    const id = this.validSnowflake(record?.userId);
                    return !owner || !id || !this.completedRestores.has(`${owner}:${id}`);
                });
                if (!this.writeSaved("audioRestores", remaining)) {
                    this.unreadableStores.add("audioRestores");
                    return false;
                }
            }
            this.completedRestores.clear();
            return true;
        }
        this.audioRestoresRead = true;
        if (!Array.isArray(saved)) return true;
        for (const record of saved) {
            try {
                if (!record || typeof record !== "object" || Array.isArray(record)) continue;
                const id = this.validSnowflake(record.userId);
                if (!id) continue;
                const owner = this.validSnowflake(record.ownerAccountId);
                const key = `${owner ?? ""}:${id}`;
                if (this.completedRestores.has(key)) continue;
                const context = typeof record.context === "string" ? record.context : undefined;
                const forcedZero = record.forcedZero === true && typeof record.volume === "number" && Number.isFinite(record.volume) && record.volume >= 0;
                const volume = forcedZero ? record.volume : undefined;
                // Preserve legacy and other accounts' metadata without applying it to the signed-in account.
                if (owner !== self || id === self) {
                    this.quarantinedRestores.set(key, { userId: id, ownerAccountId: owner ?? undefined, context, forcedZero, volume });
                    if (!owner) this.persistenceWarnings.add("audio recovery without an account owner");
                    continue;
                }
                if (this.ownedMutes.has(id)) continue;
                this.ownedMutes.set(id, { context });
                if (forcedZero) {
                    this.forcedZeroUsers.add(id);
                    this.volumeBeforeMute.set(id, volume);
                }
                this.pendingRestores.set(id, 0);
            } catch (_) { this.persistenceWarnings.add("audio recovery metadata"); }
        }
        // Merge any verified runtime recovery preserved through an earlier
        // read failure. Completed restores must not be resurrected from disk.
        this.saveAudioRestores();
        return true;
    }

    saveAudioRestores() {
        if (!this.sessionAccountId || !this.audioRestoresRead) return false;
        const records = Array.from(this.ownedMutes, ([userId, target]) => ({
            userId,
            ownerAccountId: this.sessionAccountId,
            context: target?.context,
            forcedZero: this.forcedZeroUsers.has(userId),
            volume: this.volumeBeforeMute.get(userId)
        }));
        records.push(...this.quarantinedRestores.values());
        const saved = this.writeSaved("audioRestores", records);
        if (saved) this.completedRestores.clear();
        return saved;
    }

    restoreAuthorityReady(userId) {
        const self = this.currentUserId();
        if (!this.sessionAccountId || this.accountChanged() || userId === this.sessionAccountId) return false;
        // A transient lookup failure can still release a mute owned in this session.
        return !!self || this.ownedMutes.has(userId);
    }

    releaseOwnedMute(userId, now = Date.now(), force = false) {
        if (!this.ownedMutes.has(userId)) return true;
        if (!this.restoreAuthorityReady(userId)) return false;
        if (!force && (this.pendingRestores.get(userId) || 0) > now) return false;
        const result = this.unmuteLocally(userId);
        if (!result.ok) {
            if (!this.pendingRestores.has(userId)) this.recordActivity("error", userId, "Audio restore pending", result.error);
            this.pendingRestores.set(userId, now + 2000);
        } else {
            this.recordActivity("restore", userId, "VoiceGuard audio restored");
            this.clearMemberMuteState(this.members.get(userId));
            this.resetBlastWindow(userId);
        }
        return result.ok;
    }

    processAudioRestores(now) {
        for (const userId of this.pendingRestores.keys()) this.releaseOwnedMute(userId, now);
    }

    muteLocally(userId) {
        if (!this.protectionStorageReady()) return { ok: false, error: "Waiting for saved protection settings" };
        userId = this.validSnowflake(userId);
        if (!userId || !this.activeRemoteParticipant(userId)) return { ok: false, error: "Waiting for a valid remote participant" };
        const target = this.findMuteTarget(userId);
        if (!this.ownedMutes.has(userId) && this.localMuteState(userId, target) === true) {
            return { ok: true, alreadyMuted: true, method: "existing local mute", verified: true, volumeFallback: false };
        }
        const priorVolume = this.volumeBeforeMute.get(userId) ?? this.localVolume(userId, target);
        const methods = [];
        const errors = [];
        const actionMute = this.callMediaAction("setLocalMute", [userId, true], target?.context);
        if (actionMute.ok) methods.push(actionMute.method);
        else errors.push(actionMute.error);

        if (target?.fn) {
            try {
                const result = target.fn.call(target.owner, userId, true);
                if (result === false) errors.push("Discord native local mute rejected");
                else methods.push(target.method);
            } catch (error) {
                errors.push(String(error?.message || error));
            }
        }

        const muteState = this.localMuteState(userId, target);
        const verified = muteState === true;
        let volumeFallback = this.forcedZeroUsers.has(userId);
        if (!verified && priorVolume !== null && priorVolume !== undefined) {
            if (!this.volumeBeforeMute.has(userId)) this.volumeBeforeMute.set(userId, priorVolume);
            const actionVolume = this.callMediaAction("setLocalVolume", [userId, 0], target?.context);
            if (actionVolume.ok) {
                methods.push(`${actionVolume.method}(0)`);
                volumeFallback = true;
            } else {
                errors.push(actionVolume.error);
            }
            if (typeof target?.volumeFn === "function") {
                try {
                    const result = target.volumeFn.call(target.volumeOwner, userId, 0);
                    if (result === false) errors.push("Discord native local volume rejected");
                    else {
                        methods.push(`${target.method.replace("setLocalMute", "setLocalVolume")}(0)`);
                        volumeFallback = true;
                    }
                } catch (error) {
                    errors.push(String(error?.message || error));
                }
            }
            if (volumeFallback) this.forcedZeroUsers.add(userId);
            else this.volumeBeforeMute.delete(userId);
        }
        if (!methods.length || (muteState === false && !volumeFallback)) {
            return { ok: false, error: errors.filter(Boolean).join("; ") || "Discord did not apply local mute; no safe volume fallback available" };
        }
        this.ownedMutes.set(userId, target || {});
        this.completedRestores.delete(`${this.sessionAccountId}:${userId}`);
        this.pendingRestores.delete(userId);
        this.saveAudioRestores();
        return { ok: true, method: methods.join(" + "), verified, volumeFallback };
    }

    unmuteLocally(userId) {
        userId = this.validSnowflake(userId);
        if (!userId || !this.restoreAuthorityReady(userId)) return { ok: false, error: "Waiting for a verified remote audio owner" };
        const target = this.ownedMutes.get(userId) || this.findMuteTarget(userId);
        const methods = [];
        const errors = [];
        const actionMute = this.callMediaAction("setLocalMute", [userId, false], target?.context);
        if (actionMute.ok) methods.push(actionMute.method);
        else errors.push(actionMute.error);

        if (target?.fn) {
            try {
                const result = target.fn.call(target.owner, userId, false);
                if (result === false) errors.push("Discord native local unmute rejected");
                else methods.push(target.method.replace("setLocalMute", "setLocalMute(false)"));
            } catch (error) {
                errors.push(String(error?.message || error));
            }
        }

        const mustRestoreVolume = this.forcedZeroUsers.has(userId);
        let volumeRestored = !mustRestoreVolume;
        if (mustRestoreVolume) {
            const currentVolume = this.localVolume(userId, target);
            // A volume adjustment made in Discord after our fallback is the user's newer choice.
            const restoreVolume = currentVolume > 0 ? currentVolume : this.volumeBeforeMute.get(userId);
            if (restoreVolume === undefined) return { ok: false, error: "Original volume is unavailable; adjust this user's volume in Discord" };
            const actionVolume = this.callMediaAction("setLocalVolume", [userId, restoreVolume], target?.context);
            if (actionVolume.ok) {
                methods.push(`${actionVolume.method}(${restoreVolume})`);
                volumeRestored = true;
            } else {
                errors.push(actionVolume.error);
            }
            if (typeof target?.volumeFn === "function") {
                try {
                    const result = target.volumeFn.call(target.volumeOwner, userId, restoreVolume);
                    if (result === false) errors.push("Discord native local volume restore rejected");
                    else {
                        methods.push(`${target.method.replace("setLocalMute", "setLocalVolume")}(${restoreVolume})`);
                        volumeRestored = true;
                    }
                } catch (error) {
                    errors.push(String(error?.message || error));
                }
            }
            if (volumeRestored) {
                this.forcedZeroUsers.delete(userId);
                this.volumeBeforeMute.delete(userId);
            }
        }

        const muteState = this.localMuteState(userId, target);
        const verified = muteState === false;
        if (!methods.length || !volumeRestored || muteState === true) {
            this.saveAudioRestores();
            return { ok: false, error: errors.filter(Boolean).join("; ") || "Discord has not restored this user's audio" };
        }
        this.ownedMutes.delete(userId);
        this.pendingRestores.delete(userId);
        this.completedRestores.add(`${this.sessionAccountId}:${userId}`);
        this.saveAudioRestores();
        return { ok: true, method: methods.join(" + "), verified, volumeRestored };
    }

    manualMute(userId) {
        if (!this.protectionStorageReady()) return false;
        const id = this.validSnowflake(userId);
        if (!id || !this.activeRemoteParticipant(id)) return false;
        const member = this.ensureMember(id);
        const now = Date.now();
        const result = this.muteLocally(id);
        member.muteAttemptAt = now;
        if (!result.ok) {
            member.muteError = result.error;
            BdApi.UI.showToast(`Could not mute ${this.userName(id)}: ${result.error}`, { type: "error", timeout: 6000 });
            this.renderPanel(true);
            return false;
        }
        if (result.alreadyMuted) {
            member.externalMuted = true;
            this.renderPanel(true);
            return true;
        }
        member.externalMuted = false;
        member.autoMutedAt = 0;
        member.manualMutedAt = now;
        member.manualUnmuteUntil = 0;
        member.softMutedAt = 0;
        member.softUnmuteAt = 0;
        member.rememberedMuteDismissed = false;
        member.muteReason = "muted manually";
        member.muteMethod = result.method;
        member.muteError = null;
        member.muteVerified = result.verified === true;
        member.volumeFallback = result.volumeFallback === true;
        this.recordActivity("manual-mute", id, "Muted locally");
        BdApi.UI.showToast(`${this.userName(id)} muted locally`, { type: "success" });
        this.renderPanel(true);
        return true;
    }

    manualUnmute(userId) {
        const id = this.validSnowflake(userId);
        const self = this.currentUserId();
        if (!id || this.accountChanged() || (self && id === self) || (!this.ownedMutes.has(id) && !this.activeRemoteParticipant(id))) return false;
        const member = this.ensureMember(id);
        const result = this.unmuteLocally(id);
        if (!result.ok) {
            member.muteError = result.error;
            BdApi.UI.showToast(`Could not unmute ${this.userName(id)}: ${result.error}`, { type: "error", timeout: 6000 });
            this.renderPanel(true);
            return false;
        }
        this.clearMemberMuteState(member);
        member.manualUnmuteUntil = Date.now() + 15000;
        member.rememberedMuteDismissed = true;
        this.resetBlastWindow(id);
        this.recordActivity("unmute", id, "Unmuted locally", "Detection rests for 15 seconds.");
        BdApi.UI.showToast(`${this.userName(id)} unmuted locally`, { type: "success" });
        this.renderPanel(true);
        return true;
    }

    emptyBlastMetrics() {
        return {
            durationMs: 0,
            activeMs: 0,
            loudMs: 0,
            extremeMs: 0,
            activeRatio: 0,
            loudRatio: 0,
            extremeRatio: 0,
            rms: 0,
            score: 0,
            rollingScore: 0,
            clippingScore: 0,
            requiredMs: 0,
            violation: false,
            type: null
        };
    }

    resetBlastWindow(userId) {
        const id = String(userId);
        this.blastWindows.delete(id);
        const signal = this.signals.get(id);
        if (signal) {
            signal.loudMs = 0;
            signal.extremeMs = 0;
            signal.blast = this.emptyBlastMetrics();
        }
    }

    syncLocalMuteState(userId, member, now) {
        if (!member) return;
        const target = this.ownedMutes.get(userId) || this.findMuteTarget(userId);
        const state = this.localMuteState(userId, target);
        let volumeChanged = false;
        if (this.forcedZeroUsers.has(userId)) {
            const volume = this.localVolume(userId, target);
            if (volume !== null && volume > 0) {
                volumeChanged = true;
                this.forcedZeroUsers.delete(userId);
                this.volumeBeforeMute.delete(userId);
                member.volumeFallback = false;
                this.saveAudioRestores();
            }
        }
        if (this.ownedMutes.has(userId) && state === false && (member.muteVerified || volumeChanged)) {
            if (this.pendingRestores.has(userId)) return;
            member.manualUnmuteUntil = now + 15000;
            member.rememberedMuteDismissed = true;
            if (this.forcedZeroUsers.has(userId)) {
                const result = this.unmuteLocally(userId);
                if (!result.ok) {
                    member.muteError = result.error;
                    this.pendingRestores.set(userId, now + 2000);
                    this.recordActivity("error", userId, "Discord unmute detected; volume restore pending", result.error);
                    return;
                }
            }
            this.ownedMutes.delete(userId);
            this.pendingRestores.delete(userId);
            this.completedRestores.add(`${this.sessionAccountId}:${userId}`);
            this.saveAudioRestores();
            this.clearMemberMuteState(member);
            member.manualUnmuteUntil = now + 15000;
            member.rememberedMuteDismissed = true;
            this.resetBlastWindow(userId);
            this.recordActivity("unmute", userId, "Unmuted in Discord", "Detection rests for 15 seconds.");
        } else if (this.ownedMutes.has(userId) && state === true) {
            member.muteVerified = true;
        }
        member.externalMuted = !this.ownedMutes.has(userId) && state === true;
    }

    processSoftUnmutes(now) {
        let changed = false;
        for (const [userId, member] of this.members.entries()) {
            if (!member?.softUnmuteAt || now < member.softUnmuteAt) continue;
            const policy = this.softVoicebanFor(userId);
            if (!policy || !member.autoMutedAt || member.manualMutedAt) {
                member.softMutedAt = 0;
                member.softUnmuteAt = 0;
                continue;
            }
            const result = this.unmuteLocally(userId);
            if (!result.ok) {
                member.muteError = result.error;
                member.softUnmuteAt = now + 2000;
                continue;
            }
            this.clearMemberMuteState(member);
            member.manualUnmuteUntil = now + this.settings.softRearmGraceSeconds * 1000;
            member.rememberedMuteDismissed = true;
            this.resetBlastWindow(userId);
            const probe = policy.durationSeconds === 1;
            this.recordActivity("restore", userId, probe ? "Probe mute ended" : "Soft mute ended", `Detection rests for ${this.settings.softRearmGraceSeconds} seconds.`);
            BdApi.UI.showToast(`${this.userName(userId)} ${probe ? "probe mute" : "soft voiceban"} ended`, { type: "success" });
            changed = true;
        }
        if (changed) this.renderPanel(true);
    }

    updateBlastWindow(userId, raw, active, now, elapsed) {
        const id = String(userId);
        const windowMs = this.settings.analysisWindowSeconds * 1000;
        const samples = this.blastWindows.get(id) || [];
        if (elapsed > 0) samples.push({ at: now, raw, active: active === true, dt: elapsed });
        const cutoff = now - windowMs;
        while (samples.length && samples[0].at <= cutoff) samples.shift();
        this.blastWindows.set(id, samples);

        const quietResetMs = 900;
        let episodeStart = 0;
        let quietMs = 0;
        for (let index = 0; index < samples.length; index += 1) {
            const sample = samples[index];
            if (sample.raw >= this.settings.loudThreshold) {
                if (quietMs >= quietResetMs) episodeStart = index;
                quietMs = 0;
            } else {
                quietMs += sample.dt;
            }
        }
        if (quietMs >= quietResetMs) episodeStart = samples.length;

        const metrics = this.emptyBlastMetrics();
        let energy = 0;
        for (let index = episodeStart; index < samples.length; index += 1) {
            const sample = samples[index];
            const dt = Math.min(sample.dt, Math.max(0, sample.at - cutoff));
            metrics.durationMs += dt;
            if (sample.active) metrics.activeMs += dt;
            if (sample.raw >= this.settings.loudThreshold) metrics.loudMs += dt;
            if (sample.raw >= this.settings.extremeLevel) metrics.extremeMs += dt;
            energy += sample.raw * sample.raw * dt;
        }
        if (metrics.durationMs > 0) {
            metrics.activeRatio = metrics.activeMs / metrics.durationMs;
            metrics.loudRatio = metrics.loudMs / metrics.durationMs;
            metrics.extremeRatio = metrics.extremeMs / metrics.durationMs;
            metrics.rms = Math.sqrt(energy / metrics.durationMs);
        }
        return metrics;
    }

    assessBlast(userId, member, metrics) {
        const requiredMs = this.requiredHoldMs(userId, member);
        const rollingScore = this.clamp(Math.min(
            metrics.loudMs / Math.max(1, requiredMs),
            metrics.activeRatio / this.settings.blastActiveRatio,
            metrics.loudRatio / this.settings.blastLoudRatio,
            metrics.rms / this.settings.blastRmsLevel
        ));
        const clippingScore = this.clamp(Math.min(
            metrics.extremeMs / (this.settings.extremeHoldSeconds * 1000),
            metrics.activeRatio / Math.max(0.8, this.settings.blastActiveRatio),
            metrics.extremeRatio / this.settings.extremeRatio,
            metrics.rms / this.settings.extremeRmsLevel
        ));
        const rolling = rollingScore >= 1;
        const clipping = clippingScore >= 1;
        return {
            ...metrics,
            requiredMs,
            rollingScore,
            clippingScore,
            score: Math.max(rollingScore, clippingScore),
            violation: rolling || clipping,
            type: clipping && clippingScore >= rollingScore ? "clipping" : rolling ? "rolling" : null
        };
    }

    isNewcomer(member, now = Date.now()) {
        return !!member?.confirmedJoin
            && member.joinedAt > 0
            && now - member.joinedAt <= this.settings.newcomerWindowSeconds * 1000;
    }

    requiredHoldMs(userId, member, now = Date.now()) {
        if (this.softVoicebanFor(userId)?.durationSeconds === 1) return 500;
        if (this.offenseFor(userId)) return this.settings.repeatLoudSeconds * 1000;
        if (this.isNewcomer(member, now)) return this.settings.newcomerLoudSeconds * 1000;
        return this.settings.establishedLoudSeconds * 1000;
    }

    applyAutoMute(userId, member, reason, now, recordNewOffense = true, evidence = null) {
        if (!this.protectionStorageReady()) return false;
        if (!this.activeRemoteParticipant(userId)) return false;
        if (!member || this.isTrusted(userId) || member.autoMutedAt || member.manualMutedAt || now < member.manualUnmuteUntil || now - member.muteAttemptAt < 2000) return false;
        let softPolicy = evidence ? this.softVoicebanFor(userId) : null;
        if (softPolicy?.durationSeconds === 1) {
            const decision = this.softMuteDecision(userId, member, now);
            if (decision.mode === "trust") {
                this.setTrusted(userId, true);
                this.recordActivity("probe-trust", userId, "Spaced probe hits marked trusted", `${(decision.gapMs / 1000).toFixed(1)} seconds since the last probe.`);
                BdApi.UI.showToast(`${this.userName(userId)} probe hits spaced ${(decision.gapMs / 1000).toFixed(1)}s apart; marked trusted`, { type: "success", timeout: 6000 });
                return false;
            }
            if (decision.mode === "hard") {
                delete this.softVoicebans[String(userId)];
                this.saveSoftVoicebans();
                softPolicy = null;
                recordNewOffense = true;
                reason = `${this.settings.softEscalateCount} probe strikes escalated to hard mute; ${reason}`;
            }
        }
        member.muteAttemptAt = now;
        const result = this.muteLocally(userId);
        if (!result.ok) {
            member.muteError = result.error;
            return false;
        }
        if (result.alreadyMuted) {
            member.externalMuted = true;
            return false;
        }
        if (softPolicy) recordNewOffense = false;
        member.autoMutedAt = now;
        member.softMutedAt = softPolicy ? now : 0;
        member.softUnmuteAt = softPolicy ? now + softPolicy.durationSeconds * 1000 : 0;
        member.muteReason = softPolicy ? `${softPolicy.durationSeconds === 1 ? "probe" : "soft"} ${softPolicy.durationSeconds}s; ${reason}` : reason;
        member.muteMethod = result.method;
        member.muteError = null;
        member.muteVerified = result.verified === true;
        member.volumeFallback = result.volumeFallback === true;
        member.rememberedMuteDismissed = false;
        member.violationDetectedAt = member.violationDetectedAt || now;
        if (evidence) member.lastBlast = { ...evidence, detectedAt: now };
        if (recordNewOffense && this.settings.rememberOffenders) this.recordOffense(userId, member, reason, now, evidence);
        this.recordActivity("auto-mute", userId, softPolicy ? softPolicy.durationSeconds === 1 ? "Probe-muted for 1s" : `Soft-muted for ${softPolicy.durationSeconds}s` : "Automatically muted", reason, now);
        const enforcement = member.volumeFallback ? "mute + zero-volume fallback" : member.muteVerified ? "verified local mute" : "local mute";
        const duration = softPolicy ? ` for ${softPolicy.durationSeconds}s` : "";
        BdApi.UI.showToast(`VoiceGuard ${enforcement}${duration} for ${this.userName(userId)}: ${reason}`, { type: "warning", timeout: 6000 });
        this.renderPanel(true);
        return true;
    }

    evaluateAutoMute(userId, signal, member, now) {
        if (!this.protectionStorageReady()) return;
        if (!member || this.membershipUnavailable || !signal?.mapped || this.isUserMuted(userId, member) || this.pendingRestores.has(userId)) return;
        if (this.isTrusted(userId)) {
            this.resetBlastWindow(userId);
            return;
        }
        if (now < member.manualUnmuteUntil) {
            this.resetBlastWindow(userId);
            return;
        }
        const remembered = this.offenseFor(userId);
        if (this.settings.autoMute && this.settings.muteRememberedOnRejoin && remembered && !member.rememberedMuteDismissed) {
            const reason = member.confirmedJoin ? "remembered offender rejoined" : "remembered offender already present";
            if (this.applyAutoMute(userId, member, reason, now, false)) return;
        }
        if (!this.settings.autoMute) return;

        const blast = signal.blast || this.emptyBlastMetrics();
        if (!blast.violation) return;
        member.violationDetectedAt = member.violationDetectedAt || now;
        const category = blast.type === "clipping" ? "repeated clipping" : "rolling blast";
        const reason = `${category}: ${blast.rms.toFixed(2)} RMS, ${Math.round(blast.loudRatio * 100)}% loud over ${(blast.durationMs / 1000).toFixed(1)}s`;
        this.applyAutoMute(userId, member, reason, now, true, blast);
    }

    inboundEntry(inbound, userId) {
        if (!inbound) return undefined;
        if (typeof inbound.get === "function") {
            try {
                const direct = inbound.get(userId);
                if (direct !== undefined) return direct;
            } catch (_) {}
        }
        if (typeof inbound === "object" && Object.prototype.hasOwnProperty.call(inbound, userId)) {
            return inbound[userId];
        }
        if (Array.isArray(inbound)) {
            const matches = inbound.filter(item => String(item?.userId || item?.participantUserId || "") === userId);
            if (matches.length) return matches;
        }
        return undefined;
    }

    signalFromEntry(entry) {
        if (entry === undefined || entry === null) return null;
        let items;
        if (Array.isArray(entry)) items = entry.flat(2);
        else if (entry instanceof Map || entry instanceof Set) items = Array.from(entry.values());
        else if (typeof entry === "object" && ("audioLevel" in entry || "audioDetected" in entry)) items = [entry];
        else items = this.collectionValues(entry);

        let level = 0;
        let detected = false;
        let hasAudioLevel = false;
        for (const item of items) {
            if (!item || typeof item !== "object") continue;
            if ("audioLevel" in item) {
                const value = item.audioLevel;
                const scalar = typeof value === "number" || (typeof value === "string" && value.trim() !== "");
                const candidate = scalar ? Number(value) : NaN;
                if (Number.isFinite(candidate)) {
                    hasAudioLevel = true;
                    level = Math.max(level, this.clamp(candidate));
                }
            }
            if ("audioDetected" in item) {
                detected = detected || item.audioDetected === true;
            }
        }
        return hasAudioLevel ? { level, detected } : null;
    }

    readRtpSignals(userIds) {
        const telemetry = this.emptyTelemetry("MediaEngineStore unavailable");
        telemetry.sampledAt = Date.now();
        const values = new Map();
        const mediaStore = this.store("MediaEngineStore");
        if (!mediaStore) return { telemetry, values };
        telemetry.mediaStore = true;

        let engine = null;
        try { engine = mediaStore.getMediaEngine?.() || null; } catch (_) {}
        if (!engine) {
            telemetry.reason = "Media engine unavailable";
            return { telemetry, values };
        }
        telemetry.engine = true;

        let connections = this.connectionValues(engine);
        if (!connections.length) {
            try {
                const rtcConnection = this.store("RTCConnectionStore")?.getRTCConnection?.();
                if (rtcConnection) connections = [rtcConnection];
            } catch (_) {}
        }
        telemetry.connectionCount = connections.length;
        if (!connections.length) {
            telemetry.reason = "Waiting for RTC connection";
            return { telemetry, values };
        }

        const hasInbound = connection => connection?.stats?.rtp?.inbound != null;
        const isConnected = connection => String(connection?.connectionState || "").toUpperCase() === "CONNECTED";
        const inboundConnections = connections.filter(hasInbound);
        const connectedInbound = inboundConnections.filter(isConnected);
        const signalConnections = connectedInbound.length ? connectedInbound : inboundConnections.filter(connection => !connection?.connectionState);
        const fallbackConnection = connections.find(isConnected) || connections[0];
        telemetry.connectionState = signalConnections.length
            ? Array.from(new Set(signalConnections.map(connection => String(connection?.connectionState || "UNKNOWN")))).join("/")
            : String(fallbackConnection?.connectionState || "UNKNOWN");
        if (!signalConnections.length) {
            telemetry.reason = connections.some(isConnected) ? "Connected; inbound RTP stats unavailable" : "Waiting for RTC connection";
            return { telemetry, values };
        }

        telemetry.inbound = true;
        telemetry.inboundEntries = signalConnections.reduce((count, connection) => {
            return count + this.collectionValues(connection?.stats?.rtp?.inbound).length;
        }, 0);
        for (const userId of userIds) {
            let merged = null;
            for (const connection of signalConnections) {
                const inbound = connection?.stats?.rtp?.inbound;
                const signal = this.signalFromEntry(this.inboundEntry(inbound, userId));
                if (!signal) continue;
                merged = {
                    level: Math.max(merged?.level || 0, signal.level),
                    detected: !!merged?.detected || signal.detected
                };
            }
            if (merged) values.set(userId, merged);
        }
        telemetry.mappedUsers = values.size;
        telemetry.reason = values.size
            ? `${values.size} per-user RTP ${values.size === 1 ? "stream" : "streams"} mapped`
            : "Inbound RTP is live; waiting for per-user entries";
        return { telemetry, values };
    }

    tick() {
        const tickStarted = typeof performance !== "undefined" && performance.now ? performance.now() : null;
        try {
            const now = Date.now();
            const self = this.currentUserId();
            if (this.accountChanged()) {
                const firstPausedTick = this.telemetry.reason !== "Discord account changed";
                this.signals.clear();
                this.blastWindows.clear();
                this.activity = [];
                this.activityEventId = null;
                this.clearOverlays();
                this.telemetry = this.emptyTelemetry("Discord account changed");
                this.renderPanel(firstPausedTick);
                this.recordTickTiming(tickStarted);
                return;
            }
            if (self && !this.audioRestoresRead && !this.unreadableStores.has("audioRestores")) this.loadAudioRestores();
            this.retrySavedStores(now);
            const elapsed = this.lastTickAt
                ? this.clamp(now - this.lastTickAt, 0, 500)
                : this.settings.updateInterval;
            this.lastTickAt = now;
            if (!self) {
                // A transient account-store failure is not a voice disconnect.
                // Keep existing ownership and timed recovery, but gather no evidence.
                this.processAudioRestores(now);
                this.processSoftUnmutes(now);
                this.signals.clear();
                this.blastWindows.clear();
                this.telemetry = this.emptyTelemetry("Waiting for Discord account");
                this.telemetry.sampledAt = now;
                this.renderPanel(true);
                this.paintOverlays();
                this.recordTickTiming(tickStarted);
                return;
            }
            const channelId = this.currentVoiceChannelId(self);
            const userIds = this.channelUsers(channelId).filter(id => id !== self);
            this.processAudioRestores(now);
            this.syncMembership(channelId, userIds, now);
            this.processSoftUnmutes(now);

            if (!channelId) {
                this.telemetry = this.emptyTelemetry("Not connected to voice");
                this.telemetry.sampledAt = now;
            } else {
                const sample = this.readRtpSignals(userIds);
                this.telemetry = sample.telemetry;
                const currentUsers = new Set(userIds);
                for (const userId of userIds) {
                    const mapped = sample.values.has(userId);
                    const rawSignal = sample.values.get(userId) || { level: 0, detected: false };
                    const raw = this.clamp(rawSignal.level);
                    const detected = rawSignal.detected === true;
                    const activeNow = detected || raw >= this.settings.threshold;
                    const previous = this.signals.get(userId) || {
                        raw: 0,
                        level: 0,
                        detected: false,
                        lastActiveAt: 0,
                        loudMs: 0,
                        extremeMs: 0,
                        peak: 0,
                        peakAt: 0
                    };
                    const target = activeNow ? raw : 0;
                    let level = target > previous.level
                        ? previous.level + (target - previous.level) * this.settings.riseSmoothing
                        : previous.level * this.settings.decayMultiplier;
                    if (level < 0.0012) level = 0;

                    const member = this.members.get(userId);
                    this.syncLocalMuteState(userId, member, now);
                    const analysisEnabled = this.protectionStorageReady() && mapped && !this.membershipUnavailable && !this.isTrusted(userId)
                        && !this.isUserMuted(userId, member)
                        && now >= Number(member?.manualUnmuteUntil || 0);
                    const evidenceElapsed = Math.min(elapsed, Math.max(100, this.settings.updateInterval * 2));
                    const metrics = analysisEnabled
                        ? this.updateBlastWindow(userId, raw, activeNow, now, evidenceElapsed)
                        : this.emptyBlastMetrics();
                    if (!analysisEnabled) this.blastWindows.delete(userId);
                    const blast = this.assessBlast(userId, member, metrics);
                    const replacePeak = raw >= previous.peak || now - previous.peakAt > 1800;
                    const peak = replacePeak ? raw : previous.peak;
                    const peakAt = replacePeak ? now : previous.peakAt;
                    const lastActiveAt = activeNow ? now : previous.lastActiveAt;

                    const signal = {
                        raw,
                        level: this.clamp(level),
                        mapped,
                        detected,
                        active: activeNow || (level > 0 && now - lastActiveAt < 280),
                        lastActiveAt,
                        loudMs: blast.loudMs,
                        extremeMs: blast.extremeMs,
                        peak,
                        peakAt,
                        blast
                    };
                    this.signals.set(userId, signal);
                    this.evaluateAutoMute(userId, signal, member, now);
                }

                for (const userId of Array.from(this.signals.keys())) {
                    if (!currentUsers.has(userId)) {
                        this.signals.delete(userId);
                        this.blastWindows.delete(userId);
                    }
                }
            }

            this.renderPanel();
            this.paintOverlays();
            if (now - this.lastDiscoveryAt > 1000) this.scheduleDiscovery();
            this.recordTickTiming(tickStarted);
        } catch (error) {
            this.telemetry = this.emptyTelemetry(`Sampler error: ${error?.message || "unknown"}`);
            this.telemetry.sampledAt = Date.now();
            this.renderPanel(true);
            this.recordTickTiming(tickStarted);
        }
    }

    recordTickTiming(startedAt) {
        if (startedAt === null || typeof performance === "undefined" || !performance.now) return;
        const elapsed = Math.max(0, performance.now() - startedAt);
        this.timing.samples += 1;
        this.timing.totalMs += elapsed;
        this.timing.lastMs = elapsed;
        this.timing.maxMs = Math.max(this.timing.maxMs, elapsed);
        if (this.timing.samples === 100) this.saveRuntimeStatus();
        if (this.timing.samples > 5000) {
            const average = this.timing.totalMs / this.timing.samples;
            this.timing.samples = 1000;
            this.timing.totalMs = average * 1000;
        }
    }

    levelToDb(level) {
        const value = Number(level);
        if (!Number.isFinite(value) || value <= 0) return null;
        return 20 * Math.log10(Math.max(value, 1e-6));
    }

    formatDb(level) {
        const db = this.levelToDb(level);
        return db === null ? "-inf dBFS" : `${db.toFixed(1)} dBFS`;
    }

    warningFor(signal, userId) {
        const member = this.members.get(userId);
        if (member?.softUnmuteAt > Date.now()) {
            const mode = this.softVoicebanFor(userId)?.durationSeconds === 1 ? "PROBE" : "SOFT";
            return { label: `${mode} ${Math.max(1, Math.ceil((member.softUnmuteAt - Date.now()) / 1000))}s`, color: "var(--text-warning, #d6a45b)", rank: 4 };
        }
        if (this.isUserMuted(userId, member)) return { label: "MUTED", color: "var(--text-danger, #df8a7c)", rank: 4 };
        if (this.isTrusted(userId)) return { label: "TRUSTED", color: "var(--text-positive, #8eb79e)", rank: 1 };
        if (member?.manualUnmuteUntil > Date.now()) return { label: "GRACE", color: "var(--text-positive, #8eb79e)", rank: 1 };
        if (member?.muteError && Date.now() - member.muteAttemptAt < 6000) {
            return { label: "MUTE FAILED", color: "var(--text-danger, #df8a7c)", rank: 4 };
        }
        if (!signal.mapped) return { label: "NO LEVELS", color: "#949ba4", rank: 0 };
        const blastScore = signal.blast?.score || 0;
        if (!this.settings.autoMute && blastScore >= 1) {
            return { label: "MUTE?", color: "var(--text-danger, #df8a7c)", rank: 3 };
        }
        if (blastScore >= 0.75) {
            return { label: this.isNewcomer(member) ? "NEW WATCH" : "BLAST WATCH", color: "var(--text-warning, #d6a45b)", rank: 2 };
        }
        if (signal.active && signal.level >= this.settings.loudThreshold) {
            return { label: "PEAK", color: "var(--text-warning, #d6a45b)", rank: 1 };
        }
        if (signal.active) return { label: "LIVE", color: "var(--text-positive, #8eb79e)", rank: 1 };
        return { label: "SILENT", color: "#747f8d", rank: 0 };
    }

    colorForLevel(level) {
        if (level >= 0.65) return "var(--text-danger, #df8a7c)";
        if (level >= 0.30) return "var(--text-warning, #d6a45b)";
        if (level > 0) return "var(--text-positive, #8eb79e)";
        return "#4e5058";
    }

    esc(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    recordActivity(type, userId, message, detail = "", at = Date.now()) {
        this.activity.unshift({
            id: ++this.activitySerial,
            type, userId: userId || null, at,
            name: userId ? this.userName(userId) : "VoiceGuard",
            message, detail
        });
        if (this.activity.length > 60) this.activity.length = 60;
    }

    setPanelView(view) {
        if (!["overview", "people", "activity", "settings"].includes(view)) return false;
        if (view === "settings" && this.panelView !== "settings") {
            this.settingsReturnView = this.panelView;
            this.settingsTab = "appearance";
            this.appearanceSection = "style";
            this.settingsGroup = null;
            this.settingsPage = 0;
        }
        if (view === "activity" && this.panelView !== view) this.activityEventId = null;
        this.panelView = view;
        this.toolsOpen = false;
        this.policyMenuUserId = null;
        this.renderPanel(true);
        return true;
    }

    closePanelSettings() {
        this.setPanelView(["overview", "activity"].includes(this.settingsReturnView) ? this.settingsReturnView : "people");
        this.panel?.querySelector?.('[data-vg-action="toggle-tools"]')?.focus();
    }

    protectionProfiles() {
        return {
            balanced: { label: "Balanced", detail: "Everyday voice calls", values: { loudThreshold: 0.65, newcomerLoudSeconds: 2, establishedLoudSeconds: 3, softRearmGraceSeconds: 3 } },
            cautious: { label: "Cautious", detail: "Longer evidence, fewer interruptions", values: { loudThreshold: 0.75, newcomerLoudSeconds: 3, establishedLoudSeconds: 4.5, softRearmGraceSeconds: 5 } },
            responsive: { label: "Responsive", detail: "Shorter evidence windows", values: { loudThreshold: 0.60, newcomerLoudSeconds: 1.5, establishedLoudSeconds: 2, softRearmGraceSeconds: 2 } }
        };
    }

    selectedProtectionProfile() {
        for (const [name, profile] of Object.entries(this.protectionProfiles())) {
            if (Object.entries(profile.values).every(([key, value]) => this.settings[key] === value)) return name;
        }
        return "custom";
    }

    preferencePresetKeys() {
        return ["loudThreshold", "newcomerLoudSeconds", "establishedLoudSeconds", "softRearmGraceSeconds", ...this.displayOptions().map(option => option.key), "levelDisplayFormat"];
    }

    exportPreferencePreset() {
        return JSON.stringify({
            format: "voiceguard-preferences",
            version: 1,
            preferences: Object.fromEntries(this.preferencePresetKeys().map(key => [key, this.settings[key]]))
        }, null, 2);
    }

    validatePreferencePreset(text) {
        const fail = error => ({ ok: false, error });
        if (typeof text !== "string") return fail("Choose a JSON preference preset.");
        let bytes = 0;
        for (const character of text) {
            const code = character.codePointAt(0);
            bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
            if (bytes > 16384) return fail("Preset files must be 16 KiB or smaller.");
        }
        let preset;
        try { preset = JSON.parse(text); } catch (_) { return fail("This file is not valid JSON."); }
        if (!preset || typeof preset !== "object" || Array.isArray(preset)) return fail("Expected a VoiceGuard preference preset.");
        if (Object.keys(preset).some(key => !["format", "version", "preferences"].includes(key))) return fail("The preset contains unsupported fields.");
        if (preset.format !== "voiceguard-preferences" || preset.version !== 1) return fail("This preset format or version is not supported.");
        const incoming = preset.preferences;
        if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || !Object.keys(incoming).length) return fail("The preset has no preferences to import.");
        const allowed = new Set(this.preferencePresetKeys());
        const ranges = new Map(this.panelSettingControls().map(control => [control.key, control]));
        const preferences = Object.create(null);
        for (const [key, value] of Object.entries(incoming)) {
            if (!allowed.has(key)) return fail("The preset contains a preference that cannot be imported: " + key.slice(0, 60));
            const range = ranges.get(key);
            if (range) {
                if (typeof value !== "number" || !Number.isFinite(value) || value < range.min || value > range.max) return fail("A detection value is outside its supported range: " + key);
            } else if (key === "levelDisplayFormat") {
                if (!["percent", "raw", "dbfs"].includes(value)) return fail("The level number format is not supported.");
            } else if (typeof value !== "boolean") return fail("Display preferences must be true or false: " + key);
            preferences[key] = value;
        }
        return { ok: true, preferences };
    }

    importPreferencePreset(text, label = "Preference preset imported") {
        if (!this.storesWritable("settings")) {
            const error = "Waiting for saved preferences. Try importing again after storage recovers.";
            this.presetNotice = { ok: false, message: error };
            this.renderPanel(true);
            return { ok: false, error };
        }
        const result = this.validatePreferencePreset(text);
        if (!result.ok) {
            this.presetNotice = { ok: false, message: result.error };
            this.renderPanel(true);
            return result;
        }
        const detectionKeys = this.panelSettingControls().map(control => control.key);
        const detectionChanged = detectionKeys.some(key => Object.prototype.hasOwnProperty.call(result.preferences, key) && this.settings[key] !== result.preferences[key]);
        const previousTileMeters = this.settings.tileMeters;
        Object.assign(this.settings, result.preferences);
        this.saveSettings();
        if (detectionChanged) for (const userId of this.signals.keys()) this.resetBlastWindow(userId);
        if (this.settings.tileMeters !== previousTileMeters) {
            if (this.settings.tileMeters) this.scheduleDiscovery(true);
            else this.clearOverlays();
        }
        this.presetNotice = { ok: true, message: label + ". Auto, user policies, and mute ownership are unchanged." };
        this.recordActivity("settings", null, label, "Only detection and display preferences changed.");
        this.renderPanel(true);
        return { ok: true, changed: Object.keys(result.preferences).length };
    }

    applyProtectionProfile(name) {
        const profiles = this.protectionProfiles();
        if (!Object.prototype.hasOwnProperty.call(profiles, name)) return false;
        const profile = profiles[name];
        return this.importPreferencePreset(JSON.stringify({ format: "voiceguard-preferences", version: 1, preferences: profile.values }), profile.label + " protection profile applied").ok;
    }

    async importPreferencePresetFile(file) {
        if (!file) return;
        if (!Number.isFinite(file.size) || file.size > 16384) {
            this.presetNotice = { ok: false, message: "Preset files must be 16 KiB or smaller." };
            this.renderPanel(true);
            return;
        }
        try {
            const result = this.importPreferencePreset(await file.text());
            BdApi.UI?.showToast?.(result.ok ? "VoiceGuard preferences imported" : result.error, { type: result.ok ? "success" : "error" });
        } catch (_) {
            this.presetNotice = { ok: false, message: "This preset file could not be read. Choose a local JSON file and try again." };
            this.renderPanel(true);
        }
    }

    downloadPreferencePreset() {
        try {
            const blob = new Blob([this.exportPreferencePreset()], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "voiceguard-preferences.json";
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            this.presetNotice = { ok: true, message: "Preference preset exported. It contains no people, history, or audio data." };
        } catch (_) {
            this.presetNotice = { ok: false, message: "The preset could not be downloaded. Try exporting from the plugin settings panel." };
        }
        this.renderPanel(true);
    }

    renderPreferenceProfiles() {
        const selected = this.selectedProtectionProfile();
        let html = '<div class="vg4-profiles" role="group" aria-label="Protection profiles">';
        for (const [name, profile] of Object.entries(this.protectionProfiles())) {
            html += '<button type="button" data-vg-action="protection-profile" data-profile="' + name + '" aria-pressed="' + (selected === name) + '">' + profile.label + '</button>';
        }
        const profile = this.protectionProfiles()[selected];
        const tuning = Math.round(this.settings.loudThreshold * 100) + '% threshold · ' + this.settings.newcomerLoudSeconds + 's / ' + this.settings.establishedLoudSeconds + 's evidence · ' + this.settings.softRearmGraceSeconds + 's grace';
        html += '</div><p class="vg4-profile-detail" title="' + this.esc(profile?.detail || "Custom protection settings") + '">' + tuning + '</p>';
        html += '<section class="vg4-portable"><div class="vg4-preset-actions"><button type="button" data-vg-action="export-preset">Export preset</button><label class="vg4-import-label">Import preset<input type="file" accept=".json,application/json" data-vg-preset-file="true" aria-label="Import preference preset"></label></div><p class="vg4-preset-boundary" title="Trust lists, history, existing mutes, and the Auto switch are never imported.">Display and detection preferences only.</p></section>';
        if (this.presetNotice) html += '<p class="vg4-preset-notice ' + (this.presetNotice.ok ? "success" : "error") + '" role="status">' + this.esc(this.presetNotice.message) + '</p>';
        return html;
    }

    renderOverview(rows, telemetryReady, partial, statusReason, self = this.currentUserId()) {
        const mapped = rows.filter(row => row.signal.mapped).length;
        const channelId = self ? this.currentVoiceChannelId(self) : null;
        const readyLabel = !self ? "Waiting for Discord account" : !channelId ? "Join a voice channel" : !telemetryReady ? "Waiting for audio data." : partial ? "Partial audio coverage" : "All participant levels connected";
        const detail = !self ? "VoiceGuard will reconnect automatically." : !channelId ? "Participants appear when you join a Discord voice channel." : !telemetryReady ? statusReason : partial ? "Missing data is excluded from detection." : "Per-user inbound levels are available.";
        let html = '<div class="vg3-view-body vg4-overview" data-vg-key="overview-view"><section class="vg4-coverage"><div><strong>Signal coverage</strong><span>' + mapped + ' / ' + rows.length + ' mapped</span></div><div class="vg4-coverage-track" role="meter" aria-label="Participants with audio data" aria-valuemin="0" aria-valuemax="' + Math.max(1, rows.length) + '" aria-valuenow="' + mapped + '"><i style="width:' + (rows.length ? mapped / rows.length * 100 : 0) + '%"></i></div><p title="' + this.esc(readyLabel + ' · ' + (detail || '')) + '"><strong>' + readyLabel + '</strong><span>' + this.esc(detail) + '</span></p></section><section class="vg4-overview-tuning"><div><span>Threshold</span><strong>' + Math.round(this.settings.loudThreshold * 100) + '%</strong></div><div><span>Evidence</span><strong>' + this.settings.newcomerLoudSeconds + 's / ' + this.settings.establishedLoudSeconds + 's</strong></div><button type="button" data-vg-action="open-profiles">Tune setup <span aria-hidden="true">↗</span></button></section>';
        return html + '</div>';
    }

    displaySettingsGroups() {
        return [
            { id: "audio", label: "Audio levels", hint: "Meters, numbers, peaks and markers" },
            { id: "participants", label: "Participant cards", hint: "Avatars, status and compact rows" },
            { id: "panel", label: "Panel and Discord", hint: "Call summary, tile meters and motion" }
        ];
    }

    undoActivityMute(eventId) {
        const id = this.storedNumber(eventId);
        if (id === null || !Number.isSafeInteger(id) || id < 1) return false;
        const entry = this.activity.find(item => item.id === id);
        const member = entry && this.members.get(entry.userId);
        if (entry?.type !== "auto-mute" || !member?.autoMutedAt || member.autoMutedAt !== entry.at || member.manualMutedAt) return false;
        return this.manualUnmute(entry.userId);
    }

    displayOptions() {
        return [
            { key: "showAudioLevels", group: "Audio levels", label: "Show audio levels", hint: "Show measurements in participant cards. Protection stays on." },
            { key: "showLevelMeter", group: "Audio levels", label: "Level bars", hint: "Animated bars for each participant.", requires: ["showAudioLevels"] },
            { key: "showLevelValue", group: "Audio levels", label: "Current level numbers", hint: "Show the current value beside and below the meter.", requires: ["showAudioLevels"] },
            { key: "showPeakLevel", group: "Audio levels", label: "Peak readings", hint: "Show the highest recently observed level.", requires: ["showAudioLevels"] },
            { key: "showDbfs", group: "Audio levels", label: "Extra dBFS reading", hint: "Show a separate decibel statistic.", requires: ["showAudioLevels"] },
            { key: "showThresholdMarker", group: "Audio levels", label: "Loud-threshold marker", hint: "Mark where loud evidence starts accumulating.", requires: ["showAudioLevels", "showLevelMeter"] },
            { key: "showPeakMarker", group: "Audio levels", label: "Peak marker on bars", hint: "A short peak-hold line on each meter.", requires: ["showAudioLevels", "showLevelMeter"] },
            { key: "showBlastScore", group: "Participant cards", label: "Blast confidence", hint: "Show the detector's confidence percentage." },
            { key: "showAvatars", group: "Participant cards", label: "Avatars", hint: "Show participant initials. Profile images can be enabled in BetterDiscord settings." },
            { key: "showStatusLabels", group: "Participant cards", label: "Status labels", hint: "Show LIVE, MUTED, TRUSTED, and GRACE labels." },
            { key: "showQuickPolicies", group: "Participant cards", label: "Quick protection buttons", hint: "Show Guarded / Soft / Trusted shortcuts inside the protection picker. The full chooser stays available." },
            { key: "compactRows", group: "Participant cards", label: "Compact participant cards", hint: "Use closer spacing to fit more people." },
            { key: "showCallSummary", group: "Panel and Discord", label: "Call totals", hint: "Show People, Speaking, Alerts, and Muted counts." },
            { key: "showConnectionDetails", group: "Panel and Discord", label: "Connection details", hint: "Show stream mapping counts. Connection problems remain visible." },
            { key: "tileMeters", group: "Panel and Discord", label: "Meters on Discord voice tiles", hint: "Independent of the measurements shown inside this drawer." },
            { key: "reducePanelMotion", group: "Panel and Discord", label: "Reduce panel motion", hint: "Disable drawer and meter animations. System reduced-motion preferences are always respected." }
        ];
    }

    displayPresets() {
        const detailed = {};
        for (const { key } of this.displayOptions()) {
            if (key !== "tileMeters" && key !== "reducePanelMotion") detailed[key] = this.defaultSettings[key];
        }
        return {
            detailed,
            balanced: { ...detailed, showPeakLevel: false, showDbfs: false, showPeakMarker: false, showQuickPolicies: false, showConnectionDetails: false },
            minimal: {
                ...detailed, showAudioLevels: false, showLevelMeter: false, showLevelValue: false,
                showPeakLevel: false, showDbfs: false, showThresholdMarker: false, showPeakMarker: false,
                showBlastScore: false, showAvatars: false, showQuickPolicies: false,
                showCallSummary: false, showConnectionDetails: false, compactRows: true
            }
        };
    }

    selectedDisplayPreset() {
        for (const [name, preset] of Object.entries(this.displayPresets())) {
            if (Object.entries(preset).every(([key, value]) => this.settings[key] === value)) return name;
        }
        return "custom";
    }

    updateDisplaySetting(key, value, persist = true) {
        if (!this.storesWritable("settings")) return false;
        if (key === "levelDisplayFormat") {
            if (!["percent", "raw", "dbfs"].includes(value)) return false;
        } else if (!this.displayOptions().some(option => option.key === key) || typeof value !== "boolean") return false;
        this.settings[key] = value;
        if (persist) {
            this.saveSettings();
            if (key === "tileMeters") {
                if (value) this.scheduleDiscovery(true);
                else this.clearOverlays();
            }
        }
        this.renderPanel(true);
        return true;
    }

    applyDisplayPreset(name) {
        if (!this.storesWritable("settings")) return false;
        const presets = this.displayPresets();
        if (!Object.prototype.hasOwnProperty.call(presets, name)) return false;
        Object.assign(this.settings, presets[name]);
        this.saveSettings();
        this.renderPanel(true);
        return true;
    }

    resetDisplaySettings() {
        if (!this.storesWritable("settings")) return false;
        for (const { key } of this.displayOptions()) this.settings[key] = this.defaultSettings[key];
        this.settings.levelDisplayFormat = "percent";
        this.saveSettings();
        if (this.settings.tileMeters) this.scheduleDiscovery(true);
        else this.clearOverlays();
        this.renderPanel(true);
    }

    formatDisplayLevel(level) {
        if (this.settings.levelDisplayFormat === "raw") return this.clamp(level).toFixed(3);
        if (this.settings.levelDisplayFormat === "dbfs") return this.formatDb(level);
        return Math.round(this.clamp(level) * 100) + "%";
    }

    renderDisplaySettings() {
        const preset = this.selectedDisplayPreset();
        let html = '<div class="vg3-display-presets" data-vg-option-open="' + !!this.settingsGroup + '" role="group" aria-label="Display presets">';
        for (const [name, label, detail] of [
            ["minimal", "Minimal", "Names and essential controls"],
            ["balanced", "Balanced", "Meters with fewer statistics"],
            ["detailed", "Detailed", "All measurements and controls"]
        ]) {
            html += '<button type="button" data-vg-action="display-preset" data-preset="' + name + '" aria-pressed="' + (preset === name) + '" title="' + detail + '" class="' + (preset === name ? "selected" : "") + '"><strong>' + label + '</strong></button>';
        }
        html += '</div><div class="vg5-settings-groups" role="group" aria-label="Display category">';
        for (const group of this.displaySettingsGroups()) {
            const open = this.settingsGroup === group.id;
            const label = { audio: "Levels", participants: "People", panel: "Panel" }[group.id];
            html += '<button type="button" data-vg-action="settings-group" data-group="' + group.id + '" aria-label="' + group.label + '" title="' + group.hint + '" aria-pressed="' + open + '">' + label + '</button>';
        }
        html += '</div>';
        const group = this.displaySettingsGroups().find(item => item.id === this.settingsGroup);
        if (!group) return html + '<div class="vg3-tuning-note"><span>Choose a display category.</span><button type="button" class="vg3-quiet-button" data-vg-action="reset-display">Reset display</button></div>';
        const options = this.displayOptions().filter(item => item.group === group.label);
        const pageCount = options.length + (group.id === "audio" ? 1 : 0);
        const page = Math.min(this.settingsPage, pageCount - 1);
        const option = options[page];
        if (option) {
            html += this.renderSettingToggle(option.key, option.label, option.hint, option.requires?.some(key => !this.settings[key]));
        } else {
            html += '<div class="vg3-number-format" role="group" aria-label="Level number format">';
            for (const [value, label] of [["percent", "Percent"], ["raw", "Raw 0-1"], ["dbfs", "dBFS"]]) {
                html += '<button type="button" data-vg-action="level-format" data-format="' + value + '" aria-pressed="' + (this.settings.levelDisplayFormat === value) + '"' + (this.settings.showAudioLevels ? "" : " disabled") + '>' + label + '</button>';
            }
            html += '</div>';
        }
        return html + this.renderPager("setting-page", "Display setting", page, pageCount);
    }

    renderSettingToggle(key, label, hint, disabled = false) {
        return '<label class="vg3-setting-toggle" data-vg-key="setting-' + key + '" title="' + this.esc(hint) + '"><strong>' + label + '</strong><input type="checkbox" aria-label="' + label + '" data-vg-setting="' + key + '"' + (this.settings[key] ? " checked" : "") + (disabled ? " disabled" : "") + '></label>';
    }

    renderPager(action, label, page, count) {
        return '<div class="vg5-pager" role="group" aria-label="' + label + ' pages">' +
            '<button type="button" data-vg-action="' + action + '" data-page="' + (page - 1) + '" data-page-direction="back" aria-label="Previous ' + label.toLowerCase() + '"' + (page <= 0 ? ' disabled' : '') + '>Back</button>' +
            '<span role="status">' + (page + 1) + ' / ' + count + '</span>' +
            '<button type="button" data-vg-action="' + action + '" data-page="' + (page + 1) + '" data-page-direction="next" aria-label="Next ' + label.toLowerCase() + '"' + (page >= count - 1 ? ' disabled' : '') + '>Next</button></div>';
    }

    panelSettingControls() {
        return [
            { key: "loudThreshold", label: "Loudness threshold", min: 0.1, max: 1, step: 0.01, unit: "percent" },
            { key: "newcomerLoudSeconds", label: "New arrival evidence", min: 1.5, max: 5, step: 0.25, unit: "seconds" },
            { key: "establishedLoudSeconds", label: "Established caller evidence", min: 2, max: 10, step: 0.25, unit: "seconds" },
            { key: "softRearmGraceSeconds", label: "Grace after a Soft mute", min: 1, max: 10, step: 1, unit: "seconds" }
        ];
    }

    updatePanelSetting(key, value, persist = true) {
        if (!this.storesWritable("settings")) return false;
        if (key === "levelDisplayFormat" || this.displayOptions().some(option => option.key === key)) return this.updateDisplaySetting(key, value, persist);
        const control = this.panelSettingControls().find(item => item.key === key);
        const toggles = ["rememberOffenders", "muteRememberedOnRejoin"];
        if (control) {
            if (value === "" || value === null || !Number.isFinite(Number(value))) return false;
            this.settings[key] = this.clamp(Number(value), control.min, control.max);
        } else if (toggles.includes(key) && typeof value === "boolean") {
            this.settings[key] = value;
        } else return false;
        this.normalizeSettings();
        if (key !== "tileMeters") for (const userId of this.signals.keys()) this.resetBlastWindow(userId);
        if (persist) {
            this.saveSettings();
            if (key === "tileMeters") {
                if (value) this.scheduleDiscovery(true);
                else this.clearOverlays();
            }
        }
        this.renderPanel(true);
        return true;
    }

    resetPanelTuning() {
        if (!this.storesWritable("settings")) return false;
        for (const { key } of this.panelSettingControls()) this.settings[key] = this.defaultSettings[key];
        this.saveSettings();
        for (const userId of this.signals.keys()) this.resetBlastWindow(userId);
        this.recordActivity("settings", null, "Detection sliders reset to defaults");
        this.renderPanel(true);
    }

    renderActivity() {
        let html = '<div class="vg3-view-body vg5-activity" data-vg-key="activity-view" aria-label="Recent activity">';
        if (!this.activity.length) return html + '<p class="vg5-idle">No actions in this call yet.</p></div>';
        const page = Math.max(0, this.activity.findIndex(entry => entry.id === this.activityEventId));
        const entry = this.activity[page];
        const seconds = Math.max(0, Math.floor((Date.now() - entry.at) / 1000));
        const when = seconds < 5 ? "Just now" : seconds < 60 ? seconds + "s ago" : Math.floor(seconds / 60) + "m ago";
        const member = this.members.get(entry.userId);
        const undo = entry.type === "auto-mute" && member?.autoMutedAt === entry.at && !member.manualMutedAt;
        const name = this.esc(entry.name);
        html += '<div class="vg5-activity-head"><strong title="' + name + '">' + name + '</strong><time>' + when + '</time><button type="button" class="vg3-quiet-button" data-vg-action="clear-activity">Clear</button></div>';
        html += '<div class="vg5-activity-message" data-vg-key="event-' + entry.id + '"><span title="' + this.esc(entry.message + (entry.detail ? " · " + entry.detail : "")) + '">' + this.esc(entry.message) + '</span>' +
            (undo ? '<button type="button" class="vg3-event-undo" data-vg-action="undo-event" data-event-id="' + entry.id + '" aria-label="Undo mute for ' + name + '">Undo mute</button>' : '') + '</div>';
        if (entry.detail) html += '<p class="vg5-event-detail" title="' + this.esc(entry.detail) + '">' + this.esc(entry.detail) + '</p>';
        return html + this.renderPager("activity-page", "Activity", page, this.activity.length) + '</div>';
    }

    renderPanelSettings() {
        const display = this.settingsTab === "display";
        const profiles = this.settingsTab === "profiles";
        let html = '<div id="vg3-settings-view" class="vg3-view-body vg3-settings" data-vg-key="settings-view" aria-label="VoiceGuard settings">';
        html += '<div class="vg3-settings-tabs" role="group" aria-label="Settings category">';
        for (const [tab, label] of [["appearance", "Appearance"], ["display", "Display"], ["detection", "Detection"], ["profiles", "Profiles"]]) {
            html += '<button type="button" data-vg-action="settings-tab" data-tab="' + tab + '" aria-pressed="' + (this.settingsTab === tab) + '">' + label + '</button>';
        }
        html += '</div><div data-vg-key="settings-' + this.settingsTab + '">';
        if (this.settingsTab === "appearance") return html + this.renderAppearance() + '</div></div>';
        if (display) return html + this.renderDisplaySettings() + '</div></div>';
        if (profiles) return html + this.renderPreferenceProfiles() + '</div></div>';
        const sliders = this.panelSettingControls();
        const toggles = [
            ["rememberOffenders", "Remember offenders", "Keep confirmed blast history across rejoins."],
            ["muteRememberedOnRejoin", "Protect against returning offenders", "Mute remembered offenders when they return."]
        ];
        const pageCount = sliders.length + toggles.length;
        const page = Math.min(this.settingsPage, pageCount - 1);
        const control = sliders[page];
        if (control) {
            const value = this.settings[control.key];
            const label = control.unit === "percent" ? Math.round(value * 100) + "%" : Number(value).toFixed(2).replace(/\.?0+$/, "") + "s";
            html += '<div class="vg3-setting-field" data-vg-key="setting-' + control.key + '"><label for="vg3-setting-' + control.key + '"><span>' + control.label + '</span><output for="vg3-setting-' + control.key + '">' + label + '</output></label><input id="vg3-setting-' + control.key + '" type="range" data-vg-setting="' + control.key + '" min="' + control.min + '" max="' + control.max + '" step="' + control.step + '" value="' + value + '" aria-valuetext="' + label + '"></div>';
        } else {
            const [key, label, hint] = toggles[page - sliders.length];
            html += this.renderSettingToggle(key, label, hint, key === "muteRememberedOnRejoin" && !this.settings.rememberOffenders);
        }
        html += '<div class="vg5-detection-pages">' + this.renderPager("setting-page", "Detection setting", page, pageCount);
        return html + '<button type="button" class="vg3-quiet-button" data-vg-action="reset-tuning" title="Reset detection sliders · Analysis window ' + this.settings.analysisWindowSeconds + 's">Reset</button></div></div></div>';
    }

    renderAppearance() {
        const select = (key, label, options) => '<label><span>' + label + '</span><select data-vg-appearance="' + key + '">' +
            options.map(([value, title]) => '<option value="' + value + '"' + (this.appearance[key] === value ? ' selected' : '') + '>' + title + '</option>').join("") + '</select></label>';
        const size = this.panelSize();
        const dimension = (key, label, description) => '<label><span>' + label + ' <small>px</small></span><input type="number" aria-label="' + description + '" data-vg-appearance="' + key + '" min="' + VG_SIZE_LIMITS[key][0] + '" max="' + VG_SIZE_LIMITS[key][1] + '" step="1" value="' + size[key] + '"></label>';
        const reset = '<button type="button" data-vg-appearance-action="reset" aria-label="Reset appearance" title="Reset theme, font, text size and panel size">Reset</button>';
        let html = '<section class="vg7-appearance" data-vg-section="' + this.appearanceSection + '" aria-label="Appearance controls">';
        html += '<div class="vg7-appearance-switch" role="group" aria-label="Appearance view"><button type="button" data-vg-appearance-action="style-section" aria-pressed="' + (this.appearanceSection === "style") + '">Style</button><button type="button" data-vg-appearance-action="size-section" aria-pressed="' + (this.appearanceSection === "size") + '">Size</button>' + reset + '</div><div class="vg7-style-fields">';
        html += select("theme", "Theme", Object.entries(VG_THEMES));
        html += select("font", "Font", Object.entries(VG_FONTS));
        html += select("textSize", "Text size", VG_TEXT_SIZES.map(size => [size, size + "%"]));
        html += '</div><div class="vg7-sizing"><div class="vg7-size-presets" role="group" aria-label="Panel size presets">';
        for (const [preset, label] of [["fit", "Fit"], ["compact", "Compact"], ["roomy", "Roomy"]]) {
            html += '<button type="button" data-vg-appearance-action="' + preset + '" aria-pressed="' + this.sizePresetSelected(preset) + '"' + (preset === "fit" ? ' aria-label="Fit to call" title="Fit to call"' : '') + '>' + label + '</button>';
        }
        return html + '</div><div class="vg7-size-fields">' + dimension("width", "Width", "Panel width in pixels") + dimension("height", "Height", "Roster height in pixels") +
            '<span class="vg7-reset-wide">' + reset + '</span></div></div></section>';
    }

    createPanel() {
        const existing = document.getElementById?.("vg-rtp-panel");
        if (existing) existing.remove();
        this.panel = document.createElement("div");
        this.lastPanelHtml = "";
        this.panel.id = "vg-rtp-panel";
        this.panel.setAttribute?.("role", "region");
        this.panel.setAttribute?.("aria-label", "VoiceGuard voice protection");
        this.panel.onmouseenter = () => { this.panelInteracting = true; };
        this.panel.onmouseleave = () => { this.panelInteracting = false; };
        this.panel.onpointerdown = event => this.startResize(event);
        this.panel.onpointermove = event => this.moveResize(event);
        this.panel.onpointerup = event => {
            if (this.resizeDrag?.pointerId !== event.pointerId) return;
            this.moveResize(event);
            this.finishResize(true);
        };
        this.panel.onpointercancel = this.panel.onlostpointercapture = event => {
            if (this.resizeDrag?.pointerId === event.pointerId) this.finishResize(false);
        };
        this.panel.oninput = event => {
            const key = event.target?.getAttribute?.("data-vg-setting");
            if (key) {
                this.updatePanelSetting(key, event.target.type === "checkbox" ? event.target.checked : event.target.value, false);
                return;
            }
            if (event.target?.getAttribute?.("data-vg-action") !== "search") return;
            this.panelSearch = event.target.value;
            this.renderPanel(true);
        };
        this.panel.onchange = event => {
            if (this.appearanceFieldChanged(event.target)) return;
            if (event.target?.getAttribute?.("data-vg-preset-file")) {
                this.importPreferencePresetFile(event.target.files?.[0]);
                return;
            }
            const key = event.target?.getAttribute?.("data-vg-setting");
            if (key) this.updatePanelSetting(key, event.target.type === "checkbox" ? event.target.checked : event.target.value);
        };
        this.panel.addEventListener?.("focusout", event => {
            if (this.isSizeField(event.target)) this.appearanceFieldChanged(event.target);
        });
        this.panel.onclick = event => {
            if (this.appearanceButtonClicked(event.target)) return;
            const button = event.target?.closest?.("[data-vg-action]");
            if (!button) return;
            const action = button.getAttribute("data-vg-action");
            const userId = button.getAttribute("data-user-id");
            if (action === "export-preset") {
                this.downloadPreferencePreset();
            } else if (action === "protection-profile") {
                this.applyProtectionProfile(button.getAttribute("data-profile"));
            } else if (action === "open-profiles") {
                this.setPanelView("settings");
                this.settingsTab = "profiles";
                this.renderPanel(true);
                this.panel.querySelector?.('[data-vg-action="settings-tab"][data-tab="profiles"]')?.focus();
            } else if (action === "settings-group") {
                const group = button.getAttribute("data-group");
                if (this.displaySettingsGroups().some(item => item.id === group)) {
                    this.settingsGroup = this.settingsGroup === group ? null : group;
                    this.settingsPage = 0;
                    this.renderPanel(true);
                    this.panel.querySelector?.('[data-vg-action="settings-group"][data-group="' + group + '"]')?.focus();
                }
            } else if (action === "close-tool") {
                if (this.panelView === "settings") this.closePanelSettings();
                else {
                    this.setPanelView("people");
                    this.panel.querySelector?.('[data-vg-action="toggle-tools"]')?.focus();
                }
            } else if (action === "settings-tab") {
                const tab = button.getAttribute("data-tab");
                if (["appearance", "display", "detection", "profiles"].includes(tab)) {
                    this.settingsTab = tab;
                    this.settingsPage = 0;
                    this.renderPanel(true);
                }
            } else if (action === "setting-page") {
                this.movePanelPage(button, Number(button.getAttribute("data-page")));
            } else if (action === "display-preset") {
                this.applyDisplayPreset(button.getAttribute("data-preset"));
            } else if (action === "reset-display") {
                this.resetDisplaySettings();
            } else if (action === "level-format") {
                this.updateDisplaySetting("levelDisplayFormat", button.getAttribute("data-format"));
            } else if (action === "view") {
                const view = button.getAttribute("data-view");
                this.setPanelView(view);
                const focus = view === "settings" ? '[data-vg-action="settings-tab"][data-tab="appearance"]' : '[data-vg-action="close-tool"]';
                this.panel.querySelector?.(focus)?.focus();
            } else if (action === "toggle-tools") {
                this.toolsOpen = !this.toolsOpen;
                this.policyMenuUserId = null;
                this.renderPanel(true);
            } else if (action === "toggle-find") {
                this.findOpen = !this.findOpen;
                this.setPanelView("people");
                this.panel.querySelector?.(this.findOpen ? '[data-vg-action="search"]' : '[data-vg-action="toggle-tools"]')?.focus();
            } else if (action === "clear-activity") {
                this.activity = [];
                this.activityEventId = null;
                this.renderPanel(true);
                this.panel.querySelector?.('[data-vg-action="close-tool"]')?.focus();
            } else if (action === "activity-page") {
                this.movePanelPage(button, Number(button.getAttribute("data-page")));
            } else if (action === "undo-event") {
                if (this.undoActivityMute(button.getAttribute("data-event-id"))) this.panel.querySelector?.('[data-vg-action="close-tool"]')?.focus();
            } else if (action === "reset-tuning") {
                this.resetPanelTuning();
            } else if (action === "toggle-drawer") {
                this.toggleDrawer();
                this.panel.querySelector?.('[data-vg-action="toggle-drawer"]')?.focus();
            } else if (action === "filter") {
                this.setPanelFilter(button.getAttribute("data-filter"));
            } else if (action === "toggle-auto-mute") {
                this.toggleAutoMute();
            } else if (action === "clear-search") {
                this.panelSearch = "";
                this.renderPanel(true);
                this.panel.querySelector?.('[data-vg-action="search"]')?.focus();
            } else if (action === "select-participant") {
                this.selectParticipant(userId);
            } else if (action === "toggle-details") {
                this.detailsOpen = !this.detailsOpen || !!this.policyMenuUserId;
                this.policyMenuUserId = null;
                this.renderPanel(true);
            } else if (action === "close-inspector") {
                this.closeInspector();
            } else if (action === "set-policy") {
                const fromMenu = !!button.closest?.(".vg3-policy-menu");
                this.setUserPolicy(userId, button.getAttribute("data-policy"));
                if (fromMenu) this.focusPolicyTrigger(userId);
            } else if (action === "toggle-policy-menu") {
                this.togglePolicyMenu(userId);
            } else if (action === "toggle-mute") {
                // Consult current state, not a stale button attribute.
                if (this.isUserMuted(userId)) this.manualUnmute(userId);
                else this.manualMute(userId);
            }
        };
        this.panel.onkeydown = event => {
            if (this.resizeDrag && event.key === "Escape") {
                this.finishResize(false);
                event.preventDefault?.();
                event.stopPropagation?.();
                return;
            }
            if (this.handleSizeFieldKey(event) || this.resizeFromKey(event) || this.onRosterKey(event)) return;
            if (event.key !== "Escape") return;
            if (this.toolsOpen) {
                this.toolsOpen = false;
                this.renderPanel(true);
                this.panel.querySelector?.('[data-vg-action="toggle-tools"]')?.focus();
                event.preventDefault?.();
                event.stopPropagation?.();
                return;
            }
            if (this.panelView === "settings") {
                if (this.settingsTab === "display" && this.settingsGroup) {
                    const group = this.settingsGroup;
                    this.settingsGroup = null;
                    this.settingsPage = 0;
                    this.renderPanel(true);
                    this.panel.querySelector?.('[data-vg-action="settings-group"][data-group="' + group + '"]')?.focus();
                } else this.closePanelSettings();
                event.preventDefault?.();
                event.stopPropagation?.();
                return;
            }
            if (this.policyMenuUserId) {
                const userId = this.policyMenuUserId;
                this.policyMenuUserId = null;
                this.renderPanel(true);
                this.focusPolicyTrigger(userId);
                event.preventDefault?.();
                event.stopPropagation?.();
            } else if (this.panelView !== "people") {
                this.setPanelView("people");
                this.panel.querySelector?.('[data-vg-action="toggle-tools"]')?.focus();
                event.preventDefault?.();
                event.stopPropagation?.();
            } else if (this.findOpen && this.panelSearch) {
                this.panelSearch = "";
                this.renderPanel(true);
                this.panel.querySelector?.('[data-vg-action="search"]')?.focus();
                event.preventDefault?.();
            } else if (this.findOpen) {
                this.findOpen = false;
                this.renderPanel(true);
                this.panel.querySelector?.('[data-vg-action="toggle-tools"]')?.focus();
                event.preventDefault?.();
                event.stopPropagation?.();
            } else if (this.detailsOpen) {
                this.detailsOpen = false;
                this.renderPanel(true);
                this.panel.querySelector?.('[data-vg-action="toggle-details"]')?.focus();
                event.preventDefault?.();
                event.stopPropagation?.();
            } else if (this.inspectedUserId) {
                this.closeInspector();
                event.preventDefault?.();
                event.stopPropagation?.();
            }
        };
        document.body.appendChild(this.panel);
    }

    movePanelPage(button, page) {
        if (button.disabled || !Number.isInteger(page) || page < 0) return;
        const action = button.getAttribute("data-vg-action");
        if (action === "activity-page") {
            const entry = this.activity[page];
            if (!entry) return;
            this.activityEventId = page === 0 ? null : entry.id;
        } else if (action === "setting-page") {
            if (page > this.displayOptions().length) return;
            this.settingsPage = page;
        }
        const wasNext = button.getAttribute("data-page-direction") === "next";
        this.renderPanel(true);
        const available = this.panel.querySelectorAll?.('[data-vg-action="' + action + '"]:not(:disabled)');
        if (available?.length) available[wasNext ? available.length - 1 : 0].focus();
    }

    selectParticipant(userId) {
        if (!this.rosterIds.includes(userId)) return false;
        if (this.inspectedUserId !== userId) this.detailsOpen = false;
        this.inspectedUserId = userId;
        this.rosterFocusId = userId;
        this.setPanelView("people");
        return true;
    }

    closeInspector() {
        const userId = this.inspectedUserId;
        this.inspectedUserId = null;
        this.detailsOpen = false;
        this.policyMenuUserId = null;
        this.renderPanel(true);
        this.focusRosterTile(userId);
    }

    focusRosterTile(userId) {
        if (!this.validSnowflake(userId)) return;
        this.panel?.querySelector?.('[data-vg-action="select-participant"][data-user-id="' + userId + '"]')?.focus();
    }

    onRosterKey(event) {
        const tile = event.target?.closest?.('[data-vg-action="select-participant"]');
        const index = this.rosterIds.indexOf(tile?.getAttribute("data-user-id"));
        if (index < 0 || event.altKey || event.ctrlKey || event.metaKey) return false;
        const columns = this.rosterLayout?.columns || 1;
        const destinations = {
            ArrowLeft: index - 1,
            ArrowRight: index + 1,
            ArrowUp: index - columns,
            ArrowDown: index + columns,
            Home: 0,
            End: this.rosterIds.length - 1
        };
        if (!Object.prototype.hasOwnProperty.call(destinations, event.key)) return false;
        event.preventDefault?.();
        event.stopPropagation?.();
        const next = this.rosterIds[this.clamp(destinations[event.key], 0, this.rosterIds.length - 1)];
        this.rosterFocusId = next;
        this.renderPanel(true);
        this.focusRosterTile(next);
        return true;
    }

    focusPolicyTrigger(userId) {
        if (!/^\d{15,25}$/.test(String(userId))) return;
        this.panel?.querySelector?.('[data-vg-action="toggle-policy-menu"][data-user-id="' + userId + '"]')?.focus();
    }

    patchPanelHtml(html) {
        if (html === this.lastPanelHtml) return;
        this.lastPanelHtml = html;
        const template = document.createElement("template");
        // The lightweight regression harness has no HTML parser.
        if (!template.content || !this.panel.childNodes) {
            if (this.panel.innerHTML !== html) this.panel.innerHTML = html;
            return;
        }
        template.innerHTML = html;
        const key = node => node.nodeType === 1 ? node.getAttribute("data-vg-key") : null;
        const matches = (a, b) => a && b && a.nodeType === b.nodeType && a.nodeName === b.nodeName && key(a) === key(b);
        const sync = (target, incoming) => {
            if (target.nodeType === 3) {
                if (target.nodeValue !== incoming.nodeValue) target.nodeValue = incoming.nodeValue;
                return;
            }
            if (target.nodeType === 1 && incoming.nodeType === 1) {
                for (const attribute of Array.from(target.attributes)) {
                    if (!incoming.hasAttribute(attribute.name)) target.removeAttribute(attribute.name);
                }
                for (const attribute of Array.from(incoming.attributes)) {
                    if (target.getAttribute(attribute.name) !== attribute.value) target.setAttribute(attribute.name, attribute.value);
                }
                if (target.tagName === "INPUT") {
                    if (target.type === "checkbox" || target.type === "radio") {
                        target.checked = incoming.hasAttribute("checked");
                    } else if (!(target.hasAttribute("data-vg-appearance") && document.activeElement === target) && target.value !== incoming.getAttribute("value")) {
                        target.value = incoming.getAttribute("value") || "";
                    }
                }
            }
            const previous = Array.from(target.childNodes);
            const used = new Set();
            let cursor = target.firstChild;
            for (const next of Array.from(incoming.childNodes)) {
                let node = matches(cursor, next) && !used.has(cursor) ? cursor : null;
                if (!node) node = previous.find(candidate => !used.has(candidate) && matches(candidate, next));
                if (!node) node = next.cloneNode(true);
                if (node !== cursor) target.insertBefore(node, cursor);
                used.add(node);
                sync(node, next);
                cursor = node.nextSibling;
            }
            for (const node of previous) if (!used.has(node)) node.remove();
            if (target.tagName === "SELECT" && target.value !== incoming.value) target.value = incoming.value;
        };
        sync(this.panel, template.content);
    }

    rosterLayoutFor(count, width, height) {
        const scale = this.appearance.textSize / 100;
        const targetWidth = (this.settings.compactRows ? 68 : 81) * Math.sqrt(scale);
        const targetHeight = (this.settings.compactRows ? 19 : 23) * scale;
        // Reserve room for every participant before choosing how much text to show.
        const gap = Math.min(count > 120 ? 1 : 2,
            Math.floor(height / Math.ceil(Math.sqrt(count)) / 3));
        // Chromium rounds pointer coordinates, so reserve at least two CSS pixels per tile when feasible.
        const tilesAtTwoPixels = Math.floor((width + gap) / (2 + gap)) * Math.floor((height + gap) / (2 + gap));
        const minimumCell = tilesAtTwoPixels >= count ? 2 : 0;
        let best = { columns: 1, rows: count, gap, density: "markers", count };
        let bestScore = -1;
        for (let columns = 1; columns <= count; columns++) {
            const rows = Math.ceil(count / columns);
            const cellWidth = (width - gap * (columns - 1)) / columns;
            const cellHeight = (height - gap * (rows - 1)) / rows;
            if (cellWidth <= 0 || cellHeight <= 0) continue;
            if (cellWidth < minimumCell || cellHeight < minimumCell) continue;
            const score = Math.min(cellWidth / targetWidth, cellHeight / targetHeight);
            if (score <= bestScore) continue;
            bestScore = score;
            const density = cellWidth >= 49 * scale && cellHeight >= 17 * scale ? "compact"
                : cellWidth >= 18 && cellHeight >= 10 ? "initials" : "markers";
            best = { columns, rows, gap, density, count };
        }
        return best;
    }

    rosterGridStyle(layout) {
        return '--vg-columns:' + layout.columns + ';--vg-rows:' + layout.rows + ';--vg-gap:' + layout.gap + 'px';
    }

    updateRosterLayout(width, height) {
        if (!width || !height || !this.rosterIds.length || !this.rosterElement) return;
        const layout = this.rosterLayoutFor(this.rosterIds.length, width, height);
        this.rosterLayout = layout;
        this.rosterElement.setAttribute("style", this.rosterGridStyle(layout));
        this.rosterElement.setAttribute("data-density", layout.density);
    }

    disconnectRoster() {
        this.rosterObserver?.disconnect();
        this.rosterObserver = null;
        this.rosterElement = null;
    }

    syncRosterLayout(countChanged) {
        const grid = this.settings.panelCollapsed ? null : this.panel.querySelector?.(".vg5-roster");
        if (grid === this.rosterElement) {
            if (grid && (countChanged || !this.rosterObserver)) this.updateRosterLayout(grid.clientWidth, grid.clientHeight);
            return;
        }
        this.disconnectRoster();
        if (!grid) return;
        this.rosterElement = grid;
        this.updateRosterLayout(grid.clientWidth, grid.clientHeight);
        if (typeof ResizeObserver === "function") {
            this.rosterObserver = new ResizeObserver(([entry]) => {
                if (entry?.target === this.rosterElement) this.updateRosterLayout(entry.contentRect.width, entry.contentRect.height);
            });
            this.rosterObserver.observe(grid);
        }
    }

    renderRosterTile(row, highlighted) {
        const self = row.self;
        const { userId, signal, policy, muted, attention, member } = row;
        const tone = self ? "local" : muted ? "muted" : attention ? "alert" : signal.active ? "speaking" : "quiet";
        const status = self ? "You" : member?.muteError ? "Audio action failed" : row.warning.label;
        const muteKind = !muted ? "" : member?.manualMutedAt ? "manual" : member?.autoMutedAt ? "automatic" : "discord";
        const muteLabel = { manual: "Manual local mute", automatic: "Automatic local mute", discord: "Discord local mute" }[muteKind];
        const policyLabel = self || policy === "guarded" ? "" : policy === "trusted" ? "Trusted"
            : policy === "soft:1" ? "Probe 1s" : "Soft " + policy.slice(5) + "s";
        const identity = self && row.name === "You" ? "You" : row.name + " · " + status;
        const label = [identity, muteLabel, policyLabel && policyLabel.toLowerCase() !== status.toLowerCase() ? policyLabel : ""].filter(Boolean).join(" · ");
        const name = this.esc(row.name);
        const active = userId === this.inspectedUserId;
        const reading = !self && signal.mapped && this.settings.showAudioLevels && this.settings.showLevelValue ? " · Level " + this.formatDisplayLevel(signal.raw) : "";
        let html = '<button type="button" class="vg5-tile ' + tone + (highlighted ? ' matched' : '') + '" data-vg-key="' + (self ? 'local-' : 'user-') + userId + '" data-vg-action="select-participant" data-user-id="' + userId + '" data-mute-kind="' + muteKind + '" tabindex="' + (userId === this.rosterFocusId ? 0 : -1) + '" aria-pressed="' + active + '" aria-label="' + this.esc(label) + '" title="' + this.esc(label + reading + (member?.muteError ? ' · ' + member.muteError : '')) + '">';
        html += '<span class="vg5-initial" aria-hidden="true">' + this.esc(this.userInitial(row.name)) + '</span>';
        html += '<span class="vg5-tile-copy" aria-hidden="true">' + name + '</span>';
        if (muteKind || attention) html += '<span class="vg5-state-mark" aria-hidden="true"></span>';
        if (!self && signal.mapped && !muted && this.settings.showAudioLevels && this.settings.showLevelMeter && signal.level > 0) {
            const level = Math.round(this.clamp(signal.level) * 100);
            html += '<span class="vg5-tile-meter" aria-hidden="true"><i style="width:' + level + '%"></i></span>';
        }
        return html + '</button>';
    }

    renderViewNavigation(count) {
        let html = '<nav id="vg6-tools" class="vg4-navigation" data-vg-key="navigation" aria-label="VoiceGuard tools"' + (this.toolsOpen ? '' : ' hidden') + '>';
        html += '<button type="button" data-vg-action="toggle-find"' + (count ? '' : ' disabled') + '>' + (this.findOpen ? 'Hide find' : 'Find') + '</button>';
        for (const [view, label] of [["overview", "Signal"], ["activity", "Activity"], ["settings", "Settings"]]) {
            html += '<button type="button" data-vg-action="view" data-view="' + view + '">' + label + '</button>';
        }
        return html + '</nav>';
    }

    renderPanel(force = false) {
        if (!this.panel) return;
        if (!this.settings.debugVisuals) {
            this.panel.style.display = "none";
            this.disconnectRoster();
            this.finishResize(false, false);
            return;
        }
        const renderNow = Date.now();
        const renderGap = this.settings.panelCollapsed ? 500 : 200;
        if (!force && renderNow - this.lastPanelRenderAt < renderGap) return;
        this.lastPanelRenderAt = renderNow;
        this.panel.style.display = "flex";
        this.panel.className = [
            "vg5-dock",
            this.settings.panelCollapsed ? "vg3-collapsed" : "",
            this.settings.compactRows ? "vg3-compact" : "",
            this.settings.reducePanelMotion ? "vg3-still" : ""
        ].filter(Boolean).join(" ");

        const account = this.currentUserId();
        const accountChanged = this.accountChanged();
        const self = accountChanged ? null : account;
        const channelId = self ? this.currentVoiceChannelId(self) : null;
        const rows = this.channelUsers(channelId).filter(id => id !== self).map(userId => {
            const signal = this.signals.get(userId) || { raw: 0, level: 0, mapped: false, active: false, peak: 0, blast: this.emptyBlastMetrics() };
            const member = this.members.get(userId);
            const muted = this.isUserMuted(userId, member);
            const warning = this.warningFor(signal, userId);
            return {
                userId, signal, member, muted, warning,
                name: this.userName(userId),
                policy: this.policyValueFor(userId),
                attention: !!member?.muteError || (!muted && warning.rank >= 2)
            };
        }).sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));

        const activeCount = rows.filter(row => row.signal.mapped && row.signal.active && !row.muted).length;
        const alertCount = rows.filter(row => row.attention).length;
        const mutedCount = rows.filter(row => row.muted).length;
        const managedCount = rows.filter(row => row.policy !== "guarded" || row.muted).length;
        const query = this.panelSearch.trim().toLocaleLowerCase();
        const matchesHighlight = row => {
            if (query && !row.name.toLocaleLowerCase().includes(query) && !row.userId.includes(query)) return false;
            if (this.panelFilter === "alerts") return row.attention;
            if (this.panelFilter === "managed") return row.policy !== "guarded" || row.muted;
            return true;
        };
        const local = channelId ? { userId: self, name: this.userName(self), self: true } : null;
        const countChanged = rows.length + Number(!!local) !== this.rosterIds.length;
        const focusedTile = document.activeElement?.closest?.('[data-vg-action="select-participant"]')?.getAttribute("data-user-id");
        const focusedInspector = document.activeElement?.closest?.(".vg5-inspector");
        this.rosterIds = [...(local ? [self] : []), ...rows.map(row => row.userId)];
        if (this.rosterChannelId !== channelId) {
            this.rosterChannelId = channelId;
            this.inspectedUserId = null;
            this.detailsOpen = false;
            this.policyMenuUserId = null;
        }
        if (!this.rosterIds.includes(this.inspectedUserId)) {
            this.inspectedUserId = null;
            this.detailsOpen = false;
        }
        if (!this.rosterIds.includes(this.rosterFocusId)) this.rosterFocusId = this.rosterIds[0] ?? null;
        const inspected = rows.find(row => row.userId === this.inspectedUserId);
        if (!inspected || !matchesHighlight(inspected)) this.policyMenuUserId = null;
        const count = this.rosterIds.length;
        this.applyPanelSize();
        this.panel.setAttribute?.("data-vg-theme", this.appearance.theme);
        this.panel.setAttribute?.("data-vg-font", this.appearance.font);
        this.panel.setAttribute?.("data-vg-large-text", String(this.appearance.textSize >= 115));
        this.panel.style.setProperty?.("--vg-text-scale", String(this.appearance.textSize / 100));
        const layoutChanged = count && this.rosterLayout?.count !== count;
        if (layoutChanged) {
            const { width, height } = this.panelSize();
            this.rosterLayout = this.rosterLayoutFor(count, width - 14, height);
        }
        const mappedCount = rows.filter(row => row.signal.mapped).length;
        const storageReady = this.protectionStorageReady();
        const telemetryReady = !!channelId && !this.membershipUnavailable && this.telemetry.inbound && (mappedCount > 0 || !rows.length);
        const statusReason = !storageReady ? "Waiting for saved protection settings. New muting is paused; existing audio recovery continues. Retrying automatically." : this.membershipUnavailable ? "Updating participants; automatic detection is waiting" : this.telemetry.reason;
        const partial = telemetryReady && mappedCount < rows.length;
        const status = accountChanged ? "Discord account changed" : !storageReady ? "Waiting for saved settings" : !self ? "Connecting to Discord" : !channelId ? "Standing by" : this.membershipUnavailable ? "Updating call" : !rows.length ? "Waiting for other people" : !telemetryReady ? "Waiting for levels" : partial ? "Some levels missing" : "Incoming levels live";
        const showHealth = accountChanged || !storageReady || this.membershipUnavailable || (rows.length && (!telemetryReady || partial)) || (!this.toolsOpen && this.panelView === "overview");
        const drawerLabel = this.settings.panelCollapsed ? "Open VoiceGuard" : "Collapse VoiceGuard";
        const drawerBadge = alertCount || mutedCount;
        let html = '<button type="button" class="vg3-drawer-toggle" data-vg-key="drawer" data-vg-action="toggle-drawer" aria-label="' + drawerLabel + '" title="' + drawerLabel + '" aria-expanded="' + !this.settings.panelCollapsed + '" aria-controls="vg3-content">' + (this.settings.panelCollapsed ? "VG" : "&minus;") + (this.settings.panelCollapsed && drawerBadge ? '<span class="vg3-drawer-badge">' + drawerBadge + '</span>' : "") + '</button>';
        html += '<div id="vg3-content" class="vg3-content" data-vg-key="content"' + (this.settings.panelCollapsed ? ' inert aria-hidden="true"' : "") + '>';
        if (!this.settings.panelCollapsed) {
            const countLabel = count + (count === 1 ? ' person' : ' people');
            html += '<div class="vg3-head" data-vg-key="head"><strong class="vg5-title">VoiceGuard</strong><span class="vg5-call-count" title="' + countLabel + '" aria-label="' + countLabel + '">' + count + '</span><button type="button" class="vg3-auto-switch" data-vg-action="toggle-auto-mute" role="switch" aria-label="Automatic local muting" aria-checked="' + this.settings.autoMute + '" title="Pausing Auto keeps existing mutes.">Auto ' + (this.settings.autoMute ? 'on' : 'off') + '</button><button type="button" class="vg6-tools-trigger" data-vg-action="toggle-tools" aria-label="VoiceGuard tools" aria-expanded="' + this.toolsOpen + '" aria-controls="vg6-tools" title="Find, signal, activity, and settings">&hellip;</button></div>';
            html += this.renderViewNavigation(count);
            html += '<div class="vg3-guard-strip" data-vg-key="guard"' + (showHealth ? '' : ' hidden') + '><span class="vg3-health ' + (telemetryReady && !partial ? "ready" : "waiting") + '" title="' + this.esc(statusReason || status) + '">' + status + '</span>';
            if (this.settings.showCallSummary) html += '<span class="vg3-summary" aria-label="Call summary"' + (this.panelView === "overview" ? '' : ' hidden') + '>' + activeCount + ' live · ' + mutedCount + ' muted' + (alertCount ? ' · <b>' + alertCount + ' alerts</b>' : '') + '</span>';
            if (this.settings.showConnectionDetails && rows.length) html += '<span class="vg5-coverage"' + (this.panelView === "overview" ? '' : ' hidden') + '>' + mappedCount + '/' + rows.length + ' mapped</span>';
            html += '</div>';
            if (count) {
                html += '<div class="vg5-find" data-vg-key="find"' + (this.findOpen && this.panelView === "people" && !this.toolsOpen ? '' : ' hidden') + '><div class="vg3-search" data-vg-key="search"><input type="search" data-vg-key="search-input" data-vg-action="search" aria-label="Search participants" placeholder="Find someone" autocomplete="off" spellcheck="false" maxlength="160" value="' + this.esc(this.panelSearch) + '">' + (query ? '<button type="button" data-vg-key="clear-search" data-vg-action="clear-search" aria-label="Clear participant search">&times;</button>' : "") + '</div>';
                html += '<div class="vg3-filters" role="group" aria-label="Highlight participants">';
                for (const [filter, label, total] of [["all", "All", count], ["alerts", "Alerts", alertCount], ["managed", "Managed", managedCount]]) {
                    html += '<button type="button" data-vg-action="filter" data-filter="' + filter + '" aria-pressed="' + (this.panelFilter === filter) + '" title="' + total + ' ' + label.toLowerCase() + '">' + label + '</button>';
                }
                html += '</div></div>';
                const layout = this.rosterLayout;
                html += '<div class="vg5-roster" data-vg-key="roster" role="group" aria-label="Everyone in voice" data-density="' + layout.density + '" style="' + this.rosterGridStyle(layout) + '">';
                if (local) html += this.renderRosterTile(local, this.panelFilter === "all" && !!query && local.name.toLocaleLowerCase().includes(query));
                for (const row of rows) html += this.renderRosterTile(row, (!!query || this.panelFilter !== "all") && matchesHighlight(row));
                html += '</div>';
            } else {
                const emptyMessage = accountChanged ? 'Re-enable VoiceGuard to use the current account.' : self ? 'Join a voice channel to see its roster.' : 'Waiting for your Discord account.';
                html += '<div class="vg5-empty" data-vg-key="empty">' + emptyMessage + '</div>';
            }
            if (!this.toolsOpen) {
                if (this.panelView !== "people") {
                    const tool = { overview: "Signal", activity: "Activity", settings: "Settings" }[this.panelView];
                    html += '<div class="vg6-tool-pane" data-vg-view="' + this.panelView + '" data-vg-key="tool-pane"><div class="vg6-tool-title"><strong>' + tool + '</strong><button type="button" data-vg-action="close-tool" aria-label="Close ' + tool.toLowerCase() + '">&times;</button></div>';
                    if (this.panelView === "overview") html += this.renderOverview(rows, telemetryReady, partial, statusReason, self);
                    else if (this.panelView === "activity") {
                        if (!accountChanged) html += this.renderActivity();
                    }
                    else html += this.renderPanelSettings();
                    html += '</div>';
                } else if (inspected) {
                    const avatar = this.detailsOpen && this.settings.showAvatars && this.settings.loadProfileImages ? this.userAvatar(inspected.userId) : null;
                    html += this.renderParticipant({ ...inspected, avatar });
                } else if (local && this.inspectedUserId === self) {
                    html += '<div class="vg5-inspector vg5-local-detail" data-vg-key="local-detail"><p class="vg5-idle">You · VoiceGuard monitors incoming levels.</p><button type="button" data-vg-action="close-inspector" aria-label="Close participant details">&times;</button></div>';
                } else if (this.findOpen && count && query && !rows.some(matchesHighlight) && !(local && local.name.toLocaleLowerCase().includes(query))) {
                    html += '<p class="vg5-idle" data-vg-key="empty-search">No matching names in this call.</p>';
                }
            }
        }
        html += '</div>';
        if (!this.settings.panelCollapsed) html += '<button type="button" class="vg7-resize-grip" data-vg-key="resize" data-vg-resize aria-label="Resize VoiceGuard" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home" aria-description="Drag to resize, or use the arrow keys. Hold Shift for larger steps. Home restores Fit to call." title="Resize VoiceGuard · Drag or use arrow keys"></button>';
        this.patchPanelHtml(html);
        this.syncRosterLayout(force || countChanged || layoutChanged);
        if ((focusedTile && !this.rosterIds.includes(focusedTile)) || (focusedInspector && !this.inspectedUserId)) {
            if (this.rosterFocusId) this.focusRosterTile(this.rosterFocusId);
            else this.panel.querySelector?.('[data-vg-action="toggle-drawer"]')?.focus();
        }
    }

    renderParticipant(row) {
        const { signal, warning, member, muted, policy } = row;
        const settings = this.settings;
        const userId = this.esc(row.userId);
        const name = this.esc(row.name);
        const visual = signal.level > 0 ? Math.max(signal.level, settings.minVisibleLevel) : 0;
        const width = Math.round(this.clamp(visual) * 1000) / 10;
        const level = Math.round(this.clamp(signal.raw) * 100);
        const peakRaw = signal.peak || signal.raw || 0;
        const peak = Math.round(this.clamp(peakRaw) * 100);
        const currentReading = signal.mapped ? this.formatDisplayLevel(signal.raw) : "--";
        const peakReading = signal.mapped ? this.formatDisplayLevel(peakRaw) : "--";
        const blast = Math.round((member?.autoMutedAt ? member.lastBlast?.score || 0 : signal.blast?.score || 0) * 100);
        const options = this.policyOptions();
        const selectedPolicy = options.find(option => option.value === policy) || options[0];
        const open = this.policyMenuUserId === row.userId;
        const details = this.detailsOpen && !open;
        const detailAvailable = settings.showAudioLevels || settings.showStatusLabels || settings.showBlastScore || settings.showAvatars;
        const softPolicy = policy.startsWith("soft:") ? policy : "soft:20";
        const quickValues = settings.showQuickPolicies ? ["guarded", softPolicy, "trusted"] : [];
        const quick = open ? options.filter(option => quickValues.includes(option.value)).map(option => {
            const selected = option.value === policy;
            return '<button type="button" class="vg3-policy-chip ' + (selected ? "selected" : "") + '" data-vg-action="set-policy" data-user-id="' + userId + '" data-policy="' + option.value + '" aria-pressed="' + selected + '" title="' + this.esc(option.detail) + '"><span class="vg3-policy-dot" style="background:' + option.color + '"></span>' + this.esc(option.label) + '</button>';
        }).join("") : "";
        let html = '<div class="vg3-person vg5-inspector" role="group" aria-label="Controls for ' + name + '" data-vg-key="inspector-' + userId + '" data-user-id="' + userId + '">';
        html += '<div class="vg3-person-top" data-vg-key="person-top"><span class="vg3-name" title="' + name + '">' + name + '</span>';
        html += '<button type="button" class="vg3-policy-trigger ' + (open ? "open" : "") + '" data-vg-key="policy-trigger" data-vg-action="toggle-policy-menu" data-user-id="' + userId + '" data-policy="' + policy + '" aria-label="Protection for ' + name + ': ' + this.esc(selectedPolicy.label) + '" aria-expanded="' + open + '" aria-controls="vg3-policy-' + userId + '" title="Choose protection and soft-mute duration"><span class="vg3-policy-current">' + this.esc(selectedPolicy.label) + '</span><span class="vg3-policy-chevron" aria-hidden="true">&#9662;</span></button>';
        html += '<button type="button" class="vg3-mute-button" data-vg-key="mute" data-vg-action="toggle-mute" data-user-id="' + userId + '" data-muted="' + muted + '" aria-label="' + (muted ? "Unmute " : "Mute ") + name + '">' + (muted ? "Unmute" : "Mute") + '</button>';
        if (detailAvailable) html += '<button type="button" class="vg6-details-trigger" data-vg-action="toggle-details" aria-expanded="' + details + '" aria-controls="vg6-details-' + userId + '" aria-label="Details for ' + name + '">Details</button>';
        html += '<button type="button" class="vg5-close" data-vg-action="close-inspector" aria-label="Close participant details">&times;</button></div>';
        html += '<div id="vg6-details-' + userId + '" class="vg6-details" data-vg-key="details"' + (details && detailAvailable ? '' : ' hidden') + '>';
        if (settings.showAvatars || settings.showStatusLabels) html += '<div class="vg6-details-status">';
        if (settings.showAvatars) html += '<div class="vg3-avatar" data-vg-key="avatar"><span>' + this.esc(this.userInitial(row.name)) + '</span>' + (row.avatar ? '<img src="' + this.esc(row.avatar) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : "") + '</div>';
        if (settings.showStatusLabels) html += '<span class="vg3-warning" style="color:' + warning.color + '">' + warning.label + '</span>';
        if (settings.showAvatars || settings.showStatusLabels) html += '</div>';
        if (settings.showAudioLevels && settings.showLevelMeter) {
            html += '<div class="vg3-track-wrap" data-vg-key="meter"><div class="vg3-track-label"><span>' + (signal.mapped ? "Audio level" : "Audio level unavailable") + '</span>' + (settings.showLevelValue ? '<strong data-vg-key="current" data-vg-metric="current">' + currentReading + '</strong>' : "") + '</div><div class="vg3-track" role="meter" aria-label="' + name + ' audio level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + level + '" aria-valuetext="' + (signal.mapped ? this.formatDisplayLevel(signal.raw) : "Unavailable") + '"><div class="vg3-fill" style="width:' + width + '%;background:' + this.colorForLevel(signal.level) + '"></div>';
            if (settings.showThresholdMarker) html += '<span class="vg3-threshold" data-vg-key="threshold" style="left:' + settings.loudThreshold * 100 + '%" title="Loud threshold" aria-hidden="true"></span>';
            if (settings.showPeakMarker) html += '<span class="vg3-peak" data-vg-key="peak" style="left:' + Math.min(99, peak) + '%" aria-hidden="true"></span>';
            html += '</div></div>';
        }
        const metrics = [];
        if (settings.showAudioLevels) {
            if (settings.showLevelValue && !settings.showLevelMeter) metrics.push('<span data-vg-key="current" data-vg-metric="current">Now ' + currentReading + '</span>');
            if (settings.showPeakLevel) metrics.push('<span data-vg-key="peak" data-vg-metric="peak">Peak ' + peakReading + '</span>');
            if (settings.showDbfs && settings.levelDisplayFormat !== "dbfs") metrics.push('<span data-vg-key="dbfs" data-vg-metric="dbfs">' + (signal.mapped ? this.formatDb(signal.raw) : "No signal") + '</span>');
        }
        if (settings.showBlastScore) metrics.push('<span data-vg-key="blast" data-vg-metric="blast" class="' + (blast >= 75 ? "hot" : "") + '">Blast ' + blast + '%</span>');
        if (metrics.length) html += '<div class="vg3-metrics" data-vg-key="metrics">' + metrics.join("") + '</div>';
        if (settings.showBlastScore) {
            const evidence = member?.autoMutedAt ? member.lastBlast || signal.blast || {} : signal.blast || {};
            const requiredMs = evidence.requiredMs || this.requiredHoldMs(row.userId, member);
            const loudMs = Math.max(0, evidence.loudMs || 0);
            const progress = Math.round(this.clamp(loudMs / Math.max(1, requiredMs)) * 100);
            const evidenceState = this.isTrusted(row.userId) ? "Trusted · detection skipped" : !signal.mapped ? "Waiting for audio data" : member?.manualMutedAt ? "Manually muted" : (loudMs / 1000).toFixed(1) + "s / " + (requiredMs / 1000).toFixed(1) + "s loud";
            html += '<div class="vg4-evidence" data-vg-key="evidence" title="Duration is one check. Activity, loud share, and RMS must also qualify."><div><span>Evidence</span><strong title="' + this.esc(evidenceState) + '">' + evidenceState + '</strong></div>' + (signal.mapped && !this.isTrusted(row.userId) && !member?.manualMutedAt ? '<div class="vg4-evidence-track" role="meter" aria-label="' + name + ' loud evidence progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + progress + '"><i style="width:' + progress + '%"></i></div>' : '') + '</div>';
        }
        html += '</div>';
        if (open) {
            html += '<div id="vg3-policy-' + userId + '" class="vg3-policy-menu" data-vg-key="policy-menu" role="group" aria-label="Protection options for ' + name + '">';
            if (settings.showQuickPolicies) html += '<div class="vg3-policy-chips" role="group" aria-label="Quick protection for ' + name + '">' + quick + '</div>';
            for (const option of options) {
                if (quickValues.includes(option.value)) continue;
                const selected = option.value === policy;
                html += '<button type="button" class="vg3-policy-option ' + (selected ? "selected" : "") + '" data-vg-action="set-policy" data-user-id="' + userId + '" data-policy="' + option.value + '" aria-pressed="' + selected + '" title="' + this.esc(option.detail) + '">' + this.esc(option.label) + '</button>';
            }
            html += '</div>';
        }
        if (member?.muteError) html += '<div class="vg3-error" data-vg-key="error" role="status">' + this.esc(member.muteError) + '</div>';
        return html + '</div>';
    }

    addStyles() {
        const css = `
#vg-rtp-panel {
    --vg-bg: #141b24;
    --vg-card: #1d2734;
    --vg-inset: #101720;
    --vg-text: #eff4fb;
    --vg-muted: #a7b7c9;
    --vg-line: #304155;
    --vg-green: #91dcd0;
    --vg-amber: #efc180;
    --vg-red: #f3a6a6;
    --vg-text-scale: 1;
    --vg-font: var(--font-primary, "Segoe UI", system-ui, sans-serif);
    --text-positive: var(--vg-green);
    --text-warning: var(--vg-amber);
    --text-danger: var(--vg-red);
    position: fixed;
    top: 52px;
    right: 10px;
    z-index: 100000;
    width: min(var(--vg-panel-width, 266px), calc(100vw - 20px));
    max-height: min(760px, calc(100dvh - 64px));
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: clip;
    border: 1px solid var(--vg-line);
    border-radius: 8px;
    background: var(--vg-bg);
    color: var(--vg-text);
    box-shadow: 0 6px 18px #0004;
    color-scheme: dark;
    font: calc(13px * var(--vg-text-scale))/1.32 var(--vg-font);
    font-variant-numeric: tabular-nums;
    letter-spacing: normal;
}
#vg-rtp-panel *, #vg-rtp-panel *::before, #vg-rtp-panel *::after { box-sizing: border-box; }
#vg-rtp-panel [hidden] { display: none !important; }
#vg-rtp-panel :is(button, input, select) { font: inherit; }
#vg-rtp-panel button, #vg-rtp-panel .vg4-import-label {
    min-width: 0;
    border: 1px solid var(--vg-line);
    border-radius: 6px;
    background: var(--vg-card);
    color: var(--vg-text);
    padding: 3px 7px;
    cursor: pointer;
}
#vg-rtp-panel button:hover:enabled, #vg-rtp-panel .vg4-import-label:hover { border-color: var(--vg-muted); }
#vg-rtp-panel button:disabled { opacity: .5; cursor: default; }
#vg-rtp-panel :is(button, input, select):focus-visible, #vg-rtp-panel .vg4-import-label:focus-within {
    outline: 2px solid var(--vg-green);
    outline-offset: -2px;
}
#vg-rtp-panel button[aria-pressed="true"] { border-color: var(--vg-green); color: var(--vg-green); }
#vg-rtp-panel input { accent-color: var(--vg-green); }
#vg-rtp-panel p { margin: 0; }
#vg-rtp-panel .vg3-content {
    min-height: 0; flex: 1 1 auto; display: flex; flex-direction: column;
    overflow: clip; padding-bottom: 12px; container: voiceguard / inline-size;
}
#vg-rtp-panel .vg7-resize-grip {
    position: absolute; left: 0; bottom: 0; z-index: 1; width: 18px; height: 12px; padding: 0;
    background: transparent; color: var(--vg-muted); border-color: transparent;
    touch-action: none; cursor: nesw-resize;
}
#vg-rtp-panel .vg7-resize-grip::before, #vg-rtp-panel .vg7-resize-grip::after {
    content: ""; position: absolute; left: 3px; bottom: 3px; width: 8px; height: 1px;
    background: currentColor; transform: rotate(45deg);
}
#vg-rtp-panel .vg7-resize-grip::after { width: 5px; left: 2px; bottom: 3px; }
#vg-rtp-panel[data-vg-resizing="true"] { cursor: nesw-resize; user-select: none; }
#vg-rtp-panel.vg3-collapsed { width: 34px; height: 30px; }
#vg-rtp-panel .vg3-drawer-toggle {
    position: absolute; top: 4px; right: 6px;
    width: 23px; height: 23px; padding: 0;
    font-size: 17px; font-weight: 650; line-height: 1;
    color: var(--vg-muted); background: transparent;
}
#vg-rtp-panel.vg3-collapsed .vg3-drawer-toggle {
    inset: 0; width: 100%; height: 100%; border: 0;
    color: var(--vg-green); font-size: calc(13px * var(--vg-text-scale));
}
#vg-rtp-panel .vg3-drawer-badge {
    position: absolute; top: 3px; right: 3px; padding: 1px 4px;
    border-radius: 7px; background: var(--vg-amber); color: #161b20; font-size: calc(9px * var(--vg-text-scale));
}
#vg-rtp-panel .vg3-head {
    display: flex; flex: none; align-items: center; gap: 6px;
    min-height: 32px; padding: 4px 35px 3px 9px;
}
#vg-rtp-panel .vg5-title {
    flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: calc(13px * var(--vg-text-scale)); font-weight: 700; letter-spacing: -.15px;
}
#vg-rtp-panel .vg5-call-count { flex: none; color: var(--vg-muted); font-size: calc(11px * var(--vg-text-scale)); white-space: nowrap; }
#vg-rtp-panel :is(.vg3-auto-switch, .vg6-tools-trigger) {
    flex: none; min-height: 23px; padding: 1px 6px; font-size: calc(11px * var(--vg-text-scale)); font-weight: 600;
    background: transparent; color: var(--vg-muted); border-color: transparent;
}
#vg-rtp-panel .vg3-auto-switch { margin-left: auto; }
#vg-rtp-panel .vg6-tools-trigger { width: 24px; padding: 0; font-size: 16px; line-height: 1; }
#vg-rtp-panel .vg3-auto-switch[aria-checked="true"] {
    color: var(--vg-green);
    background: color-mix(in srgb, var(--vg-green) 7%, var(--vg-bg));
}
#vg-rtp-panel .vg6-tools-trigger[aria-expanded="true"] { background: var(--vg-card); color: var(--vg-text); }
#vg-rtp-panel .vg3-guard-strip {
    flex: none; display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
    padding: 0 11px 6px; color: var(--vg-muted); font-size: calc(11px * var(--vg-text-scale)); white-space: nowrap;
}
#vg-rtp-panel .vg3-health { min-width: 0; text-overflow: ellipsis; overflow: hidden; }
#vg-rtp-panel .vg3-health.ready { color: var(--vg-green); }
#vg-rtp-panel .vg3-summary, #vg-rtp-panel .vg5-coverage { flex: none; }
#vg-rtp-panel .vg3-summary b, #vg-rtp-panel .vg3-health.waiting { color: var(--vg-amber); }
#vg-rtp-panel .vg5-find { display: flex; flex: none; gap: 6px; margin: 0 9px 6px; min-height: 28px; }
#vg-rtp-panel .vg3-search {
    flex: 1 1 100px; min-width: 0; display: flex;
    border: 1px solid var(--vg-line); border-radius: 6px; background: var(--vg-inset);
}
#vg-rtp-panel .vg3-search input {
    flex: 1; min-width: 0; width: 100%; border: 0; border-radius: inherit;
    padding: 4px 7px; background: transparent; color: var(--vg-text); font-size: calc(12px * var(--vg-text-scale));
}
#vg-rtp-panel .vg3-search input::placeholder { color: var(--vg-muted); }
#vg-rtp-panel .vg3-search input::-webkit-search-cancel-button { display: none; }
#vg-rtp-panel .vg3-search button { align-self: stretch; padding: 0 6px; border: 0; background: transparent; color: var(--vg-muted); }
#vg-rtp-panel .vg3-filters { display: flex; gap: 3px; flex: none; }
#vg-rtp-panel .vg3-filters button { padding: 2px 6px; font-size: calc(11px * var(--vg-text-scale)); }
#vg-rtp-panel .vg5-roster {
    flex: 0 1 var(--vg-roster-height, 25px);
    min-height: 20px;
    display: grid;
    grid-template-columns: repeat(var(--vg-columns), minmax(0, 1fr));
    grid-template-rows: repeat(var(--vg-rows), minmax(0, 1fr));
    gap: var(--vg-gap);
    margin: 0 6px 6px;
}
#vg-rtp-panel .vg5-tile {
    --tile-accent: var(--vg-green);
    position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto;
    align-items: center; column-gap: 4px;
    min-width: 0; min-height: 0; padding: 0 4px 1px;
    overflow: clip; text-align: left;
    border: 1px solid transparent; border-radius: 4px; background: transparent;
    font-size: calc(12px * var(--vg-text-scale));
}
#vg-rtp-panel .vg5-tile.local { color: var(--vg-muted); }
#vg-rtp-panel .vg5-tile.alert { --tile-accent: var(--vg-amber); }
#vg-rtp-panel .vg5-tile.muted { --tile-accent: var(--vg-red); color: var(--vg-muted); }
#vg-rtp-panel .vg5-tile:hover:enabled { border-color: transparent; background: var(--vg-card); color: var(--vg-text); }
#vg-rtp-panel .vg5-tile:is(.matched, [aria-pressed="true"]) {
    border-color: color-mix(in srgb, var(--vg-green) 38%, var(--vg-line));
    background: color-mix(in srgb, var(--vg-green) 9%, var(--vg-bg)); color: var(--vg-text);
}
#vg-rtp-panel .vg5-tile-copy { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#vg-rtp-panel .vg5-initial { display: none; }
#vg-rtp-panel .vg5-state-mark { width: 5px; height: 5px; background: var(--tile-accent); transform: rotate(45deg); }
#vg-rtp-panel .vg5-tile[data-mute-kind="automatic"] .vg5-state-mark { background: transparent; border: 1px solid var(--tile-accent); transform: none; }
#vg-rtp-panel .vg5-tile[data-mute-kind="manual"] .vg5-state-mark { height: 2px; transform: rotate(-45deg); }
#vg-rtp-panel .vg5-tile[data-mute-kind="discord"] .vg5-state-mark { border-radius: 50%; transform: none; }
#vg-rtp-panel .vg5-tile-meter { position: absolute; left: 4px; right: 4px; bottom: 0; height: 1.5px; overflow: clip; }
#vg-rtp-panel .vg5-tile-meter i { display: block; height: 100%; border-radius: 2px; background: var(--tile-accent); opacity: .78; }
#vg-rtp-panel .vg5-roster:is([data-density="initials"], [data-density="markers"]) .vg5-tile { padding: 0 1px; border: 0; border-radius: 2px; }
#vg-rtp-panel .vg5-roster:is([data-density="initials"], [data-density="markers"]) .vg5-tile-copy { display: none; }
#vg-rtp-panel .vg5-roster[data-density="initials"] .vg5-initial { display: block; text-align: center; font-size: 9px; line-height: 1; }
#vg-rtp-panel .vg5-roster[data-density="initials"] .vg5-state-mark { width: 4px; }
#vg-rtp-panel .vg5-roster[data-density="initials"] .vg5-tile-meter { left: 1px; right: 1px; height: 1px; }
#vg-rtp-panel .vg5-roster[data-density="markers"] :is(.vg5-initial, .vg5-tile-meter, .vg5-state-mark) { display: none; }
#vg-rtp-panel .vg5-roster[data-density="markers"] .vg5-tile { background: var(--vg-line); }
#vg-rtp-panel .vg5-roster[data-density="markers"] .vg5-tile:is(.speaking, .muted, .alert) { background: var(--tile-accent); }
#vg-rtp-panel .vg5-roster[data-density="markers"] .vg5-tile:is(.matched, [aria-pressed="true"]) { outline: 1px solid var(--vg-text); outline-offset: -1px; }
#vg-rtp-panel .vg5-empty { flex: none; padding: 2px 9px 9px; color: var(--vg-muted); font-size: calc(11px * var(--vg-text-scale)); }
#vg-rtp-panel[data-vg-sized="true"] .vg5-empty { flex: 0 1 var(--vg-roster-height); min-height: 22px; }
#vg-rtp-panel .vg4-navigation {
    flex: none; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 3px; padding: 0 6px 5px;
}
#vg-rtp-panel .vg4-navigation button { min-height: 24px; padding: 2px 4px; font-size: calc(11px * var(--vg-text-scale)); }
#vg-rtp-panel .vg5-idle { padding: 2px 8px 7px; color: var(--vg-muted); font-size: calc(11px * var(--vg-text-scale)); }
#vg-rtp-panel :is(.vg5-inspector, .vg6-tool-pane) { flex: none; min-width: 0; border-top: 1px solid var(--vg-line); }
#vg-rtp-panel .vg5-inspector { padding: 4px 6px; }
#vg-rtp-panel .vg5-local-detail { display: flex; align-items: center; justify-content: space-between; }
#vg-rtp-panel .vg5-local-detail .vg5-idle { padding: 0 3px; }
#vg-rtp-panel :is(.vg3-person-top, .vg6-tool-title, .vg6-details-status) { display: flex; align-items: center; gap: 4px; }
#vg-rtp-panel :is(.vg3-name, .vg6-tool-title strong) {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    padding-left: 3px; font-size: calc(12px * var(--vg-text-scale)); font-weight: 650;
}
#vg-rtp-panel .vg6-tool-title { padding: 3px 6px 1px; }
#vg-rtp-panel .vg6-details { padding: 3px 4px 2px; }
#vg-rtp-panel .vg6-details-status { gap: 6px; }
#vg-rtp-panel .vg3-avatar {
    position: relative; width: 20px; height: 20px; display: grid; place-items: center; overflow: clip;
    border-radius: 4px; color: var(--vg-muted); background: var(--vg-card); font-size: calc(10px * var(--vg-text-scale));
}
#vg-rtp-panel .vg3-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
#vg-rtp-panel .vg3-warning { color: var(--vg-muted); font-size: calc(10px * var(--vg-text-scale)); font-weight: 620; }
#vg-rtp-panel :is(.vg3-policy-trigger, .vg3-mute-button, .vg5-close, .vg6-details-trigger, .vg6-tool-title button) {
    flex: none; min-height: 23px; padding-inline: 5px; font-size: calc(11px * var(--vg-text-scale)); white-space: nowrap;
}
#vg-rtp-panel .vg3-policy-trigger { display: flex; align-items: center; gap: 3px; }
#vg-rtp-panel .vg3-policy-trigger.open { border-color: var(--vg-green); }
#vg-rtp-panel .vg3-mute-button[data-muted="true"] { color: var(--vg-green); }
#vg-rtp-panel :is(.vg5-close, .vg6-tool-title button, .vg6-details-trigger) { background: transparent; color: var(--vg-muted); border-color: transparent; }
#vg-rtp-panel :is(.vg5-close, .vg6-tool-title button) { width: 23px; padding-inline: 2px; font-size: 14px; }
#vg-rtp-panel .vg6-details-trigger[aria-expanded="true"] { color: var(--vg-green); background: var(--vg-card); }
#vg-rtp-panel .vg3-track-wrap, #vg-rtp-panel .vg4-evidence { margin-top: 5px; }
#vg-rtp-panel :is(.vg3-track-label, .vg4-evidence > div:first-child) {
    display: flex; justify-content: space-between; gap: 6px;
    color: var(--vg-muted); font-size: calc(10.5px * var(--vg-text-scale));
}
#vg-rtp-panel :is(.vg3-track-label, .vg4-evidence) strong { color: var(--vg-text); font-weight: 650; }
#vg-rtp-panel :is(.vg3-track, .vg4-evidence-track, .vg4-coverage-track) {
    position: relative; height: 4px; margin-top: 2px; overflow: clip; border-radius: 2px; background: var(--vg-inset);
}
#vg-rtp-panel :is(.vg3-fill, .vg4-evidence-track i, .vg4-coverage-track i) { display: block; height: 100%; }
#vg-rtp-panel .vg4-evidence-track i { background: var(--vg-amber); }
#vg-rtp-panel .vg4-coverage-track i { background: var(--vg-green); }
#vg-rtp-panel :is(.vg3-threshold, .vg3-peak) { position: absolute; inset-block: 0; width: 1px; background: var(--vg-amber); }
#vg-rtp-panel .vg3-peak { background: var(--vg-muted); }
#vg-rtp-panel .vg3-metrics { display: flex; flex-wrap: wrap; gap: 2px 8px; margin-top: 4px; color: var(--vg-muted); font-size: calc(10px * var(--vg-text-scale)); }
#vg-rtp-panel .vg3-metrics .hot { color: var(--vg-amber); }
#vg-rtp-panel .vg3-error { color: var(--vg-red); font-size: calc(11px * var(--vg-text-scale)); padding-top: 4px; overflow-wrap: anywhere; }
#vg-rtp-panel .vg3-policy-menu { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 3px; margin-top: 6px; }
#vg-rtp-panel .vg3-policy-menu button { min-height: 24px; color: var(--vg-text); font-size: calc(10.5px * var(--vg-text-scale)); padding-inline: 2px; }
#vg-rtp-panel .vg3-policy-chips { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-column: 1 / -1; gap: 3px; }
#vg-rtp-panel .vg3-policy-dot { display: inline-block; width: 5px; height: 5px; border-radius: 50%; margin-right: 4px; }
#vg-rtp-panel .vg3-view-body { flex: none; min-width: 0; padding: 2px 9px 8px; font-size: calc(11px * var(--vg-text-scale)); }
#vg-rtp-panel :is(.vg3-settings-tabs, .vg3-display-presets, .vg5-settings-groups, .vg4-profiles, .vg3-number-format) {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3px; margin: 2px 0 5px;
}
#vg-rtp-panel :is(.vg3-settings-tabs, .vg3-display-presets, .vg5-settings-groups, .vg4-profiles, .vg3-number-format) button { min-height: 24px; padding-inline: 2px; font-size: calc(11px * var(--vg-text-scale)); }
#vg-rtp-panel .vg3-settings-tabs { grid-template-columns: 1.35fr 1fr 1.1fr 1fr; }
#vg-rtp-panel .vg3-settings-tabs button { line-height: 1.15; overflow-wrap: anywhere; }
.vg7-appearance { display: grid; gap: 5px; }
.vg7-sizing { display: grid; gap: 5px; }
.vg7-appearance-switch { display: none; }
.vg7-appearance :is(.vg7-style-fields,.vg7-size-presets,.vg7-size-fields) { display: grid; gap: 4px; align-items: end; }
.vg7-style-fields { grid-template-columns: 1.15fr 1fr .8fr; }
.vg7-size-presets { grid-template-columns: 1.15fr 1fr 1fr; }
.vg7-size-fields { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; }
.vg7-appearance label { min-width: 0; display: grid; gap: 1px; }
.vg7-appearance label span { color: var(--vg-muted, var(--text-muted)); }
.vg7-appearance label small { opacity: .75; }
.vg7-appearance :is(select,input[type="number"]) {
    width: 100%; min-width: 0; min-height: 24px; padding: 2px 4px;
    border: 1px solid var(--vg-line, var(--background-modifier-accent)); border-radius: 5px;
    background: var(--vg-inset, var(--background-tertiary)); color: var(--vg-text, var(--text-normal));
}
#vg-rtp-panel .vg7-appearance button { min-height: 24px; padding-inline: 4px; line-height: 1.15; }
#vg-rtp-panel .vg7-size-presets button { white-space: normal; }
.vg4-native-settings .vg7-appearance { gap: 9px; padding: 3px 0 5px; }
.vg4-native-settings .vg7-appearance :is(button, select, input) { color: var(--text-normal); font: inherit; }
.vg4-native-settings .vg7-appearance button { min-height: 28px; border: 1px solid var(--background-modifier-accent); border-radius: 5px; background: var(--background-secondary); }
.vg4-native-settings .vg7-appearance button[aria-pressed="true"] { border-color: var(--text-positive); }
#vg-rtp-panel :is(.vg3-tuning-note, .vg3-setting-field label, .vg3-setting-toggle) {
    display: flex; justify-content: space-between; align-items: center; gap: 8px; color: var(--vg-muted);
}
#vg-rtp-panel .vg3-setting-field { padding: 0 4px 3px; }
#vg-rtp-panel .vg3-setting-field input { display: block; width: 100%; margin: 2px 0 0; min-height: 16px; }
#vg-rtp-panel .vg3-setting-toggle { min-height: 24px; padding: 0 4px; }
#vg-rtp-panel :is(.vg3-setting-toggle strong, .vg3-setting-field output) { color: var(--vg-text); font-weight: 630; }
#vg-rtp-panel .vg5-pager {
    display: grid; grid-template-columns: max-content minmax(0,1fr) max-content; gap: 4px;
    margin-top: 4px; align-items: center; text-align: center; color: var(--vg-muted);
}
#vg-rtp-panel :is(.vg5-pager button, .vg3-quiet-button, .vg3-event-undo) { min-height: 23px; padding-block: 2px; }
#vg-rtp-panel .vg3-event-undo { color: var(--vg-green); }
#vg-rtp-panel :is(.vg5-activity-head, .vg5-activity-message) { display: flex; align-items: center; gap: 6px; }
#vg-rtp-panel :is(.vg5-activity-head strong, .vg5-activity-message span, .vg5-event-detail, .vg4-preset-notice) {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#vg-rtp-panel :is(.vg5-activity-head strong, .vg5-activity-message span) { margin-right: auto; }
#vg-rtp-panel :is(.vg5-activity-head time, .vg5-event-detail) { color: var(--vg-muted); }
#vg-rtp-panel .vg5-activity-message { min-height: 25px; }
#vg-rtp-panel .vg4-profile-detail, #vg-rtp-panel .vg4-portable .vg4-preset-boundary { color: var(--vg-muted); }
#vg-rtp-panel .vg4-preset-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin: 4px 0; }
#vg-rtp-panel .vg4-import-label { position: relative; overflow: clip; text-align: center; }
#vg-rtp-panel .vg4-import-label > input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
#vg-rtp-panel .vg4-preset-notice { margin-top: 3px; color: var(--vg-green); }
#vg-rtp-panel .vg4-preset-notice.error { color: var(--vg-red); }
#vg-rtp-panel :is(.vg4-coverage > div:first-child, .vg4-overview-tuning) {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
}
#vg-rtp-panel .vg4-coverage p { margin: 3px 0 4px; color: var(--vg-muted); }
#vg-rtp-panel .vg4-coverage p strong { margin-right: 4px; color: var(--vg-text); }
#vg-rtp-panel .vg4-overview-tuning > div { display: grid; color: var(--vg-muted); }
#vg-rtp-panel .vg4-overview-tuning strong { color: var(--vg-text); }
#vg-rtp-panel .vg5-detection-pages { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
#vg-rtp-panel .vg5-detection-pages .vg5-pager { flex: 1; margin-top: 0; }
.vg3-tile-meter { position: absolute; left: 8px; right: 8px; bottom: 4px; height: 4px; background: #0008; box-shadow: 0 0 0 1px #fff2; overflow: hidden; z-index: 50; pointer-events: none; }
.vg3-tile-fill { height: 100%; width: 0; transition: width 90ms linear, background 120ms linear; }
#vg-rtp-panel[data-vg-theme="discord"] {
    --vg-bg: var(--bg-base-secondary, var(--background-secondary, #141b24));
    --vg-card: var(--bg-base-primary, var(--background-primary, #1d2734));
    --vg-inset: var(--bg-base-tertiary, var(--background-tertiary, #101720));
    --vg-text: var(--text-default, var(--text-normal, #eff4fb));
    --vg-muted: var(--text-muted, #a7b7c9);
    --vg-line: var(--border-subtle, var(--background-modifier-accent, #304155));
}
#vg-rtp-panel[data-vg-theme="midnight"] {
    --vg-bg: #121529; --vg-card: #202643; --vg-inset: #0e1122;
    --vg-text: #f3f1ff; --vg-muted: #b4beda; --vg-line: #39446a; --vg-green: #adc4ff;
}
#vg-rtp-panel[data-vg-theme="contrast"] {
    --vg-bg: #080b10; --vg-card: #151c24; --vg-inset: #040609;
    --vg-text: #fff; --vg-muted: #d9e5ef; --vg-line: #b1c2d2;
    --vg-green: #abffea; --vg-amber: #ffd78c; --vg-red: #ffb6b6;
}
#vg-rtp-panel[data-vg-theme="light"] {
    --vg-bg: #f6f8fc; --vg-card: #e8eef7; --vg-inset: #dae3ef; --vg-text: #152335; --vg-muted: #4b5f76;
    --vg-line: #abbdd2; --vg-green: #136858; --vg-amber: #894c06; --vg-red: #a43447;
    box-shadow: 0 9px 30px #283f5729; color-scheme: light;
}
.theme-light #vg-rtp-panel[data-vg-theme="discord"] { --vg-green: #136858; --vg-amber: #894c06; --vg-red: #a43447; color-scheme: light; }
#vg-rtp-panel[data-vg-font="system"] { --vg-font: "Segoe UI", system-ui, sans-serif; }
#vg-rtp-panel[data-vg-font="readable"] { --vg-font: Verdana, "Segoe UI", sans-serif; }
#vg-rtp-panel[data-vg-font="mono"] { --vg-font: "Cascadia Mono", Consolas, monospace; }
@container voiceguard (max-width: 290px) {
    #vg-rtp-panel .vg3-settings-tabs { grid-template-columns: 1.35fr 1fr; }
}
@container voiceguard (max-width: 300px) {
    #vg-rtp-panel[data-vg-large-text="true"] .vg3-person-top {
        display: grid; grid-template-columns: minmax(0, 1fr) auto auto;
        grid-template-areas: "name name close" "policy mute details";
    }
    #vg-rtp-panel[data-vg-large-text="true"] .vg3-person-top .vg3-name { grid-area: name; }
    #vg-rtp-panel[data-vg-large-text="true"] .vg3-person-top .vg5-close { grid-area: close; justify-self: end; }
    #vg-rtp-panel[data-vg-large-text="true"] .vg3-person-top .vg3-policy-trigger { grid-area: policy; justify-content: center; }
    #vg-rtp-panel[data-vg-large-text="true"] .vg3-person-top .vg3-policy-current { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #vg-rtp-panel[data-vg-large-text="true"] .vg3-person-top .vg3-mute-button { grid-area: mute; }
    #vg-rtp-panel[data-vg-large-text="true"] .vg3-person-top .vg6-details-trigger { grid-area: details; }
}
@media (max-height: 360px) {
    #vg-rtp-panel .vg7-appearance-switch { display: grid; grid-template-columns: 1fr 1fr auto; gap: 4px; }
    #vg-rtp-panel .vg7-appearance[data-vg-section="style"] .vg7-sizing,
    #vg-rtp-panel .vg7-appearance[data-vg-section="size"] .vg7-style-fields,
    #vg-rtp-panel .vg7-reset-wide { display: none; }
    #vg-rtp-panel .vg7-size-fields { grid-template-columns: 1fr 1fr; }
    #vg-rtp-panel .vg6-tool-pane[data-vg-view="settings"] { position: relative; }
    #vg-rtp-panel .vg6-tool-pane[data-vg-view="settings"] .vg6-tool-title { position: absolute; right: 6px; top: 3px; padding: 0; }
    #vg-rtp-panel .vg6-tool-pane[data-vg-view="settings"] .vg6-tool-title strong { display: none; }
    #vg-rtp-panel .vg3-settings-tabs { margin-right: 25px; }
    #vg-rtp-panel .vg3-display-presets[data-vg-option-open="true"] { display: none; }
    #vg-rtp-panel :is(.vg4-profile-detail, .vg4-preset-boundary) { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
}
#vg-rtp-panel.vg3-still, #vg-rtp-panel.vg3-still * { transition: none !important; animation: none !important; }
@media (max-height: 540px) {
    #vg-rtp-panel { top: 8px; max-height: calc(100dvh - 16px); }
}
@media (max-width: 360px) {
    #vg-rtp-panel { right: 6px; width: min(var(--vg-panel-width, 266px), calc(100vw - 12px)); }
    #vg-rtp-panel .vg3-head { gap: 5px; }
    #vg-rtp-panel .vg3-guard-strip { padding-inline: 9px; font-size: calc(10px * var(--vg-text-scale)); gap: 5px; }
    #vg-rtp-panel .vg3-filters button { padding-inline: 4px; }
}
@media (max-height: 305px) {
    #vg-rtp-panel .vg3-head { min-height: 30px; padding-block: 3px; }
    #vg-rtp-panel .vg5-find { min-height: 23px; margin-bottom: 3px; }
    #vg-rtp-panel .vg3-search input { padding-block: 2px; }
    #vg-rtp-panel .vg5-roster { margin-bottom: 4px; }
    #vg-rtp-panel .vg3-view-body { padding-bottom: 4px; line-height: 1.2; }
    #vg-rtp-panel :is(.vg7-appearance, .vg7-sizing) { gap: 3px; }
    #vg-rtp-panel :is(.vg3-settings-tabs, .vg4-profiles) { margin-bottom: 3px; }
    #vg-rtp-panel :is(.vg7-appearance button, .vg7-appearance select, .vg7-appearance input, .vg3-settings-tabs button, .vg4-profiles button, .vg4-preset-actions > *) {
        min-height: 21px; padding-block: 1px; line-height: 1.15;
    }
    #vg-rtp-panel .vg4-profiles button { font-size: calc(9px * var(--vg-text-scale)); }
    #vg-rtp-panel .vg4-preset-actions { margin-block: 2px; }
    #vg-rtp-panel .vg4-preset-actions > * { font-size: calc(10px * var(--vg-text-scale)); }
    #vg-rtp-panel :is(.vg4-profile-detail, .vg4-preset-boundary, .vg4-preset-notice) { font-size: calc(9px * var(--vg-text-scale)); }
    #vg-rtp-panel .vg4-portable:has(+ .vg4-preset-notice) .vg4-preset-boundary { display: none; }
    #vg-rtp-panel .vg6-tool-pane[data-vg-view="overview"] { position: relative; }
    #vg-rtp-panel .vg6-tool-pane[data-vg-view="overview"] .vg6-tool-title { position: absolute; right: 6px; top: 3px; padding: 0; }
    #vg-rtp-panel .vg6-tool-pane[data-vg-view="overview"] .vg6-tool-title strong { display: none; }
    #vg-rtp-panel .vg4-coverage > div:first-child { min-height: 24px; padding-right: 24px; font-size: calc(10px * var(--vg-text-scale)); }
    #vg-rtp-panel .vg4-coverage > div:first-child strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #vg-rtp-panel .vg4-coverage > div:first-child span { white-space: nowrap; }
    #vg-rtp-panel .vg4-coverage p :is(strong, span) { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #vg-rtp-panel .vg4-overview-tuning { gap: 4px; }
    #vg-rtp-panel .vg4-overview-tuning > * { font-size: calc(10px * var(--vg-text-scale)); line-height: 1.15; white-space: nowrap; }
    #vg-rtp-panel .vg4-overview-tuning button { padding: 2px 5px; }
    #vg-rtp-panel .vg3-person-top button { padding-block: 1px; line-height: 1.15; }
    #vg-rtp-panel .vg6-details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 7px; }
    #vg-rtp-panel .vg6-details-status { grid-column: 1 / -1; }
    #vg-rtp-panel .vg6-details .vg3-avatar { width: 16px; height: 16px; }
    #vg-rtp-panel .vg6-details :is(.vg3-track-wrap, .vg4-evidence, .vg3-metrics) { margin-top: 0; }
    #vg-rtp-panel .vg6-details :is(.vg3-track-label, .vg4-evidence > div:first-child, .vg3-metrics) {
        gap: 2px 4px; font-size: calc(9px * var(--vg-text-scale)); line-height: 1.15;
    }
    #vg-rtp-panel .vg6-details :is(.vg3-track-label span, .vg4-evidence strong) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #vg-rtp-panel .vg6-details .vg3-metrics { grid-column: 1 / -1; order: 1; }
    #vg-rtp-panel .vg3-policy-menu button { min-height: 22px; padding-block: 2px; font-size: calc(9px * var(--vg-text-scale)); line-height: 1.15; }
    #vg-rtp-panel .vg3-error { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
@media (prefers-reduced-motion: reduce) {
    #vg-rtp-panel, #vg-rtp-panel *, .vg3-tile-fill { transition: none !important; animation: none !important; }
}
`;
        try {
            if (BdApi.DOM?.addStyle) {
                BdApi.DOM.addStyle("voiceguard-rtp-v3", css);
                return;
            }
        } catch (_) {}
        this.styleNode = document.createElement("style");
        this.styleNode.id = "voiceguard-rtp-v3-style";
        this.styleNode.textContent = css;
        document.head?.appendChild(this.styleNode);
    }

    removeStyles() {
        try { BdApi.DOM?.removeStyle?.("voiceguard-rtp-v3"); } catch (_) {}
        if (this.styleNode) this.styleNode.remove();
        this.styleNode = null;
        document.getElementById?.("voiceguard-rtp-v3-style")?.remove?.();
    }

    startDomObserver() {
        if (typeof MutationObserver !== "function" || !document.body) return;
        this.domObserver = new MutationObserver(mutations => {
            const onlyVoiceGuard = mutations.length > 0 && mutations.every(mutation => {
                const target = mutation.target;
                return target === this.panel
                    || target?.closest?.("#vg-rtp-panel")
                    || target?.closest?.(".vg3-tile-meter");
            });
            if (!onlyVoiceGuard) this.scheduleDiscovery();
        });
        this.domObserver.observe(document.body, { childList: true, subtree: true });
        this.scheduleDiscovery(true);
    }

    stopDomObserver() {
        if (this.domObserver) this.domObserver.disconnect();
        this.domObserver = null;
        if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
        this.discoveryTimer = null;
    }

    scheduleDiscovery(force = false) {
        if (!this.settings.tileMeters || typeof document.querySelectorAll !== "function") return;
        if (this.discoveryTimer) return;
        const minGap = 250;
        const wait = force ? 0 : Math.max(0, minGap - (Date.now() - this.lastDiscoveryAt));
        this.discoveryTimer = setTimeout(() => {
            this.discoveryTimer = null;
            this.discoverOverlays();
        }, wait);
    }

    activeId(value, activeUserIds) {
        const id = value == null ? "" : String(value);
        return activeUserIds.has(id) ? id : null;
    }

    idFromProps(props, activeUserIds) {
        if (!props || typeof props !== "object") return null;
        for (const key of ["userId", "participantUserId"]) {
            const id = this.activeId(props[key], activeUserIds);
            if (id) return id;
        }
        const candidates = [
            props.user?.id,
            props.member?.user?.id,
            props.participant?.user?.id,
            props.participant?.userId,
            props.voiceState?.userId,
            props.voiceState?.user?.id
        ];
        for (const candidate of candidates) {
            const id = this.activeId(candidate, activeUserIds);
            if (id) return id;
        }
        return null;
    }

    resolveUserId(element, activeUserIds) {
        const attrValues = [
            element?.dataset?.userId,
            element?.getAttribute?.("data-user-id"),
            element?.getAttribute?.("data-list-item-id")
        ];
        for (const value of attrValues) {
            const direct = this.activeId(value, activeUserIds);
            if (direct) return direct;
            const matches = String(value || "").match(/\d{15,25}/g) || [];
            for (const match of matches) if (activeUserIds.has(match)) return match;
        }

        const source = element?.getAttribute?.("src") || element?.src || "";
        const avatarMatch = String(source).match(/\/avatars\/(\d{15,25})\//);
        if (avatarMatch && activeUserIds.has(avatarMatch[1])) return avatarMatch[1];

        let node = element;
        for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
            for (const key of Object.keys(node)) {
                if (key.startsWith("__reactProps$")) {
                    const id = this.idFromProps(node[key], activeUserIds);
                    if (id) return id;
                }
                if (key.startsWith("__reactFiber$")) {
                    let fiber = node[key];
                    for (let hops = 0; fiber && hops < 7; hops += 1, fiber = fiber.return) {
                        const id = this.idFromProps(fiber.memoizedProps, activeUserIds)
                            || this.idFromProps(fiber.pendingProps, activeUserIds);
                        if (id) return id;
                    }
                }
            }
        }
        return null;
    }

    overlayTarget(element) {
        const voiceRow = element?.closest?.('[data-list-item-id*="voice-user"]');
        if (voiceRow) return voiceRow;
        let node = element;
        for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
            const marker = `${node.className || ""} ${node.getAttribute?.("data-list-item-id") || ""}`;
            if (/(voiceUser|voice-user|participant|videoWrapper|tile)/i.test(marker)) return node;
        }
        return null;
    }

    discoverOverlays() {
        this.lastDiscoveryAt = Date.now();
        if (!this.settings.tileMeters || typeof document.querySelectorAll !== "function") {
            this.clearOverlays();
            return;
        }
        const self = this.currentUserId();
        const channelId = self && !this.accountChanged() ? this.currentVoiceChannelId(self) : null;
        const activeUserIds = new Set(this.channelUsers(channelId).filter(id => id !== self));
        if (!activeUserIds.size) {
            this.clearOverlays();
            return;
        }

        let candidates = [];
        try {
            candidates = Array.from(document.querySelectorAll('[data-list-item-id*="voice-user"],[data-user-id],[class*="tile"] img[src*="/avatars/"],[class*="participant"] img[src*="/avatars/"],[class*="voiceUser"]'));
        } catch (_) {}
        for (const element of candidates.slice(0, 300)) {
            const userId = this.resolveUserId(element, activeUserIds);
            if (!userId) continue;
            const target = this.overlayTarget(element);
            if (target) this.attachOverlay(target, userId);
        }

        for (const [target, record] of Array.from(this.overlays.entries())) {
            if (target.isConnected === false || !activeUserIds.has(record.userId)) this.removeOverlay(target, record);
        }
        this.paintOverlays();
    }

    attachOverlay(target, userId) {
        const existing = this.overlays.get(target);
        if (existing) {
            existing.userId = userId;
            return;
        }
        const node = document.createElement("div");
        node.className = "vg3-tile-meter";
        node.setAttribute?.("aria-hidden", "true");
        const fill = document.createElement("div");
        fill.className = "vg3-tile-fill";
        node.appendChild(fill);
        const previousPosition = target.style?.position || "";
        let changedPosition = false;
        if (target.style && !target.style.position) {
            target.style.position = "relative";
            changedPosition = true;
        }
        target.appendChild(node);
        this.overlays.set(target, { userId, node, fill, previousPosition, changedPosition });
    }

    removeOverlay(target, record = this.overlays.get(target)) {
        if (!record) return;
        record.node?.remove?.();
        if (record.changedPosition && target.style?.position === "relative") {
            target.style.position = record.previousPosition;
        }
        this.overlays.delete(target);
    }

    clearOverlays() {
        for (const [target, record] of Array.from(this.overlays.entries())) this.removeOverlay(target, record);
    }

    paintOverlays() {
        for (const [target, record] of Array.from(this.overlays.entries())) {
            if (target.isConnected === false) {
                this.removeOverlay(target, record);
                continue;
            }
            const signal = this.signals.get(record.userId) || { level: 0, raw: 0, mapped: false, active: false, loudMs: 0, extremeMs: 0, blast: this.emptyBlastMetrics() };
            const visual = signal.level > 0 ? Math.max(signal.level, this.settings.minVisibleLevel) : 0;
            record.fill.style.width = `${this.clamp(visual) * 100}%`;
            record.fill.style.background = this.colorForLevel(signal.level);
            record.node.style.opacity = signal.level > 0 ? "1" : "0.25";
            const warning = this.warningFor(signal, record.userId);
            const member = this.members.get(record.userId);
            const blastScore = member?.autoMutedAt ? member.lastBlast?.score || 0 : signal.blast?.score || 0;
            record.node.title = `${this.userName(record.userId)}: ${signal.raw.toFixed(3)} (${this.formatDb(signal.raw)}) B ${Math.round(blastScore * 100)}% ${warning.label}`;
        }
    }

    snapshot() {
        const self = this.currentUserId();
        const channelId = self ? this.currentVoiceChannelId(self) : null;
        const users = this.channelUsers(channelId).filter(id => id !== self).map(userId => {
            const signal = this.signals.get(userId) || { raw: 0, level: 0, mapped: false, active: false, loudMs: 0, extremeMs: 0, peak: 0, blast: this.emptyBlastMetrics() };
            const member = this.members.get(userId);
            const offense = this.offenseFor(userId);
            return {
                id: userId,
                name: this.userName(userId),
                raw: signal.raw,
                smoothed: signal.level,
                mapped: signal.mapped,
                dbfs: this.levelToDb(signal.raw),
                active: signal.active,
                loudMs: signal.loudMs,
                extremeMs: signal.extremeMs,
                blastScore: signal.blast?.score || 0,
                blastRms: signal.blast?.rms || 0,
                blastActiveRatio: signal.blast?.activeRatio || 0,
                blastLoudRatio: signal.blast?.loudRatio || 0,
                blastExtremeRatio: signal.blast?.extremeRatio || 0,
                blastWindowMs: signal.blast?.durationMs || 0,
                blastType: signal.blast?.type || null,
                peak: signal.peak,
                warning: this.warningFor(signal, userId).label,
                confirmedJoin: !!member?.confirmedJoin,
                secondsSinceJoin: member?.joinedAt ? Math.max(0, (Date.now() - member.joinedAt) / 1000) : null,
                requiredHoldMs: this.requiredHoldMs(userId, member),
                autoMuted: !!member?.autoMutedAt,
                manuallyMuted: !!member?.manualMutedAt,
                trusted: this.isTrusted(userId),
                policy: this.policyValueFor(userId),
                softVoiceban: this.softVoicebanFor(userId),
                softMuted: !!member?.softMutedAt,
                softStrikeCount: Number(member?.softStrikeCount || 0),
                softLastMutedAt: Number(member?.softLastMutedAt || 0),
                softEscalatedAt: Number(member?.softEscalatedAt || 0),
                softTrustedAt: Number(member?.softTrustedAt || 0),
                softUnmuteRemainingMs: Math.max(0, Number(member?.softUnmuteAt || 0) - Date.now()),
                manualUnmuteGraceMs: Math.max(0, Number(member?.manualUnmuteUntil || 0) - Date.now()),
                rememberedMuteDismissed: !!member?.rememberedMuteDismissed,
                muteReason: member?.muteReason || null,
                muteMethod: member?.muteMethod || null,
                muteError: member?.muteError || null,
                muteVerified: !!member?.muteVerified,
                volumeFallback: !!member?.volumeFallback,
                lastBlast: member?.lastBlast || null,
                priorOffenses: Number(offense?.count || 0),
                quickLeaves: Number(offense?.quickLeaves || 0)
            };
        });
        return {
            version: this.version,
            detectorProfile: this.detectorProfile,
            channelId,
            telemetry: { ...this.telemetry, membershipUnavailable: this.membershipUnavailable },
            activity: this.activity.map(entry => ({ ...entry })),
            ui: {
                collapsed: this.settings.panelCollapsed,
                filter: this.panelFilter,
                view: this.panelView,
                display: {
                    preset: this.selectedDisplayPreset(),
                    format: this.settings.levelDisplayFormat,
                    ...Object.fromEntries(this.displayOptions().map(({ key }) => [key, this.settings[key]]))
                }
            },
            users,
            autoMute: {
                enabled: this.settings.autoMute,
                trackedChannelId: this.trackedChannelId,
                rememberedOffenders: Object.keys(this.offenses).filter(userId => !!this.offenseFor(userId)).length,
                legacyOffensesRetired: this.legacyOffensesRetired,
                trustedUsers: Object.keys(this.trustedUsers).length,
                softVoicebanUsers: Object.keys(this.softVoicebans).length,
                support: this.inspectMuteSupport()
            },
            overlayCount: this.overlays.size,
            timing: {
                samples: this.timing.samples,
                lastMs: this.timing.lastMs,
                averageMs: this.timing.samples ? this.timing.totalMs / this.timing.samples : 0,
                maxMs: this.timing.maxMs
            },
            timerRunning: !!this.levelTimer
        };
    }

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.className = "vg4-native-settings";
        panel.style.padding = "12px";
        panel.style.maxWidth = "560px";
        panel.style.color = "var(--text-normal)";

        const intro = document.createElement("div");
        intro.style.padding = "12px";
        intro.style.border = "1px solid var(--background-modifier-accent)";
        intro.style.borderRadius = "12px";
        intro.style.background = "var(--background-secondary)";
        const heading = document.createElement("strong");
        heading.textContent = "VoiceGuard";
        heading.style.fontSize = "18px";
        heading.style.letterSpacing = "-0.5px";
        const description = document.createElement("p");
        description.textContent = "Appearance, protection, and portable preferences.";
        description.style.color = "var(--text-muted)";
        description.style.lineHeight = "1.6";
        description.style.marginBottom = "0";
        intro.append(heading, description);
        panel.appendChild(intro);

        const addSection = titleText => {
            const title = document.createElement("h3");
            title.textContent = titleText;
            title.style.margin = "20px 0 8px";
            title.style.paddingBottom = "6px";
            title.style.borderBottom = "1px solid var(--background-modifier-accent)";
            title.style.fontSize = "13px";
            title.style.letterSpacing = "0";
            panel.appendChild(title);
        };

        addSection("Appearance");
        const appearance = document.createElement("div");
        if (!this.appearanceReadable && !this.panel) this.loadAppearance();
        this.nativeAppearanceForm = appearance;
        appearance.innerHTML = this.renderAppearance();
        appearance.onchange = event => this.appearanceFieldChanged(event.target);
        appearance.addEventListener?.("focusout", event => {
            if (this.isSizeField(event.target)) this.appearanceFieldChanged(event.target);
        });
        appearance.onkeydown = event => this.handleSizeFieldKey(event);
        appearance.onclick = event => this.appearanceButtonClicked(event.target);
        panel.appendChild(appearance);

        const addToggle = (labelText, key) => {
            const label = document.createElement("label");
            label.style.display = "flex";
            label.style.alignItems = "center";
            label.style.gap = "8px";
            label.style.minHeight = "34px";
            label.style.borderBottom = "1px solid var(--background-modifier-accent)";
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = !!this.settings[key];
            input.style.accentColor = "var(--brand-experiment)";
            input.onchange = () => {
                if (key === "autoMute") { this.setAutoMute(input.checked); input.checked = this.settings.autoMute; return; }
                if (!this.storesWritable("settings")) { input.checked = !!this.settings[key]; return; }
                this.settings[key] = input.checked;
                this.saveSettings();
                if (key === "panelCollapsed") this.saveUiState();
                if (key === "autoMute") for (const userId of this.signals.keys()) this.resetBlastWindow(userId);
                if (key === "tileMeters" && !input.checked) this.clearOverlays();
                else this.scheduleDiscovery(true);
                this.renderPanel(true);
            };
            const text = document.createElement("span");
            text.textContent = labelText;
            label.append(input, text);
            panel.appendChild(label);
        };

        const addRange = (labelText, key, min, max, step, format) => {
            const row = document.createElement("label");
            row.style.display = "grid";
            row.style.gridTemplateColumns = "1fr auto";
            row.style.gap = "6px 12px";
            row.style.padding = "9px 0";
            row.style.borderBottom = "1px solid var(--background-modifier-accent)";
            const text = document.createElement("span");
            text.textContent = labelText;
            const value = document.createElement("span");
            value.textContent = format(this.settings[key]);
            value.style.fontVariantNumeric = "tabular-nums";
            const input = document.createElement("input");
            input.type = "range";
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(this.settings[key]);
            input.style.gridColumn = "1 / -1";
            input.oninput = () => {
                if (!this.storesWritable("settings")) { input.value = String(this.settings[key]); return; }
                this.settings[key] = Number(input.value);
                this.saveSettings();
                input.value = String(this.settings[key]);
                value.textContent = format(this.settings[key]);
                this.blastWindows.clear();
            };
            row.append(text, value, input);
            panel.appendChild(row);
        };

        addSection("Preference presets");
        const presetDescription = document.createElement("p");
        presetDescription.textContent = "Import a VoiceGuard website preset or export your current detection and display preferences. Auto, people, history, and existing mutes stay unchanged.";
        presetDescription.style.color = "var(--text-muted)";
        presetDescription.style.lineHeight = "1.6";
        presetDescription.style.fontSize = "12px";
        panel.appendChild(presetDescription);
        const presetActions = document.createElement("div");
        presetActions.style.display = "flex";
        presetActions.style.flexWrap = "wrap";
        presetActions.style.gap = "8px";
        const presetStatus = document.createElement("p");
        presetStatus.setAttribute?.("role", "status");
        presetStatus.style.fontSize = "12px";
        presetStatus.style.lineHeight = "1.6";
        const showPresetStatus = () => { presetStatus.textContent = this.presetNotice?.message || ""; };
        const exportButton = document.createElement("button");
        exportButton.type = "button";
        exportButton.textContent = "Export preference preset";
        exportButton.style.padding = "9px 12px";
        exportButton.onclick = () => { this.downloadPreferencePreset(); showPresetStatus(); };
        presetActions.appendChild(exportButton);
        const presetFileLabel = document.createElement("label");
        presetFileLabel.textContent = "Import preference preset (.json, max 16 KiB)";
        presetFileLabel.style.display = "flex";
        presetFileLabel.style.flexDirection = "column";
        presetFileLabel.style.gap = "8px";
        presetFileLabel.style.marginTop = "12px";
        presetFileLabel.style.fontSize = "12px";
        const presetFile = document.createElement("input");
        presetFile.type = "file";
        presetFile.accept = ".json,application/json";
        presetFile.setAttribute?.("aria-label", "Import preference preset");
        presetFile.onchange = async () => { await this.importPreferencePresetFile(presetFile.files?.[0]); showPresetStatus(); presetFile.value = ""; };
        presetFileLabel.appendChild(presetFile);
        panel.append(presetActions, presetFileLabel, presetStatus);

        addSection("Interface");
        addToggle("Show VoiceGuard panel", "debugVisuals");
        addToggle("Keep VoiceGuard drawer collapsed", "panelCollapsed");

        addSection("Display");
        for (const option of this.displayOptions()) addToggle(option.label, option.key);
        addToggle("Load profile images from Discord’s CDN", "loadProfileImages");
        const formatRow = document.createElement("div");
        formatRow.style.display = "flex";
        formatRow.style.gap = "8px";
        formatRow.style.marginTop = "12px";
        const formatButtons = [];
        for (const [format, label] of [["percent", "Percent"], ["raw", "Raw 0-1"], ["dbfs", "dBFS"]]) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.style.padding = "8px 12px";
            button.setAttribute?.("aria-label", "Level number format: " + label);
            button.setAttribute?.("aria-pressed", String(this.settings.levelDisplayFormat === format));
            button.onclick = () => {
                this.updateDisplaySetting("levelDisplayFormat", format);
                for (const item of formatButtons) item.button.setAttribute?.("aria-pressed", String(item.format === format));
            };
            formatButtons.push({button, format});
            formatRow.appendChild(button);
        }
        panel.appendChild(formatRow);

        addSection("Detection");
        addToggle("Automatically local-mute loud offenders", "autoMute");
        addToggle("Remember offenders across rejoins", "rememberOffenders");
        addToggle("Mute remembered offenders immediately on rejoin", "muteRememberedOnRejoin");
        addRange("Noise floor", "threshold", 0.001, 0.1, 0.001, value => Number(value).toFixed(3));
        addRange("Auto-mute loud level", "loudThreshold", 0.1, 1, 0.05, value => Number(value).toFixed(2));
        addRange("Newcomer watch window", "newcomerWindowSeconds", 10, 300, 5, value => `${Number(value).toFixed(0)} s`);
        addRange("Newcomer loud evidence", "newcomerLoudSeconds", 1.5, 5, 0.25, value => `${Number(value).toFixed(2)} s`);
        addRange("Established caller loud evidence", "establishedLoudSeconds", 2, 10, 0.25, value => `${Number(value).toFixed(2)} s`);
        addRange("Repeat offender loud evidence", "repeatLoudSeconds", 1, 3, 0.25, value => `${Number(value).toFixed(2)} s`);
        addRange("Rolling analysis window", "analysisWindowSeconds", 3, 15, 0.5, value => `${Number(value).toFixed(1)} s`);
        addRange("Required loud share", "blastLoudRatio", 0.4, 0.95, 0.05, value => `${Math.round(Number(value) * 100)}%`);
        addRange("Minimum blast RMS", "blastRmsLevel", 0.4, 0.95, 0.01, value => Number(value).toFixed(2));
        addRange("Extreme blast level", "extremeLevel", 0.5, 1, 0.01, value => Number(value).toFixed(2));
        addRange("Repeated clipping evidence", "extremeHoldSeconds", 1.5, 5, 0.25, value => `${Number(value).toFixed(2)} s`);

        addSection("Soft Voiceban");
        addRange("Re-arm grace after soft release", "softRearmGraceSeconds", 1, 10, 1, value => `${Number(value).toFixed(0)} s`);

        addSection("Probe 1s — advanced compatibility policy");
        const probeDescription = document.createElement("p");
        probeDescription.textContent = "Choose Probe 1s in a participant’s protection picker. It uses a 0.5-second evidence hold and a 1-second mute. Close hits can escalate to a hard mute; a later hit separated by the configured gap marks that person trusted. Ordinary Soft policies do not use these decisions.";
        probeDescription.style.color = "var(--text-muted)";
        probeDescription.style.fontSize = "12px";
        probeDescription.style.lineHeight = "1.6";
        panel.appendChild(probeDescription);
        addRange("Hard mute after close probes", "softEscalateCount", 2, 5, 1, value => `${Number(value).toFixed(0)} hits`);
        addRange("Trust if probes are apart", "softFalsePositiveGapSeconds", 3, 15, 1, value => `${Number(value).toFixed(0)} s`);

        addSection("History");
        addRange("Quick-leave window", "quickLeaveSeconds", 15, 180, 5, value => `${Number(value).toFixed(0)} s`);

        const actions = document.createElement("div");
        actions.style.display = "flex";
        actions.style.flexWrap = "wrap";
        actions.style.gap = "8px";
        actions.style.marginTop = "12px";

        const clearHistory = document.createElement("button");
        clearHistory.type = "button";
        clearHistory.textContent = "Clear remembered offenders";
        clearHistory.style.padding = "8px 12px";
        clearHistory.onclick = () => {
            if (!this.storesWritable("offenses")) return;
            this.offenses = {};
            this.saveOffenses();
            BdApi.UI.showToast("VoiceGuard offender history cleared", { type: "success" });
            this.renderPanel(true);
        };
        actions.appendChild(clearHistory);

        const clearTrusted = document.createElement("button");
        clearTrusted.type = "button";
        clearTrusted.textContent = "Clear trusted users";
        clearTrusted.style.padding = "8px 12px";
        clearTrusted.onclick = () => {
            if (!this.storesWritable("trustedUsers")) return;
            this.trustedUsers = {};
            this.saveTrustedUsers();
            BdApi.UI.showToast("VoiceGuard trusted users cleared", { type: "success" });
            this.renderPanel(true);
        };
        actions.appendChild(clearTrusted);

        const clearSoft = document.createElement("button");
        clearSoft.type = "button";
        clearSoft.textContent = "Clear soft policies";
        clearSoft.style.padding = "8px 12px";
        clearSoft.onclick = () => {
            if (!this.storesWritable("softVoicebans")) return;
            for (const [userId, member] of this.members.entries()) {
                if (member?.softMutedAt) this.manualUnmute(userId);
            }
            this.softVoicebans = {};
            this.saveSoftVoicebans();
            BdApi.UI.showToast("VoiceGuard soft policies cleared", { type: "success" });
            this.renderPanel(true);
        };
        actions.appendChild(clearSoft);
        panel.appendChild(actions);
        return panel;
    }
};
