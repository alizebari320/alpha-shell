// ALPHA Quick Launcher — an in-place Spotlight-style search HUD.
//
// A centered, modal, floating search box overlaid directly on
// Main.layoutManager.uiGroup. It never touches the active window: it does
// not open the GNOME Overview and never minimizes the focused application.
// Opening uses Main.pushModal() (and closing Main.popModal()) so every other
// actor on the stage is input-blocked only while the HUD is up, and the
// window beneath keeps its state exactly as it was.
//
// Search runs against Shell.AppSystem.get_default().get_installed() (which
// returns Gio.AppInfo objects in GNOME 50) and matches an app's name,
// description and id (case-insensitive). Results are a vertical list of
// icon + name rows.
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
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

const HUD_WIDTH = 640;
const MAX_RESULTS = 12;     // rows rendered per search — every row is a live
                            // icon texture; re-rendering 100 of them per
                            // keystroke is what made typing feel frozen.

export class Launcher {
    constructor() {
        this._active = false;
        this._destroyed = false;

        // State
        this._apps = [];             // cached Gio.AppInfo list (GNOME 50)
        this._results = [];          // currently matching apps
        this._selected = -1;         // index into this._results (-1 = none)

        // Actors
        this._overlay = null;       // fullscreen click-catcher + modal target
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
            this._apps = Shell.AppSystem.get_default().get_installed()
                .filter(app => app.should_show());

            this._buildHud();
            this._centerHud();

            this._track(Main.layoutManager, 'monitors-changed',
                () => this._invalidateMonitor());

            // Defer the modal grab by one idle cycle: the HUD must be mapped
            // on the stage first, and if we were opened from the panel menu
            // the menu is still releasing ITS grab this very frame. Pushing
            // ours immediately makes the two grabs fight and freezes all
            // input. (GNOME 50 removed Meta.later_add; idle_add replaces it.)
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (!this._active)
                    return GLib.SOURCE_REMOVE;  // closed again before we grabbed
                try {
                    this._grab = Main.pushModal(this._overlay);
                    this._entryText.grab_key_focus();
                    this._refresh('');   // start showing all apps
                } catch (e) {
                    console.error(`[alpha-shell] launcher modal grab failed: ${e.message}`);
                    this.disable();
                }
                return GLib.SOURCE_REMOVE; // run once
            });
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
        // Fullscreen transparent overlay: it is the modal grab target and the
        // click-outside-to-dismiss catcher. The visible HUD is its child.
        this._overlay = new St.Widget({
            name: 'alphaLauncherOverlay',
            style_class: 'alpha-launcher-overlay',
            reactive: true,
        });

        this._track(this._overlay, 'button-press-event', (actor, event) => {
            const [sx, sy] = event.get_coords();
            const hud = this._hud;
            if (hud) {
                const pos = hud.get_transformed_position();
                if (pos) {
                    const [hx, hy] = pos;
                    const w = hud.get_width();
                    const h = hud.get_height();
                    if (sx >= hx && sx <= hx + w && sy >= hy && sy <= hy + h)
                        return Clutter.EVENT_PROPAGATE;  // inside HUD — its children handle it
                }
            }
            this._defer(() => this.disable());
            return Clutter.EVENT_STOP;
        });

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

        // "No matches" hint. It stays a permanent (hidden) child of the
        // list so it is always inside the HUD tree and destroyed with it.
        this._noResults = new St.Label({
            text: 'No matching applications',
            style_class: 'alpha-launcher-empty',
        });
        this._noResults.hide();
        this._list.add_child(this._noResults);

        Main.layoutManager.uiGroup.add_child(this._overlay);
        this._overlay.add_child(this._hud);
    }

    // A single result row: icon + name. Selection is rendered via the
    // 'selected' style class; click and hover both drive selection/activation.
    _buildRow(app) {
        // St.Button is a St.Bin — it can hold exactly ONE child. The icon and
        // the label must go into a horizontal St.BoxLayout, which is then the
        // button's single child. (Adding both directly made them stack in
        // one spot — the "merged icon and name" glitch.)
        const row = new St.Button({
            style_class: 'alpha-launcher-row',
            reactive: true,
            track_hover: true,
            can_focus: false,
            x_expand: true,
        });

        const box = new St.BoxLayout({
            style_class: 'alpha-launcher-row-box',
            x_expand: true,
        });

        // GNOME 50's get_installed() returns Gio.AppInfo, which exposes the
        // icon via get_icon() (a GIcon) — render it through St.Icon.
        const gicon = app.get_icon();
        box.add_child(new St.Icon({
            gicon: gicon ?? null,
            fallback_icon_name: 'application-x-executable-symbolic',
            icon_size: 32,
        }));

        box.add_child(new St.Label({
            text: app.get_name(),
            style_class: 'alpha-launcher-row-label',
        }));

        row.set_child(box);

        const id = row.connect('clicked', () => {
            this._launch(app);
        });
        const hover = row.connect('enter-event', () => {
            const idx = this._results.indexOf(app);
            if (idx >= 0)
                this._select(idx);
            return Clutter.EVENT_PROPAGATE;
        });

        // Per-row handlers live on the row itself, NOT in the global
        // _handlers list: rows are recreated on every keystroke, so a global
        // list would grow without bound. They are disconnected in
        // _destroyRow() and during teardown.
        row._alphaHandlerIds = [id, hover];

        return row;
    }

    /** Disconnect a result row's handlers and destroy it. */
    _destroyRow(row) {
        for (const id of row._alphaHandlerIds ?? []) {
            try {
                row.disconnect(id);
            } catch (e) {
                // Row already destroyed — fine.
            }
        }
        row._alphaHandlerIds = [];
        row.destroy();
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
        this._results = this._results.slice(0, MAX_RESULTS);

        this._renderRows();
    }

    _matches(app, q) {
        const name = (app.get_name() || '').toLowerCase();
        const desc = (app.get_description() || '').toLowerCase();
        const id = (app.get_id() || '').toLowerCase();

        return name.includes(q) || desc.includes(q) || id.includes(q);
    }

    _renderRows() {
        // Clear previous rows (each disconnects its own handlers).
        for (const row of this._rows)
            this._destroyRow(row);
        this._rows = [];

        if (this._results.length === 0) {
            this._noResults.show();
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

        // Keep the selected row scrolled into view. St.ScrollView has no
        // scroll_to_actor() in GNOME 50 — the shell's own helper is the
        // supported way.
        if (this._selected >= 0 && this._selected < this._rows.length)
            ensureActorVisibleInScrollView(this._scroll, this._rows[this._selected]);
    }

    _launch(app) {
        try {
            // GNOME 50: AppSystem.get_installed() returns Gio.AppInfo objects
            // (no activate()). Resolve the real Shell.App for proper
            // focus/workspace behaviour; fall back to raw GIO launch.
            const shellApp = Shell.AppSystem.get_default().lookup_app(app.get_id());
            if (shellApp)
                shellApp.activate();
            else
                app.launch([], null);
        } catch (e) {
            console.error(`[alpha-shell] launcher failed to activate '${app.get_id()}': ${e.message}`);
        }
        // Close regardless of activation success so the HUD never sticks.
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
        if (!this._overlay || !this._hud)
            return;

        const m = Main.layoutManager.primaryMonitor;

        // Overlay covers the whole monitor; the HUD is positioned relative
        // to it (its local origin is the monitor's top-left).
        this._overlay.set_position(m.x, m.y);
        this._overlay.set_size(m.width, m.height);

        const width = Math.min(HUD_WIDTH, Math.floor(m.width * 0.9));
        this._hud.set_width(width);

        // Horizontally centered, vertically near the top third.
        this._hud.set_position(
            Math.floor((m.width - width) / 2),
            Math.floor(m.height * 0.18));

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

    /** Run fn outside any ongoing signal emission — see _launch().
     *  (GNOME 50 removed Meta.later_add; idle_add replaces it.) */
    _defer(fn) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                fn();
            } catch (e) {
                console.error(`[alpha-shell] deferred op failed: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE; // run once
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

        // Live result rows are not in _handlers (see _buildRow) — release
        // them here too, before the HUD tree is destroyed.
        for (const row of this._rows) {
            for (const id of row._alphaHandlerIds ?? []) {
                try {
                    row.disconnect(id);
                } catch (e) {
                    // Row already destroyed — fine.
                }
            }
            row._alphaHandlerIds = [];
        }
        this._rows = [];

        // Drop key focus explicitly so nothing references the actors we are
        // about to destroy.
        global.stage.set_key_focus(null);

        this._results = [];
        this._apps = [];
        this._selected = -1;

        if (this._hud) {
            this._hud.destroy();
            this._hud = null;
        }
        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }
        this._rows = [];
        this._entry = null;
        this._entryText = null;
        this._scroll = null;
        this._list = null;
        this._noResults = null;
    }
}