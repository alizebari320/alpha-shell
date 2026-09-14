# ALPHA Shell — Feature Expansion, Unified Design System & Performance Spec

> **Blocker before any UI work:** the repo has no `media/` folder yet. `ALPHA_MODERN_REDESIGN.md` plans `media/alpha-logo.svg`, but it isn't committed. Every feature below loads the logo from that one path, so it must land first.

## Scope

Nine new features, all inside the single `alpha-shell@donk` extension, sharing one design language, one logo, and one performance budget.

**AI features** (finally wire the unused `ai/` folder)

1. **ALPHA Ask** — `Super+Space` floating prompt bar with streamed answer panel
2. **ALPHA Snip & Explain** — drag a screen region → vision model explains / translates / describes it
3. **ALPHA Clipboard AI** — copy text → action menu: Summarize, Fix grammar, Translate (EN/AR/KU), Explain code
4. **ALPHA Terminal Assist** — plain language → shell command, gated through `ai/safety.js` approval

**Utility features**

5. **ALPHA Clipboard History** — searchable last-N clips, pinning, image previews
6. **ALPHA Zoom & Spotlight** — cursor magnifier, screen dim, spotlight circle, click highlights
7. **ALPHA Screen Recorder HUD** — region/window recording with floating control bar
8. **ALPHA Panel Stats** — CPU / RAM / temp / net in the panel, top-processes dropdown
9. **ALPHA Focus Mode** — notification silence, non-active dim, Pomodoro timer

_Dropped: Window Tiler._

---

## 1. Unified design system

Everything lives in `stylesheet.css` under shared `alpha-*` classes. Feature-specific classes only override geometry, never color, radius, or typography.

### Design tokens

GNOME Shell CSS has no variables, so these are the fixed literals every feature must copy verbatim.

| Token | Value | Use |
| --- | --- | --- |
| Surface | `rgba(16, 16, 20, 0.92)` | All panel/HUD backgrounds |
| Surface raised | `rgba(255, 255, 255, 0.06)` | Inputs, rows, inactive buttons |
| Hairline | `1px solid rgba(255, 255, 255, 0.10)` | All panel borders |
| **Accent** | `#ff7a18` | Selection, focus, active state |
| Accent wash | `rgba(255, 122, 24, 0.18)` | Selected row/button fill |
| Accent edge | `rgba(255, 122, 24, 0.55)` | Selected border, focus ring |
| Danger | `#ff4757` | Clear, stop recording, destructive |
| Text | `#ffffff` / `rgba(255,255,255,0.55)` | Primary / secondary |
| Label | `11px`, bold, `rgba(255,255,255,0.45)`, `0.4px` tracking | Section headers |
| Body | `14px` | Rows, buttons |
| Title | `15px` bold | Result titles, headers |
| Radius | `16px` panel · `10px` control · `999px` chip | — |
| Shadow | `0 12px 40px rgba(0, 0, 0, 0.55)` | All floating surfaces |
| Grid | 4px base · `12px` panel padding · `8px` row gap | — |

**Migration task:** the current stylesheet uses neon green `#2bff88` across Writer and Launcher. Replace every green literal with the orange accent set so the two existing features match the nine new ones. This is a find-and-replace on `2bff88` / `43, 255, 136`.

### Shared chrome anatomy

Every overlay feature is built from the same three pieces so they look like one product:

1. **Branded header** — `.alpha-header`: 18px logo at left, feature name in 15px bold white, secondary hint text right-aligned, then a 1px hairline rule.
2. **Body** — either a list (`.alpha-row`, 44px min-height, 12px icon-to-label gap) or a control cluster (`.alpha-btn`, 10px radius).
3. **Footer hint** — `.alpha-hint`: 11px dim keycap row, e.g. `↑↓ navigate · ⏎ select · Esc close`.

### Interaction rules

- One accent-colored focus state only — never two highlighted things at once.
- `Esc` always closes, `⏎` always confirms, in every feature.
- Selection is fill + border + accent text, matching the existing `.selected` pattern.
- Motion: 120ms fade/scale in, 90ms out. Nothing longer — snappy reads as premium.
- All HUDs center on the pointer's monitor and are 640px wide, except Writer's toolbar and the recorder bar.

---

## 2. Logo integration

### One asset, one loader

Add `media/alpha-logo.svg` (square, transparent, ≥256px, readable at 16px) plus a monochrome `media/alpha-logo-symbolic.svg` for the panel.

Create `ui/brand.js` as the single source of truth:

```js
// ui/brand.js — one cached GIcon for the whole extension
import Gio from 'gi://Gio';
import St from 'gi://St';

let _icon = null;

export function logoIcon(path) {
    // Gio.FileIcon is created once and shared; St.Icon actors are cheap views of it
    _icon ??= Gio.FileIcon.new(Gio.File.new_for_path(`${path}/media/alpha-logo.svg`));
    return _icon;
}

export function header(path, title, hint = '') {
    const box = new St.BoxLayout({ style_class: 'alpha-header' });
    box.add_child(new St.Icon({ gicon: logoIcon(path), icon_size: 18 }));
    box.add_child(new St.Label({ text: title, style_class: 'alpha-header-title' }));
    if (hint)
        box.add_child(new St.Label({ text: hint, style_class: 'alpha-header-hint' }));
    return box;
}

export function disposeBrand() { _icon = null; }
```

### Placement rules per feature

| Feature | Logo placement |
| --- | --- |
| Panel indicator | Symbolic logo replaces the current generic icon |
| Ask, Snip, Clipboard AI, Terminal Assist, Clipboard History | 18px logo in `.alpha-header` |
| Zoom & Spotlight | 16px logo on the small control pill |
| Screen Recorder HUD | 16px logo on the control bar, left of the timer |
| Panel Stats | Symbolic logo leads the dropdown header |
| Focus Mode | Logo inside the Pomodoro timer card |
| Writer | Logo added to the existing floating toolbar header |
| Preferences | Logo in the `prefs.js` header banner |

Logo rules: never recolor or stretch it, never below 16px, always ≥8px clear space, and always load through `brand.js` — no feature may construct its own `Gio.Icon`.

---

## 3. Performance & RAM budget

This code runs **inside the gnome-shell process**. A leak here is a desktop-wide leak, so treat these as hard rules.

### Budget

| State | Target |
| --- | --- |
| Idle, nothing open | < 3 MB above baseline; **zero** timers, zero canvases |
| One HUD open | < 12 MB |
| Recording active | < 25 MB (encoder is out-of-process) |
| Steady-state growth after 50 open/close cycles | ~0 MB |

### Hard rules

1. **Lazy load every feature.** `extension.js` registers only keybindings and menu items. The module is pulled in with dynamic `await import('./ui/ask.js')` on first activation. Nine eagerly imported modules would be the single biggest idle-RAM regression.
2. **Destroy, don't hide.** On close, `destroy()` the actors and null the instance. Never keep nine hidden HUDs parked in `uiGroup`.
3. **Zero idle timers.** No polling when a feature is closed. Panel Stats reads `/proc` on a 3s `GLib.timeout` **only while its dropdown is open**, and reads via `Gio.File.load_contents_async` — never sync I/O on the compositor thread.
4. **Signal ledger.** Each module keeps `this._signals = []` of `[object, handlerId]` and disconnects all of them in `destroy()`. Same pattern Writer already uses.
5. **Never destroy an actor inside its own signal emission.** This caused the SIGSEGV fixed in `ac5a0ac`; defer with `GLib.idle_add` as done in `02e0562`.
6. **Cap all history.** Clipboard History: 40 text entries, 3 image entries, 1MB per image, LRU-evicted. Ask: last 20 messages. Never unbounded arrays.
7. **Debounce and cap search.** 120ms input debounce; render at most 12 rows; reuse row actors rather than rebuilding the list.
8. **Cache the app list.** Share one `Shell.AppSystem` snapshot between Launcher and Ask, invalidated on `installed-changed` only.
9. **AI calls are async and abortable.** `Gio.Subprocess` / `Soup` with a cancellable tied to the HUD's lifetime; closing the HUD aborts in flight. No request may block the shell.
10. **Redraw only dirty regions.** Zoom, Spotlight, and Writer must use `queue_repaint` on their own actor, never a full-stage repaint per motion event.
11. **Recorder stays out-of-process.** Shell out to the GNOME screencast API or `ffmpeg` via `Gio.Subprocess`; never buffer frames in GJS.
12. **Handle `monitors-changed`** in every overlay from day one — the README's known limitation should not be inherited by nine new features.

### Verification loop

```bash
# idle RSS baseline, then after opening each feature 20x
ps -o rss= -C gnome-shell

# GJS heap objects — should return to baseline after close
busctl --user call org.gnome.Shell /org/gnome/Shell \
  org.gnome.Shell Eval s 'imports.system.gc(); "ok"'

journalctl -f -o cat /usr/bin/gnome-shell | grep -i 'alpha-shell\|gjs'
```

---

## 4. Target structure

```
alpha-shell/
├── extension.js          # keybindings + lazy loaders only
├── prefs.js              # branded header, per-feature toggles
├── stylesheet.css        # tokens + shared alpha-* chrome + per-feature geometry
├── media/
│   ├── alpha-logo.svg
│   └── alpha-logo-symbolic.svg
├── ai/                   # existing facade, now wired
├── ui/
│   ├── brand.js          # NEW — cached logo + shared header/footer builders
│   ├── shell.js          # NEW — base overlay class: modal, esc, monitor, signal ledger
│   ├── indicator.js      # logo + grouped feature menu
│   ├── writer.js         # recolor to orange, add branded header
│   ├── launcher.js       # recolor to orange, adopt brand.js header
│   ├── ask.js  · snip.js · clipboardAi.js · terminal.js
│   └── clipboard.js · zoom.js · recorder.js · stats.js · focus.js
```

`ui/shell.js` is the key addition: a base class handling modal grab, `Esc`, monitor placement, the signal ledger, and deferred teardown. Every new feature extends it, which is what actually guarantees identical behavior and no repeated leaks.

---

## 5. Build order

1. `media/` logo assets + `ui/brand.js` + `ui/shell.js` + token migration to orange (green → orange across Writer and Launcher)
2. **Clipboard History** — validates `shell.js` against the existing Launcher list pattern
3. **ALPHA Ask** — unlocks `ai/ai.js`, `models.js`, `providers.js`
4. **Snip & Explain** → **Clipboard AI** → **Terminal Assist** (reuses `ai/safety.js` approval flow)
5. **Zoom & Spotlight** → **Screen Recorder HUD**
6. **Panel Stats** → **Focus Mode**
7. Per-feature toggles in `prefs.js`, README update, RAM verification pass

Each feature ships as its own branch and PR, and no PR merges until the idle-RSS check returns to baseline after 20 open/close cycles.
