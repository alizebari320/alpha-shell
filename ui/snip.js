// ui/snip.js — Snip & Explain.
//
// Drag a region of the screen, ALPHA explains what is in it.
//
// Two phases:
//   1. SnipSelector  a bare full-screen overlay with a rubber band
//   2. SnipHud       the shared branded HUD showing the explanation
//
// Performance notes
// -----------------
// * The rubber band is a single St.Widget whose position/size is set on
//   motion. No Clutter.Canvas (removed in GNOME 50) and no full-screen
//   repaint per frame.
// * The capture is written straight to a temp file and unlinked as soon
//   as the AI request settles. No pixel buffer is retained by the shell.
// * Selector and HUD are separate objects so the selection overlay is
//   gone before the answer UI exists — only one of them is ever alive.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AlphaOverlay} from './shell.js';

const MIN_SIZE = 8; // px; ignore accidental clicks

// GNOME's own screenshot UI promisifies these; do it once, defensively,
// because a double-promisify throws.
let _promisified = false;
function _ensurePromisified() {
    if (_promisified)
        return;
    try {
        Gio._promisify(Shell.Screenshot.prototype, 'screenshot_stage_to_content');
        Gio._promisify(Shell.Screenshot, 'composite_to_stream');
    } catch (e) {
        // Already promisified elsewhere in the session — fine.
    }
    _promisified = true;
}

/** Full-screen rubber-band region selector. */
class SnipSelector {
    constructor(onSelected) {
        this._onSelected = onSelected;
        this._signals = [];
        this._modal = null;
        this._finishId = 0;
        this._destroyed = false;
        this._startX = 0;
        this._startY = 0;
        this._dragging = false;

        this._overlay = new St.Widget({
            style_class: 'alpha-snip-overlay',
            reactive: true,
        });
        this._overlay.set_position(0, 0);
        this._overlay.set_size(global.stage.width, global.stage.height);

        this._band = new St.Widget({style_class: 'alpha-snip-band', visible: false});
        this._overlay.add_child(this._band);

        this._hint = new St.Label({
            style_class: 'alpha-snip-hint',
            text: 'Drag to snip \u00b7 Esc to cancel',
        });
        this._overlay.add_child(this._hint);
        this._hint.set_position(
            Math.floor(global.stage.width / 2) - 120,
            Math.floor(global.stage.height / 2));

        Main.layoutManager.uiGroup.add_child(this._overlay);

        // The grab can fail (or throw) when another actor still holds it.
        // A selector without the grab is a dead fullscreen reactive overlay
        // that swallows every click with no way to dismiss it — i.e. a
        // frozen screen — so bail out and tear down immediately instead.
        try {
            this._modal = Main.pushModal(this._overlay, {
                actionMode: Shell.ActionMode.NORMAL,
            });
        } catch (e) {
            console.warn(`[alpha-shell] snip selector could not grab input: ${e.message}`);
            this._modal = null;
        }
        if (!this._modal) {
            this.destroy();
            return;
        }

        global.display.set_cursor(Shell.Cursor.CROSSHAIR);

        this._connect(this._overlay, 'button-press-event', (_a, event) => {
            [this._startX, this._startY] = event.get_coords();
            this._dragging = true;
            this._hint.visible = false;
            this._band.visible = true;
            this._band.set_position(this._startX, this._startY);
            this._band.set_size(0, 0);
            return Clutter.EVENT_STOP;
        });

        this._connect(this._overlay, 'motion-event', (_a, event) => {
            if (!this._dragging)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            this._band.set_position(Math.min(x, this._startX), Math.min(y, this._startY));
            this._band.set_size(Math.abs(x - this._startX), Math.abs(y - this._startY));
            return Clutter.EVENT_STOP;
        });

        this._connect(this._overlay, 'button-release-event', (_a, event) => {
            if (!this._dragging)
                return Clutter.EVENT_PROPAGATE;
            this._dragging = false;

            const [x, y] = event.get_coords();
            const area = {
                x: Math.round(Math.min(x, this._startX)),
                y: Math.round(Math.min(y, this._startY)),
                w: Math.round(Math.abs(x - this._startX)),
                h: Math.round(Math.abs(y - this._startY)),
            };

            const callback = this._onSelected;
            // Tear the selector down on the next tick, never inside this
            // emission, then hand the region over.
            this._finish(() => {
                if (area.w >= MIN_SIZE && area.h >= MIN_SIZE)
                    callback(area);
            });
            return Clutter.EVENT_STOP;
        });

        this._connect(this._overlay, 'key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._finish(() => {});
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    get dead() {
        return this._destroyed;
    }

    _connect(object, name, callback) {
        this._signals.push([object, object.connect(name, callback)]);
    }

    /** Tear the selector down on the next tick, then hand the region over.
     *  The idle is tracked and cancelled by destroy(), so a disable() in
     *  between can never resurrect a HUD after the extension is gone. */
    _finish(after) {
        this._finishId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._finishId = 0;
            this.destroy();
            after();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._destroyed = true;

        if (this._finishId) {
            try {
                GLib.source_remove(this._finishId);
            } catch (e) {
                // Already fired — fine.
            }
            this._finishId = 0;
        }

        for (const [object, id] of this._signals) {
            try {
                object.disconnect(id);
            } catch (e) {
                // Already finalized — fine.
            }
        }
        this._signals = [];

        if (this._modal) {
            try {
                Main.popModal(this._modal);
            } catch (e) {
                // Already released — fine.
            }
            this._modal = null;
        }

        global.display.set_cursor(Shell.Cursor.DEFAULT);

        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
            this._band = null;
            this._hint = null;
        }
    }
}

/** The HUD that shows what the snipped region contains. */
class SnipHud extends AlphaOverlay {
    constructor(path, ai, area) {
        super({
            path,
            title: 'Snip & Explain',
            hint: `${area.w}\u00d7${area.h}`,
            footer: 'Ctrl+C copy · Esc close',
            width: 640,
            styleClass: 'alpha-snip',
        });

        this._ai = ai;
        this._area = area;
        this._token = 0;
        this._answer = '';
        this._tempPath = null;
    }

    _build(panel) {
        this._status = new St.Label({style_class: 'alpha-spinner', text: 'Capturing\u2026'});
        panel.add_child(this._status);

        this._scroll = new St.ScrollView({
            style_class: 'alpha-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            y_expand: true,
        });
        this._body = new St.Label({style_class: 'alpha-body', text: ''});
        this._body.clutter_text.line_wrap = true;
        this._body.clutter_text.selectable = true;
        this._scroll.set_child(this._body);
        this._scroll.visible = false;
        panel.add_child(this._scroll);
    }

    _onOpened() {
        this._run();
    }

    _onClosing() {
        this._token++;      // invalidate any in-flight request
        this._cleanupTemp();
    }

    async _run() {
        const token = ++this._token;

        try {
            const path = await this._capture();
            if (token !== this._token || !this._body)
                return;

            this._tempPath = path;
            this._setStatus('Analyzing\u2026');

            const reply = await this._ai.analyzeScreenshot(path);
            if (token !== this._token || !this._body)
                return;
            this._show(reply, false);
        } catch (e) {
            if (token !== this._token || !this._body)
                return;
            this._show(e?.message ?? String(e), true);
        } finally {
            // Never keep the capture around longer than the request.
            if (token === this._token)
                this._cleanupTemp();
        }
    }

    /** Capture the selected region to a PNG and return its path. */
    async _capture() {
        _ensurePromisified();

        const {x, y, w, h} = this._area;
        const shooter = new Shell.Screenshot();

        // Same route GNOME's screenshot UI takes: grab the stage as content,
        // then composite just the selected rectangle into a stream.
        const [content, scale] = await shooter.screenshot_stage_to_content();
        const texture = content.get_texture();

        const path = GLib.build_filenamev([
            GLib.get_tmp_dir(),
            `alpha-snip-${GLib.get_monotonic_time()}.png`,
        ]);
        const file = Gio.File.new_for_path(path);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);

        await Shell.Screenshot.composite_to_stream(
            texture, x, y, w, h, scale, null, 0, 0, 1.0, stream);

        stream.close(null);
        return path;
    }

    _cleanupTemp() {
        if (!this._tempPath)
            return;
        try {
            Gio.File.new_for_path(this._tempPath).delete(null);
        } catch (e) {
            // Already gone — fine.
        }
        this._tempPath = null;
    }

    _setStatus(text) {
        if (!this._status)
            return;
        this._status.text = text;
        this._status.visible = !!text;
    }

    _show(text, isError) {
        this._setStatus('');
        this._answer = isError ? '' : text;
        this._body.text = text;
        this._body.style_class = isError ? 'alpha-body-error' : 'alpha-body';
        this._scroll.visible = true;
    }

    _onKeyPress(symbol, event) {
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (ctrl && (symbol === Clutter.KEY_c || symbol === Clutter.KEY_C)) {
            if (this._answer) {
                St.Clipboard.get_default().set_text(
                    St.ClipboardType.CLIPBOARD, this._answer);
                this._setStatus('Copied');
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
}

/**
 * Entry point for the feature. Owns whichever of the two overlays is
 * currently alive, so the extension only has to call start()/destroy().
 */
export class SnipExplain {
    constructor(path, ai) {
        this._path = path;
        this._ai = ai;
        this._selector = null;
        this._hud = null;
    }

    get isOpen() {
        if (this._selector && !this._selector.dead)
            return true;
        return !!this._hud?.isOpen;
    }

    toggle() {
        if (this.isOpen)
            this.destroy();
        else
            this.start();
    }

    start() {
        if (this.isOpen)
            return;

        const selector = new SnipSelector(area => {
            this._selector = null;
            this._hud = new SnipHud(this._path, this._ai, area);
            this._hud.open();
        });
        // The selector destroys itself when it cannot grab input.
        this._selector = selector.dead ? null : selector;
    }

    destroy() {
        this._selector?.destroy();
        this._selector = null;
        this._hud?.destroy();
        this._hud = null;
    }
}
