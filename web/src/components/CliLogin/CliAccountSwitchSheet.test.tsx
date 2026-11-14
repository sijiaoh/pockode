import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFakeCliAuth,
	type FakeCliAuth,
	makeOverview,
	resetCliLoginStore,
} from "../../test/cliAuthFixtures";
import type { CliAuthStatus } from "../../types/cliAuth";
import CliAccountSwitchSheet from "./CliAccountSwitchSheet";

const ws = vi.hoisted(() => ({ actions: {} as Record<string, unknown> }));

vi.mock("../../lib/wsStore", () => {
	const state = () => ({ status: "connected", actions: ws.actions });
	return {
		useWSStore: Object.assign(
			(selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
			{ getState: state },
		),
	};
});

let server: FakeCliAuth;

const WORK = "p-work";
const SPARE = "p-spare";

function overview(current: string) {
	return makeOverview({
		clis: [
			{
				agent: "claude",
				...(current ? { current_profile_id: current } : {}),
				profiles: [
					{ id: WORK, name: "Work" },
					{ id: SPARE, name: "Spare" },
				],
			},
			{ agent: "codex", profiles: [] },
		],
	});
}

function status(
	id: string,
	rest: Omit<CliAuthStatus, "agent" | "profile_id">,
): { status: CliAuthStatus } {
	return {
		status: { agent: "claude", ...(id ? { profile_id: id } : {}), ...rest },
	};
}

beforeEach(() => {
	resetCliLoginStore();
	server = createFakeCliAuth();
	ws.actions = server.actions;
	server.setOverview(overview(WORK));
	server.setInspections([
		status(WORK, { state: "signed_in", account: { email: "w@x.y" } }),
		status("", { state: "signed_in", account: { email: "d@x.y" } }),
		status(SPARE, { state: "signed_out" }),
	]);
});

/** The row that names the account. */
async function row(name: string) {
	// The current account's name is set apart from its tag in a span.
	const title = await screen.findByText(name, { selector: "p, p > span" });
	const box = title.closest(".min-h-11")?.parentElement;
	if (!(box instanceof HTMLElement)) throw new Error(`no row for ${name}`);
	return within(box);
}

describe("CliAccountSwitchSheet", () => {
	it("offers Use on every account but the current one, and notes the record's", async () => {
		render(
			<CliAccountSwitchSheet
				agent="claude"
				recordedProfileId={WORK}
				recordedNote="Turned away this turn"
				onClose={vi.fn()}
				onSignIn={vi.fn()}
			/>,
		);

		const work = await row("Work");
		expect(
			await work.findByText("w@x.y · Turned away this turn"),
		).toBeInTheDocument();
		expect(work.getByText("Current")).toBeInTheDocument();
		expect(
			work.queryByRole("button", { name: "Use Work" }),
		).not.toBeInTheDocument();
		expect(
			(await row("Default")).getByRole("button", { name: "Use Default" }),
		).toBeInTheDocument();
		expect(
			(await row("Spare")).getByRole("button", { name: "Use Spare" }),
		).toBeInTheDocument();
	});

	it("switches on Use, and moves Current when the list is pushed", async () => {
		const user = userEvent.setup();
		render(
			<CliAccountSwitchSheet
				agent="claude"
				onClose={vi.fn()}
				onSignIn={vi.fn()}
			/>,
		);

		const def = await row("Default");
		await user.click(def.getByRole("button", { name: "Use Default" }));
		expect(server.actions.cliProfileSwitch).toHaveBeenCalledWith("claude", "");

		server.pushProfiles(overview(""));
		expect(await def.findByText("Current")).toBeInTheDocument();
		expect(
			(await row("Work")).getByRole("button", { name: "Use Work" }),
		).toBeInTheDocument();
	});

	it("offers Sign in on the current account once it is not signed in", async () => {
		const user = userEvent.setup();
		const onSignIn = vi.fn();
		server.setOverview(overview(SPARE));
		render(
			<CliAccountSwitchSheet
				agent="claude"
				onClose={vi.fn()}
				onSignIn={onSignIn}
				sendAgain={offer()}
			/>,
		);

		const spare = await row("Spare");
		await user.click(
			await spare.findByRole("button", { name: "Sign in Spare" }),
		);
		expect(onSignIn).toHaveBeenCalledWith({ id: SPARE, name: "Spare" });
		// The current account can't take the message yet.
		expect(
			screen.queryByRole("button", { name: "Send again" }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
	});

	// A viewed session signs nothing in; switching is global and stays.
	it("offers no sign-in without a way to open one", async () => {
		server.setOverview(overview(SPARE));
		render(<CliAccountSwitchSheet agent="claude" onClose={vi.fn()} />);

		const spare = await row("Spare");
		await spare.findByText("Not signed in");
		expect(spare.queryByRole("button", { name: /Sign in/ })).toBeNull();
		expect(
			(await row("Work")).getByRole("button", { name: "Use Work" }),
		).toBeInTheDocument();
	});

	// Sending again as the account just turned away is what the user came to
	// avoid; once another signed-in account is current, it is the way on.
	it("offers Send again only once a signed-in account other than the record's is current", async () => {
		const user = userEvent.setup();
		const sendAgain = offer();
		render(
			<CliAccountSwitchSheet
				agent="claude"
				recordedProfileId={WORK}
				recordedNote="Turned away this turn"
				onClose={vi.fn()}
				onSignIn={vi.fn()}
				sendAgain={sendAgain}
			/>,
		);

		const def = await row("Default");
		await screen.findByText("w@x.y · Turned away this turn");
		expect(
			screen.queryByRole("button", { name: "Send again" }),
		).not.toBeInTheDocument();

		await user.click(def.getByRole("button", { name: "Use Default" }));
		server.pushProfiles(overview(""));
		await user.click(await screen.findByRole("button", { name: "Send again" }));
		expect(sendAgain.onSendAgain).toHaveBeenCalled();
	});

	it("offers Send again once the current account is signed in, for a record with no account", async () => {
		render(
			<CliAccountSwitchSheet
				agent="claude"
				onClose={vi.fn()}
				onSignIn={vi.fn()}
				sendAgain={offer({ draftKept: true })}
			/>,
		);

		expect(
			await screen.findByRole("button", { name: "Copy message" }),
		).toBeInTheDocument();
		expect(screen.getByText("Your draft was kept.")).toBeInTheDocument();
	});
});

function offer(over: { draftKept?: boolean } = {}) {
	return {
		text: "fix the build",
		draftKept: false,
		onSendAgain: vi.fn(),
		...over,
	};
}
