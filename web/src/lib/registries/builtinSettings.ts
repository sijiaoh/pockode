import {
	AccountSection,
	AppearanceSection,
	ThemeSection,
	WorktreeSection,
} from "../../components/Settings/sections";
import { registerSettingsSection } from "./settingsRegistry";

export function registerBuiltinSettings() {
	registerSettingsSection({
		id: "appearance",
		label: "Appearance",
		priority: 10,
		component: AppearanceSection,
	});

	registerSettingsSection({
		id: "theme",
		label: "Theme",
		priority: 20,
		component: ThemeSection,
	});

	registerSettingsSection({
		id: "worktree",
		label: "Worktree",
		priority: 30,
		component: WorktreeSection,
	});

	registerSettingsSection({
		id: "account",
		label: "Account",
		priority: 100,
		component: AccountSection,
	});
}
