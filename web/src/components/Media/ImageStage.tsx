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
	fitSize,
	isAtFit,
	KEY_PAN_SHARE,
	KEY_ZOOM_FACTOR,
	maxScale,
	toggleTarget,
	zoomLabel,
} from "./imageScale";
import type { ImageMediaItem, StageKeyHandler, StageProps } from "./types";

/** How long the toggle and the keys' zooms take. */
const ZOOM_ANIMATION_MS = 200;

type Status = "loading" | "loaded" | "error";

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
	onDimensions,
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
	const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
	const animationMs = reducedMotion ? 0 : ZOOM_ANIMATION_MS;

	// A layout effect, so it runs before the new bytes' `onLoad` can report.
	useLayoutEffect(() => {
		onDimensions(null);
		if (src) apiRef.current?.centerView(1, 0);
	}, [src, onDimensions]);

	// A smaller frame lowers the ceiling; a scale left above it is brought down.
	useEffect(() => {
		const api = apiRef.current;
		const wrapper = api?.instance.wrapperComponent;
		if (!api || !wrapper || api.instance.state.scale <= max) return;
		const rect = wrapper.getBoundingClientRect();
		void api.zoomToPoint(
			max,
			rect.left + rect.width / 2,
			rect.top + rect.height / 2,
			0,
		);
	}, [max]);

	const zoomAt = (scale: number, clientX?: number, clientY?: number) => {
		const api = apiRef.current;
		const wrapper = api?.instance.wrapperComponent;
		if (!api || !wrapper) return;
		if (isAtFit(scale)) {
			void api.centerView(1, animationMs);
			return;
		}
		const rect = wrapper.getBoundingClientRect();
		void api.zoomToPoint(
			scale,
			clientX ?? rect.left + rect.width / 2,
			clientY ?? rect.top + rect.height / 2,
			animationMs,
		);
	};

	const toggle = (clientX?: number, clientY?: number) => {
		const api = apiRef.current;
		if (!api) return;
		zoomAt(toggleTarget(api.instance.state.scale, actual), clientX, clientY);
	};
	const toggleRef = useRef(toggle);
	toggleRef.current = toggle;

	const [doubleTap] = useState(
		() => new DoubleTapTracker((x, y) => toggleRef.current(x, y)),
	);
	// `dblclick` is the mouse's; a touch's comes through `doubleTap`, and a
	// browser that synthesises one for touch as well must not toggle twice.
	const lastPointerTypeRef = useRef("mouse");

	const onKey: StageKeyHandler = (event) => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const api = apiRef.current;
		const wrapper = api?.instance.wrapperComponent;
		if (!api || !wrapper) return;
		const { scale } = api.instance.state;
		const panX = wrapper.clientWidth * KEY_PAN_SHARE;
		const panY = wrapper.clientHeight * KEY_PAN_SHARE;
		// Arrows move the view, as scrolling does: → reveals what is to the
		// right, so the image itself moves left.
		const pan = (dx: number, dy: number) => {
			if (!isAtFit(scale)) void api.panBy(dx, dy, animationMs);
		};
		switch (event.key) {
			case "+":
			case "=":
				zoomAt(Math.min(scale * KEY_ZOOM_FACTOR, max));
				break;
			case "-":
				zoomAt(Math.max(scale / KEY_ZOOM_FACTOR, 1));
				break;
			case "0":
				zoomAt(1);
				break;
			case "1":
				zoomAt(actual);
				break;
			case "ArrowLeft":
				pan(panX, 0);
				break;
			case "ArrowRight":
				pan(-panX, 0);
				break;
			case "ArrowUp":
				pan(0, panY);
				break;
			case "ArrowDown":
				pan(0, -panY);
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

	const failed = image.error || status === "error";
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
					centerOnInit
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
					// pans, its own animated pans (as a buttonless MouseEvent) and
					// touch pans here too, and a pinch taking over a one-finger pan
					// never reports its stop.
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
									toggle(event.clientX, event.clientY);
								}
							},
						}}
					>
						{src && (
							<img
								key={attempt}
								src={src}
								alt={item.name}
								draggable={false}
								onLoad={(event) => {
									const decoded = {
										width: event.currentTarget.naturalWidth,
										height: event.currentTarget.naturalHeight,
									};
									setNatural(decoded);
									onDimensions(decoded);
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
