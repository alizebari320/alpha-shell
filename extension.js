// ALPHA Shell — one extension, eleven features.
//
// Loading strategy
// ----------------
// enable() creates the panel indicator and registers keybindings. That is
// all. No feature module is imported, no HUD is constructed and no AI
// service exists until a feature is actually used for the first time, at
// which point it is imported dynamically and cached for the session.
//
// This is deliberate: nine features that each cost nothing until used is
// what keeps the idle footprint flat. A feature switched off in
// preferences registers no shortcut and its file is never even parsed.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Indicator} from './ui/indicator.js';
import * as Brand from './ui/brand.js';

/**
 * The single source of truth for the suite.
 *   key      schema shortcut key (null = menu only)
 *   enable   schema boolean, or null for always-on features
 *   create   async factory; receives the extension
 * Every factory returns an object with toggle() and destroy().
 */
const FEATURES = {
    ask: {
        label: 'ALPHA Ask',
        group: 'AI',
        key: 'toggle-ask',
        enable: 'enable-ask',
        create: async ext => {
            const {AskHud} = await import('./ui/ask.js');
            return new AskHud(ext.path, await ext._aiService());
        },
    },
    snip: {
        label: 'Snip & Explain',
        group: 'AI',
        key: 'toggle-snip',
        enable: 'enable-snip',
        create: async ext => {
            const {SnipExplain} = await import('./ui/snip.js');
            return new SnipExplain(ext.path, await ext._aiService());
        },
    },
    clipboardAi: {
        label: 'Clipboard AI',
        group: 'AI',
        key: 'toggle-clipboard-ai',
        enable: 'enable-clipboard-ai',
        create: async ext => {
            const {ClipboardAiHud} = await import('./ui/clipboardAi.js');
            return new ClipboardAiHud(ext.path, await ext._aiService());
        },
    },
    terminal: {
        label: 'Terminal Assist',
        group: 'AI',
        key: 'toggle-terminal-assist',
        enable: 'enable-terminal-assist',
        create: async ext => {
            const {TerminalAssistHud} = await import('./ui/terminal.js');
            return new TerminalAssistHud(ext.path, await ext._aiService());
        },
    },
    writer: {
        label: 'ALPHA Writer',
        group: 'Tools',
        key: 'toggle-writer',
        enable: null,
        create: async () => {
            const {Writer} = await import('./ui/writer.js');
            return new Writer();
        },
    },
    launcher: {
        label: 'ALPHA Quick Launcher',
        group: 'Tools',
        key: 'toggle-launcher',
        enable: null,
        flags: Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        create: async () => {
            const {Launcher} = await import('./ui/launcher.js');
            return new Launcher();
        },
    },
    clipboard: {
        label: 'Clipboard History',
        group: 'Tools',
        key: 'toggle-clipboard',
        enable: 'enable-clipboard',
        create: async ext => {
            const {ClipboardHistoryHud} = await import('./ui/clipboard.js');
            return new ClipboardHistoryHud(ext.path, await ext._clipboardStore());
        },
    },
    zoom: {
        label: 'Zoom & Spotlight',
        group: 'Tools',
        key: 'toggle-zoom',
        enable: 'enable-zoom',
        create: async ext => {
            const {ZoomSpotlight} = await import('./ui/zoom.js');
            return new ZoomSpotlight(ext.path);
        },
    },
    recorder: {
        label: 'Screen Recorder',
        group: 'Tools',
        key: 'toggle-recorder',
        enable: 'enable-recorder',
        create: async ext => {
            const {ScreenRecorder} = await import('./ui/recorder.js');
            return new ScreenRecorder(ext.path);
        },
    },
    focus: {
        label: 'Focus Mode',
        group: 'Tools',
        key: 'toggle-focus',
        enable: 'enable-focus',
        create: async ext => {
            const {FocusMode} = await import('./ui/focus.js');
            return new FocusMode(ext.path);
        },
    },
};

export default class AlphaShellExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._instances = new Map();
        this._bound = [];
        this._ai = null;
        this._store = null;
        this._stats = null;

        this._indicator = new Indicator({
            path: this.path,
            items: this._menuItems(),
            onActivate: id => this._toggle(id),
        });
        Main.panel.addToStatusArea('alpha-shell', this._indicator);

        for (const [id, feature] of Object.entries(FEATURES)) {
            if (!feature.key || !this._featureEnabled(feature))
                continue;
            this._addKeybinding(feature.key, () => this._toggle(id), feature.flags);
        }

        // Panel Stats is an indicator rather than a HUD, so it is created
        // up front — but only when switched on, and it polls nothing until
        // its menu is opened.
        if (this._settings.get_boolean('enable-stats'))
            this._enableStats();

        // Clipboard history has to listen from the start to have anything
        // to show, but capture is signal-driven, not polled.
        if (this._settings.get_boolean('enable-clipboard'))
            this._clipboardStore();

        // GNOME binds <Super>a to toggle-application-view (app grid) by
        // default. Free the chord for the launcher while the extension is
        // enabled, and restore the user's original binding on disable.
        this._freeSuperA();

        console.log('[alpha-shell] enabled');
    }

    disable() {
        for (const name of this._bound ?? []) {
            try {
                Main.wm.removeKeybinding(name);
            } catch (e) {
                // Was never registered — fine.
            }
        }
        this._bound = [];

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._stats) {
            this._stats.destroy();
            this._stats = null;
        }

        // Destroy every feature that was actually used this session.
        for (const instance of this._instances?.values() ?? []) {
            try {
                instance.destroy();
            } catch (e) {
                console.warn(`[alpha-shell] teardown error: ${e.message}`);
            }
        }
        this._instances?.clear();
        this._instances = null;

        if (this._store) {
            this._store.disable();
            this._store = null;
        }

        this._ai = null;

        // Drop the cached logo so a reload picks up a newly added asset.
        Brand.reset();

        this._restoreSuperA();

        this._settings = null;

        console.log('[alpha-shell] disabled');
    }

    // --- features ---------------------------------------------------------

    _menuItems() {
        return Object.entries(FEATURES)
            .filter(([, feature]) => this._featureEnabled(feature))
            .map(([id, feature]) => ({id, label: feature.label, group: feature.group}));
    }

    _featureEnabled(feature) {
        if (!feature.enable)
            return true;
        try {
            return this._settings.get_boolean(feature.enable);
        } catch (e) {
            return true; // missing key: fail open rather than hide the feature
        }
    }

    /** Load on first use, then reuse for the rest of the session. */
    async _toggle(id) {
        const feature = FEATURES[id];
        if (!feature || !this._instances)
            return;

        try {
            let instance = this._instances.get(id);
            if (!instance) {
                instance = await feature.create(this);
                // enable() may have been undone while we were importing.
                if (!this._instances) {
                    instance.destroy();
                    return;
                }
                this._instances.set(id, instance);
            }
            instance.toggle();
        } catch (e) {
            console.warn(`[alpha-shell] could not open '${id}': ${e.message}`);
        }
    }

    /** One shared AI service, created on first AI use. */
    async _aiService() {
        if (this._ai)
            return this._ai;

        const module = await import('./ai/ai.js');
        const AIService = module.AIService ?? module.default;
        this._ai = new AIService(this._settings);
        return this._ai;
    }

    /** One shared clipboard store, listening for the session. */
    async _clipboardStore() {
        if (this._store)
            return this._store;

        const {ClipboardStore} = await import('./ui/clipboard.js');
        this._store = new ClipboardStore();
        this._store.enable();
        return this._store;
    }

    async _enableStats() {
        try {
            const {PanelStats} = await import('./ui/stats.js');
            if (!this._settings)
                return; // disabled while importing
            this._stats = new PanelStats(this.path);
            Main.panel.addToStatusArea('alpha-stats', this._stats, 1, 'right');
        } catch (e) {
            console.warn(`[alpha-shell] panel stats unavailable: ${e.message}`);
        }
    }

    // --- keybindings ------------------------------------------------------

    /** Register a shortcut without ever crashing enable() — a missing or
     *  stale schema key must not take the whole extension down. */
    _addKeybinding(name, handler, flags = Meta.KeyBindingFlags.NONE) {
        try {
            Main.wm.addKeybinding(
                name,
                this._settings,
                flags,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                handler
            );
            this._bound.push(name);
        } catch (e) {
            console.warn(`[alpha-shell] keybinding '${name}' not registered: ${e.message}. ` +
                'Use the panel icon menu or reinstall schemas, then re-login.');
        }
    }

    /** Free <Super>a for the launcher by clearing GNOME's default
     *  toggle-application-view binding. The original value is remembered
     *  and restored in disable(). */
    _freeSuperA() {
        try {
            const SHELL_KEYBINDINGS = 'org.gnome.shell.keybindings';
            const KEY = 'toggle-application-view';
            const setting = new Gio.Settings({schema_id: SHELL_KEYBINDINGS});
            const current = setting.get_strv(KEY);

            // Remember the first non-empty binding for restore; only touch
            // the key if <Super>a is actually taken by it.
            if (current.includes('<Super>a')) {
                this._savedAppViewBinding = current.filter(b => b && b !== '<Super>a');
                setting.set_strv(KEY, this._savedAppViewBinding);
                console.log(`[alpha-shell] freed <Super>a from toggle-application-view ` +
                    `(was: ${current.join(', ')})`);
            }
        } catch (e) {
            // Not fatal — worst case the keybinding registration is refused
            // and the launcher stays reachable from the indicator menu.
            console.warn(`[alpha-shell] could not free <Super>a: ${e.message}`);
        }
    }

    /** Restore the toggle-application-view binding freed by _freeSuperA(). */
    _restoreSuperA() {
        if (!this._savedAppViewBinding)
            return;

        try {
            const setting = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
            setting.set_strv('toggle-application-view', this._savedAppViewBinding);
        } catch (e) {
            console.warn(`[alpha-shell] could not restore toggle-application-view: ${e.message}`);
        }
        this._savedAppViewBinding = null;
    }
}
