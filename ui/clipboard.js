// ui/clipboard.js — ALPHA Clipboard History.
//
// Two pieces:
//   ClipboardStore     headless capture + bounded history (lives for the
//                      lifetime of the extension)
//   ClipboardHistoryHud the searchable HUD (created on demand, destroyed
//                      on close)
//
// Performance notes
// -----------------
// * Capture is EVENT-DRIVEN. GNOME exposes the display selection as a
//   Meta.Selection that emits 'owner-changed' whenever the clipboard owner
//   changes, so there is no polling timer anywhere in this feature. Idle
//   cost is a single connected signal.
// * History is hard-capped and pinned items are never evicted, so the
//   array cannot grow without bound.
// * Oversized clips are skipped outright — a 40MB copy must never become
//   40MB of resident shell memory.
// * The HUD renders at most MAX_ROWS actors and REUSES them while typing
//   instead of rebuilding the list.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {AlphaOverlay} from './shell.js';

const MAX_ENTRIES = 40;      // total remembered clips
const MAX_ROWS = 12;         // rendered rows (matches the Launcher cap)
const MAX_TEXT_BYTES = 64 * 1024;
const DEBOUNCE_MS = 120;
const PREVIEW_CHARS = 120;

function _preview(text) {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > PREVIEW_CHARS
        ? `${oneLine.slice(0, PREVIEW_CHARS)}\u2026`
        : oneLine;
}

function _describe(text) {
    const lines = text.split('\n').length;
    const chars = text.length;
    return lines > 1 ? `${lines} lines · ${chars} chars` : `${chars} chars`;
}

/** Headless clipboard capture with a bounded history. */
export class ClipboardStore {
    constructor() {
        this._entries = [];   // [{text, pinned, at}] newest first
        this._selection = null;
        this._ownerChangedId = 0;
        this._clipboard = St.Clipboard.get_default();
    }

    get entries() {
        return this._entries;
    }

    /** Start listening. Called once from the extension's enable(). */
    enable() {
        if (this._ownerChangedId)
            return;

        try {
            this._selection = global.display.get_selection();
            this._ownerChangedId = this._selection.connect('owner-changed',
                (_sel, type) => {
                    if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                        this._capture();
                });
        } catch (e) {
            console.warn(`[alpha-shell] clipboard capture unavailable: ${e.message}`);
        }
    }

    disable() {
        if (this._selection && this._ownerChangedId) {
            try {
                this._selection.disconnect(this._ownerChangedId);
            } catch (e) {
                // Already finalized — fine.
            }
        }
        this._ownerChangedId = 0;
        this._selection = null;
        this._entries = [];
    }

    /** Read the clipboard asynchronously and record it. */
    _capture() {
        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_cb, text) => {
            if (!text || !text.trim())
                return;

            // Skip pathological clips rather than caching them.
            if (text.length > MAX_TEXT_BYTES)
                return;

            this.add(text);
        });
    }

    add(text) {
        const existing = this._entries.findIndex(e => e.text === text);
        if (existing !== -1) {
            // Deduplicate: promote instead of appending.
            const [entry] = this._entries.splice(existing, 1);
            entry.at = GLib.DateTime.new_now_local().to_unix();
            this._entries.unshift(entry);
            return;
        }

        this._entries.unshift({
            text,
            pinned: false,
            at: GLib.DateTime.new_now_local().to_unix(),
        });

        this._evict();
    }

    /** Drop the oldest unpinned entries past the cap. */
    _evict() {
        if (this._entries.length <= MAX_ENTRIES)
            return;

        for (let i = this._entries.length - 1; i >= 0 && this._entries.length > MAX_ENTRIES; i--) {
            if (!this._entries[i].pinned)
                this._entries.splice(i, 1);
        }
    }

    togglePin(entry) {
        entry.pinned = !entry.pinned;
        this._sort();
    }

    remove(entry) {
        const index = this._entries.indexOf(entry);
        if (index !== -1)
            this._entries.splice(index, 1);
    }

    clear() {
        this._entries = this._entries.filter(e => e.pinned);
    }

    /** Pinned first, then most recent. */
    _sort() {
        this._entries.sort((a, b) => {
            if (a.pinned !== b.pinned)
                return a.pinned ? -1 : 1;
            return b.at - a.at;
        });
    }

    search(query) {
        this._sort();
        if (!query)
            return this._entries.slice(0, MAX_ROWS);

        const needle = query.toLowerCase();
        return this._entries
            .filter(e => e.text.toLowerCase().includes(needle))
            .slice(0, MAX_ROWS);
    }

    copy(entry) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, entry.text);
    }
}

/** The searchable clipboard HUD. */
export class ClipboardHistoryHud extends AlphaOverlay {
    constructor(path, store) {
        super({
            path,
            title: 'ALPHA Clipboard',
            hint: 'History',
            footer: '\u2191\u2193 navigate · ⏎ copy · Ctrl+P pin · Del remove · Esc close',
            width: 640,
            styleClass: 'alpha-clipboard',
        });

        this._store = store;
        this._results = [];
        this._rows = [];
        this._selected = 0;
        this._debounceId = 0;
    }

    _build(panel) {
        this._entry = new St.Entry({
            style_class: 'alpha-entry',
            hint_text: 'Search clipboard history\u2026',
            can_focus: true,
            x_expand: true,
        });
        panel.add_child(this._entry);

        this._scroll = new St.ScrollView({
            style_class: 'alpha-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            y_expand: true,
        });
        this._list = new St.BoxLayout({
            style_class: 'alpha-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._scroll.set_child(this._list);
        panel.add_child(this._scroll);

        this._empty = new St.Label({
            text: 'Clipboard history is empty \u2014 copy something first',
            style_class: 'alpha-empty',
        });
        panel.add_child(this._empty);

        // Build the row actors ONCE; _render() only updates them.
        for (let i = 0; i < MAX_ROWS; i++)
            this._list.add_child(this._makeRow(i));

        this._connect(this._entry.clutter_text, 'text-changed', () => this._onTextChanged());
    }

    _makeRow(index) {
        // St.Button takes a single child, so icon + labels go in a BoxLayout.
        const label = new St.Label({style_class: 'alpha-row-label', x_expand: true});
        const sub = new St.Label({style_class: 'alpha-row-sub'});
        const pin = new St.Label({style_class: 'alpha-row-pin', text: ''});

        const box = new St.BoxLayout({style_class: 'alpha-row-box'});
        box.add_child(pin);
        box.add_child(label);
        box.add_child(sub);

        const button = new St.Button({
            style_class: 'alpha-row',
            can_focus: false,
            x_expand: true,
            child: box,
        });

        this._connect(button, 'clicked', () => {
            this._selected = index;
            this._activate();
        });
        this._connect(button, 'notify::hover', () => {
            if (button.hover && index < this._results.length)
                this._select(index);
        });

        this._rows.push({button, label, sub, pin});
        return button;
    }

    _onOpened() {
        global.stage.set_key_focus(this._entry.clutter_text);
        this._refresh('');
    }

    _onClosing() {
        this._clearTimeout(this._debounceId);
        this._debounceId = 0;
        this._rows = [];
        this._results = [];
    }

    /** 120ms debounce so fast typing does not re-filter per keystroke. */
    _onTextChanged() {
        this._clearTimeout(this._debounceId);
        this._debounceId = this._timeout(DEBOUNCE_MS, () => {
            this._debounceId = 0;
            if (this._entry)
                this._refresh(this._entry.get_text());
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh(query) {
        this._results = this._store.search(query);
        this._selected = 0;
        this._render();
    }

    _render() {
        const count = this._results.length;

        this._empty.visible = count === 0;
        this._scroll.visible = count > 0;
        if (count === 0)
            this._empty.text = this._entry.get_text()
                ? 'No clips found \u2014 try another search'
                : 'Clipboard history is empty \u2014 copy something first';

        this._rows.forEach((row, i) => {
            const entry = this._results[i];
            if (!entry) {
                row.button.visible = false;
                return;
            }

            row.button.visible = true;
            row.label.text = _preview(entry.text);
            row.sub.text = _describe(entry.text);
            row.pin.text = entry.pinned ? '\u2605' : '';

            if (i === this._selected)
                row.button.add_style_class_name('selected');
            else
                row.button.remove_style_class_name('selected');
        });
    }

    _select(index) {
        if (!this._results.length)
            return;
        const count = this._results.length;
        this._selected = ((index % count) + count) % count;
        this._render();
    }

    _activate() {
        const entry = this._results[this._selected];
        if (!entry)
            return;
        this._store.copy(entry);
        // Never tear down inside the emission that triggered this.
        this.deferClose();
    }

    _onKeyPress(symbol, event) {
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const entry = this._results[this._selected];

        switch (symbol) {
        case Clutter.KEY_Down:
            this._select(this._selected + 1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Up:
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            this._activate();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_p:
        case Clutter.KEY_P:
            if (ctrl && entry) {
                this._store.togglePin(entry);
                this._refresh(this._entry.get_text());
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;

        case Clutter.KEY_Delete:
        case Clutter.KEY_KP_Delete:
            if (ctrl && shift)
                this._store.clear();
            else if (entry)
                this._store.remove(entry);
            this._refresh(this._entry.get_text());
            return Clutter.EVENT_STOP;

        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }
}
