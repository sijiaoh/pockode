import {
	type ChatUIConfig,
	resetChatUIConfig,
	setChatUIConfig,
} from "./registries/chatUIRegistry";
import {
	DEFAULT_PRIORITY,
	registerSettingsSection,
	type SettingsSectionConfig,
} from "./registries/settingsRegistry";

export { DEFAULT_PRIORITY };
export type { SettingsSectionConfig };

export interface ExtensionContext {
	readonly id: string;
	readonly settings: {
		/** config.id will be prefixed with extension id */
		register(config: SettingsSectionConfig): void;
	};
	readonly chatUI: {
		configure(config: Partial<ChatUIConfig>): void;
	};
}

export interface Extension {
	readonly id: string;
	activate(ctx: ExtensionContext): void;
}

interface InternalContext extends ExtensionContext {
	dispose(): void;
}

function createContext(extensionId: string): InternalContext {
	const disposables: Array<() => void> = [];

	return {
		id: extensionId,
		settings: {
			register(config) {
				const namespaced: SettingsSectionConfig = {
					...config,
					id: `${extensionId}.${config.id}`,
				};
				const unregister = registerSettingsSection(namespaced);
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
		},
	};
}

const loaded = new Map<string, InternalContext>();

export function loadExtension(extension: Extension): boolean {
	const { id } = extension;

	if (loaded.has(id)) {
		console.warn(`Extension "${id}" is already loaded`);
		return false;
	}

	const context = createContext(id);
	extension.activate(context);
	loaded.set(id, context);
	return true;
}

export function unloadExtension(id: string): boolean {
	const context = loaded.get(id);
	if (!context) return false;

	context.dispose();
	loaded.delete(id);
	return true;
}

export function isExtensionLoaded(id: string): boolean {
	return loaded.has(id);
}

export function getLoadedExtensions(): string[] {
	return Array.from(loaded.keys());
}

type ExtensionModule = {
	id?: string;
	activate?: (ctx: ExtensionContext) => void;
	default?: Extension;
};

function isValidExtension(mod: ExtensionModule): mod is Extension {
	return typeof mod.id === "string" && typeof mod.activate === "function";
}

export function loadAllExtensions(): void {
	const modules = import.meta.glob<ExtensionModule>(
		"../extensions/*/index.ts",
		{ eager: true },
	);

	for (const [path, mod] of Object.entries(modules)) {
		const extension = mod.default ?? mod;

		if (isValidExtension(extension)) {
			loadExtension(extension);
		} else {
			console.error(
				`Invalid extension at ${path}: must export 'id' and 'activate'`,
			);
		}
	}
}
