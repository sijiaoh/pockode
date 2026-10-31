import type { InstalledVersion } from "@pockode/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInstalledVersion } from "../hooks/useInstalledVersion";
import { ClusterVersion } from "./ClusterVersion";

const actions = {
	serverVersion: vi.fn(),
	// The release check is ClusterVersion.update.test.tsx's; here it never answers.
	serverUpdateCheck: vi.fn(() => new Promise(() => {})),
	restartServer: vi.fn(),
};

const wsState = { status: "connected", actions };

vi.mock("../lib/wsStore", () => ({
	useWSStore: Object.assign(() => wsState, { getState: () => wsState }),
}));

const PATH = "/usr/local/bin/pockode";

/** The read is the list's; this stands in for it. */
function Harness({ running }: { running: string }) {
	const installedState = useInstalledVersion();
	return <ClusterVersion running={running} installedState={installedState} />;
}

function installed(fields: Partial<InstalledVersion>) {
	actions.serverVersion.mockResolvedValue({
		installed: { path: PATH, ...fields },
	});
}

async function openSheet() {
	const user = userEvent.setup();
	await user.click(await screen.findByRole("button", { name: /^Pockode/ }));
	const sheet = await screen.findByRole("dialog", { name: "Pockode cluster" });
	return { user, sheet };
}

/** Lets the mount's read resolve and render, before asserting an absence. */
async function readLanded() {
	await waitFor(() => expect(actions.serverVersion).toHaveBeenCalled());
	await act(async () => {});
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("ClusterVersion: the header button", () => {
	it("marks a mismatch, and says it in words", async () => {
		installed({ version: "0.17.0" });
		render(<Harness running="0.16.0" />);

		const button = await screen.findByRole("button", {
			name: "Pockode cluster v0.16.0, 0.17.0 installed",
		});
		expect(button).toHaveTextContent("v0.16.0→ 0.17.0");
		expect(screen.getByTestId("version-differs")).toBeInTheDocument();
	});

	it("shows the version alone when they are the same", async () => {
		installed({ version: "0.17.0" });
		render(<Harness running="0.17.0" />);

		await readLanded();
		expect(
			screen.getByRole("button", { name: "Pockode cluster v0.17.0" }),
		).toHaveTextContent("v0.17.0");
		expect(screen.queryByTestId("version-differs")).not.toBeInTheDocument();
	});

	// A dev build and an installed release would always differ.
	it("never marks a development build", async () => {
		installed({ version: "0.17.0" });
		render(<Harness running="dev" />);

		await readLanded();
		expect(
			screen.getByRole("button", { name: "Pockode cluster dev" }),
		).toHaveTextContent("dev");
		expect(screen.queryByTestId("version-differs")).not.toBeInTheDocument();
	});

	it("names a development build installed under a release in words", async () => {
		installed({ version: "dev" });
		render(<Harness running="0.16.0" />);

		expect(
			await screen.findByRole("button", {
				name: "Pockode cluster v0.16.0, development build installed",
			}),
		).toBeInTheDocument();
	});

	// The header is not where an error about the install belongs.
	it("shows no marker when the install cannot be read", async () => {
		installed({ error: "--version: exec format error" });
		render(<Harness running="0.16.0" />);

		await readLanded();
		expect(screen.queryByTestId("version-differs")).not.toBeInTheDocument();
	});

	it("reads again when the tab becomes visible", async () => {
		installed({ version: "0.16.0" });
		render(<Harness running="0.16.0" />);
		await waitFor(() => expect(actions.serverVersion).toHaveBeenCalledTimes(1));

		installed({ version: "0.17.0" });
		document.dispatchEvent(new Event("visibilitychange"));

		expect(
			await screen.findByRole("button", {
				name: "Pockode cluster v0.16.0, 0.17.0 installed",
			}),
		).toBeInTheDocument();
	});
});

describe("ClusterVersion: the sheet", () => {
	it("tells the user what to restart into when the versions differ", async () => {
		installed({ version: "0.17.0" });
		render(<Harness running="0.16.0" />);
		const { sheet } = await openSheet();

		expect(
			await within(sheet).findByText("Restart to use 0.17.0."),
		).toBeInTheDocument();
		expect(within(sheet).getByText("0.16.0")).toBeInTheDocument();
		expect(within(sheet).getByText(/doesn't affect nodes/)).toBeInTheDocument();
		expect(
			within(sheet).getByRole("button", { name: "Restart" }),
		).toBeEnabled();
	});

	// A restart is also how a newly installed CLI's PATH is picked up.
	it("offers Restart when the versions are the same", async () => {
		installed({ version: "0.17.0" });
		render(<Harness running="0.17.0" />);
		const { sheet } = await openSheet();

		const restart = within(sheet).getByRole("button", { name: "Restart" });
		await waitFor(() => expect(restart).toBeEnabled());
		expect(within(sheet).queryByText(/Restart to use/)).not.toBeInTheDocument();
	});

	it("says development build rather than comparing it", async () => {
		installed({ version: "dev" });
		render(<Harness running="dev" />);
		const { sheet } = await openSheet();

		await waitFor(() =>
			expect(within(sheet).getAllByText("development build")).toHaveLength(2),
		);
		expect(within(sheet).queryByText(/Restart to use/)).not.toBeInTheDocument();
	});

	// The cluster would refuse a restart into a file that does not run.
	it("withholds Restart when the install cannot be read, and says why", async () => {
		installed({ error: "--version: exec format error" });
		render(<Harness running="0.16.0" />);
		const { sheet } = await openSheet();

		expect(await within(sheet).findByText("couldn't read")).toBeInTheDocument();
		expect(
			within(sheet).getByText(/exec format error\. The cluster/),
		).toHaveTextContent(
			`The cluster can't restart until ${PATH} runs. Reinstall it on the server.`,
		);
		expect(
			within(sheet).queryByRole("button", { name: "Restart" }),
		).not.toBeInTheDocument();
		// The sheet's own ✕ is named Close too; the footer's is the second.
		expect(
			within(sheet).getAllByRole("button", { name: "Close" }),
		).toHaveLength(2);
	});

	// The sheet speaks about now: confirming on what the header read earlier
	// is exactly what the re-read on open is for.
	it("reads again on open, and holds Restart until that read lands", async () => {
		installed({ version: "0.16.0" });
		render(<Harness running="0.16.0" />);
		await waitFor(() => expect(actions.serverVersion).toHaveBeenCalledTimes(1));

		let answer: (value: unknown) => void = () => {};
		actions.serverVersion.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		const { sheet } = await openSheet();

		const restart = within(sheet).getByRole("button", { name: "Restart" });
		expect(restart).toBeDisabled();
		expect(within(sheet).getByText("Reading...")).toBeInTheDocument();

		answer({ installed: { path: PATH, version: "0.17.0" } });
		expect(
			await within(sheet).findByText("Restart to use 0.17.0."),
		).toBeInTheDocument();
		expect(restart).toBeEnabled();
	});

	it("cannot be dismissed while the request is out, and closes on success", async () => {
		installed({ version: "0.17.0" });
		let accept: () => void = () => {};
		actions.restartServer.mockReturnValue(
			new Promise<void>((resolve) => {
				accept = resolve;
			}),
		);
		render(<Harness running="0.16.0" />);
		const { user, sheet } = await openSheet();

		const restart = within(sheet).getByRole("button", { name: "Restart" });
		await waitFor(() => expect(restart).toBeEnabled());
		await user.click(restart);

		expect(
			within(sheet).getByRole("button", { name: "Cancel" }),
		).toBeDisabled();
		await user.keyboard("{Escape}");
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		accept();
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});

	it("shows a refusal in the sheet and lets it be tried again", async () => {
		installed({ version: "0.17.0" });
		actions.restartServer.mockRejectedValue(
			new Error(
				`The installed pockode at ${PATH} didn't run: boom. The cluster kept running; nothing was stopped.`,
			),
		);
		render(<Harness running="0.16.0" />);
		const { user, sheet } = await openSheet();

		const restart = within(sheet).getByRole("button", { name: "Restart" });
		await waitFor(() => expect(restart).toBeEnabled());
		await user.click(restart);

		expect(await within(sheet).findByRole("alert")).toHaveTextContent(
			"nothing was stopped",
		);
		expect(restart).toBeEnabled();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});
});
