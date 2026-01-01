import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = process.env.SERVER_PORT || "8080";

// https://vite.dev/config/
export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		allowedHosts: [".local.pockode.com"],
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
