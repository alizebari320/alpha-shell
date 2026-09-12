// Preferences window: configurable model selection (architecture only).
//
// Populates provider + model dropdowns from the catalog in ./ai/models.js.
// Selecting an entry just writes the id to GSettings; no network call is made.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {MODELS, PROVIDERS, getModelsForProvider} from './ai/models.js';

const ALL_PROVIDERS = Object.values(PROVIDERS).map((p) => p.id);
const INVALID = Gtk.INVALID_LIST_POSITION;

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
        window.add(new ModelPage(settings));
    }
}