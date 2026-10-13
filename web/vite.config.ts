import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import compression from "vite-plugin-compression";

const serverPort = process.env.SERVER_PORT || "8080";
const webPort = Number(process.env.WEB_PORT) || 5173;

// https://vite.dev/config/
export default defineConfig({
	clearScreen: false,
	define: {
		__APP_VERSION__: JSON.stringify(process.env.VERSION || "dev"),
	},
	plugins: [
		react(),
		tailwindcss(),
		// Pre-compress JS/CSS for server-side brotli serving.
		// deleteOriginFile reduces embed binary size; server falls back to index.html for SPA routes.
		compression({
			algorithm: "brotliCompress",
			ext: ".br",
			filter: /\.(js|css)$/i,
			deleteOriginFile: true,
		}),
	],
	server: {
		port: webPort,
		allowedHosts: [".local.pockode.com", ".cloud.pockode.com"],
		// Vite's own CORS middleware runs ahead of the proxy and answers every
		// OPTIONS itself, so a previewed page's preflighted fetch() to /api/raw
		// (from `Origin: null`) never reached the backend and failed in dev only.
		// Off, dev matches the relay and production: the backend alone owns
		// /api/raw's CORS policy, and the dev server grants none of its own.
		cors: false,
		proxy: {
			"/api": {
				target: `http://localhost:${serverPort}`,
				changeOrigin: true,
			},
			"/ws": {
				target: `ws://localhost:${serverPort}`,
				ws: true,
			},
		},
	},
});
