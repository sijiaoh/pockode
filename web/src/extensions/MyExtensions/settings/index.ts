import { registerSettingsSection } from "../../../lib/registries/settingsRegistry";
import AboutSection from "./AboutSection";

registerSettingsSection({
	id: "about",
	label: "About",
	priority: 200,
	component: AboutSection,
});
