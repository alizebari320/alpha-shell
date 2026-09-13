// Indicator — a top-bar button that opens the ALPHA Shell tool menu.
//
// Subclasses PanelMenu.Button, the standard GNOME Shell panel-button pattern.
// Left click opens the popup menu (native behavior); the menu lists each
// tool so the AI overlay and the Screen Annotator can both be launched from
// the panel without relying on keybindings.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const ICON_NAME = 'applications-science-symbolic';

// ESM subclass of a GObject must be registered via GObject.registerClass,
// otherwise constructing it throws "Tried to construct an object without a
// GType" and takes the whole extension down.
export const Indicator = GObject.registerClass({
    GTypeName: 'AlphaShellIndicator',
}, class Indicator extends PanelMenu.Button {
    _init({onToggleOverlay, onToggleAnnotator} = {}) {
        super._init(0.0, 'ALPHA Shell', false);

        this.add_style_class_name('alpha-indicator');

        this._onToggleOverlay = onToggleOverlay;
        this._onToggleAnnotator = onToggleAnnotator;

        // The visible icon in the top bar.
        this._icon = new St.Icon({
            icon_name: ICON_NAME,
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        if (this.menu) {
            this.menu.addMenuItem(this._menuItem(
                'AI Overlay', this._onToggleOverlay));
            this.menu.addMenuItem(this._menuItem(
                'Screen Annotator', this._onToggleAnnotator));
        }
    }

    _menuItem(label, fn) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => {
            if (fn)
                fn();
        });
        return item;
    }
});