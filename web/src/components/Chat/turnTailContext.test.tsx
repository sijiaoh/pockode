import { render, screen } from "@testing-library/react";
import { memo } from "react";
import { describe, expect, it } from "vitest";
import type { TurnTail } from "../../lib/thinking";
import {
	IDLE_TAIL,
	TurnTailContext,
	useOverviewTail,
	useTurnTail,
} from "./turnTailContext";

const tailWith = (liveCount: number): TurnTail => ({
	...IDLE_TAIL,
	phase: "running",
	overviewMessageId: "open",
	agents: { liveCount, entries: [] },
});

// Behind a memo, as every bubble of the transcript is: what reaches it is the
// tail itself, never a parent redrawing it.
const OverviewReader = memo(function OverviewReader({
	messageId,
	renders,
}: {
	messageId: string;
	renders: string[];
}) {
	const { agents } = useOverviewTail(messageId);
	renders.push(messageId);
	return (
		<p>
			{messageId}: {agents.liveCount}
		</p>
	);
});

function TailReader({ seen }: { seen: number[] }) {
	const { liveCount } = useTurnTail().agents;
	seen.push(liveCount);
	return <p>tail: {liveCount}</p>;
}

describe("TurnTailContext", () => {
	it("redraws a settled reply only when it is the one drawing the agents", () => {
		const renders: string[] = [];
		const view = (tail: TurnTail) => (
			<TurnTailContext value={tail}>
				<OverviewReader messageId="settled" renders={renders} />
				<OverviewReader messageId="open" renders={renders} />
			</TurnTailContext>
		);
		const { rerender } = render(view(tailWith(1)));
		renders.length = 0;

		// A subagent's record: a new agents overview, for the open reply alone.
		rerender(view(tailWith(2)));

		expect(screen.getByText("open: 2")).toBeInTheDocument();
		expect(screen.getByText("settled: 0")).toBeInTheDocument();
		expect(renders).toEqual(["open"]);
	});

	it("never draws a reader mounted with a change on the old tail", () => {
		const seen: number[] = [];
		const { rerender } = render(
			<TurnTailContext value={tailWith(1)}>{null}</TurnTailContext>,
		);
		rerender(
			<TurnTailContext value={tailWith(3)}>
				<TailReader seen={seen} />
			</TurnTailContext>,
		);
		expect(seen).toEqual([3]);
	});
});
