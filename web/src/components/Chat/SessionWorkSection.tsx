import { ExternalLink } from "lucide-react";
import {
	selectSessionDetail,
	useSessionDetailStore,
} from "../../lib/sessionDetailStore";
import { PanelSection } from "../ui";

interface Props {
	sessionId: string;
	/** Optional: an embedder may not offer the work pages at all. */
	onOpenWorkDetail?: (workId: string) => void;
	/** The panel is a navigation target away from itself, so it closes first. */
	onClose: () => void;
}

/**
 * The work this session runs, as one row that opens its detail page.
 *
 * Pure navigation: no activity icon, no step counter, no status colour. Chat
 * stopped answering "is my work still running" on purpose
 * (docs/code/work-system.md, docs/lifecycle-ui.md §9), and this row lives in
 * chat's own panel — carrying state back in here would buy back the thing that
 * has already been paid for. Its existence depends on the binding alone, never
 * on the work's `status` or `activity`.
 *
 * The binding is read off the open session's detail, which is the only source
 * that can speak for *this* session: the sidebar hides exactly the sessions
 * that have a work, so the one this panel describes usually has no row
 * (docs/code/subscription-system.md#which-sessions-belong-to-work). Reading it
 * here rather than in `SessionInfoButton` keeps the subscription in the leaf,
 * as `WorktreeBadge` does.
 */
function SessionWorkSection({ sessionId, onOpenWorkDetail, onClose }: Props) {
	// Null while the detail is loading and null again once it is gone, and
	// null for any other session — so nothing here ever asserts "no work" from
	// an absence. `null` rather than an empty node: `PanelSection`'s rule is a
	// `:first-child` rule, and an empty div would give Usage a stray divider.
	const detail = useSessionDetailStore(selectSessionDetail(sessionId));
	const workId = detail?.work_id;
	if (!workId || !onOpenWorkDetail) return null;

	return (
		<PanelSection title="Work">
			<button
				type="button"
				onClick={() => {
					onClose();
					onOpenWorkDetail(workId);
				}}
				className="flex min-h-11 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
			>
				{/* The session's own title. The work names the session once, when it
				    starts it, and either name can be edited afterwards — so this is the
				    string the user already sees in the sidebar, deliberately, and the
				    work's current title is on the page this row opens. */}
				<span className="min-w-0 flex-1 truncate text-sm text-th-text-primary">
					{detail.title}
				</span>
				{/* `ExternalLink`, not `ChevronRight`: a chevron promises this row
				    expands in place, and this glyph is already the one that points at
				    a work detail (MessageItem's "Details"). Muted, because the whole
				    row is the target and nothing here needs accent to announce that
				    it exists. It is not decoration either — hover fill does not exist
				    on a touch screen, so at rest it is the only cue the row is
				    pressable. */}
				<ExternalLink
					className="size-3.5 shrink-0 text-th-text-muted"
					aria-hidden="true"
				/>
			</button>
		</PanelSection>
	);
}

export default SessionWorkSection;
