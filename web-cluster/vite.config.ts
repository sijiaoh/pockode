import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import compression from "vite-plugin-compression";

const serverPort = process.env.SERVER_PORT || "9871";
const webPort = Number(process.env.WEB_PORT) || 5174;

export default defineConfig({
	clearScreen: false,
	define: {
		__APP_VERSION__: JSON.stringify(process.env.VERSION || "dev"),
	},
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
		allowedHosts: [".local.pockode.com", ".cloud.pockode.com"],
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
				// Single bundle for embedded binary simplicity
				manualChunks: undefined,
			},
		},
	},
});
