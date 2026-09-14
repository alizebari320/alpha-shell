// ui/focus.js — Focus Mode.
//
// One hotkey to silence the desktop: Do Not Disturb on, notification
// banners off, top panel faded out of the way.
//
// Performance notes
// -----------------
// * No timers and no polling. Focus mode is a state toggle.
// * The pill is the only actor, and it exists only while focus mode is
//   active.
//
// Correctness note: every setting is SAVED before it is changed and
// restored on exit or on disable(), so turning the extension off while
// focus mode is active cannot leave the session muted.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Brand from './brand.js';

const NOTIFICATION_SCHEMA = 'org.gnome.desktop.notifications';

export class FocusMode {
    constructor(path) {
        this._path = path;
        this._active = false;
        this._pill = null;
        this._signals = [];
        this._saved = null;
        this._notifications = null;
    }

    get isActive() {
        return this._active;
    }

    toggle() {
        if (this._active)
            this.deactivate();
        else
            this.activate();
    }

    activate() {
        if (this._active)
            return;
        this._active = true;

        this._saved = {
            showBanners: null,
            dnd: null,
            panelOpacity: Main.panel.opacity,
            panelReactive: Main.panel.reactive,
        };

        try {
            this._notifications ??= new Gio.Settings({schema_id: NOTIFICATION_SCHEMA});
            this._saved.showBanners = this._notifications.get_boolean('show-banners');
            this._notifications.set_boolean('show-banners', false);
        } catch (e) {
            console.warn(`[alpha-shell] could not mute notifications: ${e.message}`);
        }

        // Do Not Disturb, so nothing queues up behind the muted banners.
        try {
            const tray = Main.messageTray;
            if (tray) {
                this._saved.dnd = tray.bannerBlocked;
                tray.bannerBlocked = true;
            }
        } catch (e) {
            // Older/newer shells may not expose this — banners are already off.
        }

        // Fade the panel instead of hiding it, so layout does not jump.
        Main.panel.ease({
            opacity: 40,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        Main.panel.reactive = true;

        this._showPill();
    }

    deactivate() {
        if (!this._active)
            return;
        this._active = false;

        const saved = this._saved ?? {};
        this._saved = null;

        if (this._notifications && saved.showBanners !== null &&
            saved.showBanners !== undefined) {
            try {
                this._notifications.set_boolean('show-banners', saved.showBanners);
            } catch (e) {
                // Schema gone — nothing to restore.
            }
        }

        if (saved.dnd !== null && saved.dnd !== undefined) {
            try {
                Main.messageTray.bannerBlocked = saved.dnd;
            } catch (e) {
                // Nothing to restore.
            }
        }

        Main.panel.ease({
            opacity: saved.panelOpacity ?? 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        Main.panel.reactive = saved.panelReactive ?? true;

        this._hidePill();
    }

    destroy() {
        // Must not leave the desktop silenced.
        this.deactivate();
        this._hidePill();
        this._notifications = null;
    }

    // --- pill -------------------------------------------------------------

    _showPill() {
        if (this._pill)
            return;

        this._pill = new St.BoxLayout({
            style_class: 'alpha-pill alpha-focus',
            reactive: true,
        });
        this._pill.add_child(Brand.mark(this._path, 16));
        this._pill.add_child(new St.Label({
            style_class: 'alpha-pill-label',
            text: 'Focus mode \u00b7 notifications muted',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const exit = new St.Button({
            style_class: 'alpha-btn',
            label: 'Exit',
            can_focus: false,
        });
        this._connect(exit, 'clicked', () => {
            // Deferred: this handler lives inside the pill we are removing.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this.deactivate();
                return GLib.SOURCE_REMOVE;
            });
        });
        this._pill.add_child(exit);

        Main.layoutManager.addTopChrome(this._pill);
        this._place();
        this._connect(Main.layoutManager, 'monitors-changed', () => this._place());
    }

    _place() {
        if (!this._pill)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this._pill.set_position(
            monitor.x + Math.floor((monitor.width - this._pill.width) / 2),
            monitor.y + monitor.height - this._pill.height - 48);
    }

    _hidePill() {
        this._releaseSignals();

        if (!this._pill)
            return;

        const pill = this._pill;
        this._pill = null;

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            Main.layoutManager.removeChrome(pill);
            pill.destroy();
            return GLib.SOURCE_REMOVE;
        });
    }

    _connect(object, name, callback) {
        this._signals.push([object, object.connect(name, callback)]);
    }

    _releaseSignals() {
        for (const [object, id] of this._signals) {
            try {
                object.disconnect(id);
            } catch (e) {
                // Already finalized — fine.
            }
        }
        this._signals = [];
    }
}
