import { useIsInSheet } from "@pockode/shared";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { PageIsolation } from "../../lib/rpc/raw";
import { useWSStore } from "../../lib/wsStore";
import type { TreeOrigin } from "../../types/contents";
import PortPreviewSheet from "../PortPreview/PortPreviewSheet";

interface Props {
	isolation: PageIsolation;
	origin: TreeOrigin["kind"];
}

function subject(
	{ hiddenFolder, hiddenName, unreachableFolder }: PageIsolation,
	origin: TreeOrigin["kind"],
) {
	if (unreachableFolder) return "A page whose folder can't be opened for it";
	if (hiddenFolder) return "A page inside a hidden folder";
	if (hiddenName) return "A hidden page";
	return origin === "commit"
		? "A page at the root of the repository"
		: "A page at the root of the project";
}

/** What frees the page, as a phrase to start a sentence with. */
function remedy({
	root,
	hiddenFolder,
	hiddenName,
	unreachableFolder,
}: PageIsolation) {
	const steps: string[] = [];
	// A link on the folder's way is the usual cause; a folder the server
	// cannot read is the other.
	if (unreachableFolder)
		steps.push("open it from a readable folder that is not a link");
	if (hiddenFolder) steps.push("move it out of the hidden folder");
	else if (root) steps.push("move it into a folder");
	if (hiddenName) steps.push("rename it without the leading dot");
	const phrase = steps.join(" and ");
	return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/**
 * Why the files a page links to will not load, for a page the server gives a
 * capability for itself alone (`pageIsolation`). The page still renders —
 * many single-file pages work — so this sits above it and stays: there is no
 * dismissing a fact about where the file lives.
 *
 * Port Preview is offered while the relay is there, as the header's button
 * is, and never from inside a sheet, since sheets do not nest — which is what
 * leaves the media viewer's copy text only — nor for a page in a commit.
 */
function PageNotice({ isolation, origin }: Props) {
	const remoteUrl = useWSStore((s) => s.remoteUrl);
	const inSheet = useIsInSheet();
	const [previewing, setPreviewing] = useState(false);
	// Serving runs the worktree, not the commit the page is from.
	const portPreviewUrl = inSheet || origin === "commit" ? null : remoteUrl;

	return (
		<div
			role="note"
			className="flex shrink-0 gap-2 border-b border-th-border bg-th-warning/10 px-3 py-2 text-xs text-th-text-secondary"
		>
			<TriangleAlert
				className="mt-0.5 size-3.5 shrink-0 text-th-warning"
				aria-hidden="true"
			/>
			<p className="min-w-0">
				Files this page links to won't load. {subject(isolation, origin)} is
				shown on its own, so its scripts can't reach the rest of the{" "}
				{origin === "commit" ? "repository" : "project"} (.env, .git).{" "}
				{portPreviewUrl ? (
					<>
						{remedy(isolation)}, or serve it and use{" "}
						<button
							type="button"
							onClick={() => setPreviewing(true)}
							aria-haspopup="dialog"
							className="touch-target rounded font-medium text-th-accent underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
						>
							Port Preview <span aria-hidden="true">›</span>
						</button>
						.
					</>
				) : (
					`${remedy(isolation)} to load them.`
				)}
			</p>
			{previewing && portPreviewUrl && (
				<PortPreviewSheet
					remoteUrl={portPreviewUrl}
					onClose={() => setPreviewing(false)}
				/>
			)}
		</div>
	);
}

export default PageNotice;
