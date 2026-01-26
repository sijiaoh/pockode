import { useRef } from "react";
import BackToChatButton from "../ui/BackToChatButton";
import SettingsNav from "./SettingsNav";
import {
	AccountSection,
	AppearanceSection,
	SandboxSection,
	ThemeSection,
} from "./sections";

const SECTION_IDS = {
	appearance: "appearance",
	theme: "theme",
	sandbox: "sandbox",
	account: "account",
} as const;

const NAV_ITEMS = [
	{ id: SECTION_IDS.appearance, label: "Appearance" },
	{ id: SECTION_IDS.theme, label: "Theme" },
	{ id: SECTION_IDS.sandbox, label: "Sandbox" },
	{ id: SECTION_IDS.account, label: "Account" },
];

interface Props {
	onBack: () => void;
	onLogout: () => void;
}

export default function SettingsPage({ onBack, onLogout }: Props) {
	const scrollContainerRef = useRef<HTMLElement>(null);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
				<BackToChatButton onClick={onBack} />
				<h1 className="px-2 text-sm font-bold text-th-text-primary">
					Settings
				</h1>
			</header>

			<SettingsNav items={NAV_ITEMS} scrollContainerRef={scrollContainerRef} />

			<main ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto">
				<div className="mx-auto max-w-2xl px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
					<AppearanceSection id={SECTION_IDS.appearance} />
					<ThemeSection id={SECTION_IDS.theme} />
					<SandboxSection id={SECTION_IDS.sandbox} />
					<AccountSection id={SECTION_IDS.account} onLogout={onLogout} />
				</div>
			</main>
		</div>
	);
}
