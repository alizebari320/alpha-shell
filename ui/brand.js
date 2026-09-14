// ui/brand.js — ALPHA Shell brand layer.
//
// Single source of truth for the logo and the shared branded header, so no
// feature ever constructs its own Gio.Icon.
//
// The logo asset is intentionally NOT committed yet. Drop a file at
// `media/alpha-logo.svg` (and optionally `media/alpha-logo-symbolic.svg`
// for the panel) and every feature picks it up with zero code changes.
// Until then the header renders an "ALPHA" wordmark fallback.
//
// Performance: each icon file is resolved at most once per session and the
// resulting Gio.FileIcon is shared by all features. St.Icon actors are
// cheap views onto that one object, so nine branded HUDs cost the memory
// of a single icon.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

const LOGO = ['media', 'alpha-logo.svg'];
const LOGO_SYMBOLIC = ['media', 'alpha-logo-symbolic.svg'];
const FALLBACK_ICON = 'applications-science-symbolic';
const WORDMARK = 'ALPHA';

// key -> Gio.FileIcon | null (null means "checked, not present")
const _cache = new Map();

function _load(extensionPath, parts) {
    const key = parts.join('/');
    if (_cache.has(key))
        return _cache.get(key);

    let gicon = null;
    try {
        const file = Gio.File.new_for_path(
            GLib.build_filenamev([extensionPath, ...parts]));
        // One-off sync existence check; cached for the rest of the session
        // so this never runs per HUD open.
        if (file.query_exists(null))
            gicon = new Gio.FileIcon({file});
    } catch (e) {
        gicon = null;
    }

    _cache.set(key, gicon);
    return gicon;
}

/** The full-color logo, or null while the asset is missing. */
export function logoIcon(extensionPath) {
    return _load(extensionPath, LOGO);
}

/** Monochrome panel logo, falling back to the full-color one. */
export function symbolicLogoIcon(extensionPath) {
    return _load(extensionPath, LOGO_SYMBOLIC) ?? _load(extensionPath, LOGO);
}

/** Top-bar icon: the logo when present, a generic symbolic icon otherwise. */
export function panelIcon(extensionPath) {
    const gicon = symbolicLogoIcon(extensionPath);
    return gicon
        ? new St.Icon({gicon, style_class: 'system-status-icon alpha-panel-logo'})
        : new St.Icon({icon_name: FALLBACK_ICON, style_class: 'system-status-icon'});
}

/** Logo mark for HUD headers, or the ALPHA wordmark while it is missing. */
export function mark(extensionPath, size = 18) {
    const gicon = logoIcon(extensionPath);
    if (gicon) {
        return new St.Icon({
            gicon,
            icon_size: size,
            style_class: 'alpha-logo',
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    return new St.Label({
        text: WORDMARK,
        style_class: 'alpha-wordmark',
        y_align: Clutter.ActorAlign.CENTER,
    });
}

/**
 * The branded header every feature shares: logo, feature name, right-aligned
 * hint. Keeping this in one place is what makes nine features look like one
 * product.
 */
export function header(extensionPath, title, hint = '', logoSize = 18) {
    const box = new St.BoxLayout({style_class: 'alpha-header'});

    box.add_child(mark(extensionPath, logoSize));
    box.add_child(new St.Label({
        text: title,
        style_class: 'alpha-header-title',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    }));

    if (hint) {
        box.add_child(new St.Label({
            text: hint,
            style_class: 'alpha-header-hint',
            y_align: Clutter.ActorAlign.CENTER,
        }));
    }

    return box;
}

/** The shared keycap hint strip shown at the bottom of a HUD. */
export function footer(text) {
    return new St.Label({text, style_class: 'alpha-hint'});
}

/** Drop cached icons. Called from the extension's disable(). */
export function reset() {
    _cache.clear();
}
