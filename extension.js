import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Writer} from './ui/writer.js';
import {Indicator} from './ui/indicator.js';

export default class AlphaShellExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this.writer = new Writer();

        this._indicator = new Indicator({
            onToggleWriter: this._toggleWriter.bind(this),
        });
        Main.panel.addToStatusArea('alpha-shell', this._indicator);

        this._addKeybinding('toggle-writer', this._toggleWriter.bind(this));

        console.log('[alpha-shell] enabled');
    }

    /** Register a shortcut without ever crashing enable() — a missing or
     *  stale schema key must not take the whole extension down. */
    _addKeybinding(name, handler) {
        try {
            Main.wm.addKeybinding(
                name,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                handler
            );
        } catch (e) {
            console.warn(`[alpha-shell] keybinding '${name}' not registered: ${e.message}. ` +
                'Use the panel icon menu or reinstall schemas, then re-login.');
        }
    }

    disable() {
        for (const name of ['toggle-writer']) {
            try {
                Main.wm.removeKeybinding(name);
            } catch (e) {
                // Was never registered — fine.
            }
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this.writer) {
            this.writer.destroy();
            this.writer = null;
        }

        this._settings = null;

        console.log('[alpha-shell] disabled');
    }

    _toggleWriter() {
        if (this.writer)
            this.writer.toggle();
    }
}
