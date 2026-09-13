// Screen Annotator / Handwriting — Feature 1 of the ALPHA Shell toolset.
//
// A fully self-contained drawing layer that lives independently from the AI
// overlay: enable()/disable()/destroy() are the only lifecycle surface the
// extension needs, and the annotator never touches the AIOverlay or its state.
//
// Architecture (performance & Wayland notes):
//
//  * Two stacked transparent Clutter.Canvas actors are placed on
//    Main.layoutManager.uiGroup, above all desktop windows:
//      - "committed" canvas: holds all finished strokes. It is invalidated
//        exactly once per stroke completion, never during motion.
//      - "live" canvas: the event surface. While a stroke is in progress it
//        replays ONLY the active stroke, so per-frame cost is O(active
//        stroke), never O(session history). Long handwriting sessions stay
//        at constant frame cost — no main-thread stalls.
//
//  * Pass-through mode sets reactive = false on the live actor. Clutter
//    picking skips non-reactive actors, so every click/gesture falls through
//    to the desktop apps underneath — while both canvases keep painting the
//    strokes 100% visibly. Strokes survive mode toggles; they are only
//    dropped by the Clear button or by quitting the tool.
//
//  * Pointer capture during a stroke uses global.stage.grab() (Clutter.Grab),
//    the same mechanism GNOME Shell uses for its own popup menus. This is
//    Wayland-safe (no X grabs) and guarantees we receive motion/release even
//    when the pointer crosses the toolbar. Every grab is dismissed on
//    button-release AND during teardown, so no grab can leak.
//
//  * Every signal connection is registered through _track() and disconnected
//    in _teardown(); destroy() is idempotent.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Cairo from 'gi://cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TOOLBAR_RIGHT_MARGIN = 24;
const TOOLBAR_TOP_OFFSET = 80;
const MIN_POINT_DIST = 1.5; // px — skip micro-jitter points to bound stroke size

// Preset ink colors (Neon Green, Cyan, Red, White).
const COLORS = [
    {name: 'Neon Green', css: '#2bff88', rgba: {r: 0.169, g: 1.0, b: 0.533, a: 0.95}},
    {name: 'Cyan',       css: '#33d6ff', rgba: {r: 0.2,   g: 0.839, b: 1.0,   a: 0.95}},
    {name: 'Red',        css: '#ff4757', rgba: {r: 1.0,   g: 0.278, b: 0.341, a: 0.95}},
    {name: 'White',      css: '#ffffff', rgba: {r: 1.0,   g: 1.0,   b: 1.0,   a: 0.95}},
];

// Stroke width presets in logical pixels.
const WIDTHS = [2, 4, 8, 16];

export class Annotator {
    constructor() {
        this._active = false;
        this._destroyed = false;
        this._drawMode = true;

        this._monitor = null;

        // Actors / canvases
        this._committedActor = null;
        this._committedCanvas = null;
        this._liveActor = null;
        this._liveCanvas = null;
        this._toolbar = null;

        // Drawing state
        this._strokes = [];          // finished strokes: {color, width, points:[{x,y}]}
        this._activeStroke = null;   // stroke currently under the pointer
        this._color = COLORS[0].rgba;
        this._width = WIDTHS[1];

        // Toolbar widgets
        this._modeButton = null;
        this._colorButtons = [];
        this._widthButtons = [];

        // Interaction state
        this._drawGrab = null;       // Clutter.Grab while a stroke is in progress
        this._dragGrab = null;       // Clutter.Grab while the toolbar is dragged
        this._dragStart = null;      // {sx, sy, tx, ty}

        // Every connection made through _track(), disconnected in _teardown()
        this._handlers = [];
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    get active() {
        return this._active;
    }

    /** Build the actors and start annotating (defaults to Draw mode). */
    enable() {
        if (this._active || this._destroyed)
            return;

        this._active = true;
        this._monitor = Main.layoutManager.primaryMonitor;

        this._buildCanvases();
        this._buildToolbar();

        this._track(Main.layoutManager, 'monitors-changed',
            () => this._relayout());

        this._setDrawMode(true);
        console.log('[alpha-shell] annotator enabled');
    }

    /** Quit the tool: tears down actors, drops strokes, releases grabs. */
    disable() {
        if (!this._active)
            return;

        this._active = false;
        this._teardown();
        console.log('[alpha-shell] annotator disabled');
    }

    /** Full teardown — safe to call multiple times. */
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
    // Actor construction
    // ------------------------------------------------------------------

    _buildCanvases() {
        const m = this._monitor;

        // Bottom layer: finished strokes.
        this._committedCanvas = this._makeCanvas(
            (c, cr) => this._onCommittedDraw(c, cr));

        this._committedActor = new Clutter.Actor({
            name: 'alphaAnnotatorCommitted',
            x: m.x,
            y: m.y,
            width: m.width,
            height: m.height,
            reactive: false, // never an event surface
        });
        this._committedActor.set_content(this._committedCanvas);

        // Top layer: live stroke + event surface.
        this._liveCanvas = this._makeCanvas(
            (c, cr) => this._onLiveDraw(c, cr));

        this._liveActor = new Clutter.Actor({
            name: 'alphaAnnotatorLive',
            x: m.x,
            y: m.y,
            width: m.width,
            height: m.height,
            reactive: true,
        });
        this._liveActor.set_content(this._liveCanvas);

        // Pointer events for freehand drawing. The stage grab started in
        // _onPress routes motion/release here even outside actor bounds.
        this._track(this._liveActor, 'button-press-event',
            (a, e) => this._onPress(e));
        this._track(this._liveActor, 'motion-event',
            (a, e) => this._onMotion(e));
        this._track(this._liveActor, 'button-release-event',
            (a, e) => this._onRelease(e));

        const uiGroup = Main.layoutManager.uiGroup;
        uiGroup.add_child(this._committedActor);
        uiGroup.add_child(this._liveActor);
        // Canvas actors are added before the toolbar, so the toolbar paints
        // and picks above them (uiGroup children are stacked in add order).
    }

    _makeCanvas(onDraw) {
        const m = this._monitor;
        const canvas = new Clutter.Canvas();
        this._track(canvas, 'draw', onDraw);

        // HiDPI: the draw context arrives pre-scaled, we keep working in
        // logical (stage) coordinates everywhere.
        try {
            const scale = global.display.get_monitor_scale(m.index) || 1;
            canvas.set_scale_factor(scale);
        } catch (e) {
            // Non-fatal — worst case is soft strokes on scaled monitors.
        }

        canvas.set_size(m.width, m.height);
        return canvas;
    }

    _buildToolbar() {
        const m = this._monitor;

        this._toolbar = new St.BoxLayout({
            name: 'alphaAnnotatorToolbar',
            style_class: 'alpha-annotator-toolbar',
            vertical: true,
            reactive: true, // stays interactive in pass-through mode
        });

        // --- Drag handle ------------------------------------------------
        const handle = new St.BoxLayout({
            style_class: 'alpha-annotator-drag',
            reactive: true,
        });
        handle.add_child(new St.Label({text: '⠿'}));
        handle.add_child(new St.Label({text: 'Annotator'}));

        this._track(handle, 'button-press-event',
            (a, e) => this._onHandlePress(e));
        this._track(handle, 'motion-event',
            (a, e) => this._onHandleMotion(e));
        this._track(handle, 'button-release-event',
            (a, e) => this._onHandleRelease(e));

        this._toolbar.add_child(handle);

        // --- Mode toggle ------------------------------------------------
        this._modeButton = new St.Button({
            label: '✏️  Draw',
            style_class: 'alpha-annotator-btn alpha-annotator-mode alpha-mode-draw',
            x_expand: true,
        });
        this._track(this._modeButton, 'clicked',
            () => this._setDrawMode(!this._drawMode));
        this._toolbar.add_child(this._modeButton);

        // --- Colors -----------------------------------------------------
        this._toolbar.add_child(
            this._sectionLabel('Color'));

        const colorRow = new St.BoxLayout({style_class: 'alpha-annotator-row'});
        this._colorButtons = COLORS.map((color, index) => {
            const chip = new St.Button({
                style_class: 'alpha-annotator-chip',
                style: `background-color: ${color.css};`,
            });
            this._track(chip, 'clicked', () => {
                this._color = color.rgba;
                this._colorButtons.forEach(c => c.remove_style_class_name('selected'));
                chip.add_style_class_name('selected');
            });
            if (index === 0)
                chip.add_style_class_name('selected');
            colorRow.add_child(chip);
            return chip;
        });
        this._toolbar.add_child(colorRow);

        // --- Stroke width -------------------------------------------------
        this._toolbar.add_child(
            this._sectionLabel('Stroke'));

        const widthRow = new St.BoxLayout({style_class: 'alpha-annotator-row'});
        this._widthButtons = WIDTHS.map((width, index) => {
            const btn = new St.Button({
                label: String(width),
                style_class: 'alpha-annotator-btn alpha-annotator-width-btn',
            });
            this._track(btn, 'clicked', () => {
                this._width = width;
                this._widthButtons.forEach(b => b.remove_style_class_name('selected'));
                btn.add_style_class_name('selected');
            });
            if (width === this._width)
                btn.add_style_class_name('selected');
            widthRow.add_child(btn);
            return btn;
        });
        this._toolbar.add_child(widthRow);

        // --- Clear / Close ------------------------------------------------
        const actionRow = new St.BoxLayout({style_class: 'alpha-annotator-row'});

        const clearBtn = new St.Button({
            label: '🗑  Clear',
            style_class: 'alpha-annotator-btn alpha-annotator-clear',
            x_expand: true,
        });
        this._track(clearBtn, 'clicked', () => this.clear());
        actionRow.add_child(clearBtn);

        const closeBtn = new St.Button({
            label: '✕',
            style_class: 'alpha-annotator-btn alpha-annotator-close',
        });
        this._track(closeBtn, 'clicked', () => this.disable());
        actionRow.add_child(closeBtn);

        this._toolbar.add_child(actionRow);

        // Place at the top-right of the primary monitor.
        Main.layoutManager.uiGroup.add_child(this._toolbar);
        this._toolbar.set_position(
            m.x + m.width - 220 - TOOLBAR_RIGHT_MARGIN,
            m.y + TOOLBAR_TOP_OFFSET);
    }

    _sectionLabel(text) {
        return new St.Label({
            text,
            style_class: 'alpha-annotator-section',
        });
    }

    // ------------------------------------------------------------------
    // Modes
    // ------------------------------------------------------------------

    _setDrawMode(draw) {
        this._drawMode = draw;

        // In pass-through mode the live actor becomes invisible to the
        // picking machinery: clicks land on the desktop windows below while
        // both canvases keep painting the existing strokes.
        this._liveActor.reactive = draw;

        this._modeButton.label = draw ? '✏️  Draw' : '🖱️  Pass-Through';
        this._modeButton.remove_style_class_name('alpha-mode-draw');
        this._modeButton.remove_style_class_name('alpha-mode-pass');
        this._modeButton.add_style_class_name(draw ? 'alpha-mode-draw' : 'alpha-mode-pass');
    }

    /** Wipe the Cairo contexts and request a redraw of both layers. */
    clear() {
        this._strokes = [];
        this._activeStroke = null;
        if (this._committedCanvas)
            this._committedCanvas.invalidate();
        if (this._liveCanvas)
            this._liveCanvas.invalidate();
    }

    // ------------------------------------------------------------------
    // Pointer input — freehand drawing
    // ------------------------------------------------------------------

    _onPress(event) {
        if (!this._drawMode || event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;

        const [sx, sy] = event.get_coords();
        this._activeStroke = {
            color: this._color,
            width: this._width,
            points: [this._localPoint(sx, sy)],
        };

        // Capture the pointer for the whole stroke (Wayland-safe).
        this._drawGrab = this._beginGrab(this._liveActor);

        this._liveCanvas.invalidate();
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._activeStroke)
            return Clutter.EVENT_PROPAGATE;

        const [sx, sy] = event.get_coords();
        const p = this._localPoint(sx, sy);
        const pts = this._activeStroke.points;
        const last = pts[pts.length - 1];

        const dx = p.x - last.x;
        const dy = p.y - last.y;
        if (dx * dx + dy * dy < MIN_POINT_DIST * MIN_POINT_DIST)
            return Clutter.EVENT_STOP;

        pts.push(p);
        this._liveCanvas.invalidate();
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        if (!this._activeStroke)
            return Clutter.EVENT_PROPAGATE;

        this._endGrab(this._drawGrab);
        this._drawGrab = null;

        // Commit: the finished stroke moves to the bottom canvas; the live
        // canvas goes back to empty. Strokes survive mode switches.
        this._strokes.push(this._activeStroke);
        this._activeStroke = null;

        this._committedCanvas.invalidate();
        this._liveCanvas.invalidate();
        return Clutter.EVENT_STOP;
    }

    _localPoint(stageX, stageY) {
        const m = this._monitor;
        return {x: stageX - m.x, y: stageY - m.y};
    }

    // ------------------------------------------------------------------
    // Toolbar dragging
    // ------------------------------------------------------------------

    _onHandlePress(event) {
        if (event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;

        const [sx, sy] = event.get_coords();
        this._dragStart = {
            sx,
            sy,
            tx: this._toolbar.x,
            ty: this._toolbar.y,
        };
        this._dragGrab = this._beginGrab(this._toolbar);
        return Clutter.EVENT_STOP;
    }

    _onHandleMotion(event) {
        if (!this._dragStart)
            return Clutter.EVENT_PROPAGATE;

        const [sx, sy] = event.get_coords();
        const nx = this._dragStart.tx + (sx - this._dragStart.sx);
        const ny = this._dragStart.ty + (sy - this._dragStart.sy);
        this._toolbar.set_position(...this._clampToolbar(nx, ny));
        return Clutter.EVENT_STOP;
    }

    _onHandleRelease(event) {
        if (!this._dragStart)
            return Clutter.EVENT_PROPAGATE;

        this._dragStart = null;
        this._endGrab(this._dragGrab);
        this._dragGrab = null;
        return Clutter.EVENT_STOP;
    }

    _clampToolbar(x, y) {
        const m = this._monitor;
        const w = this._toolbar.width;
        const h = this._toolbar.height;
        return [
            Math.min(Math.max(x, m.x), m.x + m.width - w),
            Math.min(Math.max(y, m.y), m.y + m.height - h),
        ];
    }

    // ------------------------------------------------------------------
    // Cairo rendering
    // ------------------------------------------------------------------

    _onCommittedDraw(canvas, cr) {
        this._clearContext(cr);
        for (const stroke of this._strokes)
            this._paintStroke(cr, stroke);
    }

    _onLiveDraw(canvas, cr) {
        this._clearContext(cr);
        if (this._activeStroke)
            this._paintStroke(cr, this._activeStroke);
    }

    _clearContext(cr) {
        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();
    }

    /**
     * Paint one stroke with quadratic-bezier midpoint smoothing:
     * each interior point becomes a control point whose curve ends at the
     * midpoint towards the next point. Single points render as round dots.
     */
    _paintStroke(cr, stroke) {
        const pts = stroke.points;
        if (pts.length === 0)
            return;

        cr.setSourceRGBA(
            stroke.color.r, stroke.color.g, stroke.color.b, stroke.color.a);
        cr.setLineWidth(stroke.width);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);

        if (pts.length === 1) {
            // A bare click — draw a dot instead of a zero-length line.
            cr.arc(pts[0].x, pts[0].y, stroke.width / 2, 0, 2 * Math.PI);
            cr.fill();
            return;
        }

        cr.moveTo(pts[0].x, pts[0].y);

        if (pts.length === 2) {
            cr.lineTo(pts[1].x, pts[1].y);
        } else {
            let cx = pts[0].x;
            let cy = pts[0].y;
            for (let i = 1; i < pts.length - 1; i++) {
                // Quadratic (current → ctrl=pts[i] → end=midpoint) expressed
                // as the Cairo cubic equivalent.
                const ex = (pts[i].x + pts[i + 1].x) / 2;
                const ey = (pts[i].y + pts[i + 1].y) / 2;
                const c1x = cx + (pts[i].x - cx) * (2 / 3);
                const c1y = cy + (pts[i].y - cy) * (2 / 3);
                const c2x = ex + (pts[i].x - ex) * (2 / 3);
                const c2y = ey + (pts[i].y - ey) * (2 / 3);
                cr.curveTo(c1x, c1y, c2x, c2y, ex, ey);
                cx = ex;
                cy = ey;
            }
            cr.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
        }

        cr.stroke();
    }

    // ------------------------------------------------------------------
    // Grabs, relayout, teardown
    // ------------------------------------------------------------------

    _beginGrab(actor) {
        try {
            return global.stage.grab(actor);
        } catch (e) {
            // Without a grab we still receive events while the pointer is
            // over the (fullscreen) canvas; degrade gracefully.
            console.warn(`[alpha-shell] annotator: stage grab failed: ${e.message}`);
            return null;
        }
    }

    _endGrab(grab) {
        if (grab) {
            try {
                grab.dismiss();
            } catch (e) {
                // Grab already dismissed — nothing to do.
            }
        }
    }

    /** Resize/reposition after monitor changes (resolution, scale, unplug). */
    _relayout() {
        if (!this._active)
            return;

        this._monitor = Main.layoutManager.primaryMonitor;
        const m = this._monitor;

        for (const canvas of [this._committedCanvas, this._liveCanvas])
            canvas.set_size(m.width, m.height);

        for (const actor of [this._committedActor, this._liveActor]) {
            actor.set_position(m.x, m.y);
            actor.set_size(m.width, m.height);
        }

        if (this._toolbar)
            this._toolbar.set_position(
                ...this._clampToolbar(this._toolbar.x, this._toolbar.y));
    }

    _track(object, signal, handler) {
        const id = object.connect(signal, handler);
        this._handlers.push({object, id});
    }

    _teardown() {
        // Release input grabs first so no stray events arrive mid-teardown.
        this._endGrab(this._drawGrab);
        this._drawGrab = null;
        this._endGrab(this._dragGrab);
        this._dragGrab = null;
        this._dragStart = null;

        for (const {object, id} of this._handlers) {
            try {
                object.disconnect(id);
            } catch (e) {
                // Object already destroyed — fine.
            }
        }
        this._handlers = [];

        this._strokes = [];
        this._activeStroke = null;

        if (this._toolbar) {
            this._toolbar.destroy();
            this._toolbar = null;
        }
        this._modeButton = null;
        this._colorButtons = [];
        this._widthButtons = [];

        if (this._liveActor) {
            this._liveActor.destroy();
            this._liveActor = null;
        }
        if (this._committedActor) {
            this._committedActor.destroy();
            this._committedActor = null;
        }
        this._liveCanvas = null;
        this._committedCanvas = null;
    }
}
