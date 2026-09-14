// ui/shell.js — the shared overlay base class for every ALPHA feature.
//
// Subclasses implement _build(panel) and optionally _onKeyPress(symbol,
// event) / _onOpened() / _onClosing(). Everything else — modal grab, Esc,
// click-outside dismiss, monitor placement, animation, signal and timeout
// bookkeeping, and safe teardown — lives here exactly once.
//
// Why a base class rather than copy-paste per feature:
//   * identical look and behavior across all nine features, by construction
//   * one audited teardown path, so a leak fixed here is fixed everywhere
//   * no actor is ever destroyed inside its own signal emission, which is
//     the crash fixed in ac5a0ac (shell SIGSEGV -> session logout)

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Brand from './brand.js';

const OPEN_MS = 120;
const CLOSE_MS = 90;
const OPEN_SCALE = 0.96;

export class AlphaOverlay {
    /**
     * @param {object} opts
     * @param {string} opts.path       extension.path, for the logo
     * @param {string} opts.title      header title
     * @param {string} [opts.hint]     right-aligned header hint
     * @param {string} [opts.footer]   keycap hint strip
     * @param {number} [opts.width]    panel width in px
     * @param {boolean} [opts.dim]     dim the background behind the panel
     * @param {boolean} [opts.chrome]  render the shared header/footer
     * @param {string} [opts.styleClass] extra class on the panel
     */
    constructor({
        path,
        title = 'ALPHA',
        hint = '',
        footer = '',
        width = 640,
        dim = true,
        chrome = true,
        styleClass = '',
    } = {}) {
        this._path = path;
        this._title = title;
        this._hint = hint;
        this._footer = footer;
        this._width = width;
        this._dim = dim;
        this._chrome = chrome;
        this._styleClass = styleClass;

        this._overlay = null;
        this._panel = null;
        this._modal = null;
        this._closing = false;

        // Ledgers: everything registered here is released in _teardown().
        this._signals = [];
        this._timeouts = new Set();
    }

    get isOpen() {
        return this._overlay !== null;
    }

    get panel() {
        return this._panel;
    }

    toggle() {
        if (this.isOpen)
            this.deferClose();
        else
            this.open();
    }

    // --- lifecycle --------------------------------------------------------

    open() {
        if (this._overlay || this._closing)
            return;

        this._overlay = new St.Widget({
            style_class: this._dim ? 'alpha-overlay' : '',
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
        });

        this._panel = new St.BoxLayout({
            style_class: `alpha-panel ${this._styleClass}`.trim(),
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        if (this._width)
            this._panel.set_width(this._width);

        if (this._chrome)
            this._panel.add_child(Brand.header(this._path, this._title, this._hint));

        this._build(this._panel);

        if (this._chrome && this._footer)
            this._panel.add_child(Brand.footer(this._footer));

        this._overlay.add_child(this._panel);
        Main.layoutManager.uiGroup.add_child(this._overlay);

        this._layout();

        // Modal grab: without it the HUD cannot own the keyboard.
        this._modal = Main.pushModal(this._overlay, {
            actionMode: Shell.ActionMode.NORMAL,
        });
        if (!this._modal) {
            console.warn('[alpha-shell] could not grab input; closing HUD');
            this._teardown();
            return;
        }

        this._connect(this._overlay, 'key-press-event', (_a, event) =>
            this._handleKeyPress(event));

        // Click outside the panel dismisses; clicks inside are left alone.
        this._connect(this._overlay, 'button-press-event', (_a, event) => {
            if (!this._panel)
                return Clutter.EVENT_PROPAGATE;

            const [x, y] = event.get_coords();
            const [px, py] = this._panel.get_transformed_position();
            const [pw, ph] = this._panel.get_transformed_size();
            const inside = x >= px && x <= px + pw && y >= py && y <= py + ph;
            if (!inside)
                this.deferClose();
            return Clutter.EVENT_STOP;
        });

        // Never inherit the single-monitor limitation: re-place on change.
        this._connect(Main.layoutManager, 'monitors-changed', () => this._layout());

        // 120ms in — snappy reads as premium.
        this._panel.set_pivot_point(0.5, 0.5);
        this._panel.set_scale(OPEN_SCALE, OPEN_SCALE);
        this._panel.opacity = 0;
        this._panel.ease({
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
            duration: OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._onOpened();
    }

    /**
     * Close on the next idle tick. ALWAYS use this from inside a signal
     * handler (button clicked, key press, row activated). Destroying actors
     * while they are still emitting is what crashed gnome-shell in ac5a0ac.
     */
    deferClose() {
        if (!this._overlay || this._closing)
            return;
        this._closing = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._closing = false;
            this.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    close() {
        if (!this._overlay)
            return;

        this._onClosing();

        // Drop the grab before animating so input returns to apps at once.
        this._popModal();

        const overlay = this._overlay;
        const panel = this._panel;
        this._overlay = null;
        this._panel = null;

        this._releaseSignals();
        this._releaseTimeouts();

        panel.ease({
            opacity: 0,
            scale_x: OPEN_SCALE,
            scale_y: OPEN_SCALE,
            duration: CLOSE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            // Runs on a later frame, so this is outside any emission.
            onComplete: () => overlay.destroy(),
        });
    }

    /** Hard teardown with no animation. Used by destroy() and open() errors. */
    _teardown() {
        this._onClosing();
        this._popModal();
        this._releaseSignals();
        this._releaseTimeouts();

        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
            this._panel = null;
        }
    }

    /** Called from the extension's disable(). Must leave nothing behind. */
    destroy() {
        this._closing = false;
        this._teardown();
    }

    // --- helpers for subclasses ------------------------------------------

    /** Connect a signal and register it for automatic disconnection. */
    _connect(object, name, callback) {
        const id = object.connect(name, callback);
        this._signals.push([object, id]);
        return id;
    }

    /** A timeout that is cancelled automatically when the HUD closes. */
    _timeout(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            const again = callback();
            if (again !== GLib.SOURCE_CONTINUE)
                this._timeouts.delete(id);
            return again;
        });
        this._timeouts.add(id);
        return id;
    }

    _clearTimeout(id) {
        if (id && this._timeouts.delete(id))
            GLib.source_remove(id);
    }

    /** Center the overlay on the monitor that currently holds the pointer. */
    _layout() {
        if (!this._overlay)
            return;

        const [px, py] = global.get_pointer();
        const monitors = Main.layoutManager.monitors ?? [];

        let monitor = Main.layoutManager.primaryMonitor;
        for (const m of monitors) {
            const inside = px >= m.x && px < m.x + m.width &&
                py >= m.y && py < m.y + m.height;
            if (inside) {
                monitor = m;
                break;
            }
        }
        if (!monitor)
            return;

        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);
    }

    // --- internals --------------------------------------------------------

    _handleKeyPress(event) {
        const symbol = event.get_key_symbol();

        // Esc always closes, in every feature.
        if (symbol === Clutter.KEY_Escape) {
            this.deferClose();
            return Clutter.EVENT_STOP;
        }

        return this._onKeyPress(symbol, event);
    }

    _popModal() {
        if (!this._modal)
            return;
        try {
            Main.popModal(this._modal);
        } catch (e) {
            // Already released — fine.
        }
        this._modal = null;
    }

    _releaseSignals() {
        for (const [object, id] of this._signals) {
            try {
                object.disconnect(id);
            } catch (e) {
                // Object already finalized — fine.
            }
        }
        this._signals = [];
    }

    _releaseTimeouts() {
        for (const id of this._timeouts) {
            try {
                GLib.source_remove(id);
            } catch (e) {
                // Already fired — fine.
            }
        }
        this._timeouts.clear();
    }

    // --- subclass hooks ---------------------------------------------------

    /** Build the HUD body. Required. */
    _build(_panel) {
        throw new Error('AlphaOverlay subclass must implement _build(panel)');
    }

    /** Handle a key press. Return Clutter.EVENT_STOP or EVENT_PROPAGATE. */
    _onKeyPress(_symbol, _event) {
        return Clutter.EVENT_PROPAGATE;
    }

    _onOpened() {}

    _onClosing() {}
}
