import { useSyncExternalStore } from "react";

const readDeviceTimeZone = () =>
	Intl.DateTimeFormat().resolvedOptions().timeZone;

// A phone that lands in another zone while the app is in the background
// reports it when brought back; nothing fires at the moment the zone changes.
function subscribe(onChange: () => void) {
	document.addEventListener("visibilitychange", onChange);
	window.addEventListener("focus", onChange);
	return () => {
		document.removeEventListener("visibilitychange", onChange);
		window.removeEventListener("focus", onChange);
	};
}

/**
 * The device's IANA zone. The one place the schedule screens read it, so
 * every surface changes together when the device moves (docs/schedule-ui.md
 * §6.5).
 */
export function useDeviceTimeZone(): string {
	return useSyncExternalStore(subscribe, readDeviceTimeZone);
}
