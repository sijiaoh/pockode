import { useRef } from "react";
import { useSettingsSections } from "../../lib/registries/settingsRegistry";
import BackToChatButton from "../ui/BackToChatButton";
import SettingsNav from "./SettingsNav";

interface Props {
	onBack: () => void;
}

export default function SettingsPage({ onBack }: Props) {
	const scrollContainerRef = useRef<HTMLElement>(null);
	const sections = useSettingsSections();

	const navItems = sections.map((section) => ({
		id: section.id,
		label: section.label,
	}));

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
				<BackToChatButton onClick={onBack} />
				<h1 className="px-2 text-sm font-bold text-th-text-primary">
					Settings
				</h1>
			</header>

			<SettingsNav items={navItems} scrollContainerRef={scrollContainerRef} />

			<main ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto">
				<div className="mx-auto max-w-2xl px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
					{sections.map((section) => {
						const Component = section.component;
						return (
							<section key={section.id} id={section.id} className="mb-6">
								<h2 className="mb-3 text-xs uppercase tracking-wider text-th-text-muted">
									{section.label}
								</h2>
								<Component />
							</section>
						);
					})}
				</div>
			</main>
		</div>
	);
}
