import { Menu } from "lucide-react";
import { ThemeSwitcher } from "../ui";

interface Props {
	children: React.ReactNode;
	onOpenSidebar?: () => void;
	onLogout?: () => void;
	title?: string;
	headerRight?: React.ReactNode;
}

function MainContainer({
	children,
	onOpenSidebar,
	onLogout,
	title = "Pockode",
	headerRight,
}: Props) {
	return (
		<div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-th-bg-primary">
			<header className="flex h-11 shrink-0 items-center justify-between border-b border-th-border px-3 sm:h-12 sm:px-4">
				<div className="flex items-center gap-2">
					{onOpenSidebar && (
						<button
							type="button"
							onClick={onOpenSidebar}
							className="-ml-1 flex h-8 w-8 items-center justify-center rounded text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary md:hidden"
							aria-label="Open menu"
						>
							<Menu className="h-5 w-5" aria-hidden="true" />
						</button>
					)}
					<h1 className="text-base font-semibold text-th-text-primary sm:text-lg">
						{title}
					</h1>
				</div>
				<div className="flex items-center gap-2">
					{headerRight}
					<ThemeSwitcher />
					{onLogout && (
						<button
							type="button"
							onClick={onLogout}
							className="rounded px-2 py-1 text-sm text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
						>
							Logout
						</button>
					)}
				</div>
			</header>
			{children}
		</div>
	);
}

export default MainContainer;
