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
			<header className="flex items-center justify-between border-b border-th-border p-3 sm:p-4">
				<div className="flex items-center gap-3">
					{onOpenSidebar && (
						<button
							type="button"
							onClick={onOpenSidebar}
							className="rounded p-1 text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary md:hidden"
							aria-label="Open menu"
						>
							<Menu className="h-6 w-6" aria-hidden="true" />
						</button>
					)}
					<h1 className="text-lg font-bold text-th-text-primary sm:text-xl">
						{title}
					</h1>
				</div>
				<div className="flex items-center gap-3">
					{headerRight}
					<ThemeSwitcher />
					{onLogout && (
						<button
							type="button"
							onClick={onLogout}
							className="text-sm text-th-text-muted hover:text-th-text-primary"
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
