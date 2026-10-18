import { useMediaQuery } from "@pockode/shared";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	type ReactZoomPanPinchContentRef,
	TransformComponent,
	TransformWrapper,
	useTransformContext,
	useTransformEffect,
} from "react-zoom-pan-pinch";
import { useImageSrc } from "../../hooks/useImageSrc";
import type { ImageDimensions } from "../../utils/fileView";
import { Spinner } from "../ui";
import { DoubleTapTracker } from "./doubleTap";
import { ImageFailureCard } from "./ImageFailureCard";
import {
	actualScale,
	bounded,
	fitSize,
	isAtFit,
	KEY_PAN_SHARE,
	KEY_ZOOM_FACTOR,
	type Layout,
	maxScale,
	pannedBy,
	toggleTarget,
	type View,
	zoomedTo,
	zoomLabel,
} from "./imageScale";
import type { ImageMediaItem, StageKeyHandler, StageProps } from "./types";

/** How long the toggle and the keys' zooms take. */
const ZOOM_ANIMATION_MS = 200;

type Status = "loading" | "loaded" | "error";

/**
 * The stage's own moves of the transform — the keys, the toggle, the
 * re-centring — and where they are taking it. Each one composes from where the
 * view is heading, not from the frame an animation has reached: the library
 * starts a new animation from wherever it cut the last one off, so a key
 * pressed inside an animation would otherwise lose part of the one before.
 * Dragging, pinching and the wheel cancel the animation, and from then on
 * what is on screen is where the view is heading
 * (docs/media-viewer.md#where-a-move-starts).
 */
function useMoves(apiRef: React.RefObject<ReactZoomPanPinchContentRef | null>) {
	const headingRef = useRef<View | null>(null);
	/**
	 * Moves to what `to` makes of where the view is heading, unless it returns
	 * null. `to` is handed the library's own measurements, so the bounds it
	 * works out are the ones the library holds a drag to.
	 */
	return useCallback(
		(to: (from: View, layout: Layout) => View | null, ms: number) => {
			const api = apiRef.current;
			const wrapper = api?.instance.wrapperComponent;
			const content = api?.instance.contentComponent;
			if (!api || !wrapper || !content) return;
			const layout: Layout = {
				frame: { width: wrapper.clientWidth, height: wrapper.clientHeight },
				image: { width: content.offsetWidth, height: content.offsetHeight },
			};
			const { scale, positionX, positionY } = api.instance.state;
			const shown = { scale, x: positionX, y: positionY };
			const heading = headingRef.current ?? shown;
			// Not heading anywhere of ours, the view still ends inside the
			// bounds: the library brings it back to them after a gesture.
			const target = to(headingRef.current ?? bounded(shown, layout), layout);
			if (
				!target ||
				(target.scale === heading.scale &&
					target.x === heading.x &&
					target.y === heading.y)
			) {
				return;
			}
			headingRef.current = target;
			// Settled when the animation ends or anything interrupts it.
			const arrived = () => {
				if (headingRef.current === target) headingRef.current = null;
			};
			const { x, y } = target;
			if (ms > 0) {
				void api.setTransform(x, y, target.scale, ms).then(arrived);
				return;
			}
			// The library applies a zero-length move at once but leaves a running
			// animation running, to carry the view off to its own target on the
			// next frame. Any new animation replaces it; this one stays put.
			void api.setTransform(x, y, target.scale, 0);
			void api.setTransform(x, y, target.scale, 1).then(arrived);
		},
		[apiRef],
	);
}

const centreOf = ({ width, height }: ImageDimensions) => ({
	x: width / 2,
	y: height / 2,
});

/** The frame's size, followed through rotation and window resizes. */
function useElementSize(ref: React.RefObject<HTMLElement | null>) {
	const [size, setSize] = useState<ImageDimensions | null>(null);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () =>
			setSize((previous) => {
				const width = element.clientWidth;
				const height = element.clientHeight;
				return previous?.width === width && previous.height === height
					? previous
					: { width, height };
			});
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

/**
 * The zoom readout: the visible, keyboard- and screen-reader-reachable form of
 * the double-tap. Its own component, subscribed to the transform itself, so a
 * pinch re-renders this button and nothing else.
 */
function ZoomReadout({
	actual,
	onToggle,
}: {
	actual: number;
	onToggle: () => void;
}) {
	const context = useTransformContext();
	const [scale, setScale] = useState(context.state.scale);
	useTransformEffect(
		useCallback(({ state }) => {
			setScale(state.scale);
		}, []),
	);
	const label = zoomLabel(scale, actual);
	const next = !isAtFit(scale)
		? "Fit to screen"
		: toggleTarget(scale, actual) === actual
			? "Show actual size"
			: "Zoom in";
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-label={`Zoom: ${label}. ${next}`}
			title={next}
			className="touch-target flex h-9 min-w-14 shrink-0 items-center justify-center rounded px-2 text-th-text-muted tabular-nums hover:bg-th-overlay-hover hover:text-th-text-primary"
		>
			{label}
		</button>
	);
}

/**
 * An image the reader can pinch, pan, double-tap and wheel around
 * (docs/media-viewer.md#the-image-stage). The only module that imports
 * `react-zoom-pan-pinch`, so the library arrives with this stage's chunk.
 */
export default function ImageStage({
	item,
	toolbarStart,
	keysRef,
	onMetadata,
}: StageProps<ImageMediaItem>) {
	const image = useImageSrc(item.source);
	const src = image.src;
	const [status, setStatus] = useState<Status>("loading");
	const [natural, setNatural] = useState<ImageDimensions | null>(
		item.dimensions ?? null,
	);
	// Bumped to remount the <img>, since re-assigning the same src after a
	// failure does not make the browser try again.
	const [attempt, setAttempt] = useState(0);
	const [atFit, setAtFit] = useState(true);
	const [panning, setPanning] = useState(false);

	// New bytes — a Files entry rewritten on disk — are a new image: judged
	// afresh, and shown from fit. Adjusted during render for the reason
	// `ImagePreview` gives.
	const [renderedSrc, setRenderedSrc] = useState(src);
	if (renderedSrc !== src) {
		setRenderedSrc(src);
		setStatus("loading");
		setNatural(item.dimensions ?? null);
	}

	const frameRef = useRef<HTMLDivElement>(null);
	const frame = useElementSize(frameRef);
	const fit = fitSize(natural, frame);
	const actual = natural && fit ? actualScale(natural, fit) : 1;
	const max = maxScale(actual);

	const apiRef = useRef<ReactZoomPanPinchContentRef>(null);
	const move = useMoves(apiRef);
	const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
	const animationMs = reducedMotion ? 0 : ZOOM_ANIMATION_MS;

	// A layout effect, so it runs before the new bytes' `onLoad` can report.
	// biome-ignore lint/correctness/useExhaustiveDependencies: new bytes are what it runs for
	useLayoutEffect(() => {
		onMetadata(null);
	}, [src, onMetadata]);

	const failed = image.error || status === "error";

	// The library learns of a new size from its ResizeObserver, which WebKit
	// delivers a few frames late, and realigns by cancelling whatever animation
	// is running: a key pressed just after opening, or just after the frame
	// turned, would stop short. Told now, the observer has nothing left to
	// tell it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the sizes are what it runs for; the library measures them itself
	useLayoutEffect(() => {
		apiRef.current?.instance.onSizeChange();
	}, [frame?.width, frame?.height, fit?.width, fit?.height]);

	// Each image is shown from fit, centred, before the frame is painted: new
	// bytes, and the same bytes in a library instance of its own after a
	// failed load. Once each — a frame that collapses to nothing and comes back
	// keeps the reader's scale.
	const hasFit = fit !== null;
	const centredRef = useRef<string | null>(null);
	useLayoutEffect(() => {
		if (failed) {
			centredRef.current = null;
			return;
		}
		if (!src || !hasFit || centredRef.current === src) return;
		centredRef.current = src;
		move((_, layout) => bounded({ scale: 1, x: 0, y: 0 }, layout), 0);
	}, [src, hasFit, failed, move]);

	// A smaller frame lowers the ceiling; a scale left above it is brought down.
	useEffect(() => {
		move(
			(from, layout) =>
				from.scale > max
					? zoomedTo(from, max, centreOf(layout.frame), layout)
					: null,
			0,
		);
	}, [max, move]);

	/** Zooms to what `scale` makes of the scale the view is heading to. */
	const zoomTo = (
		scale: (from: number) => number,
		point?: { clientX: number; clientY: number },
	) => {
		const rect =
			apiRef.current?.instance.wrapperComponent?.getBoundingClientRect();
		move(
			(from, layout) =>
				zoomedTo(
					from,
					scale(from.scale),
					point && rect
						? { x: point.clientX - rect.left, y: point.clientY - rect.top }
						: centreOf(layout.frame),
					layout,
				),
			animationMs,
		);
	};

	const toggle = (point?: { clientX: number; clientY: number }) => {
		zoomTo((from) => toggleTarget(from, actual), point);
	};
	const toggleRef = useRef(toggle);
	toggleRef.current = toggle;

	const [doubleTap] = useState(
		() =>
			new DoubleTapTracker((clientX, clientY) =>
				toggleRef.current({ clientX, clientY }),
			),
	);
	// `dblclick` is the mouse's; a touch's comes through `doubleTap`, and a
	// browser that synthesises one for touch as well must not toggle twice.
	const lastPointerTypeRef = useRef("mouse");

	const onKey: StageKeyHandler = (event) => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		// Arrows move the view, as scrolling does: → reveals what is to the
		// right, so the image itself moves left. At fit the bounds hold it.
		const pan = (shareX: number, shareY: number) =>
			move(
				(from, layout) =>
					pannedBy(
						from,
						shareX * layout.frame.width,
						shareY * layout.frame.height,
						layout,
					),
				animationMs,
			);
		switch (event.key) {
			case "+":
			case "=":
				zoomTo((from) => Math.min(from * KEY_ZOOM_FACTOR, max));
				break;
			case "-":
				zoomTo((from) => Math.max(from / KEY_ZOOM_FACTOR, 1));
				break;
			case "0":
				zoomTo(() => 1);
				break;
			case "1":
				zoomTo(() => actual);
				break;
			case "ArrowLeft":
				pan(KEY_PAN_SHARE, 0);
				break;
			case "ArrowRight":
				pan(-KEY_PAN_SHARE, 0);
				break;
			case "ArrowUp":
				pan(0, KEY_PAN_SHARE);
				break;
			case "ArrowDown":
				pan(0, -KEY_PAN_SHARE);
				break;
			default:
				return;
		}
		event.preventDefault();
	};
	const onKeyRef = useRef(onKey);
	onKeyRef.current = onKey;
	// Installed by the effect, not during render: StrictMode's mount, cleanup,
	// mount would otherwise leave the viewer with no handler at all.
	useEffect(() => {
		keysRef.current = (event) => onKeyRef.current(event);
		return () => {
			keysRef.current = null;
		};
	}, [keysRef]);

	const cursor = atFit
		? "cursor-zoom-in"
		: panning
			? "cursor-grabbing"
			: "cursor-grab";

	return (
		<div ref={frameRef} className="absolute inset-0 touch-none select-none">
			{failed ? (
				<div className="flex size-full items-center justify-center overflow-auto">
					<ImageFailureCard
						readError={image.error}
						mime={item.mime}
						size={item.size}
						host={
							item.source.kind === "external"
								? new URL(item.source.url).host
								: undefined
						}
						onRetry={
							image.error
								? image.retry
								: () => {
										setStatus("loading");
										setAttempt((n) => n + 1);
									}
						}
					/>
				</div>
			) : (
				<TransformWrapper
					ref={apiRef}
					minScale={1}
					maxScale={max}
					// Centred by the stage itself, before the first paint: the
					// library's own centring lands a few frames late in WebKit.
					centerZoomedOut
					limitToBounds
					// The toggle is ours: the library's zooms by a fixed step rather
					// than to actual size, and its touch window misses real taps.
					doubleClick={{ disabled: true }}
					// The browser's convention: ctrl+wheel (and a trackpad pinch,
					// which arrives as one) zooms; a plain wheel pans.
					wheel={{ wheelDisabled: true }}
					trackPadPanning={{ disabled: false }}
					// The viewer's frame holds focus and forwards keys here.
					keyboard={{ disabled: true }}
					velocityAnimation={{ disabled: reducedMotion }}
					onTransform={(_, state) => setAtFit(isAtFit(state.scale))}
					// Grabbing is a held mouse button. The library reports wheel
					// pans and touch pans here too, and a pinch taking over a
					// one-finger pan never reports its stop.
					onPanningStart={(_, event) =>
						setPanning(event instanceof MouseEvent && event.buttons !== 0)
					}
					onPanningStop={() => setPanning(false)}
				>
					<TransformComponent
						wrapperClass={`!size-full ${cursor}`}
						wrapperProps={{
							onPointerDown: (event) => {
								lastPointerTypeRef.current = event.pointerType;
								doubleTap.pointerDown(event);
							},
							onPointerUp: doubleTap.pointerUp,
							onPointerCancel: doubleTap.pointerCancel,
							onDoubleClick: (event) => {
								if (lastPointerTypeRef.current === "mouse") {
									toggle(event);
								}
							},
						}}
					>
						{src && (
							<img
								key={attempt}
								src={src}
								alt={item.name}
								// Only an external image's request leaves the app, and it
								// tells that host nothing about which page asked.
								referrerPolicy="no-referrer"
								draggable={false}
								onLoad={(event) => {
									const decoded = {
										width: event.currentTarget.naturalWidth,
										height: event.currentTarget.naturalHeight,
									};
									setNatural(decoded);
									onMetadata({ dimensions: decoded, duration: null });
									setStatus("loaded");
								}}
								onError={() => setStatus("error")}
								// Laid out at explicit pixels: the library's boxes are
								// fit-content, so percentage limits would have nothing to
								// resolve against. Zero until the fit is known, so the
								// library never lays out around the natural size and then
								// chases the shrink. Hidden, not unmounted, while loading:
								// when a browser decodes a `display: none` image is up to it.
								style={fit ?? { width: 0, height: 0 }}
								className={`max-w-none ${
									status === "loading" || !fit ? "invisible" : ""
								}`}
							/>
						)}
					</TransformComponent>
					{toolbarStart &&
						status === "loaded" &&
						createPortal(
							<ZoomReadout actual={actual} onToggle={() => toggle()} />,
							toolbarStart,
						)}
				</TransformWrapper>
			)}
			{!failed && (!src || status === "loading") && (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
					<Spinner variant="current" className="text-th-text-muted" />
				</div>
			)}
		</div>
	);
}
