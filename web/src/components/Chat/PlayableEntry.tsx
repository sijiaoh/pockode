import type { AttachmentSource, FileBlock } from "../../types/content";
import type { PlayableKind } from "../../utils/fileView";
import type { VideoMediaItem } from "../Media";
import AudioEntry from "./AudioEntry";
import VideoThumb from "./VideoThumb";

interface Props {
	file: FileBlock;
	source: AttachmentSource;
	kind: PlayableKind;
	/** Hands over what the media viewer plays, should it be a video. */
	onOpen: (item: VideoMediaItem) => void;
}

/**
 * The strip's audio or video entry, by kind — and the other one when the
 * file's description disagrees with the block. The description wins: a block
 * keeps the type it was written with, and a file typed as video when it was
 * written (a voice note in an MP4 or WebM container, before the server told
 * the two apart) is audio by what is said of it now.
 */
function PlayableEntry({ file, source, kind, onOpen }: Props) {
	const other = (otherKind: PlayableKind) => (
		<PlayableEntry
			file={file}
			source={source}
			kind={otherKind}
			onOpen={onOpen}
		/>
	);
	return kind === "video" ? (
		<VideoThumb file={file} source={source} onOpen={onOpen} other={other} />
	) : (
		<AudioEntry file={file} source={source} other={other} />
	);
}

export default PlayableEntry;
