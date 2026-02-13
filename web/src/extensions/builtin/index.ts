import {
	AccountSection,
	AppearanceSection,
	ThemeSection,
	WorktreeSection,
} from "../../components/Settings/sections";
import type { Extension } from "../../lib/extensions";

// Builtin sections use 0-99
const PRIORITY = {
	APPEARANCE: 10,
	THEME: 20,
	WORKTREE: 30,
	ACCOUNT: 90,
} as const;

export const id = "builtin";

export const activate: Extension["activate"] = (ctx) => {
	ctx.settings.register({
		id: "appearance",
		label: "Appearance",
		priority: PRIORITY.APPEARANCE,
		component: AppearanceSection,
	});

	ctx.settings.register({
		id: "theme",
		label: "Theme",
		priority: PRIORITY.THEME,
		component: ThemeSection,
	});

	ctx.settings.register({
		id: "worktree",
		label: "Worktree",
		priority: PRIORITY.WORKTREE,
		component: WorktreeSection,
	});

	ctx.settings.register({
		id: "account",
		label: "Account",
		priority: PRIORITY.ACCOUNT,
		component: AccountSection,
	});
};
