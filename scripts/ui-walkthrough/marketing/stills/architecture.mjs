// The architecture figure (docs/marketing-assets.md §6), on a transparent
// background in a dark and a light variant for the README's <picture>:
// phone → relay ← PC → AI CLIs, the PC and the CLIs inside "Your machine".

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ARCHITECTURE = { width: 1220, height: 360 };

const THEMES = {
	dark: {
		card: "#141414",
		stroke: "#262626",
		title: "#fafafa",
		small: "#a1a1aa",
		sub: "#a1a1a1",
		lock: "#fafafa",
		boundary: "#3f3f46",
	},
	light: {
		card: "#ffffff",
		stroke: "#e4e4e7",
		title: "#18181b",
		small: "#52525b",
		sub: "#52525b",
		lock: "#18181b",
		boundary: "#a1a1aa",
	},
};
export const ARCHITECTURE_THEMES = Object.keys(THEMES);

const CARD = { width: 168, height: 128, top: 116 };
const MID_Y = CARD.top + CARD.height / 2;
const NODES = {
	phone: { x: 24, icon: "smartphone", title: "Your phone", sub: "any browser" },
	relay: {
		x: 328,
		icon: "cloud",
		title: "Relay",
		sub: "cloud.pockode.com",
	},
	pc: { x: 656, icon: "laptop", title: "Your PC", sub: "pockode" },
	cli: { x: 1008, icon: "terminal", title: "claude · codex", sub: "AI CLIs" },
};
const EDGES = [
	{ from: "phone", to: "relay", label: "HTTPS / WSS", lock: true },
	// At the relay: the PC dials out, which is why it opens no port.
	{ from: "pc", to: "relay", label: "outbound tunnel", lock: true },
	{ from: "pc", to: "cli", label: "spawns · stream-json" },
];
const BOUNDARY = { left: 636, right: 1196, top: 60, bottom: 300 };
// Room between a card and the edge's end, and between the line and its lock.
const CLEARANCE = 6;
const ARROW = 8;
const LOCK = { width: 12, height: 14 };

/** The app's own icon set, at the version the app pins (web's lucide-react). */
async function icon(name, projectDir) {
	const { __iconNode } = await import(
		pathToFileURL(
			join(
				projectDir,
				`web/node_modules/lucide-react/dist/esm/icons/${name}.js`,
			),
		).href
	);
	return __iconNode
		.map(
			([tag, attrs]) =>
				`<${tag} ${Object.entries(attrs)
					.filter(([k]) => k !== "key")
					.map(([k, v]) => `${k}="${v}"`)
					.join(" ")} />`,
		)
		.join("");
}

/** A horizontal edge from one card's side to the other's, arrow at `to`. */
function edge({ from, to, label, lock }, i, theme) {
	const a = NODES[from].x;
	const b = NODES[to].x;
	const left = Math.min(a, b) + CARD.width + CLEARANCE;
	const right = Math.max(a, b) - CLEARANCE;
	const mid = (left + right) / 2;
	const tip = b > a ? right : left;
	const dir = b > a ? -1 : 1;
	const base = tip + dir * ARROW;
	// The line runs to the arrow's base, and around the lock with room either side.
	const [lineLeft, lineRight] = b > a ? [left, base] : [base, right];
	const gap = lock ? LOCK.width / 2 + CLEARANCE : 0;
	const segments = lock
		? [
				[lineLeft, mid - gap],
				[mid + gap, lineRight],
			]
		: [[lineLeft, lineRight]];
	const id = `edge-${i}`;
	return `
	<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${left}" y1="0" x2="${right}" y2="0">
		<stop offset="0" stop-color="#06b6d4" /><stop offset="1" stop-color="#a855f7" />
	</linearGradient>
	${segments.map(([x1, x2]) => `<line x1="${x1}" y1="${MID_Y}" x2="${x2}" y2="${MID_Y}" stroke="url(#${id})" stroke-width="2" />`).join("")}
	<path d="M${tip} ${MID_Y} L${base} ${MID_Y - ARROW / 2} L${base} ${MID_Y + ARROW / 2} Z" fill="url(#${id})" />
	${
		lock
			? `<g transform="translate(${mid - LOCK.width / 2} ${MID_Y - LOCK.height / 2})" fill="${theme.lock}">
		<path d="M3 6.5V4a3 3 0 0 1 6 0v2.5" fill="none" stroke="${theme.lock}" stroke-width="1.5" />
		<rect x="0" y="6" width="12" height="8" rx="2" />
	</g>`
			: ""
	}
	<text x="${mid}" y="${MID_Y - 10}" text-anchor="middle" class="label">${label}</text>`;
}

export async function architecturePage(variant, projectDir) {
	const theme = THEMES[variant];
	const cards = await Promise.all(
		Object.values(NODES).map(
			async (node) => `
<div class="card" style="left: ${node.x}px">
	<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="url(#brand)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${await icon(node.icon, projectDir)}</svg>
	<div class="title">${node.title}</div>
	<div class="sub">${node.sub}</div>
</div>`,
		),
	);
	const { left, right, top, bottom } = BOUNDARY;
	return {
		css: `
body { width: 1220px; height: 360px; position: relative; }
svg.edges { position: absolute; inset: 0; }
.label { font: 500 12px Geist; fill: ${theme.sub}; }
.card {
	position: absolute; top: ${CARD.top}px; width: ${CARD.width}px; height: ${CARD.height}px;
	box-sizing: border-box; border: 1px solid ${theme.stroke}; border-radius: 14px; background: ${theme.card};
	display: flex; flex-direction: column; align-items: center; padding-top: 19px;
}
.title { margin-top: 16px; font: 600 17px Geist; color: ${theme.title}; }
.sub { margin-top: 4px; font: 400 12px "Geist Mono"; color: ${theme.sub}; }
.machine {
	position: absolute; left: ${left}px; top: ${top}px; width: ${right - left}px; height: ${bottom - top}px;
	font-size: 12px; color: ${theme.small};
}
.machine > div:first-child {
	position: absolute; left: 14px; top: 12px;
	font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
}
.machine > div:last-child { position: absolute; left: 0; right: 0; bottom: 12px; text-align: center; }`,
		body: `
<svg class="edges" width="1220" height="360">
	<defs>
		<linearGradient id="brand" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="24" y2="24">
			<stop offset="0" stop-color="#06b6d4" /><stop offset="1" stop-color="#a855f7" />
		</linearGradient>
	</defs>
	<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" rx="18"
		fill="none" stroke="${theme.boundary}" stroke-width="1.5" stroke-dasharray="6 4" />
	${EDGES.map((e, i) => edge(e, i, theme)).join("")}
</svg>
<div class="machine"><div>Your machine</div><div>no open ports · code runs here</div></div>
${cards.join("")}`,
	};
}
