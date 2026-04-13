import { Menu, Settings } from "lucide-react";
import { useHeaderUIConfig } from "../../lib/registries/headerUIRegistry";
import { ConnectionStatus } from "../ui";

interface Props {
	children: React.ReactNode;
	onOpenSidebar?: () => void;
	onOpenSettings?: () => void;
	title?: string;
}

function MainContainer({
	children,
	onOpenSidebar,
	onOpenSettings,
	title = "Pockode",
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
				/>
				{children}
			</div>
		);
	}

	return (
		<div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-th-bg-primary">
			<header className="flex h-11 shrink-0 items-center justify-between border-b border-th-border px-3 sm:h-12 sm:px-4">
				<div className="flex items-center gap-2">
					{onOpenSidebar && (
						<button
							type="button"
							onClick={onOpenSidebar}
							className="-ml-2 flex h-11 w-11 items-center justify-center rounded text-th-text-muted transition-all hover:bg-th-bg-tertiary hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 md:hidden"
							aria-label="Open menu"
						>
							<Menu className="h-5 w-5" aria-hidden="true" />
						</button>
					)}
					{TitleComponent ? (
						<TitleComponent />
					) : (
						<h1 className="text-base font-bold text-th-text-primary sm:text-lg">
							{title}
						</h1>
					)}
				</div>
				<div className="flex items-center gap-2">
					<ConnectionStatus />
					{onOpenSettings && (
						<button
							type="button"
							onClick={onOpenSettings}
							className="-mr-1 flex h-11 w-11 items-center justify-center rounded text-th-text-muted transition-all hover:bg-th-bg-tertiary hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95"
							aria-label="Settings"
						>
							<Settings className="h-5 w-5" aria-hidden="true" />
						</button>
					)}
				</div>
			</header>
			{children}
		</div>
	);
}

export default MainContainer;
