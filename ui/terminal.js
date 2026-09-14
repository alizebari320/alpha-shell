// ui/terminal.js — Terminal Assist.
//
// Describe what you want, get the shell command. The command is never
// run on the model's word alone: it goes through CommandApprover in
// ai/safety.js, which requires an explicit approval step first. That
// gate is the whole point of the feature — a hallucinated `rm -rf` must
// be something you have to look at and accept, not something that just
// happens.
//
// Performance notes
// -----------------
// * One HUD, created on open and destroyed on close.
// * The proposed command is a single monospace label that is updated in
//   place, so repeated asks do not accumulate actors.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {AlphaOverlay} from './shell.js';

export class TerminalAssistHud extends AlphaOverlay {
    constructor(path, ai) {
        super({
            path,
            title: 'Terminal Assist',
            hint: 'Review before running',
            footer: '\u23ce generate · Ctrl+C copy command · Esc close',
            width: 640,
            styleClass: 'alpha-terminal',
        });

        this._ai = ai;
        this._token = 0;
        this._command = '';
        this._busy = false;
    }

    _build(panel) {
        this._entry = new St.Entry({
            style_class: 'alpha-entry',
            hint_text: 'Describe what you want to do\u2026',
            can_focus: true,
            x_expand: true,
        });
        panel.add_child(this._entry);

        this._status = new St.Label({style_class: 'alpha-spinner', text: ''});
        this._status.visible = false;
        panel.add_child(this._status);

        this._commandLabel = new St.Label({style_class: 'alpha-body-mono', text: ''});
        this._commandLabel.clutter_text.line_wrap = true;
        this._commandLabel.clutter_text.selectable = true;
        this._commandLabel.visible = false;
        panel.add_child(this._commandLabel);

        // Approval row stays hidden until there is something to approve.
        this._actions = new St.BoxLayout({style_class: 'alpha-row-btns'});
        this._approveButton = new St.Button({
            style_class: 'alpha-btn',
            label: 'Approve & run',
            can_focus: false,
        });
        this._copyButton = new St.Button({
            style_class: 'alpha-btn',
            label: 'Copy',
            can_focus: false,
        });
        this._discardButton = new St.Button({
            style_class: 'alpha-btn alpha-btn-danger',
            label: 'Discard',
            can_focus: false,
        });
        this._actions.add_child(this._approveButton);
        this._actions.add_child(this._copyButton);
        this._actions.add_child(this._discardButton);
        this._actions.visible = false;
        panel.add_child(this._actions);

        this._output = new St.Label({style_class: 'alpha-body', text: ''});
        this._output.clutter_text.line_wrap = true;
        this._output.visible = false;
        panel.add_child(this._output);

        this._connect(this._entry.clutter_text, 'activate', () => this._generate());
        this._connect(this._approveButton, 'clicked', () => this._approveAndRun());
        this._connect(this._copyButton, 'clicked', () => this._copy());
        this._connect(this._discardButton, 'clicked', () => this._discard());
    }

    _onOpened() {
        global.stage.set_key_focus(this._entry.clutter_text);
    }

    _onClosing() {
        this._token++;
        this._busy = false;
        // Drop any pending proposal so nothing survives the HUD.
        try {
            this._ai.approver?.clear();
        } catch (e) {
            // Nothing pending — fine.
        }
    }

    async _generate() {
        const request = this._entry?.get_text()?.trim();
        if (!request || this._busy)
            return;

        const token = ++this._token;
        this._busy = true;
        this._setStatus('Generating\u2026');
        this._setOutput('', false);

        try {
            const command = await this._ai.generateCommand(request);
            if (token !== this._token || !this._commandLabel)
                return;
            this._propose(command, request);
        } catch (e) {
            if (token !== this._token || !this._commandLabel)
                return;
            this._setStatus('');
            this._setOutput(e?.message ?? String(e), true);
        } finally {
            if (token === this._token)
                this._busy = false;
        }
    }

    /** Show the command and register it as a pending proposal. */
    _propose(command, context) {
        this._command = typeof command === 'string' ? command : String(command ?? '');
        this._setStatus('Review this command \u2014 nothing runs until you approve');

        this._commandLabel.text = this._command;
        this._commandLabel.visible = true;
        this._actions.visible = true;

        try {
            this._ai.approver?.propose(this._command, context);
        } catch (e) {
            this._setOutput(e?.message ?? String(e), true);
        }
    }

    _approveAndRun() {
        if (!this._command)
            return;

        try {
            this._ai.approver.approve();
            const result = this._ai.approver.executeApproved();
            this._setStatus('');
            this._setOutput(typeof result === 'string' ? result : 'Command finished', false);
        } catch (e) {
            // The safety gate is still a stub: say so plainly.
            this._setStatus('');
            this._setOutput(e?.message ?? String(e), true);
        }
    }

    _copy() {
        if (!this._command)
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._command);
        this._setStatus('Command copied');
    }

    _discard() {
        this._command = '';
        this._commandLabel.text = '';
        this._commandLabel.visible = false;
        this._actions.visible = false;
        this._setStatus('');
        this._setOutput('', false);

        try {
            this._ai.approver?.clear();
        } catch (e) {
            // Nothing pending — fine.
        }
    }

    _setStatus(text) {
        if (!this._status)
            return;
        this._status.text = text;
        this._status.visible = !!text;
    }

    _setOutput(text, isError) {
        if (!this._output)
            return;
        this._output.text = text;
        this._output.style_class = isError ? 'alpha-body-error' : 'alpha-body';
        this._output.visible = !!text;
    }

    _onKeyPress(symbol, event) {
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;

        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            this._generate();
            return Clutter.EVENT_STOP;
        }

        if (ctrl && (symbol === Clutter.KEY_c || symbol === Clutter.KEY_C)) {
            this._copy();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }
}
