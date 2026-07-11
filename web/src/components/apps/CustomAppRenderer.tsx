import type { CustomApp } from "../../api/apps";
import { CustomAppFrame } from "./CustomAppFrame";
import { OpenUIAppRenderer } from "./OpenUIAppRenderer";

export function CustomAppRenderer({
  app,
  html,
  openui,
  title,
}: {
  app: CustomApp;
  html?: string;
  openui?: string;
  title?: string;
}) {
  if (app.representation === "openui") {
    if (openui === undefined) return null;
    return (
      <OpenUIAppRenderer
        appId={app.id}
        title={title ?? app.name}
        openui={openui}
      />
    );
  }
  if (html === undefined) return null;
  return (
    <CustomAppFrame appId={app.id} title={title ?? app.name} html={html} />
  );
}
