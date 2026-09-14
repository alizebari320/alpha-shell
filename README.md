# ALPHA Shell

A GNOME Shell extension (Fedora 44 / GNOME Shell 50, ESM, Wayland): eleven
features, one design language, one hotkey each.

## Features

### AI

| Feature | Shortcut | What it does |
| --- | --- | --- |
| **ALPHA Ask** | `Super+Space` | Prompt HUD with Ask / Summarize / Explain-code modes. `Ctrl+C` copies the answer. |
| **Snip & Explain** | `Super+Shift+S` | Drag a region, get an explanation of what is in it. |
| **Clipboard AI** | `Super+Shift+V` | Acts on the current clipboard: translate to English / العربية / Kurdî, fix grammar, summarize, shorten. `Ctrl+R` replaces the clipboard in place. |
| **Terminal Assist** | `Super+Shift+T` | Describe a task, get a shell command. The command is **proposed** and must be explicitly approved before anything can run. |

AI features call the `AIService` facade in `ai/ai.js`. No provider is wired
yet, so today they render the "not configured" message in the shared error
style instead of failing. Wiring a provider needs no UI change.

### Tools

| Feature | Shortcut | What it does |
| --- | --- | --- |
| **ALPHA Writer** | `Ctrl+Alt+D` | Screen annotation layer: pen, highlighter, eraser, shapes, text, undo/redo. |
| **ALPHA Quick Launcher** | `Super+A` | Spotlight-style application search. |
| **Clipboard History** | `Super+V` | Searchable history of recent copies, pin with `Ctrl+P`, remove with `Del`. |
| **Zoom & Spotlight** | `Super+Shift+Z` | Presentation mode: dim everything except a highlight that follows the pointer, `+` / `-` to magnify, `S` toggles the spotlight. |
| **Screen Recorder** | `Super+Shift+R` | Floating pill with a live timer; recordings are saved to `~/Videos`. |
| **Focus Mode** | `Super+Shift+F` | Mutes notifications and dims the top bar, restoring both on exit. |
| **Panel Stats** | panel item | CPU, memory, swap, disk and uptime. Off by default. |

Every shortcut is configurable in **Preferences → Shortcuts**, and every
feature can be switched off in **Preferences → Features**.

## Design system

All features share one visual language, defined once in `stylesheet.css`
and `ui/brand.js`:

- accent `#ff7a18` on surface `rgba(16, 16, 20, 0.92)` with a
  `rgba(255, 255, 255, 0.10)` hairline
- 16px panel radius, 10px controls, 999px chips, `0 12px 40px` shadow
- 640px HUD width, 12px padding, 4px spacing grid
- 120ms open / 90ms close animation
- every HUD has the same header (logo, title, hint) and keycap footer

Feature stylesheets may override **geometry only** — never color, radius
or typography. That rule is what makes eleven features feel like one
extension.

### The logo

The logo file is **not committed yet**. Drop your logo at:

```
media/alpha-logo.svg            # HUD headers and pills
media/alpha-logo-symbolic.svg   # optional, monochrome top-bar version
```

and it appears in every feature with no code change: `ui/brand.js`
resolves the file once per session, caches a single `Gio.FileIcon` shared
by all features, and falls back to an `ALPHA` wordmark until the file
exists.

## Performance

This is a suite, not a pile of extensions, and it is built to stay light.

**Budget**

| State | Target |
| --- | --- |
| idle (nothing open) | < 3 MB, zero timers |
| one HUD open | < 12 MB |
| recording | < 25 MB in-shell (encoding is out of process) |
| after 50 open/close cycles | ~0 MB growth |

**Rules the code follows**

1. **Lazy everything.** `enable()` registers an indicator and keybindings.
   Feature modules are imported dynamically on first use; a disabled
   feature is never parsed.
2. **Destroy, do not hide.** Closing a HUD destroys its actors.
3. **No idle timers.** Panel Stats polls only while its menu is open; the
   recorder timer exists only while recording. Clipboard capture is
   signal-driven (`Meta.Selection::owner-changed`), never polled.
4. **Signal and timeout ledgers.** `AlphaOverlay` disconnects every signal
   and cancels every timeout on close.
5. **Never destroy an actor inside its own signal emission.** All teardown
   goes through `deferClose()` / `GLib.idle_add`. This is the crash class
   that used to end the Wayland session.
6. **Bounded data.** Clipboard history is capped at 40 entries, oversized
   clips are skipped, result lists render at most 12 rows and reuse row
   actors.
7. **Generation tokens.** A slow AI reply from a closed or superseded HUD
   is dropped instead of writing into freed actors.
8. **Out-of-process work.** Screen recording runs in the shell's screencast
   service; snips are written to a temp file that is deleted as soon as the
   request settles.
9. **Cheap redraws.** No `Clutter.Canvas` (removed in GNOME 50), no
   full-screen textures, motion throttled to ~60Hz with sub-pixel moves
   ignored.
10. **Reversible system changes.** Focus Mode, Zoom and the `Super+A`
    rebinding all save the previous value and restore it on exit or
    `disable()`.

**Verifying**

```bash
# resident memory of the shell
ps -o rss= -C gnome-shell

# force a GC before measuring again
busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell \
  Eval s 'imports.system.gc(); "ok"'

# watch for warnings while cycling features
journalctl -f -o cat /usr/bin/gnome-shell | grep -i 'alpha-shell\|gjs'
```

## Architecture

- `ui/shell.js` — `AlphaOverlay`, the base class behind every HUD: modal
  grab, `Esc` to close, click-outside dismiss, pointer-monitor placement,
  animation, signal/timeout ledgers, safe teardown.
- `ui/brand.js` — the logo cache and the shared header/footer builders.
- `extension.js` — a `FEATURES` table (id, schema keys, async factory) plus
  lazy loading and keybinding registration.
- `ui/indicator.js` — panel button with a grouped AI / Tools menu.
- `ai/` — `AIService` facade, provider/model catalog, and the
  `CommandApprover` safety gate used by Terminal Assist.
- ALPHA Writer uses two stacked `St.DrawingArea` canvases (a committed
  layer and a live layer) on `Main.layoutManager.uiGroup`.

## Requirements

- Fedora 44 Workstation
- GNOME Shell 50.x
- GJS (ships with GNOME Shell)

## Installation

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
ln -s ~/alpha-shell ~/.local/share/gnome-shell/extensions/alpha-shell@donk
glib-compile-schemas ~/alpha-shell/schemas
# Wayland: log out and back in to load the extension code
```

## Enable / Disable

```bash
gnome-extensions enable alpha-shell@donk
gnome-extensions disable alpha-shell@donk
gnome-extensions prefs alpha-shell@donk
```

## Development commands

```bash
# watch shell logs while iterating
journalctl -f -o cat /usr/bin/gnome-shell

# rebuild the schema after editing the .gschema.xml
glib-compile-schemas ~/alpha-shell/schemas

# inspect state
gnome-extensions info alpha-shell@donk
```

## Project structure

```
alpha-shell/
├── extension.js            # FEATURES table + lazy loading + keybindings
├── prefs.js                # feature switches, shortcuts, provider/model
├── stylesheet.css          # design tokens + shared chrome + feature geometry
├── metadata.json
├── package.json
├── media/                  # put alpha-logo.svg here (not committed)
├── schemas/
│   └── org.gnome.shell.extensions.alpha-shell.gschema.xml
├── ai/
│   ├── ai.js               # AIService facade
│   ├── models.js           # provider + model catalog
│   ├── providers.js        # AIProvider base class + registry
│   └── safety.js           # CommandApprover (propose → approve → run)
└── ui/
    ├── brand.js            # logo cache + shared header/footer
    ├── shell.js            # AlphaOverlay base class
    ├── ask.js              # ALPHA Ask
    ├── snip.js             # Snip & Explain
    ├── clipboardAi.js      # Clipboard AI
    ├── terminal.js         # Terminal Assist
    ├── clipboard.js        # Clipboard History (store + HUD)
    ├── zoom.js             # Zoom & Spotlight
    ├── recorder.js         # Screen Recorder HUD
    ├── stats.js            # Panel Stats
    ├── focus.js            # Focus Mode
    ├── writer.js           # ALPHA Writer
    ├── launcher.js         # ALPHA Quick Launcher
    └── indicator.js        # panel indicator + grouped menu
```

## Known limitations

- Wayland session: the shell must be restarted (log out/in) to load new
  code; `journalctl` is the primary debugging channel.
- No AI provider is wired yet, so the four AI features report that they
  are not configured.
- Clipboard History records text only; image clips are not captured yet.
- ALPHA Writer still covers the primary monitor only and drops strokes on
  monitor layout changes. New features handle `monitors-changed`.

## How to add a new feature

1. Create `ui/<feature>.js` exporting a class that extends `AlphaOverlay`
   from `ui/shell.js` and implements `_build(panel)` (plus `_onKeyPress`,
   `_onOpened`, `_onClosing` as needed). Do not build your own overlay,
   modal grab or teardown.
2. Add an entry to the `FEATURES` table in `extension.js` with an async
   factory that dynamically imports your module.
3. Add a `toggle-<feature>` shortcut and an `enable-<feature>` boolean to
   the gschema, then `glib-compile-schemas schemas/`.
4. Add the feature to the arrays in `prefs.js`.
5. Style geometry only, under an `alpha-<feature>` class in
   `stylesheet.css`. Reuse the shared tokens for everything else.
6. Update this README.
