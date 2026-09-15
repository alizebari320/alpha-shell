// ui/clipboardAi.js — Clipboard AI.
//
// Acts on whatever is already in the clipboard: translate between
// English / Arabic / Kurdish, fix grammar, summarize, or shorten. The
// result can replace the clipboard in place, which is the point: copy,
// hotkey, paste.
//
// Performance notes
// -----------------
// * The clipboard is read ONCE when the HUD opens. Nothing is polled and
//   no text is retained after close.
// * Action buttons are built once; running an action only swaps label
//   text on the existing actors.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {AlphaOverlay} from './shell.js';

const MAX_INPUT_CHARS = 8000;
const PREVIEW_CHARS = 220;

const ACTIONS = [
    {id: 'en', label: 'English', prompt: t => `Translate the following text into English. Reply with the translation only.\n\n${t}`},
    {id: 'ar', label: '\u0627\u0644\u0639\u0631\u0628\u064a\u0629', prompt: t => `Translate the following text into Arabic. Reply with the translation only.\n\n${t}`},
    {id: 'ku', label: 'Kurd\u00ee', prompt: t => `Translate the following text into Kurdish (Sorani). Reply with the translation only.\n\n${t}`},
    {id: 'grammar', label: 'Fix grammar', prompt: t => `Correct the spelling and grammar of the following text. Keep the original language and meaning. Reply with the corrected text only.\n\n${t}`},
    {id: 'summary', label: 'Summarize', prompt: t => `Summarize the following text in a few short sentences.\n\n${t}`},
    {id: 'short', label: 'Make shorter', prompt: t => `Rewrite the following text to be much shorter while keeping its meaning and language. Reply with the rewritten text only.\n\n${t}`},
];

export class ClipboardAiHud extends AlphaOverlay {
    constructor(path, ai) {
        super({
            path,
            title: 'Clipboard AI',
            hint: 'Acts on your clipboard',
            footer: 'Ctrl+R replace clipboard · Ctrl+C copy result · Esc close',
            width: 640,
            styleClass: 'alpha-clipboard-ai',
        });

        this._ai = ai;
        this._token = 0;
        this._readToken = 0;
        this._source = '';
        this._result = '';
        this._busy = false;
    }

    _build(panel) {
        panel.add_child(new St.Label({style_class: 'alpha-section', text: 'CLIPBOARD'}));

        this._sourceLabel = new St.Label({
            style_class: 'alpha-body-mono',
            text: 'Reading clipboard\u2026',
        });
        this._sourceLabel.clutter_text.line_wrap = true;
        panel.add_child(this._sourceLabel);

        panel.add_child(new St.Label({style_class: 'alpha-section', text: 'ACTION'}));

        const row = new St.BoxLayout({style_class: 'alpha-row-btns'});
        for (const action of ACTIONS) {
            const button = new St.Button({
                style_class: 'alpha-chip',
                label: action.label,
                can_focus: false,
            });
            this._connect(button, 'clicked', () => this._run(action));
            row.add_child(button);
        }
        panel.add_child(row);

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
    }

    _onOpened() {
        // Dedicated read token: running an action must not invalidate the
        // initial clipboard read, or the preview stays "Reading clipboard…"
        // forever. Only closing/reopening the HUD does.
        const token = ++this._readToken;
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_cb, text) => {
            if (token !== this._readToken || !this._sourceLabel)
                return;

            this._source = (text ?? '').slice(0, MAX_INPUT_CHARS);
            this._sourceLabel.text = this._source
                ? this._preview(this._source)
                : 'Clipboard is empty \u2014 copy some text first';
        });
    }

    _onClosing() {
        this._token++;
        this._readToken++;
        this._source = '';
        this._result = '';
        this._busy = false;
    }

    _preview(text) {
        const oneLine = text.replace(/\s+/g, ' ').trim();
        return oneLine.length > PREVIEW_CHARS
            ? `${oneLine.slice(0, PREVIEW_CHARS)}\u2026`
            : oneLine;
    }

    async _run(action) {
        if (!this._source || this._busy)
            return;

        const token = ++this._token;
        this._busy = true;
        this._setStatus(`${action.label}\u2026`);

        try {
            const reply = await this._ai.ask(action.prompt(this._source));
            if (token !== this._token || !this._body)
                return;
            this._show(reply, false);
        } catch (e) {
            if (token !== this._token || !this._body)
                return;
            this._show(e?.message ?? String(e), true);
        } finally {
            if (token === this._token)
                this._busy = false;
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
        this._result = isError ? '' : text;
        this._body.text = text;
        this._body.style_class = isError ? 'alpha-body-error' : 'alpha-body';
        this._scroll.visible = true;
    }

    _onKeyPress(symbol, event) {
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (!ctrl || !this._result)
            return Clutter.EVENT_PROPAGATE;

        switch (symbol) {
        case Clutter.KEY_c:
        case Clutter.KEY_C:
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._result);
            this._setStatus('Copied');
            return Clutter.EVENT_STOP;

        case Clutter.KEY_r:
        case Clutter.KEY_R:
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._result);
            this._setStatus('Clipboard replaced');
            this.deferClose();
            return Clutter.EVENT_STOP;

        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }
}
