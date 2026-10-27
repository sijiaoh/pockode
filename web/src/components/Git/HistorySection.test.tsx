import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCommit } from "../../types/git";
import HistorySection from "./HistorySection";

let commits: GitCommit[] = [];

vi.mock("../../hooks/useGitLog", () => ({
	useGitLog: () => ({ data: { commits }, isLoading: false, error: null }),
}));
vi.mock("./GitCommitSheet", () => ({
	default: ({ amendInitially }: { amendInitially: boolean }) => (
		<div role="dialog">{amendInitially ? "amending" : "committing"}</div>
	),
}));

function renderSection() {
	render(<HistorySection activeHash={null} onSelectCommit={vi.fn()} />);
}

const COMMITS: GitCommit[] = [
	{
		hash: "9692fc9aaaaaaaa",
		subject: "Add branch bar to git panel",
		author: "sijiaoh",
		date: new Date().toISOString(),
	},
	{
		hash: "1c4b8e0bbbbbbbb",
		subject: "Render every codex_changes event",
		author: "sijiaoh",
		date: new Date().toISOString(),
	},
];

describe("HistorySection amend", () => {
	beforeEach(() => {
		commits = COMMITS;
	});

	// Amend belongs to the commit it replaces, and that commit is HEAD — the
	// first row of the log, and only that row.
	it("offers amend on the HEAD row only", () => {
		renderSection();

		expect(
			screen.getAllByRole("button", { name: "Amend this commit" }),
		).toHaveLength(1);
	});

	it("opens the commit sheet with amend pre-toggled", async () => {
		const user = userEvent.setup();
		renderSection();

		await user.click(screen.getByRole("button", { name: "Amend this commit" }));

		expect(screen.getByRole("dialog")).toHaveTextContent("amending");
	});

	it("has nothing to amend in a repository without commits", () => {
		commits = [];
		renderSection();

		expect(
			screen.queryByRole("button", { name: "Amend this commit" }),
		).not.toBeInTheDocument();
	});
});
