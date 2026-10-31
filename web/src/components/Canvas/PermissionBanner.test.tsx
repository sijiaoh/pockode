import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PermissionBanner } from "./PermissionBanner";

const banner = (attempt: number) => (
	<PermissionBanner
		count={1}
		oldest={null}
		refused={attempt > 0}
		attempt={attempt}
		onShow={vi.fn()}
	/>
);

const flash = (container: HTMLElement) =>
	container.querySelector(".animate-permission-flash");

describe("PermissionBanner", () => {
	it("flashes for attempts made while it is up, not for earlier ones", () => {
		const { container, rerender } = render(banner(2));
		expect(flash(container)).toBeNull();

		rerender(banner(3));
		const first = flash(container);
		expect(first).not.toBeNull();

		// Each attempt restarts it.
		rerender(banner(4));
		expect(flash(container)).not.toBe(first);
	});
});
