# ALPHA Shell

A GNOME Shell extension (Fedora 44 / GNOME Shell 50, ESM, Wayland) whose
current flagship tool is **ALPHA Writer** — a screen annotation and
handwriting layer that floats above your desktop.

## ALPHA Writer

Toggle it with `Ctrl+Alt+D` (configurable in Preferences) or from the
ALPHA Shell panel icon. A floating toolbar appears; draw directly on the
screen with your mouse or tablet.

- **Draw mode** — the canvas captures the pointer and draws freehand
  strokes with quadratic-bézier midpoint smoothing (constant frame cost:
  the live layer replays only the active stroke, never the session
  history).
- **Pass-through mode** — strokes stay 100% visible while every click,
  gesture and window interaction falls through to the desktop apps below.
- 4 preset ink colors (Neon Green, Cyan, Red, White) and stroke widths
  (2/4/8/16 px).
- Draggable floating toolbar that stays interactive in pass-through mode.
- Clear (🗑) wipes the canvas; Close (✕) quits the tool.
- Wayland-safe pointer capture via `global.stage.grab()` (Clutter.Grab);
  all signal handlers are tracked and disconnected on teardown.

## Architecture

- Two stacked `St.DrawingArea` canvases on `Main.layoutManager.uiGroup`:
  a "committed" layer for finished strokes and a "live" layer for the
  stroke currently under the pointer. (GNOME 50 removed `Clutter.Canvas`;
  `St.DrawingArea` is its supported replacement.)
- `ui/writer.js` — the `Writer` class, fully self-contained:
  `enable()` / `disable()` / `destroy()` are the whole lifecycle surface.
- `ui/indicator.js` — panel button + tool menu.
- `extension.js` — entry point: wires the indicator and keybinding.
- `ai/` — provider/model architecture kept for future AI features
  (nothing wired, no network calls).

## Requirements

- Fedora 44 Workstation
- GNOME Shell 50.x
- GJS (ships with GNOME Shell)

## Installation

```bash
# create the extensions dir if missing
mkdir -p ~/.local/share/gnome-shell/extensions

# link the project into the extensions dir
ln -s ~/alpha-shell ~/.local/share/gnome-shell/extensions/alpha-shell@donk

# compile the GSettings schema
glib-compile-schemas ~/alpha-shell/schemas

# Wayland: log out and back in to load the extension code
```

## Enable / Disable

```bash
gnome-extensions enable alpha-shell@donk
gnome-extensions disable alpha-shell@donk
```

Or use the **Extensions** app (GUI).

## Development commands

```bash
# watch shell logs while iterating
journalctl -f -o cat /usr/bin/gnome-shell

# list / inspect the extension state
gnome-extensions list
gnome-extensions info alpha-shell@donk

# rebuild schema after editing the .gschema.xml
glib-compile-schemas ~/alpha-shell/schemas
```

## Debugging commands

```bash
# error + warning lines from the shell
journalctl -b -o cat /usr/bin/gnome-shell | grep -i 'alpha-shell\|gjs'

# open preferences directly
gnome-extensions prefs alpha-shell@donk
```

## Project structure

```
alpha-shell/
├── extension.js            # entry point: wiring + keyboard shortcut
├── prefs.js                # preferences window (shortcut, provider/model)
├── stylesheet.css          # ALPHA Writer styling (auto-loaded by the shell)
├── metadata.json           # extension metadata
├── package.json            # project metadata
├── schemas/
│   └── org.gnome.shell.extensions.alpha-shell.gschema.xml
├── ai/                     # AI architecture (future features, unwired)
│   ├── ai.js               # AIService facade (one method per operation)
│   ├── models.js           # provider + model catalog (placeholders)
│   ├── providers.js        # AIProvider base class + registry
│   └── safety.js           # command approval / safe-execution workflow
└── ui/
    ├── writer.js           # ALPHA Writer (screen annotation)
    └── indicator.js        # panel indicator + tool menu
```

## Known limitations

- Wayland session: shell must be restarted (log out/in) to load new code;
  `journalctl` is the primary debugging channel.
- Single-monitor (primary) coverage; strokes are dropped on monitor
  layout changes.

## How to add a new tool

1. Create `ui/<tool>.js` exporting a class with `enable()` / `disable()` /
   `destroy()` — model it on `ui/writer.js`.
2. Add an entry to the indicator menu and a keybinding in `extension.js`.
3. Style it in `stylesheet.css` with an `alpha-<tool>-*` prefix.
4. Update this README if the tool is user-facing.
