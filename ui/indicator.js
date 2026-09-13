// Indicator — a clickable top-bar button for the ALPHA Shell tools.
//
// Left click toggles the AI overlay (unchanged behavior). Right click opens
// a popup menu with every tool, so features like the Screen Annotator can
// be launched with the mouse even if their keybinding is missing or taken.

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const ICON_NAME = 'applications-science-symbolic';

export class Indicator extends PanelMenu.Button {
    constructor({onToggleOverlay, onToggleAnnotator} = {}) {
        super(0.0, 'ALPHA Shell', false);

        this.add_style_class_name('alpha-indicator');

        this._onToggleOverlay = onToggleOverlay;
        this._onToggleAnnotator = onToggleAnnotator;

        // The visible icon in the top bar.
        this._icon = new St.Icon({
            icon_name: ICON_NAME,
            style_class: 'system-status-icon',
        });

        this.add_child(this._icon);

        this._buildMenu();

        // Left click: toggle the AI overlay. Right click: open the tool
        // menu. Other buttons propagate to GNOME Shell as usual.
        this.reactive = true;
        this.connect('button-press-event', (actor, event) => {
            const button = event.get_button();
            if (button === 1) {
                this._invoke(this._onToggleOverlay);
                return Clutter.EVENT_STOP;
            }
            if (button === 3 && this.menu) {
                this.menu.toggle();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _buildMenu() {
        if (!this.menu)
            return;

        const overlayItem = new PopupMenu.PopupMenuItem('AI Overlay');
        overlayItem.connect('activate', () =>
            this._invoke(this._onToggleOverlay));
        this.menu.addMenuItem(overlayItem);

        const annotatorItem = new PopupMenu.PopupMenuItem('Screen Annotator');
        annotatorItem.connect('activate', () =>
            this._invoke(this._onToggleAnnotator));
        this.menu.addMenuItem(annotatorItem);
    }

    _invoke(fn) {
        if (fn)
            fn();
    }

    destroy() {
        super.destroy();
    }
}
