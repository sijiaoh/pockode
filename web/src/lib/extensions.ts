import {
	type ChatUIConfig,
	resetChatUIConfig,
	setChatUIConfig,
} from "./registries/chatUIRegistry";
import {
	registerSettingsSection,
	type SettingsSectionConfig,
} from "./registries/settingsRegistry";

export interface ExtensionContext {
	readonly id: string;
	readonly settings: {
		register(config: SettingsSectionConfig): void;
	};
	readonly chatUI: {
		configure(config: Partial<ChatUIConfig>): void;
	};
}

interface InternalExtensionContext extends ExtensionContext {
	dispose(): void;
}

function createExtensionContext(extensionId: string): InternalExtensionContext {
	const disposables: Array<() => void> = [];

	return {
		id: extensionId,
		settings: {
			register(config) {
				const unregister = registerSettingsSection(config);
				disposables.push(unregister);
			},
		},
		chatUI: {
			configure(config) {
				setChatUIConfig(config);
				disposables.push(() => resetChatUIConfig());
			},
		},
		dispose() {
			for (const fn of disposables) {
				fn();
			}
			disposables.length = 0;
		},
	};
}

export interface ExtensionModule {
	id: string;
	activate(ctx: ExtensionContext): void;
}

const loadedExtensions = new Map<string, InternalExtensionContext>();

export function loadExtension(extension: ExtensionModule): void {
	const { id } = extension;
	if (loadedExtensions.has(id)) {
		console.warn(`Extension "${id}" already loaded`);
		return;
	}
	const ctx = createExtensionContext(id);
	extension.activate(ctx);
	loadedExtensions.set(id, ctx);
}

export function unloadExtension(id: string): boolean {
	const ctx = loadedExtensions.get(id);
	if (!ctx) return false;
	ctx.dispose();
	loadedExtensions.delete(id);
	return true;
}

export function loadAllExtensions(): void {
	const modules = import.meta.glob<ExtensionModule>(
		"../extensions/*/index.ts",
		{ eager: true },
	);

	for (const module of Object.values(modules)) {
		loadExtension(module);
	}
}
