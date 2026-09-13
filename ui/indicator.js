// Indicator — a clickable top-bar button that toggles the AI overlay.
//
// This is the standard GNOME Shell panel-button pattern: we extend
// PanelMenu.Button so the button sits in the top bar next to the clock and
// system indicators, and forward clicks to the overlay's toggle().

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const ICON_NAME = 'applications-science-symbolic';

export class Indicator extends PanelMenu.Button {
    constructor(onToggle) {
        super(0.0, 'ALPHA Shell', false);

        this.add_style_class_name('alpha-indicator');

        this._onToggle = onToggle;

        // The visible icon in the top bar.
        this._icon = new St.Icon({
            icon_name: ICON_NAME,
            style_class: 'system-status-icon',
        });

        this.add_child(this._icon);

        // Clicking anywhere on the button toggles the overlay.
        this.reactive = true;
        this.connect('button-press-event', () => {
            if (this._onToggle)
                this._onToggle();
            return Clutter.EVENT_STOP;
        });
    }

    destroy() {
        super.destroy();
    }
}