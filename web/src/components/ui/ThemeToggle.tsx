import { useEffect, useRef, useState } from "react";
import {
	THEME_INFO,
	THEME_NAMES,
	type ThemeMode,
	useTheme,
} from "../../hooks/useTheme";

const MODE_OPTIONS: { value: ThemeMode; label: string }[] = [
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
	{ value: "system", label: "System" },
];

function ThemeToggle() {
	const { mode, setMode, theme, setTheme, resolvedMode } = useTheme();
	const [isOpen, setIsOpen] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);

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

	const modeIcon =
		resolvedMode === "dark" ? (
			<svg
				className="h-5 w-5"
				fill="none"
				stroke="currentColor"
				viewBox="0 0 24 24"
				aria-hidden="true"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={2}
					d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
				/>
			</svg>
		) : (
			<svg
				className="h-5 w-5"
				fill="none"
				stroke="currentColor"
				viewBox="0 0 24 24"
				aria-hidden="true"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={2}
					d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
				/>
			</svg>
		);

	return (
		<div className="relative">
			<button
				ref={buttonRef}
				type="button"
				onClick={() => setIsOpen(!isOpen)}
				className="flex items-center gap-1.5 rounded p-1 text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
				aria-label="Theme settings"
				aria-expanded={isOpen}
			>
				{modeIcon}
				<span
					className="h-3 w-3 rounded-full border border-th-border"
					style={{ backgroundColor: THEME_INFO[theme].accentColor }}
					aria-hidden="true"
				/>
			</button>

			{isOpen && (
				<div
					ref={panelRef}
					className="absolute right-0 top-full z-50 mt-2 w-64 rounded-lg border border-th-border bg-th-bg-primary p-3 shadow-lg"
					role="dialog"
					aria-label="Theme settings"
				>
					{/* Mode Selection */}
					<div className="mb-3">
						<div className="mb-2 text-xs font-medium text-th-text-muted uppercase tracking-wide">
							Mode
						</div>
						<div className="flex gap-1">
							{MODE_OPTIONS.map((option) => (
								<button
									key={option.value}
									type="button"
									onClick={() => setMode(option.value)}
									className={`flex-1 rounded px-2 py-1.5 text-sm transition-colors ${
										mode === option.value
											? "bg-th-accent text-th-accent-text"
											: "bg-th-bg-tertiary text-th-text-secondary hover:text-th-text-primary"
									}`}
								>
									{option.label}
								</button>
							))}
						</div>
					</div>

					{/* Theme Selection */}
					<div>
						<div className="mb-2 text-xs font-medium text-th-text-muted uppercase tracking-wide">
							Theme
						</div>
						<div className="grid grid-cols-2 gap-2">
							{THEME_NAMES.map((name) => {
								const info = THEME_INFO[name];
								const isSelected = theme === name;
								return (
									<button
										key={name}
										type="button"
										onClick={() => setTheme(name)}
										className={`flex items-center gap-2 rounded-lg border p-2 text-left transition-all ${
											isSelected
												? "border-th-accent bg-th-bg-secondary"
												: "border-th-border hover:border-th-text-muted hover:bg-th-bg-secondary"
										}`}
									>
										<span
											className="h-4 w-4 shrink-0 rounded-full"
											style={{ backgroundColor: info.accentColor }}
											aria-hidden="true"
										/>
										<div className="min-w-0">
											<div
												className={`text-sm font-medium ${isSelected ? "text-th-text-primary" : "text-th-text-secondary"}`}
											>
												{info.label}
											</div>
											<div className="truncate text-xs text-th-text-muted">
												{info.description}
											</div>
										</div>
									</button>
								);
							})}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

export default ThemeToggle;
