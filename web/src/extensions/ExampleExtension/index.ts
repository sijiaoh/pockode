import { DEFAULT_PRIORITY, type Extension } from "../../lib/extensions";
import AboutSection from "./settings/AboutSection";

// Uncomment below import to enable custom header UI
// import CustomHeaderTitle from "./headerUI/CustomHeaderTitle";

// Uncomment below import to enable custom sidebar UI
// import CustomSidebarContent from "./sidebarUI/CustomSidebarContent";

// Uncomment below imports to enable custom chat UI
// import CustomAssistantAvatar from "./chatUI/CustomAssistantAvatar";
// import CustomChatTopContent from "./chatUI/CustomChatTopContent";
// import CustomEmptyState from "./chatUI/CustomEmptyState";
// import CustomInputBar from "./chatUI/CustomInputBar";
// import CustomUserAvatar from "./chatUI/CustomUserAvatar";

export const id = "example-extension";

export const activate: Extension["activate"] = (ctx) => {
	ctx.settings.register({
		id: "about",
		label: "About",
		priority: DEFAULT_PRIORITY + 100,
		component: AboutSection,
	});

	// Uncomment below to enable custom header title
	// ctx.headerUI.configure({
	// 	TitleComponent: CustomHeaderTitle,
	// });

	// Uncomment below to enable custom sidebar UI (replaces default tabbed sidebar)
	// ctx.sidebarUI.configure({
	// 	SidebarContent: CustomSidebarContent,
	// });

	// Uncomment below to enable custom chat UI (avatars, input bar, empty state, etc.)
	// ctx.chatUI.configure({
	// 	UserAvatar: CustomUserAvatar,
	// 	AssistantAvatar: CustomAssistantAvatar,
	// 	InputBar: CustomInputBar,
	// 	EmptyState: CustomEmptyState,
	// 	ChatTopContent: CustomChatTopContent,
	// 	ModeSelector: null,
	// 	StopButton: null,
	// });

	// Uncomment below to register a custom theme
	// ctx.theme.register(
	// 	"my-theme",
	// 	{
	// 		label: "My Theme",
	// 		description: "Custom theme example",
	// 		accent: { light: "#0ea5e9", dark: "#7dd3fc" },
	// 		bg: { light: "#f8fafc", dark: "#0c1929" },
	// 		text: { light: "#0c1929", dark: "#f0f9ff" },
	// 		textMuted: { light: "#64748b", dark: "#94a3b8" },
	// 	},
	// 	`.theme-my-theme { --th-accent: #0ea5e9; }`,
	// );
};
