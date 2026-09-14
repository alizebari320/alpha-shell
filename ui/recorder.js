// ui/recorder.js — Screen Recorder HUD.
//
// A floating pill with a live timer and a stop button.
//
// Performance notes
// -----------------
// * Recording happens OUT OF PROCESS via the org.gnome.Shell.Screencast
//   DBus service. The extension never touches frames or encoders, which
//   is what keeps recording off the gnome-shell heap.
// * The 1s elapsed timer exists only while recording and is cancelled on
//   stop, so this feature has zero idle timers.
// * The pill is not modal: you keep using your desktop while it records.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Brand from './brand.js';

const SCREENCAST_IFACE = `
<node>
  <interface name="org.gnome.Shell.Screencast">
    <method name="Screencast">
      <arg type="s" direction="in" name="file_template"/>
      <arg type="a{sv}" direction="in" name="options"/>
      <arg type="b" direction="out" name="success"/>
      <arg type="s" direction="out" name="filename_used"/>
    </method>
    <method name="StopScreencast">
      <arg type="b" direction="out" name="success"/>
    </method>
  </interface>
</node>`;

const ScreencastProxy = Gio.DBusProxy.makeProxyWrapper(SCREENCAST_IFACE);

export class ScreenRecorder {
    constructor(path) {
        this._path = path;
        this._pill = null;
        this._signals = [];
        this._timerId = 0;
        this._startedAt = 0;
        this._recording = false;
        this._proxy = null;
        this._filename = '';
    }

    get isRecording() {
        return this._recording;
    }

    toggle() {
        if (this._recording)
            this.stop();
        else
            this.start();
    }

    // --- recording --------------------------------------------------------

    start() {
        if (this._recording)
            return;

        const template = GLib.build_filenamev([
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ??
                GLib.get_home_dir(),
            `alpha-%d%t.webm`,
        ]);

        try {
            // Proxy is created lazily: no DBus traffic unless you record.
            this._proxy ??= ScreencastProxy(
                Gio.DBus.session,
                'org.gnome.Shell.Screencast',
                '/org/gnome/Shell/Screencast');

            this._proxy.ScreencastRemote(template, {}, (result, error) => {
                if (error) {
                    this._showError(error.message ?? String(error));
                    return;
                }

                const [success, filenameUsed] = result ?? [false, ''];
                if (!success) {
                    this._showError('The screencast service refused to start');
                    return;
                }

                this._filename = filenameUsed;
                this._recording = true;
                this._startedAt = GLib.get_monotonic_time();
                this._showPill();
            });
        } catch (e) {
            this._showError(e?.message ?? String(e));
        }
    }

    stop() {
        if (!this._recording) {
            this._hidePill();
            return;
        }

        this._recording = false;
        this._stopTimer();

        try {
            this._proxy?.StopScreencastRemote(() => {});
        } catch (e) {
            // Service already gone — nothing to stop.
        }

        const saved = this._filename;
        this._filename = '';
        this._hidePill();

        if (saved) {
            Main.notify('ALPHA Shell', `Recording saved to ${saved}`);
        }
    }

    destroy() {
        if (this._recording)
            this.stop();
        this._stopTimer();
        this._hidePill();
        this._proxy = null;
    }

    // --- pill -------------------------------------------------------------

    _showPill() {
        if (this._pill)
            return;

        this._pill = new St.BoxLayout({style_class: 'alpha-pill alpha-recorder', reactive: true});

        this._pill.add_child(Brand.mark(this._path, 16));
        this._dot = new St.Label({
            style_class: 'alpha-pill-live',
            text: '\u25cf REC',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pill.add_child(this._dot);

        this._time = new St.Label({
            style_class: 'alpha-pill-label',
            text: '00:00',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pill.add_child(this._time);

        const stop = new St.Button({
            style_class: 'alpha-btn alpha-btn-danger',
            label: 'Stop',
            can_focus: false,
        });
        // Deferred so the button is not destroyed mid-emission.
        this._connect(stop, 'clicked', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this.stop();
                return GLib.SOURCE_REMOVE;
            });
        });
        this._pill.add_child(stop);

        Main.layoutManager.addTopChrome(this._pill);
        this._placePill();
        this._connect(Main.layoutManager, 'monitors-changed', () => this._placePill());

        this._startTimer();
    }

    _placePill() {
        if (!this._pill)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        // Bottom center, clear of the panel.
        this._pill.set_position(
            monitor.x + Math.floor((monitor.width - this._pill.width) / 2),
            monitor.y + monitor.height - this._pill.height - 48);
    }

    _hidePill() {
        this._releaseSignals();

        if (!this._pill)
            return;

        const pill = this._pill;
        this._pill = null;
        this._dot = null;
        this._time = null;

        // Always destroy on a later tick: stop() can be called from the
        // pill's own button handler.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            Main.layoutManager.removeChrome(pill);
            pill.destroy();
            return GLib.SOURCE_REMOVE;
        });
    }

    _showError(message) {
        Main.notify('ALPHA Shell', `Could not record the screen: ${message}`);
        this._recording = false;
        this._hidePill();
    }

    // --- timer ------------------------------------------------------------

    _startTimer() {
        this._stopTimer();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 1, () => {
            if (!this._recording || !this._time) {
                this._timerId = 0;
                return GLib.SOURCE_REMOVE;
            }

            const seconds = Math.floor(
                (GLib.get_monotonic_time() - this._startedAt) / 1000000);
            const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
            const ss = String(seconds % 60).padStart(2, '0');
            this._time.text = `${mm}:${ss}`;

            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (!this._timerId)
            return;
        GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    // --- signal ledger ----------------------------------------------------

    _connect(object, name, callback) {
        this._signals.push([object, object.connect(name, callback)]);
    }

    _releaseSignals() {
        for (const [object, id] of this._signals) {
            try {
                object.disconnect(id);
            } catch (e) {
                // Already finalized — fine.
            }
        }
        this._signals = [];
    }
}
