// ALPHA Quick Launcher — an in-place Spotlight-style search HUD.
//
// A centered, modal, floating search box overlaid directly on
// Main.layoutManager.uiGroup. It never touches the active window: it does
// not open the GNOME Overview and never minimizes the focused application.
// Opening uses Main.pushModal() (and closing Main.popModal()) so every other
// actor on the stage is input-blocked only while the HUD is up, and the
// window beneath keeps its state exactly as it was.
//
// Search runs against Shell.AppSystem.get_default().get_installed() and
// matches an app's name, description and id (case-insensitive). Results are
// a vertical list of icon + name rows.
//
// Keyboard:
//   Up / Down       move the selection
//   Enter / KP_Enter  activate the selected app (app.activate()) and close
//   Escape          dismiss the HUD
//
// Mouse:
//   click           activate the clicked row and close
//   enter-event (hover)  move the selection to the hovered row
//
// The HUD input itself is a St.Entry; results live in a St.BoxLayout list
// wrapped in a St.ScrollView, and the whole thing is driven by
// 'key-press-event' on the entry's Clutter.Text (which holds focus while
// open, so the modal grab routes every key to us).
//
// Monitor changes are tracked via the global monitors-changed signal and the
// HUD re-centers/resizes itself accordingly.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HUD_WIDTH = 640;
const MAX_RESULTS = 8;      // rows shown before the list scrolls
const ROW_HEIGHT = 48;      // per-result row height (px)

export class Launcher {
    constructor() {
        this._active = false;
        this._destroyed = false;

        // State
        this._apps = [];             // cached Shell.App list
        this._results = [];          // currently matching apps
        this._selected = -1;         // index into this._results (-1 = none)

        // Actors
        this._hud = null;            // top-level St.BoxLayout (vertical)
        this._entry = null;          // St.Entry (search field)
        this._entryText = null;      // entry.clutter_text (key focus target)
        this._scroll = null;         // St.ScrollView around the list
        this._list = null;           // St.BoxLayout list container
        this._rows = [];             // live St.Button result rows
        this._noResults = null;      // "no matches" hint label
        this._grab = null;           // Clutter.Grab returned by Main.pushModal()

        // Signal tracking — every connection made through _track() is
        // disconnected in _teardown().
        this._handlers = [];

        // Monitor tracking
        this._monitorInvalidated = false;
    }

    get active() {
        return this._active;
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    enable() {
        if (this._active || this._destroyed)
            return;

        this._active = true;

        try {
            this._apps = Shell.AppSystem.get_default().get_installed();

            this._buildHud();
            this._centerHud();

            this._track(Main.layoutManager, 'monitors-changed',
                () => this._invalidateMonitor());

            // Enter the modal grab BEFORE focusing the entry so that focus is
            // fully established inside the modal region. pushModal() returns a
            // Clutter.Grab which popModal() expects back on close — store it.
            this._grab = Main.pushModal(this._hud);
            this._entryText.grab_key_focus();

            this._refresh('');   // start showing all apps
        } catch (e) {
            // A half-built HUD must never leak a modal grab onto the stage.
            console.error(`[alpha-shell] launcher failed to enable: ${e.message}\n${e.stack}`);
            this._active = false;
            this._teardown();
            return;
        }

        console.log('[alpha-shell] ALPHA Quick Launcher enabled');
    }

    disable() {
        if (!this._active)
            return;

        this._active = false;
        this._teardown();
        console.log('[alpha-shell] ALPHA Quick Launcher disabled');
    }

    destroy() {
        this.disable();
        this._destroyed = true;
    }

    toggle() {
        if (this._active)
            this.disable();
        else
            this.enable();
    }

    // ------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------

    _buildHud() {
        this._hud = new St.BoxLayout({
            name: 'alphaLauncherHud',
            style_class: 'alpha-launcher-hud',
            vertical: true,
            reactive: true,
        });

        // --- Search entry ------------------------------------------------
        this._entry = new St.Entry({
            style_class: 'alpha-launcher-entry',
            hint_text: 'Search applications…',
            can_focus: true,
        });
        this._entryText = this._entry.clutter_text;

        const entryHandlers = [
            {obj: this._entryText, id: this._entryText.connect('text-changed',
                () => this._refresh(this._entryText.get_text()))},
            {obj: this._entryText, id: this._entryText.connect('key-press-event',
                (a, e) => this._onKeyPress(e))},
        ];
        for (const h of entryHandlers)
            this._handlers.push(h);

        this._hud.add_child(this._entry);

        // --- Results list (scrollable) -----------------------------------
        this._list = new St.BoxLayout({
            style_class: 'alpha-launcher-list',
            vertical: true,
        });

        this._scroll = new St.ScrollView({
            style_class: 'alpha-launcher-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        // St.ScrollView is a St.Bin: GNOME 50 uses set_child(), the legacy
        // add_actor() is deprecated.
        this._scroll.set_child(this._list);
        this._hud.add_child(this._scroll);

        this._noResults = new St.Label({
            text: 'No matching applications',
            style_class: 'alpha-launcher-empty',
        });

        Main.layoutManager.uiGroup.add_child(this._hud);
    }

    // A single result row: icon + name. Selection is rendered via the
    // 'selected' style class; click and hover both drive selection/activation.
    _buildRow(app) {
        const row = new St.Button({
            style_class: 'alpha-launcher-row',
            reactive: true,
            track_hover: true,
            can_focus: false,
        });

        const icon = app.create_icon_texture(32);
        row.add_child(icon);

        const label = new St.Label({
            text: app.get_name(),
            style_class: 'alpha-launcher-row-label',
        });
        row.add_child(label);

        const id = row.connect('clicked', () => {
            this._launch(app);
        });
        const hover = row.connect('enter-event', () => {
            const idx = this._results.indexOf(app);
            if (idx >= 0)
                this._select(idx);
            return Clutter.EVENT_PROPAGATE;
        });

        // Track per-row signal ids so they are disconnected on teardown.
        this._handlers.push({obj: row, id}, {obj: row, id: hover});

        return row;
    }

    // ------------------------------------------------------------------
    // Search & refresh
    // ------------------------------------------------------------------

    _refresh(query) {
        const q = (query || '').trim().toLowerCase();

        this._results = q
            ? this._apps.filter(app => this._matches(app, q))
            : this._apps.slice();

        // Sort matches so name hits rank first, then by display name.
        this._results.sort((a, b) => {
            return a.get_name().localeCompare(b.get_name());
        });

        // Cap the shown list for performance and sane scrolling.
        this._results = this._results.slice(0, 200);

        this._renderRows();
    }

    _matches(app, q) {
        const name = (app.get_name() || '').toLowerCase();
        const desc = (app.get_description() || '').toLowerCase();
        const id = (app.get_id() || '').toLowerCase();

        return name.includes(q) || desc.includes(q) || id.includes(q);
    }

    _renderRows() {
        // Clear previous rows.
        for (const row of this._rows) {
            row.destroy();
        }
        this._rows = [];

        this._list.remove_all_children();

        if (this._results.length === 0) {
            this._noResults.show();
            this._list.add_child(this._noResults);
        } else {
            this._noResults.hide();
            for (const app of this._results) {
                const row = this._buildRow(app);
                this._list.add_child(row);
                this._rows.push(row);
            }
        }

        // Reset selection to the top unless the previous selection is still
        // within bounds (not possible here since results re-render), so 0.
        this._selected = this._results.length > 0 ? 0 : -1;
        this._applySelection();
    }

    // ------------------------------------------------------------------
    // Selection & activation
    // ------------------------------------------------------------------

    _select(idx) {
        if (idx < 0 || idx >= this._results.length)
            return;

        this._selected = idx;
        this._applySelection();
    }

    _applySelection() {
        for (let i = 0; i < this._rows.length; i++) {
            if (i === this._selected)
                this._rows[i].add_style_class_name('selected');
            else
                this._rows[i].remove_style_class_name('selected');
        }

        // Keep the selected row scrolled into view.
        if (this._selected >= 0 && this._selected < this._rows.length) {
            const row = this._rows[this._selected];
            this._scroll.scroll_to_actor(row);
        }
    }

    _launch(app) {
        try {
            app.activate();
        } catch (e) {
            console.error(`[alpha-shell] launcher failed to activate '${app.get_id()}': ${e.message}`);
        }
        // Close regardless of activation success so the HUD never sticks.
        // Deferred: _launch() runs inside a row's 'clicked' emission (or the
        // entry's key-press); destroying that row / the HUD synchronously
        // leaves St touching freed memory after the handler returns and
        // SIGSEGVs gnome-shell, killing the whole Wayland session.
        this._defer(() => this.disable());
    }

    // ------------------------------------------------------------------
    // Keyboard
    // ------------------------------------------------------------------

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();

        if (symbol === Clutter.KEY_Escape) {
            // Deferred — see _launch(). Destroying the key-focused entry
            // from inside its own key-press emission crashes the shell.
            this._defer(() => this.disable());
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Down) {
            const next = Math.min(this._selected + 1, this._results.length - 1);
            if (this._results.length)
                this._select(next);
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Up) {
            const prev = Math.max(this._selected - 1, 0);
            if (this._results.length)
                this._select(prev);
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            if (this._selected >= 0 && this._selected < this._results.length)
                this._launch(this._results[this._selected]);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // ------------------------------------------------------------------
    // Geometry
    // ------------------------------------------------------------------

    _centerHud() {
        if (!this._hud)
            return;

        const m = Main.layoutManager.primaryMonitor;
        const width = Math.min(HUD_WIDTH, Math.floor(m.width * 0.9));
        this._hud.set_width(width);

        // Position: horizontally centered, vertically near the top third.
        const x = m.x + Math.floor((m.width - width) / 2);
        const y = m.y + Math.floor(m.height * 0.18);

        this._hud.set_position(x, y);
        this._monitorInvalidated = false;
    }

    _invalidateMonitor() {
        // Defer to the next redraw so the monitor geometry is settled before
        // we re-center (monitors-changed can fire during a relayout).
        this._monitorInvalidated = true;
        if (this._hud) {
            this._hud.queue_relayout();
            // Re-center on the next idle cycle to avoid acting mid-relayout.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (this._active && this._monitorInvalidated)
                    this._centerHud();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // ------------------------------------------------------------------
    // Tracking & teardown
    // ------------------------------------------------------------------

    _track(object, signal, handler) {
        const id = object.connect(signal, handler);
        this._handlers.push({object, id});
    }

    /** Run fn outside any ongoing signal emission — see _launch(). */
    _defer(fn) {
        Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            try {
                fn();
            } catch (e) {
                console.error(`[alpha-shell] deferred op failed: ${e.message}`);
            }
            return false; // run once
        });
    }

    _teardown() {
        // Release the modal grab FIRST — never leave the stage frozen.
        // popModal() takes the Clutter.Grab handle returned by pushModal(),
        // not the actor.
        if (this._grab) {
            try {
                Main.popModal(this._grab);
            } catch (e) {
                // Grab already dismissed — nothing to pop.
            }
            this._grab = null;
        }

        for (const {object, id} of this._handlers) {
            try {
                object.disconnect(id);
            } catch (e) {
                // Object already destroyed — fine.
            }
        }
        this._handlers = [];

        this._results = [];
        this._apps = [];
        this._selected = -1;

        if (this._hud) {
            this._hud.destroy();
            this._hud = null;
        }
        this._rows = [];
        this._entry = null;
        this._entryText = null;
        this._scroll = null;
        this._list = null;
        this._noResults = null;
    }
}