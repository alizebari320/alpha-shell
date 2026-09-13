import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AIService} from './ai/ai.js';
import {AIOverlay} from './ui/overlay.js';
import {Annotator} from './ui/annotator.js';
import {Indicator} from './ui/indicator.js';

export default class AlphaShellExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this.ai = new AIService(this._settings);
        this.overlay = new AIOverlay();
        this.annotator = new Annotator();

        this._indicator = new Indicator({
            onToggleOverlay: this._toggleOverlay.bind(this),
            onToggleAnnotator: this._toggleAnnotator.bind(this),
        });
        Main.panel.addToStatusArea('alpha-shell', this._indicator);

        this._addKeybinding('toggle-overlay', this._toggleOverlay.bind(this));
        this._addKeybinding('toggle-annotator', this._toggleAnnotator.bind(this));

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
        for (const name of ['toggle-overlay', 'toggle-annotator']) {
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

        if (this.overlay) {
            this.overlay.destroy();
            this.overlay = null;
        }

        if (this.annotator) {
            this.annotator.destroy();
            this.annotator = null;
        }

        this.ai = null;
        this._settings = null;

        console.log('[alpha-shell] disabled');
    }

    _toggleOverlay() {
        if (this.overlay)
            this.overlay.toggle();
    }

    _toggleAnnotator() {
        if (this.annotator)
            this.annotator.toggle();
    }
}