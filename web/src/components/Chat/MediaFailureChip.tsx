import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { rawMediaUrl } from "../../hooks/useRawMediaSource";
import { saveUrl } from "../../lib/fileDownload";
import type { ContentOrigin } from "../../types/contents";
import { errorMessage } from "../../utils/errorMessage";
import type { PlayableKind } from "../../utils/fileView";
import { mediaFailureHeadline } from "../Media/MediaFailureCard";
import type { MediaFailure } from "../Media/useMediaPlayback";
import AttachmentChip from "../ui/AttachmentChip";

interface Props {
	kind: PlayableKind;
	failure: MediaFailure;
	name: string;
	origin: ContentOrigin;
	saveAs: string;
	onRetry: () => void;
}

/**
 * What an attachment-strip player turns into once it will not play: worded as
 * the Files tab's failure card words it, at the weight of a chip.
 */
function MediaFailureChip({
	kind,
	failure,
	name,
	origin,
	saveAs,
	onRetry,
}: Props) {
	const queryClient = useQueryClient();
	const [saveError, setSaveError] = useState<string | null>(null);
	const { icon, iconClassName, title } = mediaFailureHeadline(kind, failure);

	const save = async () => {
		setSaveError(null);
		try {
			saveUrl(await rawMediaUrl(queryClient, origin), saveAs);
		} catch (err) {
			setSaveError(`Couldn't save: ${errorMessage(err)}`);
		}
	};

	return (
		<AttachmentChip
			icon={icon}
			iconClassName={iconClassName}
			title={name}
			detail={saveError ?? title}
			action={
				failure.kind === "load"
					? { label: "Retry", onClick: onRetry }
					: // Bytes this browser cannot play are what another app may open,
						// and a failed entry opens no viewer, whose Save would otherwise
						// be the way to them.
						failure.kind === "unplayable"
						? { label: "Save", onClick: save }
						: undefined
			}
		/>
	);
}

export default MediaFailureChip;
