import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import compression from "vite-plugin-compression";

const serverPort = process.env.SERVER_PORT || "9871";
const webPort = Number(process.env.WEB_PORT) || 5174;

export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
		compression({
			algorithm: "brotliCompress",
			ext: ".br",
			deleteOriginFile: true,
			filter: /\.(js|css)$/i,
		}),
	],
	server: {
		port: webPort,
		proxy: {
			"/ws": {
				target: `ws://localhost:${serverPort}`,
				ws: true,
			},
			"/health": {
				target: `http://localhost:${serverPort}`,
			},
		},
	},
	build: {
		rollupOptions: {
			output: {
				manualChunks: undefined,
			},
		},
	},
});
