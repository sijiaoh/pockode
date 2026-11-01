import type { InstalledVersion } from "@pockode/shared";
import type { NodeWithStatus } from "../types/node";

declare const __APP_VERSION__: string;

export const APP_VERSION = __APP_VERSION__;

/** What a development build reports, on either side of a comparison. */
export const DEV_VERSION = "dev";

/**
 * The installed version when `running` is something other than it, else null.
 * Equality only — a downgrade is as much a reason to restart — and never for a
 * running development build, which would always differ (docs/restart-ui.md).
 */
export function differingVersion(
	running: string,
	installed: InstalledVersion | null,
): string | null {
	const version = installed?.version;
	return running !== DEV_VERSION && version !== undefined && version !== running
		? version
		: null;
}

export function displayVersion(version: string) {
	return version === DEV_VERSION ? "development build" : version;
}

/** As the cluster panel writes a running version: "v0.17.0", or "dev". */
export function versionLabel(version: string) {
	return version === DEV_VERSION ? DEV_VERSION : `v${version}`;
}

export type NodeVersionKind = "outdated" | "older" | null;

/**
 * Whether a node needs restarting into the cluster's installed version
 * (docs/restart-ui.md, "Which node is outdated"):
 *
 * - `outdated`: running a version other than the installed one;
 * - `older`: running, started by a build from before node restarts, so only
 *   a stop and a start can upgrade it;
 * - null: current, not running, or not compared — a node is never called
 *   outdated on a guess, so an installed version that could not be read marks
 *   none.
 *
 * `knownOlder` is the page's memory of `older_node` refusals, keyed by
 * `olderNodeKey`: on Windows a node with a version can still be one.
 */
export function nodeVersionKind(
	node: NodeWithStatus,
	installed: InstalledVersion | null,
	knownOlder: ReadonlySet<string>,
): NodeVersionKind {
	const target = installed?.version;
	if (node.status.status !== "running" || target === undefined) return null;
	if (isOlderNode(node, knownOlder)) return "older";
	const running = node.status.version;
	if (running === DEV_VERSION || target === DEV_VERSION) return null;
	return running === target ? null : "outdated";
}

/**
 * Whether the cluster cannot ask this running node to restart, so Restart
 * stops and starts it. A fact about the node, independent of the installed
 * read: it decides where Restart leads even when nothing is compared.
 */
export function isOlderNode(
	node: NodeWithStatus,
	knownOlder: ReadonlySet<string>,
) {
	return (
		node.status.status === "running" &&
		(node.status.version === undefined || knownOlder.has(olderNodeKey(node)))
	);
}

/**
 * Keyed by the start, not only the node: a refusal is about the process that
 * gave it, and the next start of the node may well be a current one.
 */
export function olderNodeKey(node: NodeWithStatus) {
	return `${node.id} ${node.status.started_at ?? ""}`;
}
