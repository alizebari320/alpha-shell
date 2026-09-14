// Indicator — a top-bar button that opens the ALPHA Shell tool menu.
//
// Subclasses PanelMenu.Button, the standard GNOME Shell panel-button pattern.
// Left click opens the popup menu (native behavior); the menu lists each
// tool so ALPHA Writer can be launched from the panel without relying on
// keybindings.

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
    _init({onToggleWriter, onToggleLauncher} = {}) {
        super._init(0.0, 'ALPHA Shell', false);

        this.add_style_class_name('alpha-indicator');

        this._onToggleWriter = onToggleWriter;
        this._onToggleLauncher = onToggleLauncher;

        // The visible icon in the top bar.
        this._icon = new St.Icon({
            icon_name: ICON_NAME,
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        if (this.menu) {
            this.menu.addMenuItem(this._menuItem(
                'ALPHA Writer', this._onToggleWriter));
            this.menu.addMenuItem(this._menuItem(
                'ALPHA Quick Launcher', this._onToggleLauncher));
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
