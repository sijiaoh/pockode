import { Check, Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import {
	THEME_INFO,
	THEME_NAMES,
	type ThemeMode,
	type ThemeName,
	useTheme,
} from "../../../lib/themeStore";

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
	mode,
}: {
	themeName: ThemeName;
	isSelected: boolean;
	mode: "light" | "dark";
}) {
	const info = THEME_INFO[themeName];
	const accentColor = info.accent[mode];
	const bgColor = info.bg[mode];
	const textColor = info.text[mode];
	const checkColor = isLightColor(accentColor) ? "#000" : "#fff";

	return (
		<div
			className="relative h-10 w-full overflow-hidden rounded-md"
			style={{ backgroundColor: bgColor }}
		>
			<div
				className="absolute bottom-0 left-0 h-1 w-full"
				style={{ backgroundColor: accentColor }}
			/>
			<div className="flex flex-col gap-1 p-2">
				<div
					className="h-1 w-8 rounded-full opacity-60"
					style={{ backgroundColor: textColor }}
				/>
				<div
					className="h-1 w-5 rounded-full opacity-40"
					style={{ backgroundColor: textColor }}
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

export function AppearanceSection() {
	const { mode, setMode } = useTheme();

	return (
		// biome-ignore lint/a11y/useSemanticElements: fieldset is for forms; this is an instant-apply toggle group
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
	);
}

export function ThemeSection() {
	const { theme, setTheme, resolvedMode: mode } = useTheme();

	return (
		// biome-ignore lint/a11y/useSemanticElements: fieldset is for forms; this is an instant-apply selection
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
							mode={mode}
						/>
						<div
							className="flex min-h-12 items-center justify-between px-3 py-2"
							style={{ backgroundColor: info.bg[mode] }}
						>
							<div>
								<div className="text-sm" style={{ color: info.text[mode] }}>
									{info.label}
								</div>
								<div
									className="text-xs"
									style={{ color: info.textMuted[mode] }}
								>
									{info.description}
								</div>
							</div>
							<div
								className="h-4 w-4 rounded-full"
								style={{ backgroundColor: info.accent[mode] }}
							/>
						</div>
					</button>
				);
			})}
		</div>
	);
}
