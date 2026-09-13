import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AIService} from './ai/ai.js';
import {AIOverlay} from './ui/overlay.js';
import {Indicator} from './ui/indicator.js';

export default class AlphaShellExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this.ai = new AIService(this._settings);
        this.overlay = new AIOverlay();

        this._indicator = new Indicator(this._toggleOverlay.bind(this));
        Main.panel.addToStatusArea('alpha-shell', this._indicator);

        Main.wm.addKeybinding(
            'toggle-overlay',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            this._toggleOverlay.bind(this)
        );

        console.log('[alpha-shell] enabled');
    }

    disable() {
        Main.wm.removeKeybinding('toggle-overlay');

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this.overlay) {
            this.overlay.destroy();
            this.overlay = null;
        }

        this.ai = null;
        this._settings = null;

        console.log('[alpha-shell] disabled');
    }

    _toggleOverlay() {
        if (this.overlay)
            this.overlay.toggle();
    }
}