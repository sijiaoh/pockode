import { useEffect, useState } from "react";

const DESKTOP_BREAKPOINT = 768;

/**
 * Returns true if viewport width >= md breakpoint (768px).
 * Updates reactively on window resize.
 */
export function useIsDesktop(): boolean {
	const [isDesktop, setIsDesktop] = useState(() => {
		if (typeof window === "undefined") return false;
		return window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`).matches;
	});

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
