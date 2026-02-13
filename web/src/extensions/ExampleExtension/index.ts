import { DEFAULT_PRIORITY, type Extension } from "../../lib/extensions";
import AboutSection from "./settings/AboutSection";

export const id = "example-extension";

export const activate: Extension["activate"] = (ctx) => {
	ctx.settings.register({
		id: "about",
		label: "About",
		priority: DEFAULT_PRIORITY + 100,
		component: AboutSection,
	});
};
