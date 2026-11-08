import {
	type ServerUpdateCheck,
	UPDATE_BUDGET_MS,
	updateFailedReason,
	updateFailureKind,
} from "@pockode/shared";

/*
 * The words of docs/self-update-ui.md for the cluster's own update, with "the
 * cluster" where `web` says "Pockode". Spans in backticks are code, drawn by
 * `CodeText`, as the server's own `hint` is written.
 */

/** Why one release cannot be installed here, as the subtitle and the notice. */
export function unavailableCopy(
	reason: "no_asset" | "no_checksums",
	version: string,
	check: Pick<ServerUpdateCheck, "asset" | "platform">,
) {
	return reason === "no_asset"
		? {
				subtitle: `No build for ${check.platform}`,
				notice: `Release ${version} has no \`${check.asset}\`, so it can't be installed here. Build it from source.`,
			}
		: {
				subtitle: "Can't be verified",
				notice: `Release ${version} has no \`checksums.txt\`, so its download can't be verified and the cluster won't install it.`,
			};
}

/**
 * Why nothing can be installed on this cluster, or null when it can — or when
 * the reason is a development build, which the version list already says.
 */
export function cannotInstallCopy(
	cannot: NonNullable<ServerUpdateCheck["cannot_install"]>,
): { title: string; body: string } | null {
	switch (cannot.reason) {
		case "dev_build":
			return null;
		case "not_writable":
			return {
				title: `Can't update from here: no write access to \`${cannot.dir ?? ""}\``,
				body: cannot.hint ?? cannot.message,
			};
		case "container":
			return {
				title: "Can't update from here: running in a container",
				body: "A file replaced inside a container is gone the next time it is recreated. Update by pulling a newer image.",
			};
		default:
			return { title: "Can't update from here", body: cannot.message };
	}
}

export interface FailureContext {
	version: string;
	/** The executable the install would have replaced. */
	path: string | null;
	check: Pick<ServerUpdateCheck, "asset" | "platform"> | null;
}

/** What a failed `server.update` leaves this sheet with. */
export type FailureOutcome =
	/** Said under the candidate; `retry` keeps its Update as the retry. */
	| { kind: "say"; title: string; body: string; retry: boolean }
	/** Nothing to say: the next check draws what is there now. */
	| { kind: "recheck" };

const PROXY_HINT =
	"If the cluster reaches the internet through a proxy, start it with `HTTPS_PROXY` set.";

/** How each failure of an install reads (docs/self-update-ui.md, "Failed"). */
export function failureOutcome(
	error: unknown,
	ctx: FailureContext,
): FailureOutcome {
	const reason = updateFailedReason(error);
	const kind = updateFailureKind(reason);
	if (kind.kind === "recheck") return { kind: "recheck" };
	const { retry } = kind;
	const message = (
		error instanceof Error ? error.message : "Unknown error"
	).replace(/\.$/, "");
	const executable = ctx.path ? `\`${ctx.path}\`` : "the cluster's executable";
	const unchanged = `${ctx.path ? executable : "The cluster's executable"} is unchanged.`;
	const say = (title: string, body: string): FailureOutcome => ({
		kind: "say",
		title,
		body: `${body} ${unchanged}`,
		retry,
	});
	const windows = ctx.check?.platform.startsWith("windows/") ?? false;
	const asset = ctx.check?.asset ?? "the download";

	switch (reason) {
		case "checksum_mismatch":
			return say(
				"The download didn't match its checksum",
				`\`${asset}\` from ${ctx.version} doesn't match the release's \`checksums.txt\`, so it was discarded. Try again; if it keeps failing, the download is being changed on the way — a proxy or a filter in between.`,
			);
		case "download_failed":
			return say(
				`Couldn't download ${ctx.version}`,
				`${message}. ${PROXY_HINT}`,
			);
		case "not_runnable":
			return say(
				`${ctx.version} didn't run on this machine`,
				`The downloaded file failed \`--version\`: ${message}. It was discarded.`,
			);
		case "replace_failed":
			return say(
				`Couldn't replace ${windows ? "pockode.exe" : "pockode"}`,
				windows
					? `${message}. This is usually antivirus still scanning the new file; try again in a minute.`
					: `${message}.`,
			);
		case "restore_failed":
			return {
				kind: "say",
				title: "Couldn't replace pockode.exe, and the old one wasn't put back",
				body: `${message}. The cluster keeps running, but it can't restart or start again until ${executable} is back.`,
				retry,
			};
		case "timeout":
			return say(
				"The update took too long",
				`The cluster stopped after ${UPDATE_BUDGET_MS / 60_000} minutes. Try again on a better connection, or run the install script on the server.`,
			);
		case "no_asset":
		case "no_checksums":
			return say(
				"Update failed",
				unavailableCopy(reason, ctx.version, {
					asset: ctx.check?.asset ?? "its build",
					platform: ctx.check?.platform ?? "",
				}).notice,
			);
		case null:
			return say("Update failed", `${message}.`);
		default:
			// The reasons updateFailureKind sends to a re-check, answered above.
			return { kind: "recheck" };
	}
}
