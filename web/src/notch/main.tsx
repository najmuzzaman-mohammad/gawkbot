import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { initApi } from "../api/client";
import { NotchApp } from "./NotchApp";
import "./notch.css";

// Entry for notch.html, the page the Mac app hosts over the camera notch.
// Deliberately NOT the main SPA: no router, no app shell, no onboarding
// gates, so it boots fast inside a 440px panel and polls one endpoint.

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 1_000 } },
});

void initApi().then(() => {
  const root = document.getElementById("notch-root");
  if (!root) return;
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <NotchApp />
    </QueryClientProvider>,
  );
});
