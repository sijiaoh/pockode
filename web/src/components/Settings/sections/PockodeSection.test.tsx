import type { ServerUpdateCheck, UpdateCandidate } from "@pockode/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerVersion } from "../../../lib/rpc";
import type { ServerUpdateRun } from "../../../lib/wsStore";
import PockodeSection from "./PockodeSection";

const fake = vi.hoisted(() => ({
	appVersion: "0.17.0",
	serverVersion: (() =>
		Promise.reject(new Error("unset"))) as () => Promise<unknown>,
	restartServer: (() => Promise.resolve()) as () => Promise<void>,
	updateCheck: (() => Promise.resolve(UP_TO_DATE)) as (
		params: unknown,
	) => Promise<unknown>,
	updateServer: vi.fn((_candidate: unknown) => Promise.resolve()),
}));

const UP_TO_DATE = vi.hoisted(() => ({
	// Read when a check answers, so "Checked just now" holds under any load.
	get checked_at() {
		return new Date().toISOString();
	},
	candidates: [],
	platform: "linux/amd64",
	asset: "pockode-linux-amd64",
}));

vi.mock("../../../lib/version", () => ({
	get APP_VERSION() {
		return fake.appVersion;
	},
}));

vi.mock("../../../lib/wsStore", async () => {
	const { create } = await import("zustand");
	const useWSStore = create(() => ({
		status: "connected",
		restartRequestedAt: null as number | null,
		serverUpdate: null as ServerUpdateRun | null,
	}));
	return {
		useWSStore,
		wsActions: {
			serverVersion: () => fake.serverVersion(),
			restartServer: () => fake.restartServer(),
			serverUpdateCheck: (params: unknown) => fake.updateCheck(params),
			updateServer: (candidate: unknown) => fake.updateServer(candidate),
			dismissServerUpdate: () => useWSStore.setState({ serverUpdate: null }),
		},
	};
});

const { useWSStore } = await import("../../../lib/wsStore");

function version(
	installed: ServerVersion["installed"],
	running_turns = 0,
): ServerVersion {
	return { installed, running_turns };
}

const PATH = "/home/ada/.local/bin/pockode";

/** Every read answers with `answer`; the returned spy counts them. */
function answer(info: ServerVersion) {
	const spy = vi.fn(() => Promise.resolve(info));
	fake.serverVersion = spy;
	return spy;
}

/** Reads wait until released, one by one. */
function deferredReads() {
	const pending: Array<(info: ServerVersion) => void> = [];
	fake.serverVersion = () =>
		new Promise((resolve) => {
			pending.push(resolve);
		});
	return {
		count: () => pending.length,
		release: (index: number, info: ServerVersion) =>
			act(async () => pending[index](info)),
	};
}

/** Finds the row by its title and checks the line under it. */
async function findRow(title: string, subtitle: string) {
	const line = await screen.findByText(title, { selector: "p" });
	expect(line.nextElementSibling).toHaveTextContent(subtitle);
	return line;
}

function refusal(reason: string, message: string) {
	return new JSONRPCErrorException(message, -32011, { reason });
}

beforeEach(() => {
	fake.appVersion = "0.17.0";
	fake.restartServer = () => Promise.resolve();
	fake.updateCheck = () => Promise.resolve(UP_TO_DATE);
	fake.updateServer.mockClear();
	useWSStore.setState({
		status: "connected",
		restartRequestedAt: null,
		serverUpdate: null,
	});
});

describe("PockodeSection", () => {
	describe("the row", () => {
		it("offers Restart when the installed version is the same", async () => {
			answer(version({ version: "0.17.0", path: PATH }));
			render(<PockodeSection />);

			await findRow("Version 0.17.0", "Installed version is the same");
			expect(
				screen.getByRole("button", { name: "Restart" }),
			).toBeInTheDocument();
		});

		it("says which version is installed when it differs, older ones included", async () => {
			answer(version({ version: "0.16.0", path: PATH }));
			render(<PockodeSection />);

			await findRow("Version 0.17.0", "0.16.0 installed");
			expect(
				screen.getByRole("button", { name: "Restart" }),
			).toBeInTheDocument();
		});

		// A dev build and a release always differ, so comparing them says nothing.
		it("never calls a development build out of date", async () => {
			fake.appVersion = "dev";
			answer(version({ version: "0.17.0", path: PATH }));
			render(<PockodeSection />);

			await findRow("Development build", "Installed: 0.17.0");
			expect(screen.queryByText(/installed$/)).not.toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Restart" }),
			).toBeInTheDocument();
		});

		// The server refuses a restart into a file that does not run.
		it("withholds Restart when the installed file can't be read, and says why", async () => {
			answer(
				version({
					error: "--version: fork/exec: exec format error",
					path: PATH,
				}),
			);
			render(<PockodeSection />);

			await findRow("Version 0.17.0", "Couldn't read the installed version");
			expect(screen.getByText(/exec format error/)).toHaveTextContent(
				`--version: fork/exec: exec format error. Pockode can't restart until ${PATH} runs. Reinstall it on the server.`,
			);
			expect(
				screen.queryByRole("button", { name: "Restart" }),
			).not.toBeInTheDocument();
		});

		it("reports a read that failed", async () => {
			fake.serverVersion = () => Promise.reject(new Error("Not connected"));
			render(<PockodeSection />);

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"Couldn't ask the server: Not connected",
			);
		});

		it("reads again when the page comes back into view", async () => {
			const reads = answer(version({ version: "0.17.0", path: PATH }));
			render(<PockodeSection />);
			await findRow("Version 0.17.0", "Installed version is the same");

			answer(version({ version: "0.18.0", path: PATH }));
			act(() => {
				document.dispatchEvent(new Event("visibilitychange"));
			});

			await findRow("Version 0.17.0", "0.18.0 installed");
			expect(reads).toHaveBeenCalledOnce();
		});
	});

	describe("the dialog", () => {
		it("re-reads on open, and Restart waits for that answer", async () => {
			const reads = deferredReads();
			render(<PockodeSection />);
			await reads.release(0, version({ version: "0.17.0", path: PATH }));
			const user = userEvent.setup();

			await user.click(await screen.findByRole("button", { name: "Restart" }));
			const dialog = screen.getByRole("dialog");
			const confirm = within(dialog).getByRole("button", { name: "Restart" });
			expect(reads.count()).toBe(2);
			// The card's last values until the re-read lands.
			expect(dialog).toHaveTextContent(
				"Pockode restarts on the server with the same version and options. No AI turn is running; sessions are kept. This page reconnects by itself.",
			);
			expect(confirm).toHaveAttribute("aria-disabled", "true");

			await reads.release(1, version({ version: "0.18.0", path: PATH }, 2));

			expect(dialog).toHaveTextContent(
				"Pockode restarts on the server and comes back running 0.18.0 (now 0.17.0). 2 AI turns are running and will be stopped — their sessions and history are kept, and you can continue them afterwards. This page reconnects by itself.",
			);
			expect(confirm).not.toHaveAttribute("aria-disabled");
		});

		it("is a danger only while turns are running", async () => {
			answer(version({ version: "0.17.0", path: PATH }, 1));
			render(<PockodeSection />);
			const user = userEvent.setup();

			await user.click(await screen.findByRole("button", { name: "Restart" }));
			const dialog = screen.getByRole("dialog");
			await screen.findByText(/1 AI turn is running and will be stopped/);
			expect(
				within(dialog).getByRole("button", { name: "Restart" }),
			).toHaveClass("bg-th-error");
		});

		it("is not a danger with nothing running", async () => {
			answer(version({ version: "0.17.0", path: PATH }));
			render(<PockodeSection />);
			const user = userEvent.setup();

			await user.click(await screen.findByRole("button", { name: "Restart" }));
			const dialog = screen.getByRole("dialog");
			await within(dialog).findByText(/No AI turn is running/);
			expect(
				within(dialog).getByRole("button", { name: "Restart" }),
			).not.toHaveClass("bg-th-error");
		});

		it("closes into the row's reason when the re-read finds the file unreadable", async () => {
			const reads = deferredReads();
			render(<PockodeSection />);
			await reads.release(0, version({ version: "0.17.0", path: PATH }));
			const user = userEvent.setup();

			await user.click(await screen.findByRole("button", { name: "Restart" }));
			await reads.release(1, version({ error: "--version: gone", path: PATH }));

			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			await findRow("Version 0.17.0", "Couldn't read the installed version");
		});

		// Coming back from another app re-reads; that read failing is the row's.
		it("stays up when a later read fails while the user reads it", async () => {
			const reads = deferredReads();
			render(<PockodeSection />);
			await reads.release(0, version({ version: "0.18.0", path: PATH }));
			const user = userEvent.setup();

			await user.click(await screen.findByRole("button", { name: "Restart" }));
			await reads.release(1, version({ version: "0.18.0", path: PATH }));
			act(() => {
				document.dispatchEvent(new Event("visibilitychange"));
			});
			await reads.release(2, version({ error: "--version: gone", path: PATH }));

			expect(screen.getByRole("dialog")).toBeInTheDocument();
		});

		it("keeps a refusal in the dialog, to be tried again or cancelled", async () => {
			answer(version({ version: "0.18.0", path: PATH }));
			const message = `The installed pockode at ${PATH} didn't run: exit status 2. Pockode kept running; nothing was stopped.`;
			fake.restartServer = () =>
				Promise.reject(refusal("not_runnable", message));
			render(<PockodeSection />);
			const user = userEvent.setup();

			await user.click(await screen.findByRole("button", { name: "Restart" }));
			const dialog = screen.getByRole("dialog");
			const confirm = within(dialog).getByRole("button", { name: "Restart" });
			await vi.waitFor(() =>
				expect(confirm).not.toHaveAttribute("aria-disabled"),
			);
			await user.click(confirm);

			expect(await within(dialog).findByRole("alert")).toHaveTextContent(
				message,
			);
			expect(screen.getByRole("dialog")).toBeInTheDocument();
			expect(screen.queryByText("Restarting Pockode...")).toBeNull();
		});

		it("closes into Restarting once the server accepts", async () => {
			answer(version({ version: "0.18.0", path: PATH }));
			fake.restartServer = async () => {
				useWSStore.setState({ restartRequestedAt: Date.now() });
			};
			render(<PockodeSection />);
			const user = userEvent.setup();

			await user.click(await screen.findByRole("button", { name: "Restart" }));
			const confirm = within(screen.getByRole("dialog")).getByRole("button", {
				name: "Restart",
			});
			await vi.waitFor(() =>
				expect(confirm).not.toHaveAttribute("aria-disabled"),
			);
			await user.click(confirm);

			await vi.waitFor(() =>
				expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
			);
			await findRow("Restarting Pockode...", "Started 0:00 ago");
			// Announced through the region that was there all along, and the
			// keyboard is left on the card rather than on the page body.
			expect(screen.getByRole("status")).toHaveTextContent(
				"Restarting Pockode...",
			);
			expect(document.activeElement).not.toBe(document.body);
		});
	});

	describe("while it restarts", () => {
		it("says it hasn't come back a minute on", async () => {
			answer(version({ version: "0.18.0", path: PATH }));
			useWSStore.setState({
				status: "reconnecting",
				restartRequestedAt: Date.now() - 64_000,
			});
			render(<PockodeSection />);

			await findRow("Pockode hasn't come back", "Started 1:04 ago");
			expect(
				screen.getByText(/The restart may have failed on the server/),
			).toBeInTheDocument();
		});

		// A same-version restart: the page stays, and the row reads the file again.
		it("reads the installed version again once the connection is back", async () => {
			const reads = answer(version({ version: "0.17.0", path: PATH }));
			useWSStore.setState({
				status: "reconnecting",
				restartRequestedAt: Date.now(),
			});
			render(<PockodeSection />);
			await findRow("Restarting Pockode...", "Started 0:00 ago");
			expect(reads).not.toHaveBeenCalled();

			act(() => {
				useWSStore.setState({ status: "connected", restartRequestedAt: null });
			});

			await findRow("Version 0.17.0", "Installed version is the same");
			expect(reads).toHaveBeenCalledOnce();
		});
	});

	// docs/self-update-ui.md, "web: Settings → Pockode".
	describe("updates", () => {
		const LATEST: UpdateCandidate = {
			channel: "latest",
			version: "0.25.0",
			notes_url: "https://github.com/sijiaoh/pockode/releases/tag/v0.25.0",
		};
		const ALPHA: UpdateCandidate = {
			channel: "alpha",
			version: "0.26.0-alpha.1",
			notes_url:
				"https://github.com/sijiaoh/pockode/releases/tag/v0.26.0-alpha.1",
		};

		function offers(
			candidates: UpdateCandidate[],
			extra: Partial<ServerUpdateCheck> = {},
		) {
			const result: ServerUpdateCheck = {
				...UP_TO_DATE,
				candidates,
				latest_version: "0.25.0",
				...extra,
			};
			const spy = vi.fn((_params: unknown) => Promise.resolve(result));
			fake.updateCheck = spy;
			return spy;
		}

		/** Checks wait until released, one by one. */
		function deferredChecks() {
			const pending: Array<{
				resolve: (check: ServerUpdateCheck) => void;
				reject: (err: Error) => void;
			}> = [];
			fake.updateCheck = () =>
				new Promise((resolve, reject) => {
					pending.push({ resolve, reject });
				});
			return {
				count: () => pending.length,
				release: (index: number, check: ServerUpdateCheck) =>
					act(async () => pending[index].resolve(check)),
				fail: (index: number, message: string) =>
					act(async () => pending[index].reject(new Error(message))),
			};
		}

		function checkOf(
			candidates: UpdateCandidate[],
			extra: Partial<ServerUpdateCheck> = {},
		): ServerUpdateCheck {
			return { ...UP_TO_DATE, candidates, latest_version: "0.25.0", ...extra };
		}

		const tryAgain = (candidate = LATEST) => ({
			name: `Try again to update to ${candidate.version} (${candidate.channel})`,
		});

		function card() {
			return screen.getByRole("status").parentElement;
		}

		function updateButton(candidate: UpdateCandidate) {
			return screen.findByRole("button", {
				name: `Update to ${candidate.version} (${candidate.channel})`,
			});
		}

		function failed(
			reason: string | null,
			message: string,
			candidate = LATEST,
		): ServerUpdateRun {
			return {
				phase: "failed",
				candidate,
				endedAt: Date.now(),
				reason: reason as Extract<
					ServerUpdateRun,
					{ phase: "failed" }
				>["reason"],
				message,
			};
		}

		beforeEach(() => {
			answer(version({ version: "0.17.0", path: PATH }));
		});

		describe("the candidate rows", () => {
			it("draws each release as a link to its notes, with Update", async () => {
				offers([LATEST, ALPHA]);
				render(<PockodeSection />);

				expect(await updateButton(LATEST)).toHaveTextContent(/^Update$/);
				expect(await updateButton(ALPHA)).toBeInTheDocument();
				const link = screen.getByRole("link", {
					name: "Release notes for 0.25.0 (latest), opens GitHub",
				});
				expect(link).toHaveAttribute("href", LATEST.notes_url);
				expect(link).toHaveAttribute("target", "_blank");
				expect(link).toHaveTextContent("0.25.0 (latest)Release notes");
			});

			it("makes latest's Update primary, never Restart beside it", async () => {
				answer(version({ version: "0.18.0", path: PATH }));
				offers([LATEST, ALPHA]);
				render(<PockodeSection />);

				expect(await updateButton(LATEST)).toHaveClass("bg-th-accent");
				expect(await updateButton(ALPHA)).not.toHaveClass("bg-th-accent");
				await findRow("Version 0.17.0", "0.18.0 installed");
				expect(screen.getByRole("button", { name: "Restart" })).not.toHaveClass(
					"bg-th-accent",
				);
			});

			it("leaves Restart primary beside an alpha, which never is", async () => {
				answer(version({ version: "0.18.0", path: PATH }));
				offers([ALPHA]);
				render(<PockodeSection />);

				expect(await updateButton(ALPHA)).not.toHaveClass("bg-th-accent");
				await findRow("Version 0.17.0", "0.18.0 installed");
				expect(screen.getByRole("button", { name: "Restart" })).toHaveClass(
					"bg-th-accent",
				);
			});

			it("offers an update as the fix for an unreadable file", async () => {
				answer(version({ error: "--version: gone", path: PATH }));
				offers([LATEST]);
				render(<PockodeSection />);

				await updateButton(LATEST);
				expect(screen.getByText(/--version: gone/)).toHaveTextContent(
					"Update it below, or reinstall it on the server.",
				);
			});
		});

		describe("the status row", () => {
			it("waits for the first answer with a skeleton", async () => {
				fake.updateCheck = () => new Promise(() => {});
				render(<PockodeSection />);
				await findRow("Version 0.17.0", "Installed version is the same");
				expect(
					screen.getByLabelText("Checking for a newer Pockode"),
				).toBeInTheDocument();
			});

			it("says up to date, and Check again looks past the cache", async () => {
				const checks = offers([]);
				render(<PockodeSection />);
				const user = userEvent.setup();

				await findRow("Up to date", "Checked just now");
				expect(checks).toHaveBeenLastCalledWith({});
				await user.click(screen.getByRole("button", { name: "Check again" }));
				expect(checks).toHaveBeenLastCalledWith({ force: true });
			});

			it("never calls a failed check up to date", async () => {
				const checks = offers([], {
					checked_at: undefined,
					check_error: { reason: "unavailable", message: "GitHub: 503" },
				});
				render(<PockodeSection />);
				const user = userEvent.setup();

				await screen.findByText("Couldn't check for updates");
				expect(screen.queryByText("Up to date")).toBeNull();
				expect(screen.getByText(/GitHub: 503/)).toHaveTextContent(
					"GitHub: 503. If this server reaches the internet through a proxy, start pockode with HTTPS_PROXY set.",
				);
				await user.click(screen.getByRole("button", { name: "Try again" }));
				expect(checks).toHaveBeenLastCalledWith({ force: true });
			});

			describe("not checked yet", () => {
				const NOT_CHECKED = checkOf([], { checked_at: undefined });
				const checkButton = () =>
					screen.getByRole("button", { name: "Check for updates" });

				/** Lands the mount's read as not checked, then presses Check. */
				async function pressCheck() {
					const checks = deferredChecks();
					render(<PockodeSection />);
					await checks.release(0, NOT_CHECKED);
					await findRow("Updates not checked", "Checked only on request");
					await userEvent.setup().click(checkButton());
					return checks;
				}

				it("is a row of its own, with Check, and says nothing", async () => {
					offers([], { checked_at: undefined });
					render(<PockodeSection />);

					await findRow("Updates not checked", "Checked only on request");
					expect(checkButton()).toHaveTextContent(/^Check$/);
					expect(screen.queryByText("Up to date")).toBeNull();
					expect(
						screen.queryByLabelText("Checking for a newer Pockode"),
					).toBeNull();
					expect(screen.getByRole("status")).toBeEmptyDOMElement();
				});

				it("forces a check, and shows it is out without letting go of focus", async () => {
					const calls: unknown[] = [];
					const checks = deferredChecks();
					const pending = fake.updateCheck;
					fake.updateCheck = (params) => {
						calls.push(params);
						return pending(params);
					};
					render(<PockodeSection />);
					await checks.release(0, NOT_CHECKED);
					const user = userEvent.setup();

					await user.click(
						await screen.findByRole("button", { name: "Check for updates" }),
					);
					expect(calls).toEqual([{}, { force: true }]);
					await findRow("Updates not checked", "Checking...");
					expect(checkButton()).toHaveAttribute("aria-disabled", "true");
					expect(checkButton()).toHaveFocus();
					expect(screen.getByRole("status")).toHaveTextContent(
						"Checking for updates...",
					);

					await user.click(checkButton());
					expect(calls).toHaveLength(2);

					await checks.release(1, checkOf([]));
					await findRow("Up to date", "Checked just now");
					const again = screen.getByRole("button", { name: "Check again" });
					expect(again).toHaveFocus();
					expect(again).not.toHaveAttribute("aria-disabled");
					expect(screen.getByRole("status")).toHaveTextContent("Up to date");
				});

				it("hands focus to the card when releases replace the row", async () => {
					const checks = await pressCheck();
					await checks.release(1, checkOf([LATEST, ALPHA]));

					await updateButton(LATEST);
					await waitFor(() => expect(card()).toHaveFocus());
					expect(screen.getByRole("status")).toHaveTextContent(
						"Updates available: 0.25.0 (latest), 0.26.0-alpha.1 (alpha)",
					);
				});

				it("stays not checked when the request fails, and says it couldn't", async () => {
					const checks = await pressCheck();
					await checks.fail(1, "WebSocket is not connected");

					expect(await screen.findByRole("alert")).toHaveTextContent(
						"Couldn't check: WebSocket is not connected",
					);
					await findRow("Updates not checked", "Checked only on request");
					expect(checkButton()).not.toHaveAttribute("aria-disabled");
					expect(screen.getByRole("status")).toBeEmptyDOMElement();
				});

				it("says the check still runs when it outlived the server's wait", async () => {
					const checks = await pressCheck();
					await checks.release(1, NOT_CHECKED);

					expect(
						await screen.findByText(/still running on the server/),
					).toHaveTextContent(
						"The check is still running on the server. Press Check in a moment to see its answer.",
					);
					expect(screen.getByRole("status")).toHaveTextContent(
						"Still checking on the server",
					);
				});

				// The server may have restarted in between: not checked is then no
				// answer to the press.
				it("forgets the press when the connection drops", async () => {
					const checks = await pressCheck();
					act(() => useWSStore.setState({ status: "disconnected" }));
					act(() => useWSStore.setState({ status: "connected" }));
					await checks.release(2, NOT_CHECKED);

					await findRow("Updates not checked", "Checked only on request");
					expect(checkButton()).not.toHaveAttribute("aria-disabled");
					expect(screen.queryByText(/still running on the server/)).toBeNull();
					expect(screen.getByRole("status")).toBeEmptyDOMElement();
				});

				it("says what a failed check found", async () => {
					const checks = await pressCheck();
					await checks.release(
						1,
						checkOf([], {
							checked_at: undefined,
							check_error: { reason: "unavailable", message: "GitHub: 503" },
						}),
					);

					await screen.findByText(/GitHub: 503/);
					expect(screen.getByRole("status")).toHaveTextContent(
						"Couldn't check for updates",
					);
				});
			});

			// An answer from the server's cache lands at once: without a minimum
			// the press would look like it did nothing.
			it.each([
				["Check again", "Up to date", {}],
				[
					"Try again",
					"Couldn't check for updates",
					{
						checked_at: undefined,
						check_error: {
							reason: "unavailable" as const,
							message: "GitHub: 503",
						},
					},
				],
			])("shows %s's check as out, even when it answers at once", async (button, row, extra) => {
				offers([], extra);
				render(<PockodeSection />);
				const user = userEvent.setup();

				await screen.findByText(row);
				await user.click(screen.getByRole("button", { name: button }));
				await findRow(row, "Checking...");
				expect(screen.getByRole("button", { name: button })).toHaveAttribute(
					"aria-disabled",
					"true",
				);
				await waitFor(() =>
					expect(
						screen.getByRole("button", { name: button }),
					).not.toHaveAttribute("aria-disabled"),
				);
			});

			it("offers nothing to a development build", async () => {
				offers([], {
					checked_at: undefined,
					check_error: { reason: "dev_build", message: "dev" },
				});
				render(<PockodeSection />);
				await findRow(
					"No updates for a development build",
					"Built from source",
				);
			});

			it("withholds Update while another process installs", async () => {
				offers([LATEST], { installing: {} });
				render(<PockodeSection />);

				await findRow("Another update is running", "On this machine");
				expect(screen.queryByRole("button", { name: /^Update to/ })).toBeNull();
			});
		});

		describe("can't update", () => {
			it("keeps the releases without Update, says why, and keeps Restart", async () => {
				offers([LATEST], {
					cannot_install: {
						reason: "not_writable",
						message: "no write access",
						dir: "/usr/local/bin",
						hint: "Update from a terminal with `install.sh --install-dir /usr/local/bin`.",
					},
				});
				render(<PockodeSection />);

				await screen.findByText(/no write access to/);
				expect(screen.getByText(/no write access to/)).toHaveTextContent(
					"Can't update from here: no write access to /usr/local/bin",
				);
				expect(
					screen.getByText("install.sh --install-dir /usr/local/bin"),
				).toHaveClass("font-mono");
				expect(
					screen.getByRole("link", { name: /Release notes for 0.25.0/ }),
				).toBeInTheDocument();
				expect(screen.queryByRole("button", { name: /^Update to/ })).toBeNull();
				expect(
					screen.getByRole("button", { name: "Restart" }),
				).toBeInTheDocument();
			});

			it("drops only the Update of a release with no build here", async () => {
				offers([
					LATEST,
					{
						...ALPHA,
						unavailable: { reason: "no_asset", message: "no build" },
					},
				]);
				render(<PockodeSection />);

				await updateButton(LATEST);
				expect(screen.queryByRole("button", { name: /alpha/ })).toBeNull();
				expect(
					screen.getByText("No build for linux/amd64"),
				).toBeInTheDocument();
				expect(
					screen.getByText(/so it can't be installed here/),
				).toHaveTextContent(
					"Release 0.26.0-alpha.1 has no pockode-linux-amd64, so it can't be installed here. Build it from source.",
				);
			});
		});

		describe("the dialog", () => {
			it("checks again on open, and waits for that and the turn count", async () => {
				const reads = deferredReads();
				const checks = deferredChecks();
				render(<PockodeSection />);
				await reads.release(0, version({ version: "0.17.0", path: PATH }));
				await checks.release(0, checkOf([LATEST]));
				const user = userEvent.setup();

				await user.click(await updateButton(LATEST));
				const dialog = screen.getByRole("dialog");
				expect(checks.count()).toBe(2);
				const confirm = within(dialog).getByRole("button", {
					name: "Update and restart",
				});
				expect(confirm).toHaveAttribute("aria-disabled", "true");

				await reads.release(1, version({ version: "0.17.0", path: PATH }, 2));
				expect(confirm).toHaveAttribute("aria-disabled", "true");
				await checks.release(1, checkOf([LATEST]));
				expect(confirm).not.toHaveAttribute("aria-disabled");
				expect(confirm).toHaveClass("bg-th-error");
				expect(dialog).toHaveTextContent("Update Pockode to 0.25.0?");
				expect(dialog).toHaveTextContent(
					`Pockode downloads 0.25.0 (latest) from GitHub, verifies it and replaces ${PATH}, then restarts. 2 AI turns are running now; any still running when it restarts are stopped — their sessions and history are kept. Other Pockode servers that run this file, cluster nodes included, keep the version they run until they restart. To go back, install 0.17.0 with the install script. This page reconnects by itself.`,
				);
			});

			it("leads with the prerelease for an alpha, and is no danger when idle", async () => {
				offers([ALPHA]);
				render(<PockodeSection />);
				const user = userEvent.setup();

				await user.click(await updateButton(ALPHA));
				const dialog = screen.getByRole("dialog");
				const confirm = within(dialog).getByRole("button", {
					name: "Update and restart",
				});
				await vi.waitFor(() =>
					expect(confirm).not.toHaveAttribute("aria-disabled"),
				);
				expect(confirm).not.toHaveClass("bg-th-error");
				expect(dialog).toHaveTextContent(
					/^Update Pockode to 0.26.0-alpha.1\?0.26.0-alpha.1 is a prerelease and may be less stable than 0.25.0. Pockode downloads/,
				);
				expect(dialog).toHaveTextContent(
					"No AI turn is running now; any running when it restarts are stopped — sessions are kept.",
				);
			});

			it("closes when the fresh check no longer offers the release", async () => {
				offers([LATEST]);
				render(<PockodeSection />);
				const user = userEvent.setup();
				const button = await updateButton(LATEST);

				offers([]);
				await user.click(button);

				await vi.waitFor(() =>
					expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
				);
				await findRow("Up to date", "Checked just now");
				expect(document.activeElement).toBe(card());
			});

			it("closes when the fresh check finds this server can't install", async () => {
				offers([LATEST]);
				render(<PockodeSection />);
				const user = userEvent.setup();
				const button = await updateButton(LATEST);

				offers([LATEST], {
					cannot_install: { reason: "container", message: "container" },
				});
				await user.click(button);

				await vi.waitFor(() =>
					expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
				);
				expect(screen.getByText(/running in a container/)).toBeInTheDocument();
			});

			// The server checks again itself; the press is not refused here.
			it("stays up when its check fails, and can still be confirmed", async () => {
				const checks = deferredChecks();
				render(<PockodeSection />);
				await checks.release(0, checkOf([LATEST]));
				const user = userEvent.setup();

				await user.click(await updateButton(LATEST));
				await checks.fail(1, "Request timed out");

				const confirm = within(screen.getByRole("dialog")).getByRole("button", {
					name: "Update and restart",
				});
				await vi.waitFor(() =>
					expect(confirm).not.toHaveAttribute("aria-disabled"),
				);
			});

			// Its turn count would be the old one.
			it("closes when the version read fails", async () => {
				const reads = deferredReads();
				offers([LATEST]);
				render(<PockodeSection />);
				await reads.release(0, version({ version: "0.17.0", path: PATH }));
				const user = userEvent.setup();

				let failRead: (err: Error) => void = () => {};
				fake.serverVersion = () =>
					new Promise((_, reject) => {
						failRead = reject;
					});
				await user.click(await updateButton(LATEST));
				expect(screen.getByRole("dialog")).toBeInTheDocument();
				await act(async () => failRead(new Error("gone")));

				expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
				expect(screen.getByRole("alert")).toHaveTextContent(
					"Couldn't read the installed version again: gone",
				);
			});

			it("closes at once into Installing, with Restart withheld", async () => {
				offers([LATEST, ALPHA]);
				fake.updateServer.mockImplementation(async (candidate) => {
					useWSStore.setState({
						serverUpdate: {
							phase: "installing",
							candidate: candidate as UpdateCandidate,
							startedAt: Date.now(),
						},
					});
				});
				render(<PockodeSection />);
				const user = userEvent.setup();

				await user.click(await updateButton(LATEST));
				const confirm = within(screen.getByRole("dialog")).getByRole("button", {
					name: "Update and restart",
				});
				await vi.waitFor(() =>
					expect(confirm).not.toHaveAttribute("aria-disabled"),
				);
				await user.click(confirm);

				expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
				expect(fake.updateServer).toHaveBeenCalledExactlyOnceWith(LATEST);
				await findRow("Installing 0.25.0...", "Started 0:00 ago");
				expect(screen.getByRole("status")).toHaveTextContent(
					"Installing 0.25.0...",
				);
				expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
				expect(screen.queryByText("0.26.0-alpha.1 (alpha)")).toBeNull();
				expect(document.activeElement).toBe(card());
			});
		});

		describe("installing, and after", () => {
			// Coming back to Settings mid-install finds it where the store has it.
			it("names the budget from two minutes on", async () => {
				offers([LATEST]);
				useWSStore.setState({
					serverUpdate: {
						phase: "installing",
						candidate: LATEST,
						startedAt: Date.now() - 130_000,
					},
				});
				render(<PockodeSection />);
				await findRow("Installing 0.25.0...", "Started 2:10 ago · up to 5 min");
			});

			it("says the file was installed when the restart was refused", async () => {
				answer(version({ version: "0.25.0", path: PATH }));
				offers([]);
				useWSStore.setState({
					serverUpdate: {
						phase: "restart_refused",
						candidate: LATEST,
						endedAt: Date.now(),
						message: "Pockode is shutting down.",
					},
				});
				render(<PockodeSection />);

				await findRow("Version 0.17.0", "0.25.0 installed");
				expect(screen.getByRole("alert")).toHaveTextContent(
					"0.25.0 was installed, but Pockode didn't restart: Pockode is shutting down.",
				);
				expect(screen.getByRole("button", { name: "Restart" })).toHaveClass(
					"bg-th-accent",
				);

				await userEvent
					.setup()
					.click(screen.getByRole("button", { name: "Dismiss" }));
				expect(screen.queryByRole("alert")).toBeNull();
				expect(document.activeElement).toBe(card());
			});

			it("says a lost install didn't finish once a later check still offers it", async () => {
				offers([LATEST]);
				useWSStore.setState({
					serverUpdate: {
						phase: "lost",
						candidate: LATEST,
						endedAt: Date.now() - 1000,
						cause: "connection",
					},
				});
				render(<PockodeSection />);

				expect(
					await screen.findByText(/The connection was lost during the update/),
				).toHaveTextContent(
					`The connection was lost during the update; it didn't finish. ${PATH} is unchanged.`,
				);
				expect(screen.getByRole("button", tryAgain())).toBeInTheDocument();
			});

			it("says no answer came when this page stopped waiting", async () => {
				offers([LATEST]);
				useWSStore.setState({
					serverUpdate: {
						phase: "lost",
						candidate: LATEST,
						endedAt: Date.now() - 1000,
						cause: "timeout",
					},
				});
				render(<PockodeSection />);

				expect(
					await screen.findByText(/No answer came for the update/),
				).toHaveTextContent(
					`No answer came for the update; it didn't finish. ${PATH} is unchanged.`,
				);
			});

			// The install may well have finished: only a check that answered after
			// the drop can say it didn't.
			it("says nothing of a lost install when the check after it fails", async () => {
				const checks = deferredChecks();
				render(<PockodeSection />);
				await checks.release(0, checkOf([LATEST]));
				await updateButton(LATEST);

				act(() => {
					useWSStore.setState({
						status: "reconnecting",
						serverUpdate: {
							phase: "lost",
							candidate: LATEST,
							endedAt: Date.now(),
							cause: "connection",
						},
					});
				});
				act(() => {
					useWSStore.setState({ status: "connected" });
				});
				await checks.fail(1, "Request timed out");

				expect(
					await screen.findByText(/Couldn't check again/),
				).toBeInTheDocument();
				expect(screen.queryByText(/The connection was lost/)).toBeNull();
				// Nor is the release offered again: it may still be installing.
				expect(
					screen.queryByRole("button", { name: "Update to 0.25.0 (latest)" }),
				).toBeNull();
			});

			it("says the page's own install still runs after a reconnect", async () => {
				offers([LATEST], {
					installing: {
						version: "0.25.0",
						channel: "latest",
						started_at: new Date().toISOString(),
					},
				});
				useWSStore.setState({
					serverUpdate: {
						phase: "lost",
						candidate: LATEST,
						endedAt: Date.now() - 1000,
						cause: "connection",
					},
				});
				render(<PockodeSection />);

				expect(
					await screen.findByText(/this page started is still running/),
				).toHaveTextContent(
					"The update to 0.25.0 this page started is still running; the page lost its answer.",
				);
			});

			it("reads once on a visit that finds an ended install", async () => {
				const reads = answer(version({ version: "0.17.0", path: PATH }));
				const checks = offers([LATEST]);
				useWSStore.setState({ serverUpdate: failed("timeout", "stopped") });
				render(<PockodeSection />);

				await screen.findByRole("button", tryAgain());
				expect(reads).toHaveBeenCalledOnce();
				expect(checks).toHaveBeenCalledOnce();
			});
		});

		describe("failed", () => {
			const cases: Array<{
				reason: string | null;
				message: string;
				title: string | null;
				body: string;
				retry: boolean;
				platform?: string;
			}> = [
				{
					reason: "checksum_mismatch",
					message: "expected aa, got bb",
					title: "The download didn't match its checksum",
					body: "pockode-linux-amd64 from 0.25.0 doesn't match the release's checksums.txt, so it was discarded.",
					retry: true,
				},
				{
					reason: "download_failed",
					message: "download pockode-linux-amd64: 502 Bad Gateway",
					title: "Couldn't download 0.25.0",
					body: "Download pockode-linux-amd64: 502 Bad Gateway. If this server reaches the internet through a proxy, start pockode with HTTPS_PROXY set.",
					retry: true,
				},
				{
					reason: "not_runnable",
					message: "exec format error",
					title: "0.25.0 didn't run on this machine",
					body: "The downloaded file failed --version: exec format error. It was discarded.",
					retry: false,
				},
				{
					reason: "replace_failed",
					message: "put the new version in place of C:\\p.exe: denied",
					title: "Couldn't replace pockode.exe",
					body: "On Windows this is usually antivirus still scanning the new file; try again in a minute.",
					retry: true,
					platform: "windows/amd64",
				},
				{
					reason: "timeout",
					message: "stopped",
					title: "The update took too long",
					body: "Pockode stopped after 5 minutes.",
					retry: true,
				},
				{
					reason: "no_checksums",
					message: "the release has no checksums.txt",
					title: null,
					body: "Release 0.25.0 has no checksums.txt, so its download can't be verified",
					retry: false,
				},
				{
					reason: null,
					message: "something new",
					title: "Update failed",
					body: "Something new.",
					retry: true,
				},
			];

			for (const c of cases) {
				it(`draws ${c.reason ?? "an unknown failure"}, ending with the file unchanged`, async () => {
					offers([LATEST], c.platform ? { platform: c.platform } : {});
					useWSStore.setState({ serverUpdate: failed(c.reason, c.message) });
					render(<PockodeSection />);

					const body = await screen.findByText(
						(_, el) =>
							el?.tagName === "P" &&
							!!el.textContent?.includes(c.body) &&
							!!el.textContent?.endsWith(`${PATH} is unchanged.`),
					);
					if (c.title) {
						expect(body).toHaveTextContent(c.title);
						expect(screen.getByRole("status")).toHaveTextContent(c.title);
					}
					expect(screen.queryByRole("button", tryAgain()) !== null).toBe(
						c.retry,
					);
					expect(
						screen.queryByRole("button", { name: /^Update to/ }),
					).toBeNull();
					expect(
						screen.getByRole("button", { name: "Restart" }),
					).toBeInTheDocument();
				});
			}

			it("says where the old file is when Windows couldn't put it back", async () => {
				offers([LATEST], { platform: "windows/amd64" });
				useWSStore.setState({
					serverUpdate: failed(
						"restore_failed",
						"it is at C:\\p.exe.1.old — rename it back to C:\\p.exe",
					),
				});
				render(<PockodeSection />);

				const body = await screen.findByText(/rename it back/);
				expect(body).toHaveTextContent(
					`Couldn't replace pockode.exe, and the old one wasn't put back`,
				);
				expect(body).toHaveTextContent(
					`This Pockode keeps running, but it can't restart or start again until ${PATH} is back.`,
				);
				expect(body).not.toHaveTextContent("is unchanged");
				expect(screen.queryByRole("button", tryAgain())).toBeNull();
			});

			it("keeps the server's detail under Details", async () => {
				offers([LATEST]);
				useWSStore.setState({
					serverUpdate: failed("checksum_mismatch", "expected aa, got bb"),
				});
				render(<PockodeSection />);
				const user = userEvent.setup();

				await user.click(
					await screen.findByRole("button", { name: "Details" }),
				);
				expect(screen.getByText("expected aa, got bb")).toBeInTheDocument();
			});

			it("opens the dialog again on Try again, and Dismiss forgets it", async () => {
				offers([LATEST]);
				useWSStore.setState({ serverUpdate: failed("timeout", "stopped") });
				render(<PockodeSection />);
				const user = userEvent.setup();

				await user.click(await screen.findByRole("button", tryAgain()));
				expect(screen.getByRole("dialog")).toHaveTextContent(
					"Update Pockode to 0.25.0?",
				);
				await user.click(screen.getByRole("button", { name: "Cancel" }));

				await user.click(screen.getByRole("button", { name: "Dismiss" }));
				expect(await updateButton(LATEST)).toBeInTheDocument();
				expect(screen.queryByText("The update took too long")).toBeNull();
				expect(document.activeElement).toBe(card());
			});

			it("names the missing file when a release turns out to have none", async () => {
				offers([LATEST]);
				useWSStore.setState({
					serverUpdate: failed(
						"no_asset",
						"the release has no pockode-linux-amd64",
					),
				});
				render(<PockodeSection />);

				expect(
					await screen.findByText("No build for linux/amd64"),
				).toBeInTheDocument();
				expect(
					screen.getByText(/so it can't be installed here/),
				).toHaveTextContent(
					`Release 0.25.0 has no pockode-linux-amd64, so it can't be installed here. Build it from source. ${PATH} is unchanged.`,
				);
				expect(screen.getByRole("status")).toHaveTextContent("Update failed");
				expect(screen.queryByRole("button", tryAgain())).toBeNull();
			});

			// These say nothing themselves: the check that follows draws the card.
			it("checks again after a release went, and forgets the failure", async () => {
				offers([LATEST]);
				render(<PockodeSection />);
				await updateButton(LATEST);

				offers([]);
				act(() => {
					useWSStore.setState({
						serverUpdate: failed(
							"release_gone",
							"Another update finished first.",
						),
					});
				});

				await findRow("Up to date", "Checked just now");
				await vi.waitFor(() =>
					expect(useWSStore.getState().serverUpdate).toBeNull(),
				);
			});

			// It went through after all: the version row's Restart needed says so.
			it("forgets a lost install once a later check stops offering it", async () => {
				answer(version({ version: "0.25.0", path: PATH }));
				offers([]);
				useWSStore.setState({
					serverUpdate: {
						phase: "lost",
						candidate: LATEST,
						endedAt: Date.now() - 1000,
						cause: "connection",
					},
				});
				render(<PockodeSection />);

				await findRow("Version 0.17.0", "0.25.0 installed");
				await vi.waitFor(() =>
					expect(useWSStore.getState().serverUpdate).toBeNull(),
				);
				expect(screen.queryByText(/didn't finish/)).toBeNull();
			});

			it("draws this server's reason after the install was refused for it", async () => {
				offers([LATEST]);
				render(<PockodeSection />);
				await updateButton(LATEST);

				offers([LATEST], {
					cannot_install: { reason: "container", message: "container" },
				});
				act(() => {
					useWSStore.setState({
						serverUpdate: failed("not_installable", "running in a container"),
					});
				});

				expect(
					await screen.findByText(/running in a container/),
				).toBeInTheDocument();
				expect(screen.queryByRole("button", { name: /^Update to/ })).toBeNull();
				expect(screen.queryByText("Update failed")).toBeNull();
			});

			it("draws Installing elsewhere after the install was refused as busy", async () => {
				offers([LATEST]);
				render(<PockodeSection />);
				await updateButton(LATEST);

				offers([LATEST], { installing: {} });
				act(() => {
					useWSStore.setState({
						serverUpdate: failed("already_installing", "busy"),
					});
				});

				await findRow("Another update is running", "On this machine");
			});
		});
	});
});
