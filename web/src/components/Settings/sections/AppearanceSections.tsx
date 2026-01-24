import { Check, Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import {
	THEME_INFO,
	THEME_NAMES,
	type ThemeMode,
	type ThemeName,
	useTheme,
} from "../../../hooks/useTheme";
import SettingsSection from "../SettingsSection";

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

function isLightColor(hex: string): boolean {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luminance > 0.6;
}

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
	const checkColor = isLightColor(accentColor) ? "#000" : "#fff";

	return (
		<div
			className="relative h-10 w-full overflow-hidden rounded-md"
			style={{ backgroundColor: previewBg }}
		>
			<div
				className="absolute bottom-0 left-0 h-1 w-full"
				style={{ backgroundColor: accentColor }}
			/>
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
			{isSelected && (
				<div
					className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full"
					style={{ backgroundColor: accentColor }}
				>
					<Check
						className="h-2.5 w-2.5"
						style={{ color: checkColor }}
						strokeWidth={3}
						aria-hidden="true"
					/>
				</div>
			)}
		</div>
	);
}

export function AppearanceSection({ id }: { id: string }) {
	const { mode, setMode } = useTheme();

	return (
		<SettingsSection id={id} title="Appearance">
			{/* biome-ignore lint/a11y/useSemanticElements: fieldset is for forms; this is an instant-apply toggle group */}
			<div
				role="group"
				aria-label="Appearance mode"
				className="flex gap-1 rounded-lg bg-th-bg-secondary p-1"
			>
				{MODE_OPTIONS.map((option) => (
					<button
						key={option.value}
						type="button"
						onClick={() => setMode(option.value)}
						aria-pressed={mode === option.value}
						className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 ${
							mode === option.value
								? "bg-th-bg-tertiary text-th-text-primary shadow-sm"
								: "text-th-text-muted hover:text-th-text-secondary"
						}`}
					>
						{option.icon}
						<span>{option.label}</span>
					</button>
				))}
			</div>
		</SettingsSection>
	);
}

export function ThemeSection({ id }: { id: string }) {
	const { theme, setTheme, resolvedMode } = useTheme();
	const isDarkMode = resolvedMode === "dark";

	return (
		<SettingsSection id={id} title="Theme">
			{/* biome-ignore lint/a11y/useSemanticElements: fieldset is for forms; this is an instant-apply selection */}
			<div
				role="group"
				aria-label="Theme selection"
				className="grid grid-cols-1 gap-2"
			>
				{THEME_NAMES.map((name) => {
					const info = THEME_INFO[name];
					const isSelected = theme === name;
					return (
						<button
							key={name}
							type="button"
							onClick={() => setTheme(name)}
							aria-pressed={isSelected}
							className={`group overflow-hidden rounded-lg border text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-offset-2 active:scale-[0.98] ${
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
		</SettingsSection>
	);
}
