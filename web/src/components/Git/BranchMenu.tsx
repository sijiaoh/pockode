import type { BranchRow } from "../../lib/gitBranches";
import type { GitHead } from "../../types/git";
import { Sheet } from "../ui";
import { BranchActionRows, type BranchActions } from "./BranchActions";

interface Props {
	row: BranchRow;
	head: GitHead;
	actions: BranchActions;
	onClose: () => void;
}

/**
 * A branch's `⋯`: the quick path to what its detail offers
 * (docs/git-branches-ui.md#the-branchs-menu-). A sheet on both layouts that
 * closes on whichever action is taken — the switch's spinner, the handoff's
 * and the delete's confirm all outlive it, and sheets do not nest.
 */
function BranchMenu({ row, head, actions, onClose }: Props) {
	return (
		<Sheet title={row.label} onClose={onClose}>
			<BranchActionRows
				row={row}
				head={head}
				actions={actions}
				onAct={onClose}
			/>
		</Sheet>
	);
}

export default BranchMenu;
