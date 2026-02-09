type ExtensionInitFn = () => void;

const extensions: ExtensionInitFn[] = [];

export function registerExtension(init: ExtensionInitFn) {
	extensions.push(init);
}

// Initialize all extensions synchronously (before React rendering)
export function initializeExtensions() {
	for (const fn of extensions) {
		fn();
	}
}
