import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import compression from "vite-plugin-compression";

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
		port: 5174,
		proxy: {
			"/ws": {
				target: "ws://localhost:9871",
				ws: true,
			},
			"/health": {
				target: "http://localhost:9871",
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
