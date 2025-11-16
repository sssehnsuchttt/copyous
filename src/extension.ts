import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import type HLJSApi from 'highlight.js';
import type { LanguageFn } from 'highlight.js';

import { ClipboardHistory, getHljsLanguages, getHljsPath } from './lib/common/constants.js';
import { DbusService } from './lib/common/dbus.js';
import { SoundManager, tryCreateSoundManager } from './lib/common/sound.js';
import { ClipboardManager } from './lib/misc/clipboard.js';
import { ClipboardEntry, ClipboardEntryTracker } from './lib/misc/db.js';
import { NotificationManager } from './lib/misc/notifications.js';
import { ShortcutManager } from './lib/misc/shortcuts.js';
import { ClipboardDialog } from './lib/ui/clipboardDialog.js';
import { ClipboardIndicator } from './lib/ui/indicator.js';

export default class CopyousExtension extends Extension {
	public hljs: typeof HLJSApi | null | undefined;
	private hljsCallbacks: (() => void)[] | undefined;

	private clipboardDialog: ClipboardDialog | undefined;
	private indicator: ClipboardIndicator | undefined;

	private dbus: DbusService | undefined;

	public notificationManager: NotificationManager | undefined;
	private soundManager: SoundManager | undefined;

	public shortcutsManager: ShortcutManager | undefined;

	private settings: Gio.Settings | undefined;
	private entryTracker: ClipboardEntryTracker | undefined;
	private historyTimeoutId: number = -1;
	private updateHistory: boolean = false;

	public clipboardManager: ClipboardManager | undefined;

	override enable() {
		const logger = this.getLogger();
		const error = logger.error.bind(logger);

		// Highlight.js
		this.initHljs().catch(error);

		// UI
		this.clipboardDialog = new ClipboardDialog(this);
		this.clipboardDialog.connect('notify::opened', async () => {
			// Update the history when the dialog is closed and an update was scheduled while the dialog was open
			if (!this.clipboardDialog?.opened && this.updateHistory) {
				await this.entryTracker?.deleteOldest();
			}
		});

		this.indicator = new ClipboardIndicator(this);
		this.indicator.connect('open-dialog', () => this.clipboardDialog?.open());
		this.indicator.connect('clear-history', (_, history: ClipboardHistory) => this.entryTracker?.clear(history));

		// DBus
		this.dbus = new DbusService();
		this.dbus.connect('toggle', () => this.clipboardDialog?.toggle());
		this.dbus.connect('show', () => this.clipboardDialog?.open());
		this.dbus.connect('hide', () => this.clipboardDialog?.close());
		this.dbus.connect('clear-history', (_, history: ClipboardHistory | -1) =>
			this.entryTracker?.clear(history === -1 ? null : history),
		);

		// Feedback
		this.notificationManager = new NotificationManager(this);
		tryCreateSoundManager(this)
			.then((soundManager) => {
				if (soundManager) this.soundManager = soundManager;
			})
			.catch(error);

		// Shortcuts
		this.shortcutsManager = new ShortcutManager(this, this.clipboardDialog);
		this.shortcutsManager.connect('open-clipboard-dialog', () => this.clipboardDialog?.toggle());
		this.shortcutsManager.connect('toggle-incognito-mode', () => this.indicator?.toggleIncognito());

		// Database
		this.entryTracker = new ClipboardEntryTracker(this);
		this.initEntryTracker().catch(error);

		this.settings = this.getSettings();
		this.settings.connectObject(
			'changed::database-location',
			this.initEntryTracker.bind(this),
			'changed::in-memory-database',
			this.initEntryTracker.bind(this),
			this,
		);

		this.initHistoryTimeout().catch(error);
		this.settings.connect('changed::history-time', this.initHistoryTimeout.bind(this));

		// Clipboard Manager
		this.clipboardManager = new ClipboardManager(this, this.entryTracker);
		this.clipboardManager.connect('clipboard', (_, entry: ClipboardEntry) => {
			this.clipboardDialog?.addEntry(entry);
			this.indicator?.animate();
			this.notificationManager?.notification(entry);
			this.soundManager?.playSound();
		});
		this.clipboardManager.connect('text', (_, text: string) => {
			this.indicator?.animate();
			this.notificationManager?.textNotification(text);
			this.soundManager?.playSound();
		});
		this.clipboardManager.connect('image', (_, image: Uint8Array, width: number, height: number) => {
			this.indicator?.animate();
			this.notificationManager?.imageNotification(image, width, height);
			this.soundManager?.playSound();
		});
	}

	private async initHljs() {
		try {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			const hljs: typeof import('highlight.js') = await import(getHljsPath(this).get_uri());
			this.hljs = hljs.default;

			// Initialize extra languages
			const languages = getHljsLanguages(this);
			await Promise.all(
				languages.map(async ([name, _language, _hash, path]) => {
					if (!path.query_exists(null)) return;

					try {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
						const language: { default: LanguageFn } = await import(path.get_uri());
						this.hljs?.registerLanguage(name, language.default);
					} catch {
						this.getLogger().error(`Failed to register language "${name}"`);
					}
				}),
			);
		} catch {
			this.hljs = null;
		}

		this.hljsCallbacks?.forEach((fn) => fn());
		this.hljsCallbacks = undefined;
	}

	public connectHljsInit(fn: () => void) {
		if (this.hljs !== undefined) return;

		this.hljsCallbacks ??= [];
		this.hljsCallbacks.push(fn);
	}

	private async initEntryTracker() {
		if (!this.entryTracker) return;

		const entries = await this.entryTracker.init();
		for (const entry of entries) {
			this.clipboardDialog?.addEntry(entry);
		}
	}

	private async initHistoryTimeout() {
		if (this.historyTimeoutId >= 0) GLib.source_remove(this.historyTimeoutId);

		const historyTime = this.settings?.get_int('history-time');
		if (historyTime === undefined || historyTime === 0) return;

		await this.entryTracker?.deleteOldest();
		this.historyTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
			// Do not update the history if the dialog is open
			this.updateHistory = this.clipboardDialog?.opened ?? false;
			if (this.updateHistory) return GLib.SOURCE_CONTINUE;

			if (this.entryTracker?.checkOldest()) {
				const logger = this.getLogger();
				this.entryTracker?.deleteOldest().catch(logger.error.bind(logger));
			}

			return GLib.SOURCE_CONTINUE;
		});
	}

	override disable() {
		// Highlight.js
		this.hljs = undefined;
		this.hljsCallbacks = undefined;

		// UI
		this.clipboardDialog?.destroy();
		this.indicator?.destroy();
		this.clipboardDialog = undefined;
		this.indicator = undefined;

		// DBus
		this.dbus?.destroy();
		this.dbus = undefined;

		// Feedback
		this.notificationManager = undefined;
		this.soundManager = undefined;

		// Shortcuts
		this.shortcutsManager?.destroy();
		this.shortcutsManager = undefined;

		// Database
		this.settings?.disconnectObject(this);
		this.settings = undefined;

		const logger = this.getLogger();
		this.entryTracker?.destroy().catch(logger.error.bind(logger));
		this.entryTracker = undefined;

		if (this.historyTimeoutId >= 0) GLib.source_remove(this.historyTimeoutId);
		this.historyTimeoutId = -1;

		// Clipboard Manager
		this.clipboardManager?.destroy();
		this.clipboardManager = undefined;
	}

	/* DEBUG-ONLY */
	override getSettings(schema?: string): Gio.Settings {
		try {
			const environment = GLib.get_environ();
			const settings = GLib.environ_getenv(environment, 'DEBUG_COPYOUS_SCHEMA');
			if (Number(settings)) schema ??= this.metadata['settings-schema'] + '.debug';

			return super.getSettings(schema);
		} catch {
			// Fallback for when debug schema does not exist
			return super.getSettings();
		}
	}
}
