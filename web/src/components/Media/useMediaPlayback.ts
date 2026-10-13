import {
	type SyntheticEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useRawMediaSource } from "../../hooks/useRawMediaSource";
import { isGone, probeRaw } from "../../lib/rawProbe";
import type { ContentOrigin } from "../../types/contents";
import { asError } from "../../utils/errorMessage";
import type { PlayableKind } from "../../utils/fileView";
import type { MediaMetadata, PlaybackHandoff } from "./types";

export interface PlayableMedia {
	kind: PlayableKind;
	origin: ContentOrigin;
	mime: string;
	size: number;
}

/**
 * Why the media is not playing, as far as the server's answer tells: bytes it
 * serves that this browser cannot play, a file that is gone, or a load that
 * failed on the way and may well succeed on another try.
 */
export type MediaFailure =
	| { kind: "unplayable" }
	| { kind: "gone" }
	| { kind: "load"; error: Error };

export type PlaybackStatus = "waiting" | "ready" | "recovering" | "failed";

/**
 * How long after a recovery a failure counts as the same one, unless playback
 * has moved on since. Recovery is for a capability that has died, which
 * happens hours apart; a failure again this soon, at the same point, is
 * something a new capability did not fix — a file this browser cannot play,
 * or one that breaks at the second it resumes at — and recovering again would
 * only loop on it.
 */
export const RECOVERY_WINDOW_MS = 60 * 1000;

/** Seconds played past the resumed point that show a recovery worked. */
const RECOVERED_AFTER_S = 1;

/**
 * iOS Safari paints no frame for `preload="metadata"`; seeking a hair past the
 * start makes it paint the first one. A fragment never reaches the server.
 */
const FIRST_FRAME_FRAGMENT = "#t=0.001";

/**
 * `MediaError.MEDIA_ERR_NETWORK`: the element lost the bytes on the way, as
 * opposed to receiving bytes it could not play. Spelled out because jsdom
 * defines no `MediaError`.
 */
const MEDIA_ERR_NETWORK = 2;

interface State {
	identity: string;
	/** Asking for a new capability, or probing why the last one failed. */
	busy: boolean;
	failure: MediaFailure | null;
	metadata: MediaMetadata | null;
}

function initialState(identity: string): State {
	return { identity, busy: false, failure: null, metadata: null };
}

/**
 * A media element streamed from a raw capability, kept playing across the
 * capability's death (docs/file.md, "Playing audio and video").
 *
 * A media element cannot see the HTTP status behind its `error` — an expired
 * capability's 404 reads exactly like a file the browser cannot play — so the
 * first error is answered by a new capability on the same element. Whenever
 * the capability changes under the element, whoever renewed it, playback is
 * put back at the same second and, if the user had it playing, played. Only an
 * error the new one does not cure is looked into, with a one-byte request, to
 * say why.
 *
 * Spread `mediaProps` on the `<video>` or `<audio>` and key it by `key`: a
 * different file (or a rewrite, which changes its size) starts over from the
 * beginning, paused, in a new element.
 *
 * A player taking over from another (the viewer's stage from the in-place
 * preview) passes `handoff`: it starts there instead of at the beginning, and
 * keeps the position in it current for whoever takes over next.
 */
export function useMediaPlayback(
	media: PlayableMedia,
	enabled: boolean,
	handoff?: PlaybackHandoff,
) {
	const source = useRawMediaSource(
		{ origin: media.origin, scope: "file" },
		enabled,
	);
	const { src, refresh } = source;
	const identity = `${source.key}:${media.size}:${media.mime}`;

	const [stored, setState] = useState(() => initialState(identity));
	let state = stored;
	if (stored.identity !== identity) {
		state = initialState(identity);
		setState(state);
	}

	// Where playback is, kept from `timeupdate`: by the time a new `src` is on
	// the element, the element itself already reads 0.
	const position = useRef(handoff?.time ?? 0);
	// Whether the user means it to be playing: set by play, cleared by a pause,
	// and left alone by a failure, which is not the user's doing. Reaching the
	// end pauses too, and clears it: `play()` at the end starts over, which a
	// resume or a handover must not do.
	const wantsPlay = useRef(handoff?.playing ?? false);
	// What the next metadata puts back. Set when the source changes under the
	// element, or by a handoff; until it is consumed, the element's own
	// position is not news.
	const resume = useRef<PlaybackHandoff | null>(
		handoff ? { ...handoff } : null,
	);
	const element = useRef<HTMLMediaElement | null>(null);
	// A callback rather than the object: a `<video>`'s ref is typed for a
	// video, and this one serves `<audio>` as well.
	const elementRef = useCallback((node: HTMLMediaElement | null) => {
		element.current = node;
	}, []);
	const recovery = useRef<{ at: number; from: number } | null>(null);
	const pending = useRef<AbortController | null>(null);
	const shown = useRef({ identity, src });

	// A layout effect, so it runs before the new source can report anything.
	useLayoutEffect(() => {
		const before = shown.current;
		shown.current = { identity, src };
		if (before.identity !== identity) {
			position.current = 0;
			wantsPlay.current = false;
			if (handoff) Object.assign(handoff, { time: 0, playing: false });
			resume.current = null;
			recovery.current = null;
			return;
		}
		if (before.src !== null && before.src !== src) {
			resume.current ??= {
				time: position.current,
				playing: wantsPlay.current,
			};
		}
	}, [identity, src, handoff]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `identity` is the trigger — what is in flight is for the file before it
	useEffect(() => () => pending.current?.abort(), [identity]);

	const update = useCallback(
		(change: Partial<State>) =>
			setState((current) =>
				current.identity === identity ? { ...current, ...change } : current,
			),
		[identity],
	);

	const start = useCallback(() => {
		pending.current?.abort();
		const controller = new AbortController();
		pending.current = controller;
		return controller.signal;
	}, []);

	const recover = useCallback(() => {
		recovery.current = { at: Date.now(), from: position.current };
		const signal = start();
		update({ busy: true, failure: null });
		// The new capability reaches the element through the cache, as one
		// renewed by another player would.
		refresh(signal).then(
			() => {
				if (!signal.aborted) update({ busy: false });
			},
			(error: unknown) => {
				if (!signal.aborted) {
					update({
						busy: false,
						failure: { kind: "load", error: asError(error) },
					});
				}
			},
		);
	}, [refresh, start, update]);

	const diagnose = useCallback(
		(failed: string, lostOnTheWay: boolean) => {
			const signal = start();
			update({ busy: true });
			probe(failed, lostOnTheWay, signal).then((failure) => {
				if (!signal.aborted) update({ busy: false, failure });
			});
		},
		[start, update],
	);

	const onError = (event: SyntheticEvent<HTMLMediaElement>) => {
		if (src === null || state.busy || state.failure) return;
		const last = recovery.current;
		if (last && Date.now() - last.at <= RECOVERY_WINDOW_MS) {
			diagnose(src, event.currentTarget.error?.code === MEDIA_ERR_NETWORK);
		} else {
			recover();
		}
	};

	const onTimeUpdate = (event: SyntheticEvent<HTMLMediaElement>) => {
		// A source still loading, or one about to be replaced, reports a
		// position that is not the user's.
		if (resume.current || state.busy) return;
		const time = event.currentTarget.currentTime;
		position.current = time;
		if (handoff) handoff.time = time;
		const last = recovery.current;
		if (last && time > last.from + RECOVERED_AFTER_S) recovery.current = null;
	};

	const onLoadedMetadata = (event: SyntheticEvent<HTMLMediaElement>) => {
		const target = event.currentTarget;
		const width = target instanceof HTMLVideoElement ? target.videoWidth : 0;
		const height = target instanceof HTMLVideoElement ? target.videoHeight : 0;
		update({
			metadata: {
				dimensions: width > 0 && height > 0 ? { width, height } : null,
				duration: Number.isFinite(target.duration) ? target.duration : null,
			},
		});

		const back = resume.current;
		resume.current = null;
		if (!back) return;
		if (back.time > 0) target.currentTime = back.time;
		// Refused outside a user gesture on iOS, or in Low Power Mode. Paused
		// at the right second is the answer then, and not an error — but no
		// longer meant to be playing, or the next new source would start it.
		// An `AbortError` is a load replacing this one, which carries the intent.
		if (back.playing) {
			target.play().catch((error: unknown) => {
				if (error instanceof DOMException && error.name === "NotAllowedError") {
					setPlaying(false);
				}
			});
		}
	};

	const setPlaying = (playing: boolean) => {
		wantsPlay.current = playing;
		if (handoff) handoff.playing = playing;
	};

	const failure: MediaFailure | null =
		state.failure ??
		(src === null && !state.busy && source.error
			? { kind: "load", error: source.error }
			: null);

	const status: PlaybackStatus = failure
		? "failed"
		: state.busy
			? "recovering"
			: src === null
				? "waiting"
				: "ready";

	return {
		key: identity,
		status,
		failure,
		metadata: state.metadata,
		/** Asks again, and puts back where the player was if it ever played. */
		retry: recover,
		/** The mounted element, for a stage's keys. */
		element,
		/**
		 * Pauses for another player to take over, and says where to carry on
		 * from.
		 */
		handOff: (): PlaybackHandoff => {
			const taken = { time: position.current, playing: wantsPlay.current };
			element.current?.pause();
			setPlaying(false);
			// A source swapped in while it played would otherwise start it again
			// behind the viewer once its metadata lands.
			if (resume.current) resume.current.playing = false;
			return taken;
		},
		/**
		 * Takes back from another player at `time`, paused: carrying on with
		 * sound behind a closing viewer is not what the user just asked for.
		 */
		takeBack: (time: number) => {
			position.current = time;
			setPlaying(false);
			if (resume.current) resume.current = { time, playing: false };
			else if (element.current) element.current.currentTime = time;
		},
		mediaProps: {
			src:
				src === null
					? undefined
					: media.kind === "video"
						? `${src}${FIRST_FRAME_FRAGMENT}`
						: src,
			ref: elementRef,
			preload: "metadata",
			onError,
			onTimeUpdate,
			onLoadedMetadata,
			onPlay: () => setPlaying(true),
			onPause: () => setPlaying(false),
		} as const,
	};
}

/**
 * Why `src` will not play, from one byte of it. Bytes served mean the browser
 * cannot play them — unless the element lost them on the way, when the
 * connection, now back, is all that failed; the server's `not_found` means the
 * file is gone; anything else — a dead capability included, since one was just
 * issued — is a load worth retrying.
 */
async function probe(
	src: string,
	lostOnTheWay: boolean,
	signal: AbortSignal,
): Promise<MediaFailure> {
	const answer = await probeRaw(src, signal);
	if (answer.ok) {
		return lostOnTheWay
			? {
					kind: "load",
					error: new Error("The connection dropped while loading."),
				}
			: { kind: "unplayable" };
	}
	return isGone(answer)
		? { kind: "gone" }
		: { kind: "load", error: answer.error };
}
