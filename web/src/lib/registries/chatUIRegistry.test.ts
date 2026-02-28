import { afterEach, describe, expect, it } from "vitest";
import {
	getChatUIConfig,
	resetChatUIConfig,
	setChatUIConfig,
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
});
