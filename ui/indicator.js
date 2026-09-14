// Indicator — the top-bar button that opens the ALPHA Shell tool menu.
//
// Subclasses PanelMenu.Button, the standard GNOME Shell panel-button
// pattern. The menu is grouped (AI / Tools) and driven by the feature
// table in extension.js, so adding a feature there adds it here too.
//
// The icon comes from ui/brand.js: the moment media/alpha-logo.svg is
// added it becomes the real logo, with no change needed here.

import GObject from 'gi://GObject';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Brand from './brand.js';

// ESM subclass of a GObject must be registered via GObject.registerClass,
// otherwise constructing it throws "Tried to construct an object without a
// GType" and takes the whole extension down.
export const Indicator = GObject.registerClass({
    GTypeName: 'AlphaShellIndicator',
}, class Indicator extends PanelMenu.Button {
    /**
     * @param {object} args
     * @param {string} args.path       extension.path, for the logo
     * @param {Array}  args.items      [{id, label, group}] in menu order
     * @param {Function} args.onActivate called with a feature id
     */
    _init({path, items = [], onActivate} = {}) {
        super._init(0.0, 'ALPHA Shell', false);

        this.add_style_class_name('alpha-indicator');
        this._onActivate = onActivate;

        this.add_child(Brand.panelIcon(path));

        if (!this.menu)
            return;

        // Group in the order the groups first appear.
        const groups = [];
        for (const item of items) {
            const group = item.group ?? 'Tools';
            let bucket = groups.find(g => g.name === group);
            if (!bucket) {
                bucket = {name: group, items: []};
                groups.push(bucket);
            }
            bucket.items.push(item);
        }

        groups.forEach((group, index) => {
            if (index > 0)
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this.menu.addMenuItem(
                new PopupMenu.PopupMenuItem(group.name, {reactive: false}));

            for (const item of group.items)
                this.menu.addMenuItem(this._menuItem(item));
        });
    }

    _menuItem({id, label}) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => {
            if (this._onActivate)
                this._onActivate(id);
        });
        return item;
    }
});
