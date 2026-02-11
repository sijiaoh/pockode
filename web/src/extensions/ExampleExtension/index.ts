import type { ExtensionContext } from "../../lib/extensions";
import { DEFAULT_PRIORITY } from "../../lib/registries/settingsRegistry";
import AboutSection from "./settings/AboutSection";

export const id = "example-extension";

export function activate(ctx: ExtensionContext) {
	ctx.settings.register({
		id: "about",
		label: "About",
		priority: DEFAULT_PRIORITY + 100,
		component: AboutSection,
	});
}
