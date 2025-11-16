import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';

import CopyousExtension from '../../extension.js';
import { Color } from '../common/color.js';
import { ItemType, getImagesPath } from '../common/constants.js';
import { registerClass } from '../common/gjs.js';
import { ClipboardEntry, ClipboardEntryTracker, FileOperation, Metadata } from './db.js';
import { Keyboard } from './keyboard.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');

const MimeTypes = {
	Text: ['text/plain', 'text/plain;charset=utf-8', 'STRING', 'UTF8_STRING'],
	Image: ['image/png', 'image/jxl', 'image/webp', 'image/avif', 'image/jpeg'],
	File: ['x-special-gnome-copied-files', 'text/uri-list'],
	Sensitive: ['x-kde-passwordManagerHint'],
} as const;

export const ContentType = {
	Text: 0,
	Image: 1,
	File: 2,
} as const;

export type ContentType = (typeof ContentType)[keyof typeof ContentType];

type ClipboardContent =
	| { type: (typeof ContentType)['Text']; text: string }
	| { type: (typeof ContentType)['Image']; mimetype: string; data: Uint8Array; checksum: string }
	| { type: (typeof ContentType)['File']; paths: string[]; operation: FileOperation };

function contentChecksum(content: ClipboardContent): string | null {
	switch (content.type) {
		case ContentType.Text:
			return GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, content.text, content.text.length);
		case ContentType.Image:
			return content.checksum;
		case ContentType.File: {
			const s = content.paths.map((f) => decodeURI(f).substring('file://'.length)).join('\n');
			return GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, s, s.length);
		}
	}
}

@registerClass({
	Signals: {
		clipboard: {
			param_types: [ClipboardEntry.$gtype],
		},
		text: {
			param_types: [GObject.TYPE_STRING],
		},
		image: {
			param_types: [GObject.TYPE_JSOBJECT, GObject.TYPE_INT, GObject.TYPE_INT],
		},
	},
})
export class ClipboardManager extends GObject.Object {
	private settings: Gio.Settings;
	private selection: Meta.Selection;
	private clipboard: St.Clipboard;
	private keyboard: Keyboard;
	private signalId: number = -1;
	private pasteSignalId: number = -1;

	private prevClipboard: [ContentType, string] | null = null;

	constructor(
		private ext: CopyousExtension,
		private tracker: ClipboardEntryTracker,
	) {
		super();

		this.settings = ext.getSettings();

		this.selection = global.display.get_selection();
		this.clipboard = St.Clipboard.get_default();
		this.keyboard = new Keyboard();

		this.signalId = this.selection.connect('owner-changed', this.ownerChanged.bind(this));
	}

	public destroy() {
		this.keyboard.destroy();

		if (this.signalId >= 0) this.selection.disconnect(this.signalId);
		if (this.pasteSignalId >= 0) GLib.source_remove(this.pasteSignalId);
		this.signalId = -1;
		this.pasteSignalId = -1;
	}

	public copyContent(content: ClipboardContent) {
		const checksum = contentChecksum(content);
		if (!checksum) return;
		this.prevClipboard = [content.type, checksum];

		// Text
		if (content.type === ContentType.Text) {
			this.clipboard.set_text(St.ClipboardType.CLIPBOARD, content.text);
			if (this.settings.get_boolean('sync-primary')) {
				this.clipboard.set_text(St.ClipboardType.PRIMARY, content.text);
			}
			return;
		}

		// Image
		if (content.type === ContentType.Image) {
			this.clipboard.set_content(St.ClipboardType.CLIPBOARD, content.mimetype, content.data);
			return;
		}

		// File
		if (content.type === ContentType.File) {
			const s = `${FileOperation.Copy}\n${content.paths.join('\n')}`;
			const bytes = new TextEncoder().encode(s);
			this.clipboard.set_content(St.ClipboardType.CLIPBOARD, MimeTypes.File[0], bytes);
			return;
		}
	}

	public pasteContent(content: ClipboardContent) {
		this.copyContent(content);

		if (!this.settings.get_boolean('paste-on-copy')) return;

		if (this.pasteSignalId >= 0) GLib.source_remove(this.pasteSignalId);
		this.pasteSignalId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
			// https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator/blob/89c57703641a9d5d15f899f6e780174641911d95/extension.js#L1094
			if (this.keyboard.purpose === Clutter.InputContentPurpose.TERMINAL) {
				this.keyboard.press(Clutter.KEY_Control_L);
				this.keyboard.press(Clutter.KEY_Shift_L);
				this.keyboard.press(Clutter.KEY_V);
				this.keyboard.release(Clutter.KEY_V);
				this.keyboard.release(Clutter.KEY_Shift_L);
				this.keyboard.release(Clutter.KEY_Control_L);
			} else {
				this.keyboard.press(Clutter.KEY_Control_L);
				this.keyboard.press(Clutter.KEY_v);
				this.keyboard.release(Clutter.KEY_v);
				this.keyboard.release(Clutter.KEY_Control_L);
			}

			this.pasteSignalId = -1;
			return GLib.SOURCE_REMOVE;
		});
	}

	public copyText(s: string) {
		this.copyContent({ type: ContentType.Text, text: s });
		this.emit('text', s);
	}

	public pasteText(s: string) {
		this.pasteContent({ type: ContentType.Text, text: s });
	}

	public copyPng(data: Uint8Array, width: number, height: number) {
		const checksum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.MD5, data);
		if (!checksum) return;
		this.copyContent({ type: ContentType.Image, mimetype: 'image/png', data, checksum });
		this.emit('image', data, width, height);
	}

	public async pasteEntry(entry: ClipboardEntry) {
		if (this.settings.get_boolean('update-date-on-copy')) {
			entry.datetime = GLib.DateTime.new_now_utc();
		}

		switch (entry.type) {
			case ItemType.Text:
			case ItemType.Code:
			case ItemType.Link:
			case ItemType.Character:
			case ItemType.Color:
				return this.pasteContent({ type: ContentType.Text, text: entry.content });
			case ItemType.Image:
				try {
					const image = Gio.File.new_for_uri(entry.content);
					const [contents, _etag] = await image.load_contents_async(null);
					const [contentType] = Gio.content_type_guess(image.get_path(), contents);
					const mimetype = Gio.content_type_get_mime_type(contentType);
					if (!mimetype) break;

					return this.pasteContent({ type: ContentType.Image, mimetype, data: contents, checksum: '' });
				} catch {
					break;
				}
			case ItemType.File:
			case ItemType.Files: {
				const paths = entry.content.split('\n');
				return this.pasteContent({ type: ContentType.File, paths, operation: FileOperation.Copy });
			}
		}
	}

	private shouldSave(): boolean {
		const window = global.display.focus_window;
		if (window) {
			const exclusions = this.settings.get_strv('wmclass-exclusions');
			if (exclusions.includes(window.wm_class)) return false;
		}

		return !this.settings.get_boolean('incognito');
	}

	private async ownerChanged(
		_selection: Meta.Selection,
		selectionType: Meta.SelectionType,
		_selectionSource: Meta.SelectionSource,
	) {
		try {
			if (selectionType !== Meta.SelectionType.SELECTION_CLIPBOARD) return;

			const content = await this.getContent(St.ClipboardType.CLIPBOARD);
			if (!content) return;

			const checksum = contentChecksum(content);
			if (!checksum) return;

			// Check duplicate
			if (this.prevClipboard) {
				const [type, prevChecksum] = this.prevClipboard;
				if (type === content.type && prevChecksum === checksum) {
					return;
				}

				// Do not update clipboard when clipboard ownership of a copied file is lost
				// i.e. nautilus is closed
				if (type === ContentType.File && content.type === ContentType.Text && prevChecksum === checksum) {
					return;
				}
			}

			this.prevClipboard = [content.type, checksum];

			// Check if history should be saved after setting the previous clipboard item.
			// This ensures that content copied in incognito mode is not saved to history
			// after copying an item after exiting incognito mode.
			if (!this.shouldSave()) return;

			const res = await this.convertContent(content);
			if (!res) return;

			const [type, text, metadata] = res;
			const entry = await this.tracker.insert(type, text, metadata);
			if (entry) {
				this.emit('clipboard', entry);
			}
		} catch (e) {
			this.ext.getLogger().error(e);
		}
	}

	private async getContent(clipboardType: St.ClipboardType): Promise<ClipboardContent | null> {
		return new Promise((resolve) => {
			const mimeTypes = this.clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);

			// Sensitive
			if (MimeTypes.Sensitive.some((value) => mimeTypes.includes(value))) {
				resolve(null);
				return;
			}

			// Image
			const imageMimeType = MimeTypes.Image.find((value) => mimeTypes.includes(value));
			if (imageMimeType) {
				this.clipboard.get_content(clipboardType, imageMimeType, (_, bytes) => {
					bytes = bytes instanceof Uint8Array ? bytes : bytes.toArray();
					if (bytes.length > 0) {
						const checksum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.MD5, bytes);
						if (!checksum) return resolve(null);
						return resolve({ type: ContentType.Image, mimetype: imageMimeType, data: bytes, checksum });
					} else {
						return resolve(null);
					}
				});
				return;
			}

			// File
			const fileMimeType = MimeTypes.File.find((value) => mimeTypes.includes(value));
			if (fileMimeType) {
				this.clipboard.get_content(clipboardType, fileMimeType, (_, bytes) => {
					bytes = bytes instanceof Uint8Array ? bytes : bytes.toArray();
					const text = new TextDecoder().decode(bytes).trim();
					if (text) {
						const files = text
							.split('\n')
							.map((f) => f.trim())
							.filter((f) => f.length !== 0);
						if (files[0] === FileOperation.Copy || files[0] === FileOperation.Cut) {
							return resolve({ type: ContentType.File, paths: files.slice(1), operation: files[0] });
						} else {
							return resolve({ type: ContentType.File, paths: files, operation: FileOperation.Copy });
						}
					} else {
						return resolve(null);
					}
				});
				return;
			}

			// Text
			const textMimeType = MimeTypes.Text.find((value) => mimeTypes.includes(value));
			if (textMimeType) {
				this.clipboard.get_text(clipboardType, (_, text) => {
					if (text && text.trim()) {
						return resolve({ type: ContentType.Text, text });
					} else {
						return resolve(null);
					}
				});
				return;
			}

			resolve(null);
		});
	}

	private async convertContent(content: ClipboardContent): Promise<[ItemType, string, Metadata | null] | null> {
		if (content.type === ContentType.Text) {
			const trimmed = content.text.trim();

			// Link
			try {
				if (trimmed.startsWith('http') && GLib.uri_is_valid(trimmed, GLib.UriFlags.NONE)) {
					return [ItemType.Link, content.text, null];
				}
			} catch {
				// Ignore
			}

			// Character
			const iterator = new Intl.Segmenter().segment(trimmed)[Symbol.iterator]();
			const maxCharacters = this.settings.get_child('character-item').get_int('max-characters');
			for (let i = 0; i < maxCharacters; i++) iterator.next();
			if (!iterator.next().value) {
				return [ItemType.Character, content.text, null];
			}

			// Color
			if (Color.parse(trimmed)) {
				return [ItemType.Color, content.text, null];
			}

			// Code
			const slice = trimmed.slice(0, 10000);
			const n = Math.max(1, slice.length / 100);
			const highlightResult = this.ext.hljs?.highlightAuto(slice);
			if (highlightResult && highlightResult.language && highlightResult.relevance / n >= 3) {
				const id = highlightResult.language;
				const name = this.ext.hljs?.getLanguage(id)?.name ?? id;

				const metadata = {
					language: { id, name: id.length < name.length - 3 ? id.charAt(0) + id.slice(1) : name },
				};
				return [ItemType.Code, content.text, metadata];
			}

			// Text
			return [ItemType.Text, content.text, null];
		}

		// Image
		if (content.type === ContentType.Image) {
			try {
				const path = getImagesPath(this.ext);
				if (!path.query_exists(null)) path.make_directory_with_parents(null);

				const image = path.get_child(content.checksum);
				if (!image.query_exists(null)) {
					await image.replace_contents_async(
						content.data,
						null,
						false,
						Gio.FileCreateFlags.REPLACE_DESTINATION,
						null,
					);
				}

				return [ItemType.Image, image.get_uri(), null];
			} catch {
				return null;
			}
		}

		// File
		if (content.type === ContentType.File) {
			const metadata = { operation: content.operation };
			if (content.paths.length === 1) {
				return [ItemType.File, content.paths[0]!, metadata];
			} else {
				return [ItemType.Files, content.paths.join('\n'), metadata];
			}
		}

		return null;
	}
}
