// Safe command execution workflow.
//
// The AI may *suggest* a shell command, but it must NEVER run one on its own.
// A suggested command is returned to the UI, shown to the user, and only
// executed after an explicit confirmation. Until a real provider is wired,
// nothing here touches the shell.

import GLib from 'gi://GLib';

export class CommandApprover {
    constructor() {
        this.pending = null;
    }

    // Package an AI-suggested command for the UI to display.
    propose(command, context = '') {
        this.pending = {
            command,
            context,
            status: 'proposed', // proposed -> approved -> executed
            proposedAt: GLib.DateTime.new_now_local().to_unix(),
        };
        return this.pending;
    }

    // Explicit user confirmation required before anything runs.
    approve() {
        if (!this.pending) return null;
        this.pending.status = 'approved';
        return this.pending;
    }

    // The actual execution is intentionally NOT implemented.
    // It will land here only when we add a real provider and a real,
    // sandboxed execution path (and explicit user consent).
    executeApproved() {
        throw new Error('Command execution is not implemented yet (safety gate).');
    }

    clear() {
        this.pending = null;
    }
}