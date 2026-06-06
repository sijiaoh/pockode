import { useEffect, useState } from "react";

const DESKTOP_BREAKPOINT = 768;

export function useIsDesktop(): boolean {
	const [isDesktop, setIsDesktop] = useState(
		() => window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`).matches,
	);

	useEffect(() => {
		const mql = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`);

		const handleChange = (e: MediaQueryListEvent) => {
			setIsDesktop(e.matches);
		};

		mql.addEventListener("change", handleChange);
		return () => mql.removeEventListener("change", handleChange);
	}, []);

	return isDesktop;
}
