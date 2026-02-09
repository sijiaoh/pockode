import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Example extension: uncomment to see how custom settings sections can be added.
// import "./extensions/MyExtensions";
import "./index.css";
import { initializeExtensions } from "./lib/extensions";
import { createQueryClient } from "./lib/queryClient";
import { registerBuiltinSettings } from "./lib/registries/builtinSettings";
import { themeActions } from "./lib/themeStore";
import { router } from "./router";

const queryClient = createQueryClient();
themeActions.init();
registerBuiltinSettings();
initializeExtensions();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</StrictMode>,
);
