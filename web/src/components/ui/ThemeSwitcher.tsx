import { Check, Monitor, Moon, Sun } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	THEME_INFO,
	THEME_NAMES,
	type ThemeMode,
	type ThemeName,
	useTheme,
} from "../../hooks/useTheme";
import { isMobile } from "../../utils/breakpoints";

const MODE_OPTIONS: { value: ThemeMode; label: string; icon: ReactNode }[] = [
	{
		value: "light",
		label: "Light",
		icon: <Sun className="h-4 w-4" aria-hidden="true" />,
	},
	{
		value: "dark",
		label: "Dark",
		icon: <Moon className="h-4 w-4" aria-hidden="true" />,
	},
	{
		value: "system",
		label: "Auto",
		icon: <Monitor className="h-4 w-4" aria-hidden="true" />,
	},
];

function ThemePreview({
	themeName,
	isSelected,
	isDarkMode,
}: {
	themeName: ThemeName;
	isSelected: boolean;
	isDarkMode: boolean;
}) {
	const info = THEME_INFO[themeName];
	const accentColor = isDarkMode ? info.accentDark : info.accentLight;
	const previewBg = isDarkMode ? info.previewBgDark : info.previewBgLight;

	return (
		<div
			className="relative h-10 w-full overflow-hidden rounded-md"
			style={{ backgroundColor: previewBg }}
		>
			{/* Accent line */}
			<div
				className="absolute bottom-0 left-0 h-1 w-full"
				style={{ backgroundColor: accentColor }}
			/>
			{/* Content preview dots */}
			<div className="flex flex-col gap-1 p-2">
				<div
					className="h-1 w-8 rounded-full opacity-60"
					style={{ backgroundColor: isDarkMode ? "#fff" : "#000" }}
				/>
				<div
					className="h-1 w-5 rounded-full opacity-40"
					style={{ backgroundColor: isDarkMode ? "#fff" : "#000" }}
				/>
			</div>
			{/* Selection indicator */}
			{isSelected && (
				<div
					className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full"
					style={{ backgroundColor: accentColor }}
				>
					<Check
						className="h-2.5 w-2.5 text-white"
						strokeWidth={3}
						aria-hidden="true"
					/>
				</div>
			)}
		</div>
	);
}

function ThemeSwitcher() {
	const { mode, setMode, theme, setTheme, resolvedMode } = useTheme();
	const [isOpen, setIsOpen] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);

	const isDarkMode = resolvedMode === "dark";

	// Close panel on outside click
	useEffect(() => {
		if (!isOpen) return;

		const handleClickOutside = (e: MouseEvent) => {
			if (
				panelRef.current &&
				!panelRef.current.contains(e.target as Node) &&
				buttonRef.current &&
				!buttonRef.current.contains(e.target as Node)
			) {
				setIsOpen(false);
			}
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [isOpen]);

	// Close on Escape
	useEffect(() => {
		if (!isOpen) return;

		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") setIsOpen(false);
		};

		document.addEventListener("keydown", handleEscape);
		return () => document.removeEventListener("keydown", handleEscape);
	}, [isOpen]);

	// Prevent body scroll when panel is open on mobile
	useEffect(() => {
		if (!isOpen) return;

		if (!isMobile()) return;

		const originalOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		return () => {
			document.body.style.overflow = originalOverflow;
		};
	}, [isOpen]);

	const modeIcon = isDarkMode ? (
		<Moon className="h-4 w-4" aria-hidden="true" />
	) : (
		<Sun className="h-4 w-4" aria-hidden="true" />
	);

	return (
		<div className="relative">
			<button
				ref={buttonRef}
				type="button"
				onClick={() => setIsOpen(!isOpen)}
				className="flex h-8 w-8 items-center justify-center rounded text-th-text-muted transition-transform hover:bg-th-bg-tertiary hover:text-th-text-primary active:scale-95"
				aria-label="Theme settings"
				aria-expanded={isOpen}
			>
				{modeIcon}
			</button>

			{isOpen && (
				<>
					{/* Backdrop for mobile */}
					<div
						className="fixed inset-0 z-40 bg-black/50 sm:hidden"
						onClick={() => setIsOpen(false)}
						aria-hidden="true"
					/>
					<div
						ref={panelRef}
						className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80dvh] flex-col rounded-t-2xl border-t border-th-border bg-th-bg-primary pt-3 shadow-xl sm:absolute sm:inset-auto sm:right-0 sm:top-full sm:mt-2 sm:w-72 sm:rounded-xl sm:border sm:pt-4"
						role="dialog"
						aria-label="Theme settings"
					>
						{/* Drag handle for mobile - stays fixed at top */}
						<div className="mb-3 flex shrink-0 justify-center sm:hidden">
							<div className="h-1 w-10 rounded-full bg-th-text-muted/30" />
						</div>
						{/* Scrollable content area */}
						<div className="overflow-y-auto px-4 pb-[max(2rem,env(safe-area-inset-bottom))] sm:pb-4">
							{/* Mode Selection */}
							<div className="mb-4">
								<div className="mb-2 text-xs font-medium uppercase tracking-wider text-th-text-muted">
									Appearance
								</div>
								<div className="flex gap-1 rounded-lg bg-th-bg-secondary p-1">
									{MODE_OPTIONS.map((option) => (
										<button
											key={option.value}
											type="button"
											onClick={() => setMode(option.value)}
											className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm transition-all active:scale-95 ${
												mode === option.value
													? "bg-th-bg-primary text-th-text-primary shadow-sm"
													: "text-th-text-muted hover:text-th-text-secondary"
											}`}
										>
											{option.icon}
											<span>{option.label}</span>
										</button>
									))}
								</div>
							</div>

							{/* Theme Selection */}
							<div>
								<div className="mb-2 text-xs font-medium uppercase tracking-wider text-th-text-muted">
									Theme
								</div>
								<div className="grid grid-cols-1 gap-2">
									{THEME_NAMES.map((name) => {
										const info = THEME_INFO[name];
										const isSelected = theme === name;
										return (
											<button
												key={name}
												type="button"
												onClick={() => setTheme(name)}
												className={`group overflow-hidden rounded-lg border text-left transition-all active:scale-[0.98] ${
													isSelected
														? "border-th-accent ring-1 ring-th-accent"
														: "border-th-border hover:border-th-text-muted"
												}`}
											>
												<ThemePreview
													themeName={name}
													isSelected={isSelected}
													isDarkMode={isDarkMode}
												/>
												<div className="flex min-h-12 items-center justify-between bg-th-bg-secondary px-3 py-2">
													<div>
														<div
															className={`text-sm font-medium ${isSelected ? "text-th-text-primary" : "text-th-text-secondary"}`}
														>
															{info.label}
														</div>
														<div className="text-xs text-th-text-muted">
															{info.description}
														</div>
													</div>
													<div
														className="h-4 w-4 rounded-full"
														style={{
															backgroundColor: isDarkMode
																? info.accentDark
																: info.accentLight,
														}}
													/>
												</div>
											</button>
										);
									})}
								</div>
							</div>
						</div>
					</div>
				</>
			)}
		</div>
	);
}

export default ThemeSwitcher;
