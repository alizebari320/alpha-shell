// ui/ask.js — ALPHA Ask.
//
// The primary AI surface: one keystroke (Super+Space), one prompt, one
// answer, no window.
//
// Performance notes
// -----------------
// * The HUD is created on open and destroyed on close (destroy, never
//   hide), so an unused feature costs zero actors.
// * Every request gets a monotonic token. Late results from a superseded
//   request, or from a request whose HUD has already closed, are dropped.
//   This is the cheap stand-in for cancellation while ai/ai.js is a stub,
//   and it is what prevents a callback from touching a freed actor.
// * The answer is ONE wrapping label, not a label per line.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {AlphaOverlay} from './shell.js';

const MODES = [
    {id: 'ask', label: 'Ask', hint: 'Ask anything'},
    {id: 'summarize', label: 'Summarize', hint: 'Summarize the text'},
    {id: 'code', label: 'Explain code', hint: 'Explain this code'},
];

export class AskHud extends AlphaOverlay {
    /**
     * @param {string} path extension.path
     * @param {object} ai   AIService instance from ai/ai.js
     */
    constructor(path, ai) {
        super({
            path,
            title: 'ALPHA Ask',
            hint: 'Super+Space',
            footer: '\u23ce ask · Tab switch mode · Ctrl+C copy answer · Esc close',
            width: 640,
            styleClass: 'alpha-ask',
        });

        this._ai = ai;
        this._mode = MODES[0].id;
        this._token = 0;
        this._answer = '';
        this._busy = false;
    }

    _build(panel) {
        this._entry = new St.Entry({
            style_class: 'alpha-entry',
            hint_text: MODES[0].hint,
            can_focus: true,
            x_expand: true,
        });
        panel.add_child(this._entry);

        // Mode chips — same selection style as every other ALPHA control.
        this._chipBox = new St.BoxLayout({style_class: 'alpha-row-btns'});
        this._chips = MODES.map(mode => {
            const chip = new St.Button({
                style_class: 'alpha-chip',
                label: mode.label,
                can_focus: false,
            });
            this._connect(chip, 'clicked', () => this._setMode(mode.id));
            this._chipBox.add_child(chip);
            return {id: mode.id, chip};
        });
        panel.add_child(this._chipBox);

        this._status = new St.Label({style_class: 'alpha-spinner', text: ''});
        this._status.visible = false;
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

        this._connect(this._entry.clutter_text, 'activate', () => this._submit());
        this._setMode(this._mode);
    }

    _onOpened() {
        global.stage.set_key_focus(this._entry.clutter_text);
    }

    _onClosing() {
        // Invalidate any in-flight request before the actors go away.
        this._token++;
        this._busy = false;
    }

    _setMode(id) {
        this._mode = id;
        const mode = MODES.find(m => m.id === id) ?? MODES[0];
        if (this._entry)
            this._entry.hint_text = mode.hint;

        for (const {id: chipId, chip} of this._chips) {
            if (chipId === id)
                chip.add_style_class_name('selected');
            else
                chip.remove_style_class_name('selected');
        }
    }

    _cycleMode(backwards = false) {
        const index = MODES.findIndex(m => m.id === this._mode);
        const next = (index + (backwards ? -1 : 1) + MODES.length) % MODES.length;
        this._setMode(MODES[next].id);
    }

    async _submit() {
        const prompt = this._entry?.get_text()?.trim();
        if (!prompt || this._busy)
            return;

        const token = ++this._token;
        this._busy = true;
        this._setStatus('Thinking\u2026');

        try {
            const reply = await this._call(prompt);
            if (token !== this._token || !this._body)
                return; // superseded, or the HUD closed — drop it
            this._show(reply, false);
        } catch (e) {
            if (token !== this._token || !this._body)
                return;
            // ai/ai.js is a stub today: surface the reason, do not crash.
            this._show(e?.message ?? String(e), true);
        } finally {
            if (token === this._token)
                this._busy = false;
        }
    }

    _call(prompt) {
        switch (this._mode) {
        case 'summarize':
            return this._ai.summarize(prompt);
        case 'code':
            return this._ai.explainCode(prompt);
        default:
            return this._ai.ask(prompt);
        }
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

    _copyAnswer() {
        if (!this._answer)
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._answer);
        this._setStatus('Answer copied');
    }

    _onKeyPress(symbol, event) {
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

        switch (symbol) {
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab:
            this._cycleMode(shift);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            this._submit();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_c:
        case Clutter.KEY_C:
            if (ctrl) {
                this._copyAnswer();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;

        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }
}
