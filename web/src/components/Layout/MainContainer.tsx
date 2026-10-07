import { Menu, PanelLeftOpen, Settings } from "lucide-react";
import type { Ref } from "react";
import { useSidebarAttention } from "../../hooks/useSidebarAttention";
import {
	type SidebarKind,
	useHeaderUIConfig,
} from "../../lib/registries/headerUIRegistry";
import PortPreviewButton from "../PortPreview/PortPreviewButton";
import { BadgeDot, ConnectionStatus, headerIconButtonClass } from "../ui";

interface Props {
	children: React.ReactNode;
	/**
	 * Omitted while the sidebar is already on screen as a column, which is the
	 * only thing that decides whether the button exists. The tier is read once,
	 * by whoever owns the sidebar, and handed down as `sidebarKind`; a
	 * `lg:hidden` or a second `useIsExpanded` here would be another copy of
	 * that decision, and either half could then be edited into "a sidebar with
	 * no switch" or "a switch with no sidebar".
	 */
	onOpenSidebar?: () => void;
	sidebarKind?: SidebarKind;
	sidebarToggleRef?: Ref<HTMLButtonElement>;
	onOpenSettings?: () => void;
	/**
	 * The open session's name, or the project's where no session is in view.
	 * Handed to a custom `HeaderContent` and, when there is no `heading`, drawn
	 * here.
	 */
	title?: string;
	/**
	 * The heading of whatever is on screen — the session's, or a page's (its way
	 * back and its title) — replacing the default title. It owns its `h1`, and is
	 * given the room between the menu and the status, since a heading that does
	 * something has to be large enough to press.
	 */
	heading?: React.ReactNode;
}

function MainContainer({
	children,
	onOpenSidebar,
	sidebarKind = "drawer",
	sidebarToggleRef,
	onOpenSettings,
	title = "Pockode",
	heading,
}: Props) {
	const { HeaderContent, TitleComponent } = useHeaderUIConfig();
	const attention = useSidebarAttention();

	// If custom HeaderContent is provided, use it instead
	if (HeaderContent) {
		return (
			<div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-th-bg-primary">
				<HeaderContent
					onOpenSidebar={onOpenSidebar}
					sidebarKind={sidebarKind}
					sidebarToggleRef={sidebarToggleRef}
					onOpenSettings={onOpenSettings}
					title={title}
					heading={heading}
				/>
				{children}
			</div>
		);
	}

	return (
		<div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-th-bg-primary">
			{/* `gap-2` keeps a pressable heading 8px off the buttons beside it,
			    which a thumb needs between any two targets. */}
			<header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-th-border px-3 sm:h-12 sm:px-4">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					{onOpenSidebar && (
						// The drawer is a modal dialog, and while it is open this button
						// is inert behind it: an `aria-expanded` here could never be read
						// as true. The column is a region in the page, expanded in place.
						<button
							ref={sidebarToggleRef}
							type="button"
							onClick={onOpenSidebar}
							className={`relative -ml-2 ${headerIconButtonClass}`}
							{...(sidebarKind === "drawer"
								? { "aria-label": "Open sidebar", "aria-haspopup": "dialog" }
								: { "aria-label": "Expand sidebar", "aria-expanded": false })}
						>
							{sidebarKind === "drawer" ? (
								<Menu className="size-5" aria-hidden="true" />
							) : (
								<PanelLeftOpen className="size-5" aria-hidden="true" />
							)}
							{/* The tabs' badges seen from outside: with the sidebar off
							    screen they are too. Unspoken, like the badges themselves. */}
							<BadgeDot
								show={attention.show}
								tone={attention.tone}
								className="top-2.5 right-2.5 ring-2 ring-th-bg-primary"
							/>
						</button>
					)}
					{heading ?? (
						<h1 className="min-w-0 truncate text-base font-bold text-th-text-primary sm:text-lg">
							{TitleComponent ? <TitleComponent title={title} /> : title}
						</h1>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<ConnectionStatus />
					<PortPreviewButton />
					{onOpenSettings && (
						<button
							type="button"
							onClick={onOpenSettings}
							className={`-mr-1 ${headerIconButtonClass}`}
							aria-label="Settings"
						>
							<Settings className="size-5" aria-hidden="true" />
						</button>
					)}
				</div>
			</header>
			{children}
		</div>
	);
}

export default MainContainer;
