import { useMemo } from "react";
import { encode } from "uqr";

export interface QrCodeProps {
	value: string;
	/** What the code leads to, for a screen reader. */
	label: string;
}

/** The quiet zone a scanner needs around the code, in modules (ISO/IEC 18004). */
const QUIET_ZONE = 4;
/**
 * A whole number of pixels per module, so no module edge falls between two
 * device pixels and blurs.
 */
const MODULE_PX = 4;

/**
 * A QR code as an SVG, dark on a white tile in every theme: a scanner needs
 * the contrast, not the theme, and a light code on a dark ground is one many
 * cannot read. The value is drawn in the page and kept nowhere.
 */
export function QrCode({ value, label }: QrCodeProps) {
	const { size, path } = useMemo(() => {
		const { size, data } = encode(value, { border: QUIET_ZONE });
		// One subpath per dark module: a single path element keeps the DOM small
		// however long the value.
		let d = "";
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				if (data[y][x]) d += `M${x} ${y}h1v1h-1z`;
			}
		}
		return { size, path: d };
	}, [value]);

	return (
		<svg
			role="img"
			aria-label={label}
			width={size * MODULE_PX}
			height={size * MODULE_PX}
			viewBox={`0 0 ${size} ${size}`}
			shapeRendering="crispEdges"
			className="shrink-0 rounded-md"
		>
			{/* Literal colours on purpose: theme tokens would turn the code light
			    on dark in the dark theme. */}
			<rect width={size} height={size} fill="#ffffff" />
			<path d={path} fill="#000000" />
		</svg>
	);
}
