import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Writer} from './ui/writer.js';
import {Indicator} from './ui/indicator.js';
import {Launcher} from './ui/launcher.js';

export default class AlphaShellExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this.writer = new Writer();
        this.launcher = new Launcher();

        this._indicator = new Indicator({
            onToggleWriter: this._toggleWriter.bind(this),
        });
        Main.panel.addToStatusArea('alpha-shell', this._indicator);

        this._addKeybinding('toggle-writer', this._toggleWriter.bind(this));
        this._addKeybinding('toggle-launcher',
            this._toggleLauncher.bind(this), Meta.KeyBindingFlags.IGNORE_AUTOREPEAT);

        console.log('[alpha-shell] enabled');
    }

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
        } catch (e) {
            console.warn(`[alpha-shell] keybinding '${name}' not registered: ${e.message}. ` +
                'Use the panel icon menu or reinstall schemas, then re-login.');
        }
    }

    disable() {
        for (const name of ['toggle-writer', 'toggle-launcher']) {
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

        if (this.launcher) {
            this.launcher.destroy();
            this.launcher = null;
        }

        this._settings = null;

        console.log('[alpha-shell] disabled');
    }

    _toggleWriter() {
        if (this.writer)
            this.writer.toggle();
    }

    _toggleLauncher() {
        if (this.launcher)
            this.launcher.toggle();
    }
}
