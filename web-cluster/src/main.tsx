import { createLayerHistory, LayerHistoryContext } from "@pockode/shared";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { windowLayerEntries } from "./lib/layerEntries";

// Once, before anything renders: a reload under a sheet is answered here.
const layerHistory = createLayerHistory(windowLayerEntries());

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<LayerHistoryContext value={layerHistory}>
				<App />
			</LayerHistoryContext>
		</StrictMode>,
	);
}
