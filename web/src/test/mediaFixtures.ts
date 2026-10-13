import { vi } from "vitest";

/**
 * jsdom implements neither `play` nor `pause`: these do what a browser's
 * would that a player listens to — flip `paused` and say so. Undone by
 * `vi.restoreAllMocks()`.
 */
export function stubMediaControls() {
	const setPaused = (element: HTMLMediaElement, paused: boolean) =>
		Object.defineProperty(element, "paused", {
			value: paused,
			configurable: true,
		});
	const play = vi
		.spyOn(HTMLMediaElement.prototype, "play")
		.mockImplementation(function (this: HTMLMediaElement) {
			setPaused(this, false);
			this.dispatchEvent(new Event("play"));
			return Promise.resolve();
		});
	const pause = vi
		.spyOn(HTMLMediaElement.prototype, "pause")
		.mockImplementation(function (this: HTMLMediaElement) {
			if (this.paused) return;
			setPaused(this, true);
			this.dispatchEvent(new Event("pause"));
		});
	return { play, pause };
}
