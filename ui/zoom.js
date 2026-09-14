// ui/zoom.js — Zoom & Spotlight.
//
// Presentation mode: dim everything except a rounded highlight that
// follows the pointer, optionally magnified.
//
// Performance notes
// -----------------
// * The spotlight is FOUR dim rectangles arranged around the highlight,
//   repositioned on pointer motion. There is no full-screen texture, no
//   Clutter.Canvas (removed in GNOME 50) and nothing repaints unless the
//   pointer actually moves.
// * Motion is throttled to ~60Hz and sub-pixel moves are ignored.
// * Magnification reuses the shell's own magnifier instead of a second
//   scaled copy of the stage, so there is no duplicate framebuffer. The
//   previous magnifier state is always restored on exit.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AlphaOverlay} from './shell.js';

const SPOT_W = 420;
const SPOT_H = 260;
const MOTION_INTERVAL_US = 16000; // ~60Hz
const ZOOM_MIN = 1.0;
const ZOOM_MAX = 4.0;
const ZOOM_STEP = 0.25;

export class ZoomSpotlight extends AlphaOverlay {
    constructor(path) {
        super({
            path,
            title: 'Zoom & Spotlight',
            chrome: false,   // this feature uses a floating pill, not a panel
            dim: false,      // the dim comes from the spotlight rectangles
            width: 0,
            styleClass: 'alpha-zoom',
        });

        this._zoom = 1.0;
        this._spotOn = true;
        this._lastMotionUs = 0;
        this._lastX = -1;
        this._lastY = -1;
        this._savedMagnifierActive = null;
    }

    _build(panel) {
        // Floating pill control bar.
        panel.style_class = 'alpha-pill alpha-zoom';
        panel.orientation = Clutter.Orientation.HORIZONTAL;

        this._label = new St.Label({
            style_class: 'alpha-pill-label',
            text: 'Spotlight on · 1.0\u00d7',
            y_align: Clutter.ActorAlign.CENTER,
        });
        panel.add_child(this._label);

        const out = new St.Button({style_class: 'alpha-btn', label: '\u2212', can_focus: false});
        const reset = new St.Button({style_class: 'alpha-btn', label: '1\u00d7', can_focus: false});
        const zoomIn = new St.Button({style_class: 'alpha-btn', label: '+', can_focus: false});
        const spot = new St.Button({style_class: 'alpha-btn selected', label: 'Spotlight', can_focus: false});
        const exit = new St.Button({style_class: 'alpha-btn alpha-btn-danger', label: 'Exit', can_focus: false});

        this._spotButton = spot;

        this._connect(out, 'clicked', () => this._setZoom(this._zoom - ZOOM_STEP));
        this._connect(reset, 'clicked', () => this._setZoom(1.0));
        this._connect(zoomIn, 'clicked', () => this._setZoom(this._zoom + ZOOM_STEP));
        this._connect(spot, 'clicked', () => this._toggleSpot());
        this._connect(exit, 'clicked', () => this.deferClose());

        panel.add_child(out);
        panel.add_child(reset);
        panel.add_child(zoomIn);
        panel.add_child(spot);
        panel.add_child(exit);
    }

    _onOpened() {
        // Pill sits at the bottom, not centered over the content.
        this._panel.y_align = Clutter.ActorAlign.END;
        this._panel.x_align = Clutter.ActorAlign.CENTER;

        // Four dim rectangles, inserted behind the pill.
        this._dims = [];
        for (let i = 0; i < 4; i++) {
            const dim = new St.Widget({style_class: 'alpha-dim', reactive: false});
            this._overlay.insert_child_below(dim, this._panel);
            this._dims.push(dim);
        }

        this._connect(this._overlay, 'motion-event', (_a, event) => {
            this._onMotion(event);
            return Clutter.EVENT_PROPAGATE;
        });

        const [x, y] = global.get_pointer();
        this._place(x, y);
        this._updateLabel();
    }

    _onClosing() {
        this._restoreMagnifier();
        this._dims = [];
    }

    _onMotion(event) {
        if (!this._spotOn || !this._dims?.length)
            return;

        const now = GLib.get_monotonic_time();
        if (now - this._lastMotionUs < MOTION_INTERVAL_US)
            return;
        this._lastMotionUs = now;

        const [x, y] = event.get_coords();
        if (Math.round(x) === this._lastX && Math.round(y) === this._lastY)
            return;

        this._place(x, y);
    }

    /** Arrange the four dim rectangles around the highlight at (x, y). */
    _place(x, y) {
        if (!this._dims?.length || !this._overlay)
            return;

        this._lastX = Math.round(x);
        this._lastY = Math.round(y);

        const width = this._overlay.width;
        const height = this._overlay.height;
        const ox = this._overlay.x;
        const oy = this._overlay.y;

        // Overlay-local coordinates for the hole.
        const left = Math.max(0, Math.min(width - SPOT_W, Math.round(x - ox - SPOT_W / 2)));
        const top = Math.max(0, Math.min(height - SPOT_H, Math.round(y - oy - SPOT_H / 2)));
        const right = left + SPOT_W;
        const bottom = top + SPOT_H;

        const [above, below, leftBox, rightBox] = this._dims;

        above.set_position(0, 0);
        above.set_size(width, top);

        below.set_position(0, bottom);
        below.set_size(width, Math.max(0, height - bottom));

        leftBox.set_position(0, top);
        leftBox.set_size(left, SPOT_H);

        rightBox.set_position(right, top);
        rightBox.set_size(Math.max(0, width - right), SPOT_H);
    }

    _toggleSpot() {
        this._spotOn = !this._spotOn;

        for (const dim of this._dims ?? [])
            dim.visible = this._spotOn;

        if (this._spotOn) {
            this._spotButton.add_style_class_name('selected');
            const [x, y] = global.get_pointer();
            this._place(x, y);
        } else {
            this._spotButton.remove_style_class_name('selected');
        }

        this._updateLabel();
    }

    _setZoom(factor) {
        const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, factor));
        this._zoom = Math.round(clamped * 100) / 100;

        try {
            const magnifier = Main.magnifier;
            if (!magnifier)
                throw new Error('magnifier unavailable');

            if (this._savedMagnifierActive === null)
                this._savedMagnifierActive = magnifier.isActive();

            if (this._zoom <= 1.0) {
                magnifier.setActive(false);
            } else {
                magnifier.setActive(true);
                for (const region of magnifier.getZoomRegions())
                    region.setMagFactor(this._zoom, this._zoom);
            }
        } catch (e) {
            // Magnifier not available: spotlight still works on its own.
            console.warn(`[alpha-shell] zoom unavailable: ${e.message}`);
        }

        this._updateLabel();
    }

    _restoreMagnifier() {
        if (this._savedMagnifierActive === null)
            return;
        try {
            Main.magnifier?.setActive(this._savedMagnifierActive);
        } catch (e) {
            // Nothing to restore — fine.
        }
        this._savedMagnifierActive = null;
    }

    _updateLabel() {
        if (!this._label)
            return;
        this._label.text = `${this._spotOn ? 'Spotlight on' : 'Spotlight off'} \u00b7 ${this._zoom.toFixed(2)}\u00d7`;
    }

    _onKeyPress(symbol, _event) {
        switch (symbol) {
        case Clutter.KEY_plus:
        case Clutter.KEY_equal:
        case Clutter.KEY_KP_Add:
            this._setZoom(this._zoom + ZOOM_STEP);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_minus:
        case Clutter.KEY_KP_Subtract:
            this._setZoom(this._zoom - ZOOM_STEP);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_0:
        case Clutter.KEY_KP_0:
            this._setZoom(1.0);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_s:
        case Clutter.KEY_S:
            this._toggleSpot();
            return Clutter.EVENT_STOP;

        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }
}
