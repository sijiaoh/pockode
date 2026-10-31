import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerVersion } from "../../../lib/rpc";
import PockodeSection from "./PockodeSection";

const fake = vi.hoisted(() => ({
	appVersion: "0.17.0",
	serverVersion: (() =>
		Promise.reject(new Error("unset"))) as () => Promise<unknown>,
	restartServer: (() => Promise.resolve()) as () => Promise<void>,
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
	}));
	return {
		useWSStore,
		wsActions: {
			serverVersion: () => fake.serverVersion(),
			restartServer: () => fake.restartServer(),
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
	useWSStore.setState({ status: "connected", restartRequestedAt: null });
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
});
