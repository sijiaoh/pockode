import { type CloudLinkRelay, hostOf } from "@pockode/shared";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import type { ReactNode } from "react";
import { Spinner } from "../ui";

// The words the Cloud card and the link sheet share (docs/cloud-link-ui.md).

/**
 * The machine a link or an unlink acts on, as the copy names it; `start` for
 * a line that begins with it.
 */
export function machineLabel(
	machineName: string | undefined,
	start = false,
): string {
	return machineName || (start ? "This machine" : "this machine");
}

export interface InstanceLine {
	icon: ReactNode;
	title: string;
	subtitle: string;
}

/**
 * Whether this Pockode is in the account's list, while the machine is linked
 * to this cloud: the card's instance row, and the line under a sheet's
 * *Linked* (docs/cloud-link-ui.md, "The instance row").
 */
export function instanceLine(
	relay: Exclude<CloudLinkRelay, "link_invalid">,
	cloudUrl: string,
): InstanceLine {
	switch (relay) {
		case "attached":
			return {
				icon: <CheckCircle2 className="h-4 w-4 text-th-success" />,
				title: "This Pockode is listed",
				subtitle: hostOf(cloudUrl),
			};
		case "pending":
			// No duration is promised: a relay that cannot reach the cloud can
			// leave it here, and the server is the clock.
			return {
				icon: <Spinner srText={null} />,
				title: "Adding this Pockode…",
				subtitle: "Waiting for the cloud to list it",
			};
		case "not_attached":
			return {
				icon: <AlertTriangle className="h-4 w-4 text-th-warning" />,
				title: "This Pockode isn't listed",
				subtitle: "Linking again won't fix this",
			};
		case "guest":
			return {
				icon: <AlertTriangle className="h-4 w-4 text-th-warning" />,
				title: "This Pockode isn't listed",
				subtitle: "The server log says why",
			};
		case "disabled":
			return {
				icon: <Info className="h-4 w-4 text-th-text-muted" />,
				title: "This Pockode isn't listed",
				subtitle: "Remote access is off",
			};
	}
}

export const SCOPE_SENTENCE =
	"Every Pockode on this machine — this one, other projects and cluster nodes — will be listed in the account you approve with.";

/** `left_behind`: an approved link nothing on this machine uses. */
export function leftBehindText(cloudUrl: string): string {
	return `An extra entry for this machine may be left in your cloud account. Remove it on ${hostOf(cloudUrl)}.`;
}
