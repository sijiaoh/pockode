import {
	CrashScreen,
	createLayerHistory,
	ErrorBoundary,
	LayerHistoryContext,
} from "@pockode/shared";
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
			{/* Without it a throw anywhere leaves a blank page. There is no URL
			    state to escape here, so a reload is the way out. */}
			<ErrorBoundary
				fallback={(error) => (
					<CrashScreen
						error={error}
						title="Something went wrong"
						actions={[
							{ label: "Reload", onClick: () => window.location.reload() },
						]}
					/>
				)}
			>
				<LayerHistoryContext value={layerHistory}>
					<App />
				</LayerHistoryContext>
			</ErrorBoundary>
		</StrictMode>,
	);
}
