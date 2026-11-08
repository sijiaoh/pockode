import type { ServerUpdateCheck, UpdateCandidate } from "@pockode/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorException } from "json-rpc-2.0";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInstalledVersion } from "../hooks/useInstalledVersion";
import { ClusterVersion } from "./ClusterVersion";

// The cluster updating itself from its header (docs/self-update-ui.md,
// "web-cluster: the header" and "What to test").

const actions = {
	serverVersion: vi.fn(),
	restartServer: vi.fn(),
	serverUpdateCheck: vi.fn(),
	serverUpdate: vi.fn(),
};

const wsState = { status: "connected", actions };

vi.mock("../lib/wsStore", () => ({
	useWSStore: Object.assign(() => wsState, { getState: () => wsState }),
}));

const PATH = "/home/ada/.local/bin/pockode";

const LATEST: UpdateCandidate = {
	channel: "latest",
	version: "0.25.0",
	notes_url: "https://github.com/sijiaoh/pockode/releases/tag/v0.25.0",
};
const ALPHA: UpdateCandidate = {
	channel: "alpha",
	version: "0.26.0-alpha.1",
	notes_url: "https://github.com/sijiaoh/pockode/releases/tag/v0.26.0-alpha.1",
};

function check(fields: Partial<ServerUpdateCheck> = {}): ServerUpdateCheck {
	return {
		checked_at: new Date(Date.now() - 3 * 60_000).toISOString(),
		candidates: [LATEST, ALPHA],
		latest_version: "0.25.0",
		platform: "linux/amd64",
		asset: "pockode-linux-amd64",
		...fields,
	};
}

/** What the server says before anyone has pressed since it started. */
function notChecked(fields: Partial<ServerUpdateCheck> = {}) {
	return check({ checked_at: undefined, candidates: [], ...fields });
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function updateFailed(reason: string, message: string) {
	return Object.assign(new Error(message), { code: -32012, data: { reason } });
}

function Harness({ running = "0.24.0" }: { running?: string }) {
	const installedState = useInstalledVersion();
	return <ClusterVersion running={running} installedState={installedState} />;
}

async function openSheet() {
	const user = userEvent.setup();
	await user.click(await screen.findByRole("button", { name: /^Pockode/ }));
	const sheet = await screen.findByRole("dialog", { name: "Pockode cluster" });
	return { user, sheet };
}

/** Opens the sheet and presses a candidate's Update, once the re-check lands. */
async function openConfirm(name: string) {
	const { user, sheet } = await openSheet();
	await user.click(
		await within(sheet).findByRole("button", { name: `Update to ${name}` }),
	);
	const confirm = await screen.findByRole("dialog", {
		name: /^Update the cluster to/,
	});
	const press = within(confirm).getByRole("button", {
		name: "Update and restart",
	});
	await waitFor(() => expect(press).toBeEnabled());
	return { user, confirm, press };
}

beforeEach(() => {
	wsState.status = "connected";
	actions.serverVersion.mockResolvedValue({
		installed: { path: PATH, version: "0.24.0" },
	});
	actions.serverUpdateCheck.mockResolvedValue(check());
	actions.restartServer.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("the header button", () => {
	it("marks a latest release with a dot, and says it in words", async () => {
		render(<Harness />);
		expect(
			await screen.findByRole("button", {
				name: "Pockode cluster v0.24.0, 0.25.0 out",
			}),
		).toBeInTheDocument();
		expect(screen.getByTestId("release-out")).toBeInTheDocument();
	});

	// Alphas come often; a marker on most weeks teaches the user to ignore it.
	it("does not mark an alpha", async () => {
		actions.serverUpdateCheck.mockResolvedValue(check({ candidates: [ALPHA] }));
		render(<Harness />);
		// The landed check is what the sheet draws its alpha row from.
		const { sheet } = await openSheet();
		await within(sheet).findByRole("button", { name: /^Update to 0.26.0/ });
		expect(
			screen.getByRole("button", { name: "Pockode cluster v0.24.0" }),
		).toBeInTheDocument();
		expect(screen.queryByTestId("release-out")).not.toBeInTheDocument();
	});
});

describe("the sheet's candidates", () => {
	it("draws each candidate as a release-notes link and a named Update", async () => {
		render(<Harness />);
		const { sheet } = await openSheet();

		const notes = await within(sheet).findByRole("link", {
			name: "Release notes for 0.25.0 (latest), opens GitHub",
		});
		expect(notes).toHaveAttribute("href", LATEST.notes_url);
		expect(notes).toHaveAttribute("target", "_blank");
		expect(
			within(sheet).getByRole("link", {
				name: "Release notes for 0.26.0-alpha.1 (alpha), opens GitHub",
			}),
		).toBeInTheDocument();
		const latest = within(sheet).getByRole("button", {
			name: "Update to 0.25.0 (latest)",
		});
		const alpha = within(sheet).getByRole("button", {
			name: "Update to 0.26.0-alpha.1 (alpha)",
		});
		expect(latest).toHaveTextContent(/^Update$/);
		expect(latest.className).toContain("bg-th-accent");
		expect(alpha.className).not.toContain("bg-th-accent");
		expect(within(sheet).getByText(/Checked 3 min ago/)).toBeInTheDocument();
	});

	it("leaves Restart primary only to an installed version with no latest row", async () => {
		actions.serverVersion.mockResolvedValue({
			installed: { path: PATH, version: "0.25.0" },
		});
		actions.serverUpdateCheck.mockResolvedValue(check({ candidates: [ALPHA] }));
		render(<Harness />);
		const { sheet } = await openSheet();

		await within(sheet).findByText("Restart to use 0.25.0.");
		expect(
			within(sheet).getByRole("button", { name: "Restart" }).className,
		).toContain("bg-th-accent");
	});

	it("keeps Restart secondary beside a latest Update", async () => {
		actions.serverVersion.mockResolvedValue({
			installed: { path: PATH, version: "0.24.1" },
		});
		render(<Harness />);
		const { sheet } = await openSheet();

		await within(sheet).findByText("Restart to use 0.24.1.");
		await within(sheet).findByRole("button", { name: /^Update to 0.25.0/ });
		expect(
			within(sheet).getByRole("button", { name: "Restart" }).className,
		).not.toContain("bg-th-accent");
	});

	// A latest row with no Update has no action to outrank Restart with.
	it("leaves Restart primary beside a latest row this cluster cannot install", async () => {
		actions.serverVersion.mockResolvedValue({
			installed: { path: PATH, version: "0.24.1" },
		});
		actions.serverUpdateCheck.mockResolvedValue(
			check({
				cannot_install: {
					reason: "container",
					message: "Pockode is running in a container",
				},
			}),
		);
		render(<Harness />);
		const { sheet } = await openSheet();

		await within(sheet).findByText("Restart to use 0.24.1.");
		await within(sheet).findByRole("link", { name: /0\.25\.0 \(latest\)/ });
		expect(
			within(sheet).getByRole("button", { name: "Restart" }).className,
		).toContain("bg-th-accent");
	});

	it("says up to date, and Check again looks past the cache", async () => {
		actions.serverUpdateCheck.mockResolvedValue(check({ candidates: [] }));
		render(<Harness />);
		const { user, sheet } = await openSheet();

		expect(
			await within(sheet).findByText(/Up to date · checked 3 min ago/),
		).toBeInTheDocument();
		await user.click(
			within(sheet).getByRole("button", { name: "Check again" }),
		);
		expect(actions.serverUpdateCheck).toHaveBeenLastCalledWith(true);
	});

	it("never calls a failed check up to date", async () => {
		actions.serverUpdateCheck.mockResolvedValue(
			check({
				candidates: [],
				check_error: { reason: "unavailable", message: "GitHub: 503" },
			}),
		);
		render(<Harness />);
		const { user, sheet } = await openSheet();

		expect(
			await within(sheet).findByText(/Couldn't check for updates: GitHub: 503/),
		).toBeInTheDocument();
		expect(within(sheet).queryByText(/Up to date/)).not.toBeInTheDocument();
		await user.click(within(sheet).getByRole("button", { name: "Try again" }));
		expect(actions.serverUpdateCheck).toHaveBeenLastCalledWith(true);
	});

	it("shows nothing about releases for a development build", async () => {
		actions.serverUpdateCheck.mockResolvedValue(
			check({
				candidates: [],
				check_error: { reason: "dev_build", message: "development build" },
			}),
		);
		render(<Harness running="dev" />);
		const { sheet } = await openSheet();

		await within(sheet).findAllByText("development build");
		await act(async () => {});
		expect(within(sheet).queryByText(/update/i)).not.toBeInTheDocument();
		expect(
			within(sheet).getByRole("button", { name: "Restart" }),
		).toBeEnabled();
	});

	it("keeps the rows without Update when this cluster cannot install, and says why", async () => {
		actions.serverUpdateCheck.mockResolvedValue(
			check({
				cannot_install: {
					reason: "not_writable",
					message: "Pockode cannot write to /usr/local/bin ...",
					dir: "/usr/local/bin",
					hint: "Update from a terminal with `install.sh --install-dir /usr/local/bin`.",
				},
			}),
		);
		render(<Harness />);
		const { sheet } = await openSheet();

		await within(sheet).findByRole("link", { name: /0\.25\.0 \(latest\)/ });
		expect(
			within(sheet).queryByRole("button", { name: /^Update to/ }),
		).not.toBeInTheDocument();
		expect(
			within(sheet).getByText(/Can't update from here: no write access to/),
		).toBeInTheDocument();
		expect(
			within(sheet).getByText("install.sh --install-dir /usr/local/bin"),
		).toHaveClass("font-mono");
		await waitFor(() =>
			expect(
				within(sheet).getByRole("button", { name: "Restart" }),
			).toBeEnabled(),
		);
	});

	it("drops only the Update of a release with no build here", async () => {
		actions.serverUpdateCheck.mockResolvedValue(
			check({
				candidates: [
					{
						...LATEST,
						unavailable: { reason: "no_asset", message: "no build" },
					},
					ALPHA,
				],
			}),
		);
		render(<Harness />);
		const { sheet } = await openSheet();

		expect(
			await within(sheet).findByRole("link", {
				name: "0.25.0 (latest), No build for linux/amd64, release notes on GitHub",
			}),
		).toHaveTextContent("No build for linux/amd64");
		expect(
			within(sheet).getByText(/Release 0\.25\.0 has no/),
		).toHaveTextContent(
			"Release 0.25.0 has no pockode-linux-amd64, so it can't be installed here.",
		);
		expect(
			within(sheet).queryByRole("button", { name: /^Update to 0.25.0/ }),
		).not.toBeInTheDocument();
		expect(
			within(sheet).getByRole("button", { name: /^Update to 0.26.0/ }),
		).toBeInTheDocument();
	});

	it("offers no Update while another install runs", async () => {
		actions.serverUpdateCheck.mockResolvedValue(check({ installing: {} }));
		render(<Harness />);
		const { sheet } = await openSheet();

		expect(
			await within(sheet).findByText(
				"Another Pockode on this machine is installing a new version.",
			),
		).toBeInTheDocument();
		expect(
			within(sheet).queryByRole("button", { name: /^Update to/ }),
		).not.toBeInTheDocument();
	});
});

describe("not checked yet", () => {
	it("says so and offers the check, which looks past the cache", async () => {
		actions.serverUpdateCheck.mockResolvedValue(notChecked());
		render(<Harness />);
		const { user, sheet } = await openSheet();

		expect(
			await within(sheet).findByText(/Not checked since the cluster started/),
		).toBeInTheDocument();
		expect(within(sheet).queryByText(/Up to date/)).not.toBeInTheDocument();
		expect(within(sheet).queryByText(/Checking/)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /^Update to/ }),
		).not.toBeInTheDocument();

		const answer = deferred<ServerUpdateCheck>();
		actions.serverUpdateCheck.mockReturnValue(answer.promise);
		await user.click(
			within(sheet).getByRole("button", { name: "Check for updates" }),
		);
		expect(actions.serverUpdateCheck).toHaveBeenLastCalledWith(true);
		expect(
			within(sheet).getByRole("button", { name: "Checking..." }),
		).toBeDisabled();
		expect(
			within(sheet).getByText(/Not checked since the cluster started/),
		).toBeInTheDocument();

		await act(async () => answer.resolve(check({ candidates: [] })));
		expect(
			within(sheet).getByText(/Up to date · checked 3 min ago/),
		).toBeInTheDocument();
		expect(
			within(sheet).getByRole("button", { name: "Check again" }),
		).toBeEnabled();
	});

	// Those reads ask the server's memory, not GitHub.
	it("does not say Checking for a connect or visibility read", async () => {
		const first = deferred<ServerUpdateCheck>();
		actions.serverUpdateCheck.mockReturnValue(first.promise);
		render(<Harness />);
		const { sheet } = await openSheet();

		await act(async () => {});
		expect(within(sheet).queryByText(/[Cc]heck/)).not.toBeInTheDocument();
		await act(async () => first.resolve(notChecked()));
		await within(sheet).findByRole("button", { name: "Check for updates" });

		actions.serverUpdateCheck.mockReturnValue(
			deferred<ServerUpdateCheck>().promise,
		);
		act(() => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(actions.serverUpdateCheck).toHaveBeenLastCalledWith(false);
		expect(
			within(sheet).getByRole("button", { name: "Check for updates" }),
		).toBeEnabled();
	});

	// The server holds that read for the running check, so its answer is the
	// check's.
	it("keeps Checking through a read started meanwhile, until that settles", async () => {
		actions.serverUpdateCheck.mockResolvedValue(notChecked());
		render(<Harness />);
		const { user, sheet } = await openSheet();
		const press = await within(sheet).findByRole("button", {
			name: "Check for updates",
		});

		const forced = deferred<ServerUpdateCheck>();
		const unforced = deferred<ServerUpdateCheck>();
		actions.serverUpdateCheck
			.mockReturnValueOnce(forced.promise)
			.mockReturnValueOnce(unforced.promise);
		await user.click(press);
		act(() => {
			document.dispatchEvent(new Event("visibilitychange"));
		});

		await act(async () => forced.resolve(check({ candidates: [] })));
		expect(
			within(sheet).getByRole("button", { name: "Checking..." }),
		).toBeDisabled();

		await act(async () => unforced.resolve(check()));
		expect(
			within(sheet).getByRole("button", { name: "Update to 0.25.0 (latest)" }),
		).toBeInTheDocument();
		expect(within(sheet).getByText(/Checked 3 min ago/)).toBeInTheDocument();
		expect(
			within(sheet).getByRole("button", { name: "Check again" }),
		).toBeEnabled();
	});

	it("ends Checking when the socket drops, without a message", async () => {
		actions.serverUpdateCheck.mockResolvedValue(notChecked());
		render(<Harness />);
		const { user, sheet } = await openSheet();
		const press = await within(sheet).findByRole("button", {
			name: "Check for updates",
		});

		actions.serverUpdateCheck.mockImplementationOnce(async () => {
			wsState.status = "reconnecting";
			throw new Error("Connection lost");
		});
		await user.click(press);

		expect(
			within(sheet).getByRole("button", { name: "Check for updates" }),
		).toBeEnabled();
		expect(
			within(sheet).queryByText(/Connection lost/),
		).not.toBeInTheDocument();
	});

	it("is outranked by an install running elsewhere", async () => {
		actions.serverUpdateCheck.mockResolvedValue(notChecked({ installing: {} }));
		render(<Harness />);
		const { sheet } = await openSheet();

		expect(
			await within(sheet).findByText(
				"Another Pockode on this machine is installing a new version.",
			),
		).toBeInTheDocument();
		expect(within(sheet).queryByText(/Not checked/)).not.toBeInTheDocument();
	});
});

describe("confirming in the sheet", () => {
	it("checks again on open, and holds the confirm until it lands", async () => {
		render(<Harness />);
		const { user, sheet } = await openSheet();
		const update = await within(sheet).findByRole("button", {
			name: "Update to 0.25.0 (latest)",
		});

		let answer: (value: ServerUpdateCheck) => void = () => {};
		actions.serverUpdateCheck.mockReturnValueOnce(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		const calls = actions.serverUpdateCheck.mock.calls.length;
		await user.click(update);

		const confirm = screen.getByRole("dialog", {
			name: "Update the cluster to 0.25.0?",
		});
		expect(actions.serverUpdateCheck).toHaveBeenCalledTimes(calls + 1);
		const press = within(confirm).getByRole("button", {
			name: "Update and restart",
		});
		expect(press).toBeDisabled();
		expect(confirm).toHaveTextContent(
			`The cluster downloads 0.25.0 (latest) from GitHub, verifies it and replaces ${PATH}, then restarts.`,
		);
		expect(confirm).toHaveTextContent("Restart all outdated moves them over");
		expect(confirm).toHaveTextContent(
			"To go back, install 0.24.0 with the install script.",
		);
		expect(
			within(confirm).getByRole("link", { name: /^Release notes for 0.25.0/ }),
		).toBeInTheDocument();

		await act(async () => answer(check()));
		expect(press).toBeEnabled();
	});

	it("leads with the prerelease sentence for an alpha", async () => {
		actions.serverUpdateCheck.mockResolvedValue(
			check({ candidates: [ALPHA], latest_version: "0.25.0" }),
		);
		render(<Harness />);
		const { confirm } = await openConfirm("0.26.0-alpha.1 (alpha)");

		expect(confirm).toHaveTextContent(
			/^.*0\.26\.0-alpha\.1 is a prerelease and may be less stable than 0\.25\.0\. The cluster downloads/,
		);
	});

	it("returns to the first view when the candidate is gone", async () => {
		render(<Harness />);
		const { user, sheet } = await openSheet();
		const update = await within(sheet).findByRole("button", {
			name: "Update to 0.25.0 (latest)",
		});
		actions.serverUpdateCheck.mockResolvedValue(check({ candidates: [ALPHA] }));
		await user.click(update);

		expect(
			await screen.findByRole("dialog", { name: "Pockode cluster" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /^Update to 0.25.0/ }),
		).not.toBeInTheDocument();
	});

	// A re-check whose request failed says nothing about the candidate: the
	// confirmation stays, and the server decides on the press.
	it("keeps the confirmation when its re-check request fails", async () => {
		render(<Harness />);
		const { user, sheet } = await openSheet();
		const update = await within(sheet).findByRole("button", {
			name: "Update to 0.25.0 (latest)",
		});
		actions.serverUpdateCheck.mockRejectedValue(new Error("Request failed"));
		await user.click(update);

		const confirm = await screen.findByRole("dialog", {
			name: /^Update the cluster to/,
		});
		await waitFor(() =>
			expect(
				within(confirm).getByRole("button", { name: "Update and restart" }),
			).toBeEnabled(),
		);
	});

	it("installs, cannot be dismissed meanwhile, then restarts once", async () => {
		let replaced: () => void = () => {};
		actions.serverUpdate.mockReturnValue(
			new Promise<void>((resolve) => {
				replaced = resolve;
			}),
		);
		render(<Harness />);
		const { user, confirm, press } = await openConfirm("0.25.0 (latest)");

		await user.click(press);
		expect(actions.serverUpdate).toHaveBeenCalledWith("0.25.0");
		expect(press).toHaveTextContent("Installing...");
		expect(
			within(confirm).getByRole("button", { name: "Back" }),
		).toBeDisabled();
		expect(confirm).toHaveTextContent("Started 0:00 ago");
		await user.keyboard("{Escape}");
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(actions.restartServer).not.toHaveBeenCalled();

		await act(async () => replaced());
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(actions.restartServer).toHaveBeenCalledTimes(1);
	});

	it("says a refused restart after a good install, back in the first view", async () => {
		actions.serverUpdate.mockResolvedValue(undefined);
		actions.restartServer.mockRejectedValue(
			new Error("The cluster is shutting down"),
		);
		render(<Harness />);
		const { user, press } = await openConfirm("0.25.0 (latest)");

		actions.serverVersion.mockResolvedValue({
			installed: { path: PATH, version: "0.25.0" },
		});
		actions.serverUpdateCheck.mockResolvedValue(check({ candidates: [ALPHA] }));
		await user.click(press);

		const sheet = await screen.findByRole("dialog", {
			name: "Pockode cluster",
		});
		expect(await within(sheet).findByRole("alert")).toHaveTextContent(
			"0.25.0 was installed, but the cluster didn't restart: The cluster is shutting down",
		);
		const restart = within(sheet).getByRole("button", { name: "Restart" });
		await waitFor(() => expect(restart.className).toContain("bg-th-accent"));
	});

	it.each([
		["checksum_mismatch", "The download didn't match its checksum", true],
		["download_failed", "Couldn't download 0.25.0", true],
		["timeout", "The update took too long", true],
		["not_runnable", "0.25.0 didn't run on this machine", false],
	])("says a %s under the candidate, the file unchanged", async (reason, title, retry) => {
		actions.serverUpdate.mockRejectedValue(updateFailed(reason, "boom"));
		render(<Harness />);
		const { user, press } = await openConfirm("0.25.0 (latest)");
		await user.click(press);

		const sheet = await screen.findByRole("dialog", {
			name: "Pockode cluster",
		});
		const alert = await within(sheet).findByRole("alert");
		expect(alert).toHaveTextContent(title);
		expect(alert).toHaveTextContent(new RegExp(`${PATH} is unchanged\\.$`));
		expect(actions.restartServer).not.toHaveBeenCalled();
		const update = within(sheet).queryByRole("button", {
			name: "Update to 0.25.0 (latest)",
		});
		if (retry) expect(update).toBeInTheDocument();
		else expect(update).not.toBeInTheDocument();
	});

	// The one failure that does leave the file changed.
	it("does not promise an unchanged file after restore_failed", async () => {
		actions.serverUpdateCheck.mockResolvedValue(
			check({ platform: "windows/amd64", asset: "pockode-windows-amd64.exe" }),
		);
		actions.serverUpdate.mockRejectedValue(
			updateFailed("restore_failed", "The old file is at C:\\p.exe.123.old"),
		);
		render(<Harness />);
		const { user, press } = await openConfirm("0.25.0 (latest)");
		await user.click(press);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("and the old one wasn't put back");
		expect(alert).not.toHaveTextContent("unchanged");
		expect(
			screen.queryByRole("button", { name: "Update to 0.25.0 (latest)" }),
		).not.toBeInTheDocument();
	});

	it("draws the check again for a release gone meanwhile, saying nothing", async () => {
		actions.serverUpdate.mockRejectedValue(
			updateFailed("release_gone", "gone"),
		);
		render(<Harness />);
		const { user, press } = await openConfirm("0.25.0 (latest)");
		const calls = actions.serverUpdateCheck.mock.calls.length;
		await user.click(press);

		await screen.findByRole("dialog", { name: "Pockode cluster" });
		expect(actions.serverUpdateCheck.mock.calls.length).toBeGreaterThan(calls);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	// A restart nobody is watching, which stops turns started since, is not
	// one to send blind.
	it("never restarts after the connection dropped during the install", async () => {
		actions.serverUpdate.mockImplementation(async () => {
			wsState.status = "reconnecting";
			throw new Error("Connection lost");
		});
		render(<Harness />);
		const { user, press } = await openConfirm("0.25.0 (latest)");
		await user.click(press);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The connection was lost during the update. The cluster checks again when it reconnects.",
		);

		// Back, with the install finished meanwhile: the reads say so, and still
		// nothing restarts.
		wsState.status = "connected";
		actions.serverVersion.mockResolvedValue({
			installed: { path: PATH, version: "0.25.0" },
		});
		actions.serverUpdateCheck.mockResolvedValue(check({ candidates: [ALPHA] }));
		document.dispatchEvent(new Event("visibilitychange"));
		expect(
			await screen.findByText("Restart to use 0.25.0."),
		).toBeInTheDocument();
		expect(actions.restartServer).not.toHaveBeenCalled();
	});

	// This page's clock giving up is no answer: the install may have finished,
	// so the file is not said to be unchanged and nothing restarts.
	it("does not call an update it stopped waiting for a failure", async () => {
		actions.serverUpdate.mockRejectedValue(
			new JSONRPCErrorException("No answer came for the update", 0),
		);
		render(<Harness />);
		const { user, press } = await openConfirm("0.25.0 (latest)");
		await user.click(press);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/No answer came for the update/);
		expect(alert).not.toHaveTextContent(/unchanged/);
		expect(actions.restartServer).not.toHaveBeenCalled();
	});

	it("goes Back to the first view without installing", async () => {
		render(<Harness />);
		const { user, confirm } = await openConfirm("0.25.0 (latest)");
		await user.click(within(confirm).getByRole("button", { name: "Back" }));

		expect(
			await screen.findByRole("dialog", { name: "Pockode cluster" }),
		).toBeInTheDocument();
		expect(actions.serverUpdate).not.toHaveBeenCalled();
	});

	it("makes Update and restart primary for an alpha too", async () => {
		actions.serverUpdateCheck.mockResolvedValue(check({ candidates: [ALPHA] }));
		render(<Harness />);
		const { press } = await openConfirm("0.26.0-alpha.1 (alpha)");
		expect(press.className).toContain("bg-th-accent");
	});

	it("names pockode.exe and antivirus for replace_failed on Windows", async () => {
		actions.serverUpdateCheck.mockResolvedValue(
			check({ platform: "windows/amd64", asset: "pockode-windows-amd64.exe" }),
		);
		actions.serverUpdate.mockRejectedValue(
			updateFailed("replace_failed", "Access is denied."),
		);
		render(<Harness />);
		const { user, press } = await openConfirm("0.25.0 (latest)");
		await user.click(press);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			`Couldn't replace pockode.exe. Access is denied. This is usually antivirus still scanning the new file; try again in a minute. ${PATH} is unchanged.`,
		);
	});

	it("shows a failure no reason names by its message", async () => {
		actions.serverUpdate.mockRejectedValue(updateFailed("", "Something odd"));
		render(<Harness />);
		const { user, press } = await openConfirm("0.25.0 (latest)");
		await user.click(press);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			`Update failed. Something odd. ${PATH} is unchanged.`,
		);
		expect(
			screen.getByRole("button", { name: "Update to 0.25.0 (latest)" }),
		).toBeInTheDocument();
	});

	it("draws the other install when one was already running", async () => {
		actions.serverUpdate.mockRejectedValue(
			updateFailed("already_installing", "busy"),
		);
		render(<Harness />);
		const { user, press } = await openConfirm("0.25.0 (latest)");
		actions.serverUpdateCheck.mockResolvedValue(check({ installing: {} }));
		await user.click(press);

		expect(
			await screen.findByText(
				"Another Pockode on this machine is installing a new version.",
			),
		).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	// Pressing again would fetch the same file that did not run.
	it("keeps a failure that rules out a retry across reopening the sheet", async () => {
		actions.serverUpdate.mockRejectedValue(
			updateFailed("not_runnable", "boom"),
		);
		render(<Harness />);
		const { user, press } = await openConfirm("0.25.0 (latest)");
		await user.click(press);
		await screen.findByRole("alert");

		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		const { sheet } = await openSheet();
		await within(sheet).findByRole("link", { name: /0\.25\.0 \(latest\)/ });
		expect(within(sheet).getByRole("alert")).toHaveTextContent(
			"0.25.0 didn't run on this machine",
		);
		expect(
			within(sheet).queryByRole("button", {
				name: "Update to 0.25.0 (latest)",
			}),
		).not.toBeInTheDocument();
	});
});

describe("beside a restart", () => {
	// A press there would hide the restart's refusal behind a confirmation.
	it("offers no Update to press while Restart is out", async () => {
		actions.restartServer.mockReturnValue(new Promise(() => {}));
		render(<Harness />);
		const { user, sheet } = await openSheet();
		const restart = within(sheet).getByRole("button", { name: "Restart" });
		await waitFor(() => expect(restart).toBeEnabled());
		await within(sheet).findByRole("button", { name: /^Update to 0.25.0/ });
		await user.click(restart);

		expect(
			within(sheet).getByRole("button", { name: "Update to 0.25.0 (latest)" }),
		).toBeDisabled();
		expect(
			within(sheet).getByRole("button", { name: "Check again" }),
		).toBeDisabled();
	});

	it("offers Update as the way out of an unreadable install", async () => {
		actions.serverVersion.mockResolvedValue({
			installed: { path: PATH, error: "exec format error" },
		});
		render(<Harness />);
		const { sheet } = await openSheet();

		expect(
			await within(sheet).findByText(/Update it below, or reinstall it/),
		).toBeInTheDocument();
		expect(
			await within(sheet).findByRole("button", { name: /^Update to 0.25.0/ }),
		).toBeInTheDocument();
	});
});
