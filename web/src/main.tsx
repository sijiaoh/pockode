import { LayerHistoryContext } from "@pockode/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { loadAllExtensions } from "./lib/extensions";
import { watchAppInput } from "./lib/pageHosts";
import { createQueryClient } from "./lib/queryClient";
import { themeActions } from "./lib/themeStore";
import { layerHistory, router } from "./router";

const queryClient = createQueryClient();
themeActions.init();
loadAllExtensions();
watchAppInput();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<LayerHistoryContext value={layerHistory}>
				<RouterProvider router={router} />
			</LayerHistoryContext>
		</QueryClientProvider>
	</StrictMode>,
);
