/** Check if running on macOS (for Emacs-style Ctrl+N/P shortcuts). */
export const isMac = (() => {
	if (typeof navigator === "undefined") return false;
	// Use userAgentData if available (modern browsers), fallback to userAgent
	const platform =
		(navigator as Navigator & { userAgentData?: { platform: string } })
			.userAgentData?.platform ?? navigator.userAgent;
	return /mac/i.test(platform);
})();
