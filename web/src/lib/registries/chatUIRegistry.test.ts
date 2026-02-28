import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getChatUIConfig,
	resetChatUIConfig,
	setChatUIConfig,
	subscribe,
} from "./chatUIRegistry";

describe("chatUIRegistry", () => {
	afterEach(() => {
		resetChatUIConfig();
	});

	it("sets config values", () => {
		setChatUIConfig({ userBubbleClass: "custom-bubble" });

		expect(getChatUIConfig().userBubbleClass).toBe("custom-bubble");
	});

	it("merges config with existing values", () => {
		setChatUIConfig({ userBubbleClass: "custom-bubble" });
		setChatUIConfig({ assistantBubbleClass: "ai-bubble" });

		const config = getChatUIConfig();
		expect(config.userBubbleClass).toBe("custom-bubble");
		expect(config.assistantBubbleClass).toBe("ai-bubble");
	});

	it("resets config to default", () => {
		setChatUIConfig({ userBubbleClass: "custom-bubble" });
		resetChatUIConfig();

		expect(getChatUIConfig().userBubbleClass).toBeUndefined();
	});

	it("notifies listeners on set", () => {
		const listener = vi.fn();
		const unsubscribe = subscribe(listener);

		setChatUIConfig({ userBubbleClass: "x" });
		expect(listener).toHaveBeenCalledOnce();

		unsubscribe();
	});

	it("notifies listeners on reset", () => {
		const listener = vi.fn();
		const unsubscribe = subscribe(listener);

		resetChatUIConfig();
		expect(listener).toHaveBeenCalledOnce();

		unsubscribe();
	});

	it("stops notifying after unsubscribe", () => {
		const listener = vi.fn();
		const unsubscribe = subscribe(listener);
		unsubscribe();

		setChatUIConfig({ userBubbleClass: "x" });
		expect(listener).not.toHaveBeenCalled();
	});
});
