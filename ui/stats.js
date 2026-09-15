// ui/stats.js — Panel Stats.
//
// CPU / memory / swap / disk / uptime in the top bar dropdown.
//
// Performance notes
// -----------------
// * THE TIMER ONLY RUNS WHILE THE DROPDOWN IS OPEN. It is created in
//   open-state-changed and removed as soon as the menu closes. A closed
//   menu costs zero timers and zero file reads, which is the whole
//   difference between this and a typical always-polling system monitor.
// * Every read is async (Gio.File.load_contents_async), so the
//   compositor is never blocked on I/O.
// * Rows are created once; a tick only assigns label text.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Brand from './brand.js';

const REFRESH_SECONDS = 3;
const DECODER = new TextDecoder();

function _readFile(path) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(null, (file, result) => {
            try {
                const [, contents] = file.load_contents_finish(result);
                resolve(DECODER.decode(contents));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function _formatBytes(kb) {
    const mb = kb / 1024;
    if (mb < 1024)
        return `${Math.round(mb)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
}

function _formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0)
        return `${d}d ${h}h`;
    if (h > 0)
        return `${h}h ${m}m`;
    return `${m}m`;
}

export const PanelStats = GObject.registerClass({
    GTypeName: 'AlphaPanelStats',
}, class PanelStats extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.5, 'ALPHA Panel Stats', false);

        this._path = extensionPath;
        this._timerId = 0;
        this._prevCpu = null;
        this._rows = new Map();

        // Compact top-bar summary.
        const box = new St.BoxLayout({style_class: 'alpha-stats-button'});
        box.add_child(Brand.mark(extensionPath, 14));
        this._summary = new St.Label({
            style_class: 'alpha-stats-summary',
            text: '\u2014',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._summary);
        this.add_child(box);

        // Dropdown rows, built once.
        for (const [key, label] of [
            ['cpu', 'CPU'],
            ['memory', 'Memory'],
            ['swap', 'Swap'],
            ['disk', 'Disk /'],
            ['uptime', 'Uptime'],
        ]) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
            const name = new St.Label({
                style_class: 'alpha-stats-name',
                text: label,
                x_expand: true,
            });
            const value = new St.Label({style_class: 'alpha-stats-value', text: '\u2026'});
            item.add_child(name);
            item.add_child(value);
            this.menu.addMenuItem(item);
            this._rows.set(key, value);
        }

        // Refresh only while the user is looking at the menu.
        this._openStateId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._startPolling();
            else
                this._stopPolling();
        });
    }

    _startPolling() {
        if (this._timerId)
            return;

        this._refresh();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, REFRESH_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPolling() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        // Drop the CPU baseline so the next open measures a fresh interval
        // instead of averaging over the time the menu was closed.
        this._prevCpu = null;
    }

    async _refresh() {
        try {
            await Promise.all([
                this._refreshCpu(),
                this._refreshMemory(),
                this._refreshUptime(),
            ]);
            this._refreshDisk();
        } catch (e) {
            // A transient /proc read failure must not break the menu.
            this._set('cpu', 'unavailable');
        }
    }

    _set(key, text) {
        const label = this._rows.get(key);
        if (label)
            label.text = text;
    }

    async _refreshCpu() {
        const text = await _readFile('/proc/stat');
        const line = text.split('\n', 1)[0];
        const parts = line.split(/\s+/).slice(1).map(Number).filter(n => !isNaN(n));
        if (parts.length < 4)
            return;

        const idle = parts[3] + (parts[4] ?? 0);
        const total = parts.reduce((a, b) => a + b, 0);

        if (this._prevCpu) {
            const dTotal = total - this._prevCpu.total;
            const dIdle = idle - this._prevCpu.idle;
            const usage = dTotal > 0
                ? Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)))
                : 0;
            this._set('cpu', `${usage}%`);
            if (this._summary)
                this._summary.text = `${usage}%`;
        } else {
            this._set('cpu', 'measuring\u2026');
        }

        this._prevCpu = {idle, total};
    }

    async _refreshMemory() {
        const text = await _readFile('/proc/meminfo');
        const values = {};
        for (const line of text.split('\n')) {
            const match = line.match(/^(\w+):\s+(\d+)/);
            if (match)
                values[match[1]] = Number(match[2]);
        }

        const total = values.MemTotal ?? 0;
        const available = values.MemAvailable ?? 0;
        const used = Math.max(0, total - available);
        if (total > 0) {
            const percent = Math.round((used / total) * 100);
            this._set('memory', `${_formatBytes(used)} / ${_formatBytes(total)} \u00b7 ${percent}%`);
        }

        const swapTotal = values.SwapTotal ?? 0;
        const swapFree = values.SwapFree ?? 0;
        this._set('swap', swapTotal > 0
            ? `${_formatBytes(swapTotal - swapFree)} / ${_formatBytes(swapTotal)}`
            : 'off');
    }

    async _refreshUptime() {
        const text = await _readFile('/proc/uptime');
        const seconds = Number(text.split(' ')[0]);
        if (!isNaN(seconds))
            this._set('uptime', _formatUptime(seconds));
    }

    _refreshDisk() {
        // Async like every other read: a statfs on a slow mount must never
        // block the compositor main loop.
        Gio.File.new_for_path('/').query_filesystem_info_async(
            'filesystem::size,filesystem::free',
            GLib.PRIORITY_DEFAULT, null, (file, result) => {
                try {
                    const info = file.query_filesystem_info_finish(result);
                    const size = info.get_attribute_uint64('filesystem::size');
                    const free = info.get_attribute_uint64('filesystem::free');
                    if (size > 0) {
                        const usedGb = (size - free) / (1024 ** 3);
                        const totalGb = size / (1024 ** 3);
                        const percent = Math.round(((size - free) / size) * 100);
                        this._set('disk',
                            `${usedGb.toFixed(1)} / ${totalGb.toFixed(1)} GB \u00b7 ${percent}%`);
                    }
                } catch (e) {
                    // _set() is a no-op once the rows are gone (menu closed,
                    // indicator destroyed) — never touch freed actors.
                    this._set('disk', 'unavailable');
                }
            });
    }

    destroy() {
        this._stopPolling();

        if (this._openStateId) {
            try {
                this.menu.disconnect(this._openStateId);
            } catch (e) {
                // Already finalized — fine.
            }
            this._openStateId = 0;
        }

        this._rows.clear();
        super.destroy();
    }
});
