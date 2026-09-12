// AIOverlay — a fullscreen St widget toggled by the keyboard shortcut.
//
// This is the visual skeleton for the future AI interface. It renders a
// centered placeholder card. Later phases add the input box, mode buttons
// (ask / summarize / explain / command / search) and result area on top
// of this widget.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class AIOverlay {
    constructor() {
        const monitor = Main.layoutManager.primaryMonitor;

        this._visible = false;

        this.widget = new St.BoxLayout({
            name: 'alphaOverlay',
            style_class: 'alpha-overlay',
            reactive: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        const card = new St.BoxLayout({
            style_class: 'alpha-overlay-card',
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        const title = new St.Label({
            text: 'ALPHA Shell',
            style_class: 'alpha-overlay-title',
        });

        const subtitle = new St.Label({
            text: 'AI overlay — coming soon',
            style_class: 'alpha-overlay-subtitle',
        });

        card.add_child(title);
        card.add_child(subtitle);
        this.widget.add_child(card);

        Main.layoutManager.uiGroup.add_child(this.widget);
    }

    isVisible() {
        return this._visible;
    }

    show() {
        this.widget.show();
        this._visible = true;
    }

    hide() {
        this.widget.hide();
        this._visible = false;
    }

    toggle() {
        if (this._visible) this.hide();
        else this.show();
    }

    destroy() {
        if (this.widget) {
            this.widget.destroy();
            this.widget = null;
        }
    }
}