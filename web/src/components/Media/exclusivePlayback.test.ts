import { afterEach, describe, expect, it, vi } from "vitest";
import { claimPlayback, releasePlayback } from "./exclusivePlayback";

const audio = () => document.createElement("audio");

describe("exclusivePlayback", () => {
	const claimed: HTMLMediaElement[] = [];
	const claim = (element: HTMLMediaElement, yieldTo: () => void) => {
		claimed.push(element);
		claimPlayback(element, yieldTo);
	};

	afterEach(() => {
		for (const element of claimed.splice(0)) releasePlayback(element);
	});

	it("tells the player that was sounding to stop, once", () => {
		const [a, b] = [audio(), audio()];
		const stopA = vi.fn();
		claim(a, stopA);
		claim(a, stopA);
		expect(stopA).not.toHaveBeenCalled();

		claim(b, vi.fn());

		expect(stopA).toHaveBeenCalledOnce();
	});

	it("tells nothing to a player that has gone", () => {
		const [a, b] = [audio(), audio()];
		const stopA = vi.fn();
		claim(a, stopA);
		releasePlayback(a);

		claim(b, vi.fn());

		expect(stopA).not.toHaveBeenCalled();
	});
});
