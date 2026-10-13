import type { ReactNode } from "react";
import {
	useAttachmentContent,
	useAttachmentOrigin,
} from "../../hooks/useAttachmentContent";
import { useInView } from "../../hooks/useInView";
import type { AttachmentSource, FileBlock } from "../../types/content";
import type { ContentOrigin } from "../../types/contents";
import {
	attachmentDetail,
	attachmentName,
	omittedLabel,
} from "../../utils/attachment";
import { getFileViewState, type PlayableKind } from "../../utils/fileView";
import { mediaFailureHeadline, mediaKindIcon } from "../Media/MediaFailureCard";
import AttachmentChip from "../ui/AttachmentChip";

/** What a description says about the file to play. */
export interface PlayableFile {
	origin: ContentOrigin;
	mime: string;
	size: number;
}

interface Props {
	file: FileBlock;
	source: AttachmentSource;
	kind: PlayableKind;
	/** The entry before it may play, in the box the player will fill. */
	waiting: (boxRef: (node: HTMLDivElement | null) => void) => ReactNode;
	/** The player, mounted only once on screen. */
	children: (playable: PlayableFile) => ReactNode;
	/** The entry of the other playable kind, for a description that is one. */
	other: (kind: PlayableKind) => ReactNode;
}

/**
 * The part an attachment strip's audio and video entries share: read the
 * file's description once the entry is on screen — one small request with no
 * bytes, which gives the real type and size the player keys on — and say so
 * when it cannot be read, or is nothing the strip can play.
 */
function PlayableAttachment({
	file,
	source,
	kind,
	waiting,
	children,
	other,
}: Props) {
	const { ref, inView } = useInView<HTMLDivElement>();
	const origin = useAttachmentOrigin(source);
	const { data, error, refetch } = useAttachmentContent(source, inView);
	const view = data ? getFileViewState(data, origin) : null;
	const name = attachmentName(file);

	if (error) {
		const headline = mediaFailureHeadline(kind, { kind: "load", error });
		return (
			<AttachmentChip
				icon={headline.icon}
				iconClassName={headline.iconClassName}
				title={name}
				detail={headline.title}
				action={{ label: "Retry", onClick: () => refetch() }}
			/>
		);
	}

	// The description wins over the block, which keeps the type it was written
	// with. Its box changes shape here, once, as an untyped block's does in
	// `AttachmentThumb`; the other entry reads nothing before it is on screen
	// either, and finds the description already cached.
	if (
		view &&
		view.kind !== kind &&
		(view.kind === "audio" || view.kind === "video")
	) {
		return other(view.kind);
	}

	// Worded as `AttachmentThumb` words an image that turned out not to be one.
	if (data && view && view.kind !== kind) {
		return (
			<AttachmentChip
				icon={mediaKindIcon(kind)}
				title={name}
				detail={omittedLabel(data) ?? "Can't be previewed"}
				tooltip={attachmentDetail(file) || undefined}
			/>
		);
	}

	// Gated on being in view as well as on the description: one already cached
	// (the same file shown again, a remounted row) arrives before then, and the
	// player would start reading the file off screen. Past the checks above, a
	// playable description is one of `kind`.
	if (!inView || (view?.kind !== "audio" && view?.kind !== "video")) {
		return waiting(ref);
	}

	return children({ origin: view.origin, mime: view.mime, size: view.size });
}

export default PlayableAttachment;
