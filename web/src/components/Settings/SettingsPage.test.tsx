import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import {
	registerSettingsSection,
	resetSettingsSections,
} from "../../lib/registries/settingsRegistry";
import SettingsPage from "./SettingsPage";

// The way back to chat reads the route for its unread dot.
vi.mock("../../hooks/useOpenSessionUnread", () => ({
	useOpenSessionUnread: () => false,
}));
// jsdom has no layout; the nav centres its active entry with it.
Element.prototype.scrollTo = vi.fn();

const useShown = create(() => ({ shown: false }));

afterEach(() => {
	resetSettingsSections();
	useShown.setState({ shown: false });
});

describe("SettingsPage", () => {
	it("is headed Settings, with the way back to chat", async () => {
		const user = userEvent.setup();
		const onBack = vi.fn();
		render(<SettingsPage onBack={onBack} />);

		expect(
			screen.getByRole("heading", { level: 1, name: "Settings" }),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Back to chat" }));
		expect(onBack).toHaveBeenCalled();
	});

	// The heading and the navigation entry are the page's, not the section's,
	// so a section that rendered null would leave both behind.
	it("leaves out a section that says it does not apply, heading and navigation included", () => {
		registerSettingsSection({
			id: "always",
			label: "Always",
			priority: 1,
			component: () => <p>always body</p>,
		});
		registerSettingsSection({
			id: "sometimes",
			label: "Sometimes",
			priority: 2,
			component: () => <p>sometimes body</p>,
			visibility: {
				get: () => useShown.getState().shown,
				subscribe: useShown.subscribe,
			},
		});

		render(<SettingsPage onBack={() => {}} />);
		expect(screen.getByRole("button", { name: "Always" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Sometimes" })).toBeNull();
		expect(screen.queryByRole("heading", { name: "Sometimes" })).toBeNull();
		expect(screen.queryByText("sometimes body")).toBeNull();

		act(() => useShown.setState({ shown: true }));
		expect(
			screen.getByRole("button", { name: "Sometimes" }),
		).toBeInTheDocument();
		expect(screen.getByText("sometimes body")).toBeInTheDocument();
	});
});
