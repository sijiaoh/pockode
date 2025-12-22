import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = process.env.API_PORT || "8080";
const apiTarget = `http://localhost:${apiPort}`;

// https://vite.dev/config/
export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		proxy: {
			"/api": apiTarget,
			"/ws": { target: apiTarget, ws: true },
			"/health": apiTarget,
		},
	},
});
