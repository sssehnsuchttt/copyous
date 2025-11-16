import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import St from 'gi://St';

import { Extension, gettext as _, ngettext } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import { ItemType } from '../common/constants.js';
import { registerClass } from '../common/gjs.js';
import { Icon } from '../common/icons.js';
import { normalizeIndentation, trim } from '../ui/components/label.js';
import { commonDirectory } from '../ui/items/filesItem.js';
import { ClipboardEntry } from './db.js';

@registerClass()
export class NotificationManager extends GObject.Object {
	private readonly _ext: Extension;
	private readonly _settings: Gio.Settings;
	private _source: MessageTray.Source | null = null;

	constructor(ext: Extension) {
		super();

		this._ext = ext;
		this._settings = ext.getSettings();
	}

	private get source() {
		if (this._source) return this._source;

		this._source = new MessageTray.Source({
			title: this._ext.metadata.name,
			icon: Icon.Clipboard.load(this._ext),
		});

		this._source.connect('destroy', () => (this._source = null));
		Main.messageTray.add(this._source);
		return this._source;
	}

	public warning(title: string, body: string, ...actions: [label: string, callback: () => void][]) {
		const source = this.source;
		const notification = new MessageTray.Notification({
			source,
			title,
			body,
			gicon: Icon.Warning.load(this._ext),
		});

		for (const [label, callback] of actions) {
			notification.addAction(label, callback);
		}

		source.addNotification(notification);
	}

	public textNotification(text: string) {
		if (!this._settings.get_boolean('send-notification')) return;

		const source = this.source;
		const notification = new MessageTray.Notification({
			source,
			title: _('Copied Text'),
			body: text,
			gicon: Icon.Text.load(this._ext),
			isTransient: true,
		});
		source.addNotification(notification);
	}

	private createImageContent(pixbuf: GdkPixbuf.Pixbuf): St.ImageContent {
		const context = global.stage.context.get_backend().get_cogl_context();
		const pixels = pixbuf.get_pixels();
		const content = new St.ImageContent({
			preferred_width: pixbuf.width,
			preferred_height: pixbuf.height,
		});
		content.set_bytes(context, pixels, Cogl.PixelFormat.RGBA_8888, pixbuf.width, pixbuf.height, pixbuf.rowstride);
		return content;
	}

	public imageNotification(bytes: GLib.Bytes | Uint8Array, width: number, height: number) {
		if (!this._settings.get_boolean('send-notification')) return;

		let gicon: Gio.Icon | St.ImageContent;
		try {
			const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
			const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_at_scale(stream, 256, 256, true, null);
			gicon = this.createImageContent(pixbuf);
		} catch (error) {
			this._ext.getLogger().error(error);
			return;
		}

		const source = this.source;
		const notification = new MessageTray.Notification({
			source,
			title: _('Copied Image'),
			body: _('Size: %d×%d px').format(width, height),
			gicon,
			isTransient: true,
		});
		source.addNotification(notification);
	}

	public notification(entry: ClipboardEntry) {
		if (!this._settings.get_boolean('send-notification')) return;

		let title: string;
		let body: string | null = normalizeIndentation(trim(entry.content), 4);
		let gicon: Gio.Icon | St.ImageContent;
		switch (entry.type) {
			case ItemType.Text:
				title = _('Copied Text');
				gicon = Icon.Text.load(this._ext);
				break;
			case ItemType.Code:
				title = _('Copied Code');
				gicon = Icon.Code.load(this._ext);
				break;
			case ItemType.Image: {
				const file = body.substring('file://'.length);
				title = _('Copied Image');

				try {
					const [, width, height] = GdkPixbuf.Pixbuf.get_file_info(file);
					const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(file, 256, 256, true);
					gicon = this.createImageContent(pixbuf);
					body = _('Size: %d×%d px').format(width, height);
				} catch (error) {
					this._ext.getLogger().error(error);
					return;
				}

				break;
			}
			case ItemType.File:
			case ItemType.Files: {
				const files = body.split('\n').map((f) => Gio.file_new_for_uri(f));
				const common = files.length === 1 ? files[0]! : commonDirectory(files);

				title = ngettext('Copied %d File', 'Copied %d Files', files.length).format(files.length);
				body = common.get_path() ?? '';
				gicon = (files.length === 1 ? Icon.File : Icon.Folder).load(this._ext);
				break;
			}
			case ItemType.Link:
				title = _('Copied Link');
				gicon = Icon.Link.load(this._ext);
				break;
			case ItemType.Character:
				title = _('Copied Character');
				gicon = Icon.Character.load(this._ext);
				break;
			case ItemType.Color:
				title = _('Copied Color');
				gicon = Icon.Color.load(this._ext);
				break;
		}

		const source = this.source;
		const notification = new MessageTray.Notification({ source, title, body, gicon, isTransient: true });
		source.addNotification(notification);
	}
}
