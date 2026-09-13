// Preferences window: configurable model selection (architecture only).
//
// Populates provider + model dropdowns from the catalog in ./ai/models.js.
// Selecting an entry just writes the id to GSettings; no network call is made.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {MODELS, PROVIDERS, getModelsForProvider} from './ai/models.js';

const ALL_PROVIDERS = Object.values(PROVIDERS).map((p) => p.id);
const INVALID = Gtk.INVALID_LIST_POSITION;

// A row that shows the current shortcut and lets the user capture a new one.
// Built from a Gtk.ShortcutController (no Adw.ShortcutRow on Adw 1.9).
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
        // The controller must see raw key events; a ShortcutController manages
        // this differently, so we attach the key controller to the row's widget.
        this.add_controller(this._controller);

        this._button.connect('clicked', () => this._startCapture());
        this._refresh();

        // Keep the displayed accelerator in sync if changed elsewhere.
        this._settings.connect(`changed::${key}`, () => this._refresh());
    }

    _startCapture() {
        this._capturing = true;
        this._button.set_label(_('Press keys…'));
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
        const trigger = Gtk.ShortcutTrigger.parse_string(accel);
        this._label.set_accelerator(accel);
        this._button.set_label(_('Set'));
        this._capturing = false;
    }
}

class GeneralPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(this);
    }

    constructor(settings) {
        super({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        this._settings = settings;

        const group = new Adw.PreferencesGroup({title: _('Shortcuts')});
        this.add(group);

        group.add(new ShortcutSetting(
            _('Toggle overlay'),
            _('Keyboard shortcut that shows or hides the AI overlay.'),
            settings,
            'toggle-overlay'
        ));

        group.add(new ShortcutSetting(
            _('Toggle Screen Annotator'),
            _('Keyboard shortcut that starts or quits the screen annotator tool.'),
            settings,
            'toggle-annotator'
        ));
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
        window.add(new GeneralPage(settings));
        window.add(new ModelPage(settings));
    }
}