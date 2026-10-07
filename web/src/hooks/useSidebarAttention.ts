import type { BadgeDotTone } from "../components/ui/BadgeDot";
import { useSidebarUIConfig } from "../lib/registries/sidebarUIRegistry";
import { useSessionStore } from "../lib/sessionStore";
import { useHasUploadActivity } from "../lib/uploadStore";
import { useWorkNeedsAttention } from "../lib/workStore";

export interface SidebarAttention {
	sessionsUnread: boolean;
	/**
	 * The upload queue lives inside the Files tab and is hidden from every other
	 * one, so this is the only sign an upload is still running or has failed.
	 */
	uploadActivity: boolean;
	worksNeedAttention: boolean;
	/** Whether the button that brings the sidebar back should wear a dot. */
	show: boolean;
	tone: BadgeDotTone;
}

/**
 * The tab badges and the dot on the button that brings the sidebar on screen,
 * read from one place: the dot is the tabs' badges seen from outside, and two
 * copies of the rule could light one without the other.
 *
 * The Git count is left out of `show`: it is the state of the repository, not
 * something that happened. Nor is anything shown when an extension's
 * `SidebarContent` replaces the built-in tabs, since the dot would point at
 * badges that are not there.
 */
export function useSidebarAttention(): SidebarAttention {
	// The server's answer over the whole list, not the loaded page's
	// (docs/list-paging-ui.md §2.1).
	const sessionsUnread = useSessionStore((s) => s.hasUnread);
	const uploadActivity = useHasUploadActivity();
	const worksNeedAttention = useWorkNeedsAttention();
	const { SidebarContent } = useSidebarUIConfig();

	return {
		sessionsUnread,
		uploadActivity,
		worksNeedAttention,
		show:
			!SidebarContent &&
			(sessionsUnread || uploadActivity || worksNeedAttention),
		// A person being waited on outranks news, as it does on the tabs.
		tone: worksNeedAttention ? "attention" : "news",
	};
}
