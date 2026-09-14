// Preferences window: feature switches, shortcuts and model selection.
//
// Turning a feature off here is not cosmetic: extension.js skips its
// keybinding and never imports its module, so a disabled feature costs
// literally nothing.

import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PROVIDERS, getModelsForProvider} from './ai/models.js';

const ALL_PROVIDERS = Object.values(PROVIDERS).map((p) => p.id);
const INVALID = Gtk.INVALID_LIST_POSITION;

// Feature metadata mirrors the FEATURES table in extension.js.
const AI_FEATURES = [
    {key: 'enable-ask', shortcut: 'toggle-ask', title: 'ALPHA Ask', subtitle: 'Ask, summarize or explain code from anywhere.'},
    {key: 'enable-snip', shortcut: 'toggle-snip', title: 'Snip & Explain', subtitle: 'Drag a region of the screen and get an explanation.'},
    {key: 'enable-clipboard-ai', shortcut: 'toggle-clipboard-ai', title: 'Clipboard AI', subtitle: 'Translate, fix or shorten whatever you just copied.'},
    {key: 'enable-terminal-assist', shortcut: 'toggle-terminal-assist', title: 'Terminal Assist', subtitle: 'Turn a description into a shell command you approve first.'},
];

const TOOL_FEATURES = [
    {key: null, shortcut: 'toggle-writer', title: 'ALPHA Writer', subtitle: 'Annotate and draw directly on the screen.'},
    {key: null, shortcut: 'toggle-launcher', title: 'ALPHA Quick Launcher', subtitle: 'Spotlight-style application search.'},
    {key: 'enable-clipboard', shortcut: 'toggle-clipboard', title: 'Clipboard History', subtitle: 'Searchable history of your recent copies.'},
    {key: 'enable-zoom', shortcut: 'toggle-zoom', title: 'Zoom & Spotlight', subtitle: 'Magnify and spotlight for presentations.'},
    {key: 'enable-recorder', shortcut: 'toggle-recorder', title: 'Screen Recorder', subtitle: 'Record the screen with a floating timer pill.'},
    {key: 'enable-focus', shortcut: 'toggle-focus', title: 'Focus Mode', subtitle: 'Mute notifications and dim the top bar.'},
];

// A row that shows the current shortcut and lets the user capture a new one.
// Built from a Gtk.EventControllerKey (no Adw.ShortcutRow on Adw 1.9).
class ShortcutSetting extends Adw.ActionRow {
    static {
        GObject.registerClass(this);
    }

    constructor(title, subtitle, settings, key) {
        super({title, subtitle});
        this._settings = settings;
        this._key = key;

        this._label = new Gtk.ShortcutLabel({valign: Gtk.Align.CENTER});
        this.add_suffix(this._label);

        this._button = new Gtk.Button({
            label: _('Set'),
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._button);

        // Capture the next key chord the user presses while the row is "armed".
        this._capturing = false;
        this._controller = new Gtk.EventControllerKey();
        this._controller.connect('key-pressed', (ctrl, keyval, keycode, state) =>
            this._onKeyPressed(keyval, state));
        this.add_controller(this._controller);

        this._button.connect('clicked', () => this._startCapture());
        this._refresh();

        // Keep the displayed accelerator in sync if changed elsewhere.
        this._settings.connect(`changed::${key}`, () => this._refresh());
    }

    _startCapture() {
        this._capturing = true;
        this._button.set_label(_('Press keys\u2026'));
    }

    _onKeyPressed(keyval, state) {
        if (!this._capturing)
            return Gdk.EVENT_PROPAGATE;

        // Ignore bare modifier presses — wait for a real key.
        if (Gtk.accelerator_valid(keyval, state)) {
            const accel = Gtk.accelerator_name(keyval, state);
            this._settings.set_strv(this._key, [accel]);
        }
        this._capturing = false;
        this._refresh();
        return Gdk.EVENT_STOP;
    }

    _refresh() {
        const accels = this._settings.get_strv(this._key);
        const accel = accels && accels[0] ? accels[0] : '';
        this._label.set_accelerator(accel);
        this._button.set_label(_('Set'));
        this._capturing = false;
    }
}

/** One switch per feature. Off means "never loaded". */
class FeaturesPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(this);
    }

    constructor(settings) {
        super({
            title: _('Features'),
            icon_name: 'view-grid-symbolic',
        });

        const ai = new Adw.PreferencesGroup({
            title: _('AI features'),
            description: _('Disabled features register no shortcut and are never loaded.'),
        });
        this.add(ai);
        for (const feature of AI_FEATURES)
            ai.add(this._switchRow(settings, feature));

        const tools = new Adw.PreferencesGroup({title: _('Tools')});
        this.add(tools);
        for (const feature of TOOL_FEATURES) {
            if (feature.key)
                tools.add(this._switchRow(settings, feature));
        }

        const panel = new Adw.PreferencesGroup({title: _('Top bar')});
        this.add(panel);
        panel.add(this._switchRow(settings, {
            key: 'enable-stats',
            title: _('Panel Stats'),
            subtitle: _('Adds a second top-bar item. Refreshes only while its menu is open.'),
        }));
    }

    _switchRow(settings, {key, title, subtitle}) {
        const row = new Adw.SwitchRow({
            title: _(title),
            subtitle: _(subtitle),
        });
        settings.bind(key, row, 'active', 0 /* Gio.SettingsBindFlags.DEFAULT */);
        return row;
    }
}

class GeneralPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(this);
    }

    constructor(settings) {
        super({
            title: _('Shortcuts'),
            icon_name: 'preferences-desktop-keyboard-symbolic',
        });

        const ai = new Adw.PreferencesGroup({title: _('AI')});
        this.add(ai);
        for (const feature of AI_FEATURES) {
            ai.add(new ShortcutSetting(
                _(feature.title), _(feature.subtitle), settings, feature.shortcut));
        }

        const tools = new Adw.PreferencesGroup({title: _('Tools')});
        this.add(tools);
        for (const feature of TOOL_FEATURES) {
            tools.add(new ShortcutSetting(
                _(feature.title), _(feature.subtitle), settings, feature.shortcut));
        }
    }
}

class ModelPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(this);
    }

    constructor(settings) {
        super({
            title: _('AI Models'),
            icon_name: 'applications-science-symbolic',
        });
        this._settings = settings;

        const group = new Adw.PreferencesGroup({title: _('Provider & Model')});
        this.add(group);

        this._providerRow = new Adw.ComboRow({
            title: _('Provider'),
            model: new Gtk.StringList({strings: ALL_PROVIDERS}),
        });
        group.add(this._providerRow);

        this._modelRow = new Adw.ComboRow({title: _('Model')});
        group.add(this._modelRow);

        this._providerRow.connect('notify::selected', () => {
            const id = this._providerRow.get_selected_item()?.get_string() ?? '';
            this._settings.set_string('provider', id);
            this._refreshModels(id);
        });

        this._modelRow.connect('notify::selected', () => {
            const id = this._modelRow.get_selected_item()?.get_string() ?? '';
            this._settings.set_string('model', id);
        });

        this._sync();
    }

    _refreshModels(providerId) {
        const ids = getModelsForProvider(providerId).map((m) => m.id);
        this._modelRow.set_model(new Gtk.StringList({strings: ids}));
        const current = this._settings.get_string('model');
        const idx = ids.indexOf(current);
        this._modelRow.set_selected(idx >= 0 ? idx : INVALID);
    }

    _sync() {
        const provider = this._settings.get_string('provider');
        const pIdx = ALL_PROVIDERS.indexOf(provider);
        this._providerRow.set_selected(pIdx >= 0 ? pIdx : INVALID);
        this._refreshModels(provider || ALL_PROVIDERS[0]);
    }
}

export default class AlphaShellPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.add(new FeaturesPage(settings));
        window.add(new GeneralPage(settings));
        window.add(new ModelPage(settings));
    }
}
