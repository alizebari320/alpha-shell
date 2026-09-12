# ALPHA Shell

A GNOME Shell extension that provides a keyboard-activated AI overlay. The
extension is the **foundation** — the AI overlay UI, a model/provider catalog,
and a safe command-execution workflow are all scaffolded, but no AI provider
is wired yet. No API calls are made and no credentials are stored.

## What ALPHA Shell is

ALPHA Shell adds a fullscreen overlay (toggled with `Super` + `Space`) that will
eventually let you ask the AI, summarize text, explain code, generate shell
commands, analyze screenshots and search — through multiple, configurable model
providers. Today it renders a placeholder card so the UI, shortcut, and
settings plumbing can be tested end-to-end.

## Features currently implemented

- GNOME Shell 50 extension scaffold (ESM, modern `Extension` base class)
- Fullscreen overlay UI, toggled with `Super` + `Space`
- Stylesheet (auto-loaded by the shell from `stylesheet.css`)
- GSettings schema for the shortcut + provider/model selection
- AI architecture:
  - Provider abstraction (`ai/providers.js`)
  - Model catalog with capabilities (`ai/models.js`)
  - Single service facade with one method per operation (`ai/ai.js`)
  - Safe command execution workflow — proposed, never auto-run (`ai/safety.js`)
- Preferences page with provider/model dropdowns (writes ids to settings only)

## Features planned (not implemented)

- Ask AI from the overlay (live input)
- Send selected text to AI
- Summarize text
- Explain code
- Generate commands (routed through the safety gate)
- Analyze screenshots
- Search with AI
- Execute approved commands through a safe workflow
- Multiple real model providers (xAI, OpenAI, local LLM, …)
- Credential storage via GNOME libsecret (never in source)

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

# restart the shell (Wayland: log out and back in)
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
├── prefs.js                # preferences window (provider/model selection)
├── stylesheet.css          # overlay styling (auto-loaded by the shell)
├── metadata.json           # extension metadata
├── package.json            # project metadata
├── schemas/
│   └── org.gnome.shell.extensions.alpha-shell.gschema.xml
├── ai/
│   ├── ai.js               # AIService facade (one method per operation)
│   ├── models.js           # provider + model catalog (placeholders)
│   ├── providers.js        # AIProvider base class + registry
│   └── safety.js           # command approval / safe-execution workflow
├── ui/
│   └── overlay.js          # fullscreen overlay widget
├── .gitignore
└── README.md
```

## Known limitations

- No AI provider is wired: every operation in `ai/ai.js` is an intentional
  stub that rejects with a clear "not implemented" message.
- Model names / providers in `ai/models.js` are placeholders supplied as
  examples; they do not map to real endpoints.
- Command execution in `ai/safety.js` is deliberately absent (safety gate).
- Wayland session: shell must be restarted (log out/in) to load new native
  code; `journalctl` is the primary debugging channel.

## How to add a new module

1. Create a file inside an existing folder (`ai/`, `ui/`) or a new folder.
2. Export a class or a set of functions with `export`.
3. Import and instantiate it from `extension.js` (or a parent module) inside
   `enable()`, and clean it up in `disable()`.
4. Update this README if the module is user-facing.

## How to add a new UI component

1. Add a class to `ui/` (mirroring `ui/overlay.js`): build an `St` widget,
   expose `show()` / `hide()` / `destroy()`.
2. Add `St.ThemeNode`-style selectors to `stylesheet.css`.
3. Instantiate the component from `extension.js` and attach it to
   `Main.layoutManager.uiGroup` (for fullscreen overlays) or a shell container.