import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Entry } from "../../types/contents";
import FileEntryMenu from "./FileEntryMenu";

vi.mock("../../hooks/useFileDownload", () => ({
	useFolderDownload: () => ({
		label: "Download as zip",
		isDownloading: false,
		toggle: () => {},
	}),
}));

function renderMenu(entry: Entry) {
	const handlers = {
		onClose: vi.fn(),
		onUpload: vi.fn(),
		onNewFile: vi.fn(),
		onNewFolder: vi.fn(),
		onRename: vi.fn(),
		onRevealTarget: vi.fn(),
		onDelete: vi.fn(),
		onDownloadError: vi.fn(),
	};
	render(<FileEntryMenu entry={entry} {...handlers} />);
	return handlers;
}

describe("FileEntryMenu", () => {
	it("offers a link's target, to reveal and to copy", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		const { onRevealTarget } = renderMenu({
			name: "skills",
			type: "dir",
			path: ".claude/skills",
			link: {
				target: "../.agent-skills",
				state: "ok",
				resolved: ".agent-skills",
			},
		});

		await user.click(screen.getByRole("button", { name: /^Reveal target/ }));
		expect(onRevealTarget).toHaveBeenCalledWith(".agent-skills");

		await user.click(screen.getByRole("button", { name: /^Copy link target/ }));
		expect(writeText).toHaveBeenCalledWith("../.agent-skills");
		expect(
			await screen.findByRole("button", { name: /^Copied link target/ }),
		).toBeInTheDocument();
	});

	it("keeps a cycle's folder rows to the folder it really is", () => {
		renderMenu({
			name: "up",
			type: "dir",
			path: "a/up",
			link: { target: "..", state: "cycle", resolved: "a" },
		});
		expect(screen.queryByRole("button", { name: /^New file/ })).toBeNull();
		expect(
			screen.getByRole("button", { name: /^Reveal target/ }),
		).toBeInTheDocument();
	});

	it("has no target to reveal for a link that cannot be followed", () => {
		renderMenu({
			name: "gone",
			type: "link",
			path: "gone",
			link: { target: "missing", state: "broken" },
		});
		expect(screen.queryByRole("button", { name: /^Reveal target/ })).toBeNull();
		expect(
			screen.getByRole("button", { name: /^Copy link target/ }),
		).toBeInTheDocument();
	});
});
