import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';

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
            onToggleLauncher: this._toggleLauncher.bind(this),
        });
        Main.panel.addToStatusArea('alpha-shell', this._indicator);

        this._addKeybinding('toggle-writer', this._toggleWriter.bind(this));
        this._addKeybinding('toggle-launcher',
            this._toggleLauncher.bind(this), Meta.KeyBindingFlags.IGNORE_AUTOREPEAT);

        // GNOME binds <Super>a to toggle-application-view (app grid) by
        // default. Free the chord for the launcher while the extension is
        // enabled, and restore the user's original binding on disable.
        this._freeSuperA();

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

        this._restoreSuperA();

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
