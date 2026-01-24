import { useCallback, useEffect, useRef, useState } from "react";

export interface NavItem {
	id: string;
	label: string;
}

interface Props {
	items: NavItem[];
	scrollContainerRef: React.RefObject<HTMLElement | null>;
}

const SCROLL_OFFSET = 16;

export default function SettingsNav({ items, scrollContainerRef }: Props) {
	const [activeId, setActiveId] = useState(items[0]?.id ?? "");
	const navRef = useRef<HTMLDivElement>(null);
	const isClickScrolling = useRef(false);

	const scrollToSection = useCallback(
		(id: string) => {
			const container = scrollContainerRef.current;
			const section = document.getElementById(id);
			if (!container || !section) return;

			isClickScrolling.current = true;
			setActiveId(id);

			const containerRect = container.getBoundingClientRect();
			const sectionRect = section.getBoundingClientRect();
			const offset = sectionRect.top - containerRect.top + container.scrollTop;

			container.scrollTo({
				top: offset - SCROLL_OFFSET,
				behavior: "smooth",
			});

			setTimeout(() => {
				isClickScrolling.current = false;
			}, 500);
		},
		[scrollContainerRef],
	);

	useEffect(() => {
		const container = scrollContainerRef.current;
		if (!container) return;

		const handleScroll = () => {
			if (isClickScrolling.current) return;

			const containerRect = container.getBoundingClientRect();
			let currentId = items[0]?.id ?? "";

			for (const item of items) {
				const section = document.getElementById(item.id);
				if (!section) continue;

				const sectionRect = section.getBoundingClientRect();
				const sectionTop = sectionRect.top - containerRect.top;

				if (sectionTop <= SCROLL_OFFSET * 2) {
					currentId = item.id;
				}
			}

			setActiveId(currentId);
		};

		container.addEventListener("scroll", handleScroll, { passive: true });
		return () => container.removeEventListener("scroll", handleScroll);
	}, [items, scrollContainerRef]);

	useEffect(() => {
		const nav = navRef.current;
		const activeButton = nav?.querySelector(`[data-id="${activeId}"]`);
		if (nav && activeButton) {
			const navRect = nav.getBoundingClientRect();
			const buttonRect = activeButton.getBoundingClientRect();
			const scrollLeft =
				buttonRect.left -
				navRect.left +
				nav.scrollLeft -
				navRect.width / 2 +
				buttonRect.width / 2;
			nav.scrollTo({ left: scrollLeft, behavior: "smooth" });
		}
	}, [activeId]);

	return (
		<nav
			ref={navRef}
			className="flex gap-1 overflow-x-auto border-b border-th-border bg-th-bg-secondary px-2 py-1 scrollbar-none"
			aria-label="Settings sections"
		>
			{items.map((item) => (
				<button
					key={item.id}
					type="button"
					data-id={item.id}
					aria-pressed={activeId === item.id}
					onClick={() => scrollToSection(item.id)}
					className={`shrink-0 rounded-full px-4 py-2.5 text-xs font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 ${
						activeId === item.id
							? "bg-th-accent text-white"
							: "bg-th-bg-tertiary text-th-text-muted hover:text-th-text-secondary"
					}`}
				>
					{item.label}
				</button>
			))}
		</nav>
	);
}
