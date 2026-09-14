# ALPHA Shell

A GNOME Shell extension (Fedora 44 / GNOME Shell 50, ESM, Wayland) featuring:

- **ALPHA Writer** — a screen annotation and handwriting layer that floats
  above your desktop.
- **ALPHA Quick Launcher** — an in-place Spotlight-style search HUD.

## ALPHA Quick Launcher

Toggle it with `Super+a` or from the ALPHA Shell panel icon menu. A centered
search HUD appears over the current windows — the active application is
neither minimized nor sent behind the Overview.

- Type to search all installed applications (name, description, or app id,
  case-insensitive) via `Shell.AppSystem.get_default().get_installed()`.
- `Up` / `Down` move the selection, `Enter` / `KP_Enter` launch the selected
  app, `Escape` dismisses the HUD.
- Clicking a result launches it; hovering moves the selection.
- Because GNOME binds `Super+a` to the app grid by default
  (`toggle-application-view`), the extension clears that binding while it is
  enabled and restores the previous value on disable.

## ALPHA Writer

Toggle it with `Ctrl+Alt+D` (configurable in Preferences) or from the
ALPHA Shell panel icon. A floating toolbar appears; draw directly on the
screen with your mouse or tablet.

**Tools** (select from the toolbar or press `1`–`8` in Draw mode):

- **Pen** — freehand strokes with quadratic-bézier midpoint smoothing
- **Highlighter** — wide, translucent, square-cap ink for emphasis
- **Eraser** — stroke-level erase: whole strokes vanish under the pointer
- **Line / Arrow / Rectangle / Ellipse** — crisp drag-from-to shapes
- **Text** — click, type into the inline entry, `Enter` places the label
  (size follows the Width presets)

**Other features:**

- **Undo / Redo** — snapshot history (`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`
  or toolbar buttons). Every action is undoable: strokes, shapes, text,
  eraser drags (one drag = one undo step) and Clear.
- **Draw vs Pass-through mode** — in pass-through, strokes stay 100%
  visible while every click, gesture and window interaction falls through
  to the desktop apps below.
- 4 preset ink colors (Neon Green, Cyan, Red, White) and width presets
  (2/4/8/16 px, also mapped to text sizes).
- `Escape` cancels a pending text entry or quits the tool.
- Draggable floating toolbar that stays interactive in pass-through mode.
- Wayland-safe pointer capture via `global.stage.grab()` (Clutter.Grab);
  all signal handlers are tracked and disconnected on teardown.

Keyboard shortcuts are only active in Draw mode, where the canvas holds
the shell key focus — in pass-through mode all keys (and clicks) go to
your apps.

## Architecture

- Two stacked `St.DrawingArea` canvases on `Main.layoutManager.uiGroup`:
  a "committed" layer for finished strokes and a "live" layer for the
  stroke currently under the pointer. (GNOME 50 removed `Clutter.Canvas`;
  `St.DrawingArea` is its supported replacement.)
- `ui/writer.js` — the `Writer` class, fully self-contained:
  `enable()` / `disable()` / `destroy()` are the whole lifecycle surface.
- `ui/launcher.js` — the `Launcher` class (same self-contained lifecycle
  pattern as Writer) powering the Quick Launcher HUD.
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
├── ui/
│   ├── writer.js           # ALPHA Writer (screen annotation)
│   ├── launcher.js         # ALPHA Quick Launcher (search HUD)
│   └── indicator.js        # panel indicator + tool menu
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
