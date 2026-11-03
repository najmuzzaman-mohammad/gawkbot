import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { initApi } from "../api/client";
import { isDockPage } from "./dockBridge";
import { NotchApp } from "./NotchApp";
import { NotchDock } from "./NotchDock";
import "./notch.css";

// Entry for notch.html, the page the Mac app hosts over the camera notch.
// Deliberately NOT the main SPA: no router, no app shell, no onboarding
// gates, so it boots fast inside the notch panel and polls one endpoint.
// With ?dock=1 the same page is the working-bot cards at the top right of
// the screen (NotchDock.tsx), in a second panel the Mac app floats.

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 1_000 } },
});

void initApi().then(() => {
  const root = document.getElementById("notch-root");
  if (!root) return;
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      {isDockPage() ? <NotchDock /> : <NotchApp />}
    </QueryClientProvider>,
  );
});
