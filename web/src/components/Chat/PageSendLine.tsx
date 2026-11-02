import { Check, TriangleAlert } from "lucide-react";
import { type PageSendOutcome, usePageSendOutcome } from "../../lib/pageSends";

function sentence(outcome: PageSendOutcome): string {
	const action = `"${outcome.action}"`;
	switch (outcome.state) {
		case "sending":
			return `Sending ${action}…`;
		case "sent":
			return `Sent ${action}`;
		case "refused":
			return outcome.code === "inactive"
				? `Not sent · ${action} — the page tried to send before you used it`
				: `Not sent · ${action} — ${outcome.message}`;
	}
}

/**
 * What became of the latest send from the page `pageKey` names, under the
 * page — where the press was, which on an old card may be far from where its
 * bubble lands (docs/tool-call-ui.md § The card's send line). Shared by the
 * card and its full-screen view.
 *
 * A refusal after a press is an alert; one the reader never pressed for
 * (`inactive`, a page sending on load) is muted and silent, so a session
 * reopened over such pages announces nothing, yet the page is not hidden
 * either.
 */
export function PageSendLine({ pageKey }: { pageKey: string }) {
	const outcome = usePageSendOutcome(pageKey);
	const kind: "status" | "alert" | "quiet" | null = !outcome
		? null
		: outcome.state !== "refused"
			? "status"
			: outcome.code === "inactive"
				? "quiet"
				: "alert";
	const line = outcome && (
		<div
			title={sentence(outcome)}
			className={`flex items-center gap-1.5 border-t border-th-border px-2 py-1 text-xs sm:px-2.5 ${
				kind === "alert" ? "text-th-error" : "text-th-text-muted"
			}`}
		>
			{outcome.state === "sent" && (
				<Check className="size-3 shrink-0" aria-hidden="true" />
			)}
			{kind === "alert" && (
				<TriangleAlert className="size-3 shrink-0" aria-hidden="true" />
			)}
			<span className="min-w-0 truncate">{sentence(outcome)}</span>
		</div>
	);
	// Both live regions are there, empty, from before the first send: a
	// region that appears already holding its text, or whose role changes
	// under it, is announced unreliably. The quiet line is in neither.
	return (
		<>
			<output className="block">{kind === "status" && line}</output>
			<div role="alert">{kind === "alert" && line}</div>
			{kind === "quiet" && line}
		</>
	);
}
