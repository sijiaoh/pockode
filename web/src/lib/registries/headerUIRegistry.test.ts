import { afterEach, describe, expect, it } from "vitest";
import {
	getHeaderUIConfig,
	resetHeaderUIConfig,
	setHeaderUIConfig,
} from "./headerUIRegistry";

describe("headerUIRegistry", () => {
	afterEach(() => {
		resetHeaderUIConfig();
	});

	it("sets config values", () => {
		const Component = () => null;
		setHeaderUIConfig({ HeaderContent: Component });

		expect(getHeaderUIConfig().HeaderContent).toBe(Component);
	});

	it("merges config with existing values", () => {
		const Header = () => null;
		const Title = () => null;
		setHeaderUIConfig({ HeaderContent: Header });
		setHeaderUIConfig({ TitleComponent: Title });

		expect(getHeaderUIConfig().HeaderContent).toBe(Header);
		expect(getHeaderUIConfig().TitleComponent).toBe(Title);
	});

	it("resets config to default", () => {
		setHeaderUIConfig({ HeaderContent: () => null });
		resetHeaderUIConfig();

		expect(getHeaderUIConfig().HeaderContent).toBeUndefined();
	});
});
