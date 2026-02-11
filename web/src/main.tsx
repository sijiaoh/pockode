import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { loadAllExtensions } from "./lib/extensions";
import { createQueryClient } from "./lib/queryClient";
import { themeActions } from "./lib/themeStore";
import { router } from "./router";

const queryClient = createQueryClient();
themeActions.init();
loadAllExtensions();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</StrictMode>,
);
