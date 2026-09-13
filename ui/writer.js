// ALPHA Writer — a screen annotation & handwriting tool of the ALPHA Shell toolset.
//
// A fully self-contained drawing layer: enable()/disable()/destroy() are
// the only lifecycle surface the extension needs, and the writer never
// touches other tools or their state.
//
// Tools:
//   pen          freehand strokes, quadratic-bézier midpoint smoothing
//   highlighter  wide, translucent, square-cap ink for emphasis
//   eraser       stroke-level erase (whole strokes vanish under the pointer)
//   line/arrow/rect/ellipse  drag-from-to shapes, crisp Cairo rendering
//   text         click, type into an inline entry, Enter places the label
//
// Keyboard (active in Draw mode, where the canvas holds shell key focus):
//   1..8        select tool
//   Ctrl+Z      undo          Ctrl+Shift+Z / Ctrl+Y  redo
//   Escape      cancel text entry, or quit the tool
//
// Architecture (performance & Wayland notes):
//
//  * Two stacked transparent St.DrawingArea canvases are placed on
//    Main.layoutManager.uiGroup, above all desktop windows:
//      - "committed" canvas: holds all finished strokes. It is invalidated
//        exactly once per stroke completion, never during motion.
//      - "live" canvas: the event surface. While a stroke is in progress it
//        replays ONLY the active stroke, so per-frame cost is O(active
//        stroke), never O(session history). Long handwriting sessions stay
//        at constant frame cost — no main-thread stalls.
//
//  * Pass-through mode sets reactive = false on the live actor (and drops
//    key focus). Clutter picking skips non-reactive actors, so every click
//    falls through to the desktop apps underneath — while both canvases
//    keep painting the strokes 100% visibly. Strokes survive mode toggles;
//    they are only dropped by Clear, Undo or quitting the tool.
//
//  * Undo/redo keeps snapshot stacks of the stroke list (capped). Every
//    mutating action — stroke commit, text commit, eraser drag (once per
//    drag, taken before the first removal), clear — pushes a snapshot.
//
//  * Pointer capture during a stroke uses global.stage.grab() (Clutter.Grab),
//    the same mechanism GNOME Shell uses for its own popup menus. This is
//    Wayland-safe (no X grabs) and guarantees we receive motion/release even
//    when the pointer crosses the toolbar. Every grab is dismissed on
//    button-release AND during teardown, so no grab can leak.
//
//  * Every signal connection is registered through _track() (or tracked
//    locally for the transient text entry) and disconnected on teardown.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Cairo from 'gi://cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TOOLBAR_RIGHT_MARGIN = 24;
const TOOLBAR_TOP_OFFSET = 80;
const TOOLBAR_WIDTH = 232;
const MIN_POINT_DIST = 1.5;  // px — skip micro-jitter points to bound stroke size
const SHAPE_MIN_DRAG = 4;    // px — a click shorter than this is not a shape
const ERASER_PAD = 8;        // px — hit-testing slack around stroke ink
const MAX_HISTORY = 100;     // undo snapshots kept

// Preset ink colors (Neon Green, Cyan, Red, White).
const COLORS = [
    {name: 'Neon Green', css: '#2bff88', rgba: {r: 0.169, g: 1.0, b: 0.533, a: 0.95}},
    {name: 'Cyan',       css: '#33d6ff', rgba: {r: 0.2,   g: 0.839, b: 1.0,   a: 0.95}},
    {name: 'Red',        css: '#ff4757', rgba: {r: 1.0,   g: 0.278, b: 0.341, a: 0.95}},
    {name: 'White',      css: '#ffffff', rgba: {r: 1.0,   g: 1.0,   b: 1.0,   a: 0.95}},
];

// Stroke width presets in logical pixels. For the text tool these map to
// font sizes below.
const WIDTHS = [2, 4, 8, 16];
const TEXT_SIZES = {2: 24, 4: 36, 8: 54, 16: 78};

// Toolbar tool buttons, in keyboard-selection order (1..8).
const TOOLS = [
    {id: 'pen',         label: '✏️'},
    {id: 'highlighter', label: '🖍'},
    {id: 'eraser',      label: '🧽'},
    {id: 'line',        label: '╱'},
    {id: 'arrow',       label: '→'},
    {id: 'rect',        label: '▭'},
    {id: 'ellipse',     label: '◯'},
    {id: 'text',        label: 'T'},
];
const TOOL_KEYS = [
    Clutter.KEY_1, Clutter.KEY_2, Clutter.KEY_3, Clutter.KEY_4,
    Clutter.KEY_5, Clutter.KEY_6, Clutter.KEY_7, Clutter.KEY_8,
];

export class Writer {
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
        this._tool = 'pen';
        this._strokes = [];          // finished items: {type, color, width, points|from/to|at+text+size}
        this._activeStroke = null;   // item currently under the pointer
        this._color = COLORS[0].rgba;
        this._width = WIDTHS[1];

        // Undo / redo (snapshots of this._strokes)
        this._undoStack = [];
        this._redoStack = [];

        // Eraser drag state
        this._erasing = false;
        this._eraseDirty = false;

        // Text tool: {entry, at, handlers} while the inline entry is open
        this._textEntry = null;

        // Toolbar widgets
        this._modeButton = null;
        this._colorButtons = [];
        this._widthButtons = [];
        this._toolButtons = new Map();

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

    /** Build the actors and start writing (defaults to pen in Draw mode). */
    enable() {
        if (this._active || this._destroyed)
            return;

        this._active = true;

        try {
            this._monitor = Main.layoutManager.primaryMonitor;
            this._buildCanvases();
            this._buildToolbar();

            this._track(Main.layoutManager, 'monitors-changed',
                () => this._relayout());

            this._setDrawMode(true);
        } catch (e) {
            // A half-built writer must never be left behind: either the
            // full tool is on screen or nothing is.
            console.error(`[alpha-shell] writer failed to enable: ${e.message}\n${e.stack}`);
            this._active = false;
            this._teardown();
            return;
        }

        console.log('[alpha-shell] ALPHA Writer enabled');
    }

    /** Quit the tool: tears down actors, drops strokes, releases grabs. */
    disable() {
        if (!this._active)
            return;

        this._active = false;
        this._teardown();
        console.log('[alpha-shell] ALPHA Writer disabled');
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

        // Bottom layer: finished strokes. (Never an event surface.)
        // GNOME 50 removed Clutter.Canvas, so the drawing surface is an
        // St.DrawingArea that doubles as the actor itself.
        // NOTE: St.DrawingArea's 'repaint' signal passes ONLY the area —
        // the Cairo context is fetched via get_context() inside the handler
        // (unlike the removed Clutter.Canvas 'draw' signal, which passed cr).
        this._committedCanvas = this._makeCanvas(
            a => this._onCommittedDraw(a));
        this._committedActor = this._committedCanvas;
        this._committedActor.name = 'alphaWriterCommitted';
        this._committedActor.reactive = false;
        this._committedActor.set_position(m.x, m.y);

        // Top layer: live item + event surface + key focus for shortcuts.
        this._liveCanvas = this._makeCanvas(
            a => this._onLiveDraw(a));
        this._liveActor = this._liveCanvas;
        this._liveActor.name = 'alphaWriterLive';
        this._liveActor.reactive = true;
        this._liveActor.can_focus = true;
        this._liveActor.set_position(m.x, m.y);

        // Pointer events. The stage grab started in _onPress routes
        // motion/release here even outside actor bounds.
        this._track(this._liveActor, 'button-press-event',
            (a, e) => this._onPress(e));
        this._track(this._liveActor, 'motion-event',
            (a, e) => this._onMotion(e));
        this._track(this._liveActor, 'button-release-event',
            (a, e) => this._onRelease(e));

        // Keyboard shortcuts (only delivered while the canvas holds key
        // focus, i.e. in Draw mode).
        this._track(this._liveActor, 'key-press-event',
            (a, e) => this._onKeyPress(e));

        const uiGroup = Main.layoutManager.uiGroup;
        uiGroup.add_child(this._committedActor);
        uiGroup.add_child(this._liveActor);
        // Canvas actors are added before the toolbar, so the toolbar paints
        // and picks above them (uiGroup children are stacked in add order).
    }

    /** Build one transparent drawing surface covering the monitor.
     *  St.DrawingArea is the GNOME 50 replacement for the removed
     *  Clutter.Canvas. It pre-scales its Cairo context for HiDPI itself,
     *  so we keep working in logical (stage) coordinates everywhere. */
    _makeCanvas(onDraw) {
        const m = this._monitor;
        const area = new St.DrawingArea({
            width: m.width,
            height: m.height,
        });
        this._track(area, 'repaint', onDraw);
        return area;
    }

    _buildToolbar() {
        const m = this._monitor;

        this._toolbar = new St.BoxLayout({
            name: 'alphaWriterToolbar',
            style_class: 'alpha-writer-toolbar',
            vertical: true,
            reactive: true, // stays interactive in pass-through mode
        });

        // --- Drag handle ------------------------------------------------
        const handle = new St.BoxLayout({
            style_class: 'alpha-writer-drag',
            reactive: true,
        });
        handle.add_child(new St.Label({text: '⠿'}));
        handle.add_child(new St.Label({text: 'ALPHA Writer'}));

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
            style_class: 'alpha-writer-btn alpha-writer-mode alpha-mode-draw',
            x_expand: true,
        });
        this._track(this._modeButton, 'clicked',
            () => this._setDrawMode(!this._drawMode));
        this._toolbar.add_child(this._modeButton);

        // --- Tools (2 rows x 4) ------------------------------------------
        this._toolbar.add_child(this._sectionLabel('Tool'));

        for (let row = 0; row < 2; row++) {
            const toolRow = new St.BoxLayout({style_class: 'alpha-writer-row'});
            for (let col = 0; col < 4; col++) {
                const tool = TOOLS[row * 4 + col];
                const btn = new St.Button({
                    label: tool.label,
                    style_class: 'alpha-writer-btn alpha-writer-tool-btn',
                });
                this._track(btn, 'clicked', () => this._setTool(tool.id));
                if (tool.id === this._tool)
                    btn.add_style_class_name('selected');
                this._toolButtons.set(tool.id, btn);
                toolRow.add_child(btn);
            }
            this._toolbar.add_child(toolRow);
        }

        // --- Colors -----------------------------------------------------
        this._toolbar.add_child(
            this._sectionLabel('Color'));

        const colorRow = new St.BoxLayout({style_class: 'alpha-writer-row'});
        this._colorButtons = COLORS.map((color, index) => {
            const chip = new St.Button({
                style_class: 'alpha-writer-chip',
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

        // --- Width / text size -------------------------------------------
        this._toolbar.add_child(
            this._sectionLabel('Width / Size'));

        const widthRow = new St.BoxLayout({style_class: 'alpha-writer-row'});
        this._widthButtons = WIDTHS.map((width, index) => {
            const btn = new St.Button({
                label: String(width),
                style_class: 'alpha-writer-btn alpha-writer-width-btn',
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

        // --- Undo / Redo --------------------------------------------------
        const historyRow = new St.BoxLayout({style_class: 'alpha-writer-row'});

        const undoBtn = new St.Button({
            label: '↩  Undo',
            style_class: 'alpha-writer-btn alpha-writer-undo-btn',
            x_expand: true,
        });
        this._track(undoBtn, 'clicked', () => this.undo());
        historyRow.add_child(undoBtn);

        const redoBtn = new St.Button({
            label: '↪  Redo',
            style_class: 'alpha-writer-btn alpha-writer-redo-btn',
            x_expand: true,
        });
        this._track(redoBtn, 'clicked', () => this.redo());
        historyRow.add_child(redoBtn);

        this._toolbar.add_child(historyRow);

        // --- Clear / Close ------------------------------------------------
        const actionRow = new St.BoxLayout({style_class: 'alpha-writer-row'});

        const clearBtn = new St.Button({
            label: '🗑  Clear',
            style_class: 'alpha-writer-btn alpha-writer-clear',
            x_expand: true,
        });
        this._track(clearBtn, 'clicked', () => this.clear());
        actionRow.add_child(clearBtn);

        const closeBtn = new St.Button({
            label: '✕',
            style_class: 'alpha-writer-btn alpha-writer-close',
        });
        this._track(closeBtn, 'clicked', () => this.disable());
        actionRow.add_child(closeBtn);

        this._toolbar.add_child(actionRow);

        // Place at the top-right of the primary monitor.
        Main.layoutManager.uiGroup.add_child(this._toolbar);
        this._toolbar.set_position(
            m.x + m.width - TOOLBAR_WIDTH - TOOLBAR_RIGHT_MARGIN,
            m.y + TOOLBAR_TOP_OFFSET);
    }

    _sectionLabel(text) {
        return new St.Label({
            text,
            style_class: 'alpha-writer-section',
        });
    }

    // ------------------------------------------------------------------
    // Modes & tools
    // ------------------------------------------------------------------

    _setDrawMode(draw) {
        this._drawMode = draw;

        if (this._textEntry)
            this._cancelText();

        // In pass-through mode the live actor becomes invisible to the
        // picking machinery: clicks land on the desktop windows below while
        // both canvases keep painting the existing strokes. Key focus is
        // dropped as well so the apps receive keyboard input again.
        this._liveActor.reactive = draw;
        global.stage.set_key_focus(draw ? this._liveActor : null);

        this._modeButton.label = draw ? '✏️  Draw' : '🖱️  Pass-Through';
        this._modeButton.remove_style_class_name('alpha-mode-draw');
        this._modeButton.remove_style_class_name('alpha-mode-pass');
        this._modeButton.add_style_class_name(draw ? 'alpha-mode-draw' : 'alpha-mode-pass');
    }

    _setTool(tool) {
        if (this._textEntry)
            this._cancelText();

        this._tool = tool;
        for (const [id, btn] of this._toolButtons) {
            btn.remove_style_class_name('selected');
            if (id === tool)
                btn.add_style_class_name('selected');
        }
    }

    // ------------------------------------------------------------------
    // History (undo / redo)
    // ------------------------------------------------------------------

    _snapshot() {
        return this._strokes.map(s => {
            const c = {...s};
            if (c.points)
                c.points = c.points.map(p => ({x: p.x, y: p.y}));
            if (c.from)
                c.from = {...c.from};
            if (c.to)
                c.to = {...c.to};
            if (c.at)
                c.at = {...c.at};
            return c;
        });
    }

    /** Push the current state as an undo point and drop the redo stack. */
    _pushHistory() {
        this._undoStack.push(this._snapshot());
        if (this._undoStack.length > MAX_HISTORY)
            this._undoStack.shift();
        this._redoStack = [];
    }

    undo() {
        if (!this._undoStack.length)
            return;

        this._redoStack.push(this._snapshot());
        this._strokes = this._undoStack.pop();
        this._repaint();
    }

    redo() {
        if (!this._redoStack.length)
            return;

        this._undoStack.push(this._snapshot());
        this._strokes = this._redoStack.pop();
        this._repaint();
    }

    /** Wipe the canvas (undoable). */
    clear() {
        if (!this._strokes.length && !this._activeStroke)
            return;

        this._pushHistory();
        this._strokes = [];
        this._activeStroke = null;
        this._repaint();
    }

    _repaint() {
        if (this._committedCanvas)
            this._committedCanvas.queue_repaint();
        if (this._liveCanvas)
            this._liveCanvas.queue_repaint();
    }

    // ------------------------------------------------------------------
    // Pointer input — dispatch by tool
    // ------------------------------------------------------------------

    _onPress(event) {
        if (!this._drawMode || event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;

        // Any canvas press closes a pending text entry first.
        if (this._textEntry)
            this._cancelText();

        const [sx, sy] = event.get_coords();
        const p = this._localPoint(sx, sy);

        if (this._tool === 'text') {
            this._beginTextInput(p);
            return Clutter.EVENT_STOP;
        }

        if (this._tool === 'eraser') {
            this._erasing = true;
            this._eraseDirty = false;
            this._eraseAt(p);
        } else if (this._tool === 'pen' || this._tool === 'highlighter') {
            this._activeStroke = {
                type: this._tool,
                color: this._color,
                width: this._width,
                points: [p],
            };
        } else {
            // Shapes: from/to drag model.
            this._activeStroke = {
                type: this._tool,
                color: this._color,
                width: this._width,
                from: p,
                to: {x: p.x, y: p.y},
            };
        }

        // Capture the pointer for the whole gesture (Wayland-safe).
        this._drawGrab = this._beginGrab(this._liveActor);

        this._liveCanvas.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const [sx, sy] = event.get_coords();
        const p = this._localPoint(sx, sy);

        if (this._erasing) {
            this._eraseAt(p);
            return Clutter.EVENT_STOP;
        }

        if (!this._activeStroke)
            return Clutter.EVENT_PROPAGATE;

        if (this._activeStroke.points) {
            // Freehand: append points, skipping micro-jitter.
            const pts = this._activeStroke.points;
            const last = pts[pts.length - 1];
            const dx = p.x - last.x;
            const dy = p.y - last.y;
            if (dx * dx + dy * dy < MIN_POINT_DIST * MIN_POINT_DIST)
                return Clutter.EVENT_STOP;
            pts.push(p);
        } else {
            // Shape: just move the endpoint.
            this._activeStroke.to = p;
        }

        this._liveCanvas.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        if (this._erasing) {
            this._erasing = false;
            this._eraseDirty = false;
            this._endGrab(this._drawGrab);
            this._drawGrab = null;
            return Clutter.EVENT_STOP;
        }

        if (!this._activeStroke)
            return Clutter.EVENT_PROPAGATE;

        this._endGrab(this._drawGrab);
        this._drawGrab = null;

        const s = this._activeStroke;
        this._activeStroke = null;

        if (s.points) {
            // Freehand: a bare click stays a dot, never an empty stroke.
            if (s.points.length === 0) {
                this._liveCanvas.queue_repaint();
                return Clutter.EVENT_STOP;
            }
        } else {
            // Shape: a click without a drag is discarded.
            const d = Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y);
            if (d < SHAPE_MIN_DRAG) {
                this._liveCanvas.queue_repaint();
                return Clutter.EVENT_STOP;
            }
        }

        // Commit: the finished item moves to the bottom canvas; the live
        // canvas goes back to empty. Strokes survive mode switches.
        this._pushHistory();
        this._strokes.push(s);

        this._repaint();
        return Clutter.EVENT_STOP;
    }

    _localPoint(stageX, stageY) {
        const m = this._monitor;
        return {x: stageX - m.x, y: stageY - m.y};
    }

    // ------------------------------------------------------------------
    // Keyboard shortcuts (canvas key focus, Draw mode only)
    // ------------------------------------------------------------------

    _onKeyPress(event) {
        const keyval = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

        if (ctrl && (keyval === Clutter.KEY_z || keyval === Clutter.KEY_Z)) {
            if (shift)
                this.redo();
            else
                this.undo();
            return Clutter.EVENT_STOP;
        }

        if (ctrl && (keyval === Clutter.KEY_y || keyval === Clutter.KEY_Y)) {
            this.redo();
            return Clutter.EVENT_STOP;
        }

        if (keyval === Clutter.KEY_Escape) {
            if (this._textEntry)
                this._cancelText();
            else
                this.disable();
            return Clutter.EVENT_STOP;
        }

        const toolIndex = TOOL_KEYS.indexOf(keyval);
        if (toolIndex >= 0) {
            this._setTool(TOOLS[toolIndex].id);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // ------------------------------------------------------------------
    // Eraser
    // ------------------------------------------------------------------

    /** Remove every stroke whose ink is under p. The undo snapshot is taken
     *  before the FIRST removal of a drag, so one drag = one undo step. */
    _eraseAt(p) {
        if (!this._strokes.length)
            return;

        const kept = [];
        let removed = false;
        for (const s of this._strokes) {
            if (this._strokeHit(s, p))
                removed = true;
            else
                kept.push(s);
        }
        if (!removed)
            return;

        if (!this._eraseDirty) {
            this._undoStack.push(this._snapshot());
            if (this._undoStack.length > MAX_HISTORY)
                this._undoStack.shift();
            this._redoStack = [];
            this._eraseDirty = true;
        }

        this._strokes = kept;
        this._committedCanvas.queue_repaint();
    }

    /** Rough hit-test of a point against a stroke's ink. */
    _strokeHit(s, p) {
        if (s.type === 'text') {
            const w = s.text.length * s.size * 0.55;
            return p.x >= s.at.x - ERASER_PAD && p.x <= s.at.x + w + ERASER_PAD &&
                   p.y >= s.at.y - ERASER_PAD && p.y <= s.at.y + s.size + ERASER_PAD;
        }

        const ink = this._inkWidth(s) / 2 + ERASER_PAD;

        if (s.type === 'rect') {
            const x0 = Math.min(s.from.x, s.to.x);
            const x1 = Math.max(s.from.x, s.to.x);
            const y0 = Math.min(s.from.y, s.to.y);
            const y1 = Math.max(s.from.y, s.to.y);
            return p.x >= x0 - ink && p.x <= x1 + ink &&
                   p.y >= y0 - ink && p.y <= y1 + ink;
        }

        if (s.type === 'ellipse') {
            const cx = (s.from.x + s.to.x) / 2;
            const cy = (s.from.y + s.to.y) / 2;
            const rx = Math.abs(s.to.x - s.from.x) / 2 + ink || ink;
            const ry = Math.abs(s.to.y - s.from.y) / 2 + ink || ink;
            const nx = (p.x - cx) / rx;
            const ny = (p.y - cy) / ry;
            return nx * nx + ny * ny <= 1;
        }

        // Freehand polylines and lines/arrows: segment distance.
        const segs = s.points
            ? s.points.map((pt, i) => [i === 0 ? pt : s.points[i - 1], pt])
            : [[s.from, s.to]];
        return segs.some(([a, b]) => this._segDist(p, a, b) <= ink);
    }

    _segDist(p, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    }

    _inkWidth(s) {
        return s.type === 'highlighter' ? s.width * 4 : s.width;
    }

    // ------------------------------------------------------------------
    // Text tool — inline entry
    // ------------------------------------------------------------------

    _beginTextInput(p) {
        // Only one entry at a time.
        this._destroyTextEntry();

        const m = this._monitor;
        const entry = new St.Entry({
            style_class: 'alpha-writer-text-entry',
            hint_text: 'Type…  (Enter places · Esc cancels)',
            can_focus: true,
        });

        const ct = entry.clutter_text;
        const handlers = [
            {obj: ct, id: ct.connect('activate', () => this._commitText())},
            {obj: ct, id: ct.connect('key-press-event', (a, e) => {
                if (e.get_key_symbol() === Clutter.KEY_Escape) {
                    this._cancelText();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            })},
        ];

        entry.set_position(m.x + p.x, m.y + p.y);
        Main.layoutManager.uiGroup.add_child(entry);

        this._textEntry = {entry, at: p, handlers};
        ct.grab_key_focus();
    }

    _commitText() {
        const rec = this._textEntry;
        if (!rec)
            return;

        const text = rec.entry.get_text().trim();
        this._destroyTextEntry();

        if (!text)
            return;

        this._pushHistory();
        this._strokes.push({
            type: 'text',
            color: this._color,
            size: TEXT_SIZES[this._width] ?? 36,
            at: rec.at,
            text,
        });
        this._repaint();
    }

    _cancelText() {
        this._destroyTextEntry();
    }

    /** Tear down the entry (no commit) and hand key focus back to the
     *  canvas so shortcuts keep working. */
    _destroyTextEntry() {
        const rec = this._textEntry;
        if (!rec)
            return;

        this._textEntry = null;
        for (const {obj, id} of rec.handlers) {
            try {
                obj.disconnect(id);
            } catch (e) {
                // Object already destroyed — fine.
            }
        }
        try {
            rec.entry.destroy();
        } catch (e) {
            // Already destroyed — fine.
        }

        if (this._active && this._drawMode && this._liveActor)
            global.stage.set_key_focus(this._liveActor);
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

    _onCommittedDraw(area) {
        const cr = area.get_context();
        try {
            this._clearContext(cr);
            for (const stroke of this._strokes)
                this._paintStroke(cr, stroke);
        } finally {
            cr.$dispose();
        }
    }

    _onLiveDraw(area) {
        const cr = area.get_context();
        try {
            this._clearContext(cr);
            if (this._activeStroke)
                this._paintStroke(cr, this._activeStroke);
        } finally {
            cr.$dispose();
        }
    }

    _clearContext(cr) {
        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();
    }

    _paintStroke(cr, s) {
        switch (s.type) {
        case 'text':
            return this._paintText(cr, s);
        case 'line':
        case 'arrow':
            return this._paintLine(cr, s);
        case 'rect':
            return this._paintRect(cr, s);
        case 'ellipse':
            return this._paintEllipse(cr, s);
        case 'highlighter':
            return this._paintFreehand(cr, s, true);
        default:
            return this._paintFreehand(cr, s, false);
        }
    }

    _applyInk(cr, s, alpha = s.color.a, width = s.width,
        cap = Cairo.LineCap.ROUND) {
        cr.setSourceRGBA(s.color.r, s.color.g, s.color.b, alpha);
        cr.setLineWidth(width);
        cr.setLineCap(cap);
        cr.setLineJoin(cap === Cairo.LineCap.BUTT
            ? Cairo.LineJoin.BEVEL
            : Cairo.LineJoin.ROUND);
    }

    /**
     * Paint one freehand stroke with quadratic-bézier midpoint smoothing:
     * each interior point becomes a control point whose curve ends at the
     * midpoint towards the next point. Single points render as round dots.
     */
    _paintFreehand(cr, s, isHighlighter) {
        const pts = s.points;
        if (!pts || pts.length === 0)
            return;

        if (isHighlighter)
            this._applyInk(cr, s, s.color.a * 0.35, s.width * 4, Cairo.LineCap.BUTT);
        else
            this._applyInk(cr, s);

        if (pts.length === 1) {
            // A bare click — draw a dot instead of a zero-length line.
            cr.arc(pts[0].x, pts[0].y, (isHighlighter ? s.width * 4 : s.width) / 2,
                0, 2 * Math.PI);
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

    _paintLine(cr, s) {
        this._applyInk(cr, s);
        cr.moveTo(s.from.x, s.from.y);
        cr.lineTo(s.to.x, s.to.y);
        cr.stroke();

        if (s.type === 'arrow')
            this._paintArrowHead(cr, s);
    }

    _paintArrowHead(cr, s) {
        const angle = Math.atan2(s.to.y - s.from.y, s.to.x - s.from.x);
        const len = Math.max(14, s.width * 3.5);
        const a1 = angle + 0.42 * Math.PI;
        const a2 = angle - 0.42 * Math.PI;

        cr.moveTo(s.to.x + len * Math.cos(a1), s.to.y + len * Math.sin(a1));
        cr.lineTo(s.to.x, s.to.y);
        cr.lineTo(s.to.x + len * Math.cos(a2), s.to.y + len * Math.sin(a2));
        cr.closePath();
        cr.fill();
    }

    _paintRect(cr, s) {
        this._applyInk(cr, s);
        const x = Math.min(s.from.x, s.to.x);
        const y = Math.min(s.from.y, s.to.y);
        cr.rectangle(x, y, Math.abs(s.to.x - s.from.x), Math.abs(s.to.y - s.from.y));
        cr.stroke();
    }

    _paintEllipse(cr, s) {
        this._applyInk(cr, s);
        const cx = (s.from.x + s.to.x) / 2;
        const cy = (s.from.y + s.to.y) / 2;
        const rx = Math.max(Math.abs(s.to.x - s.from.x) / 2, 0.01);
        const ry = Math.max(Math.abs(s.to.y - s.from.y) / 2, 0.01);

        // Build a unit circle under a scale transform, then restore before
        // stroking: the path stays where it was built but the line width
        // is no longer distorted by the scale.
        cr.save();
        cr.translate(cx, cy);
        cr.scale(rx, ry);
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.restore();
        cr.stroke();
    }

    _paintText(cr, s) {
        cr.setSourceRGBA(s.color.r, s.color.g, s.color.b, s.color.a);
        cr.selectFontFace('Sans',
            Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(s.size);
        // The entry's top-left was the click point; place the baseline
        // roughly one ascent below it so the label lands where you typed.
        cr.moveTo(s.at.x, s.at.y + s.size * 0.8);
        cr.showText(s.text);
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
            console.warn(`[alpha-shell] writer: stage grab failed: ${e.message}`);
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

        // A pending text entry would land at stale coordinates — drop it.
        this._cancelText();

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

        // Drop the text entry and key focus before destroying the actors.
        this._destroyTextEntry();
        this._drawMode = false;
        global.stage.set_key_focus(null);

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
        this._undoStack = [];
        this._redoStack = [];
        this._erasing = false;
        this._eraseDirty = false;

        if (this._toolbar) {
            this._toolbar.destroy();
            this._toolbar = null;
        }
        this._modeButton = null;
        this._colorButtons = [];
        this._widthButtons = [];
        this._toolButtons.clear();

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
