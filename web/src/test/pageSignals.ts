/**
 * What a page in the app's double frame tells a browser test: the script
 * `pageSignal` writes posts a value, and `signals` collects every one, as it
 * arrives, between `startPageSignals` and `stopPageSignals`.
 */
export const signals: string[] = [];

/** A script posting `expression`'s value from a page inside its wrapper. */
export const pageSignal = (expression: string) =>
	`parent.parent.postMessage({signal:${expression}},'*')`;

function onSignal(event: MessageEvent) {
	const data: unknown = event.data;
	if (data && typeof data === "object" && "signal" in data) {
		signals.push(String(data.signal));
	}
}

/** Forgets what was collected, so what follows is all `signals` holds. */
export function clearPageSignals() {
	signals.length = 0;
}

export function startPageSignals() {
	clearPageSignals();
	window.addEventListener("message", onSignal);
}

export function stopPageSignals() {
	window.removeEventListener("message", onSignal);
}
