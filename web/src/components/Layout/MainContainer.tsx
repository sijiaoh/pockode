import { Menu, Settings } from "lucide-react";
import { useHeaderUIConfig } from "../../lib/registries/headerUIRegistry";
import { ConnectionStatus } from "../ui";
import { headerIconButtonClass } from "../ui/headerIconButtonClass";

interface Props {
	children: React.ReactNode;
	/**
	 * Omitted when there is no drawer to open, which is the only thing that
	 * decides whether the hamburger exists. The tier is read once, by whoever
	 * owns the sidebar; a `lg:hidden` here would be a second copy of that
	 * decision, and either half could then be edited into "a sidebar with no
	 * switch" or "a switch with no sidebar".
	 */
	onOpenSidebar?: () => void;
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
	onOpenSettings,
	title = "Pockode",
	heading,
}: Props) {
	const { HeaderContent, TitleComponent } = useHeaderUIConfig();

	// If custom HeaderContent is provided, use it instead
	if (HeaderContent) {
		return (
			<div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-th-bg-primary">
				<HeaderContent
					onOpenSidebar={onOpenSidebar}
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
			{/* `gap-2` keeps a pressable heading 8px off the status and settings,
			    which a thumb needs between any two targets. */}
			<header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-th-border px-3 sm:h-12 sm:px-4">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					{onOpenSidebar && (
						<button
							type="button"
							onClick={onOpenSidebar}
							className={`-ml-2 ${headerIconButtonClass}`}
							aria-label="Open menu"
						>
							<Menu className="size-5" aria-hidden="true" />
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
