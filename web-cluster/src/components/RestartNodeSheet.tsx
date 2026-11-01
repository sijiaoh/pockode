import { type InstalledVersion, Sheet, Spinner } from "@pockode/shared";
import { DEV_VERSION, displayVersion } from "../lib/version";
import { NEUTRAL_BUTTON, PRIMARY_BUTTON } from "./buttons";

const RESTART_COST =
	"Any AI turn running in it is stopped — its session and history are kept, and can be continued afterwards.";

/**
 * What a restart does to this node, per docs/restart-ui.md's "Confirming one"
 * parts table. `installed` is null when the read failed or has not landed: the
 * cluster still checks the file before it asks.
 */
function whatHappens(
	running: string | undefined,
	installed: InstalledVersion | null,
) {
	const target = installed?.version;
	if (target === undefined || running === undefined) {
		return "Pockode in this project restarts into the installed version, with the same password and options.";
	}
	if (running === DEV_VERSION || target === DEV_VERSION) {
		return "Pockode in this project restarts with the same password and options.";
	}
	if (running === target) {
		return "Pockode in this project restarts with the same version, password and options.";
	}
	return `Pockode in this project restarts and comes back running ${displayVersion(target)} (now ${displayVersion(running)}).`;
}

interface Props {
	nodeName: string;
	/** The node's running version when the sheet opened. */
	running: string | undefined;
	installed: InstalledVersion | null;
	/** A read started on opening has not landed: Restart waits for it. */
	reading: boolean;
	loading: boolean;
	/** Why the last confirm from this sheet was refused; it stays here. */
	refusal: string | null;
	/** "Back" when the sheet replaced the menu, "Cancel" from the card. */
	cancelLabel: "Back" | "Cancel";
	onCancel: () => void;
	onClose: () => void;
	onConfirm: () => void;
}

/**
 * The confirmation of one node's restart — through the cluster, without its
 * password. Always `PRIMARY_BUTTON`: the cluster cannot count the turns a node
 * is running, so there is no `danger` case to switch to (as for Stop).
 */
export function RestartNodeSheet({
	nodeName,
	running,
	installed,
	reading,
	loading,
	refusal,
	cancelLabel,
	onCancel,
	onClose,
	onConfirm,
}: Props) {
	return (
		<Sheet
			title={`Restart ${nodeName}?`}
			onClose={onClose}
			dismissible={!loading}
			footer={
				<>
					<button
						type="button"
						onClick={onCancel}
						disabled={loading}
						className={`${NEUTRAL_BUTTON} flex-1`}
					>
						{cancelLabel}
					</button>
					<button
						type="button"
						onClick={onConfirm}
						aria-busy={loading}
						disabled={reading || loading}
						className={`${PRIMARY_BUTTON} flex-1`}
					>
						{loading && <Spinner size="h-4 w-4" />}
						{loading ? "Restarting..." : "Restart"}
					</button>
				</>
			}
		>
			<div className="flex flex-col gap-3 p-4 text-sm text-th-text-secondary">
				<p>
					{whatHappens(running, installed)} {RESTART_COST} Pages open on it
					reconnect by themselves.
				</p>
				{refusal && (
					<p role="alert" className="text-th-error">
						{refusal}
					</p>
				)}
			</div>
		</Sheet>
	);
}
