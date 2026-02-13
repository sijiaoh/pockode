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
		setChatUIConfig({ maxWidth: "800px" });

		expect(getChatUIConfig().maxWidth).toBe("800px");
	});

	it("merges config with existing values", () => {
		setChatUIConfig({ maxWidth: "800px" });
		setChatUIConfig({ userBubbleClass: "custom-bubble" });

		const config = getChatUIConfig();
		expect(config.maxWidth).toBe("800px");
		expect(config.userBubbleClass).toBe("custom-bubble");
	});

	it("resets config to default", () => {
		setChatUIConfig({ maxWidth: "800px" });
		resetChatUIConfig();

		expect(getChatUIConfig().maxWidth).toBeUndefined();
	});
});
