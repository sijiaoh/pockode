import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import {
	type SettingsSectionConfig,
	useSettingsSections,
} from "../../lib/registries/settingsRegistry";
import PageHeader from "../Layout/PageHeader";
import SettingsNav from "./SettingsNav";

interface Props {
	onBack: () => void;
}

export default function SettingsPage({ onBack }: Props) {
	const scrollContainerRef = useRef<HTMLElement>(null);
	const sections = useVisibleSettingsSections();

	const navItems = sections.map((section) => ({
		id: section.id,
		label: section.label,
	}));

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader back={{ to: "chat", onClick: onBack }} title="Settings" />

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

function isVisible(section: SettingsSectionConfig): boolean {
	return section.visibility?.get() ?? true;
}

function useVisibleSettingsSections(): SettingsSectionConfig[] {
	const registered = useSettingsSections();

	const subscribe = useCallback(
		(onChange: () => void) => {
			const unsubscribes = registered.map((section) =>
				section.visibility?.subscribe(onChange),
			);
			return () => {
				for (const unsubscribe of unsubscribes) unsubscribe?.();
			};
		},
		[registered],
	);
	// A string, so an unrelated store update that leaves every answer as it was
	// does not re-render the page.
	const getVisibleIds = useCallback(
		() =>
			registered
				.filter(isVisible)
				.map((section) => section.id)
				.join("\0"),
		[registered],
	);
	const visibleIds = useSyncExternalStore(subscribe, getVisibleIds);

	return useMemo(() => {
		const ids = new Set(visibleIds.split("\0"));
		return registered.filter((section) => ids.has(section.id));
	}, [registered, visibleIds]);
}
