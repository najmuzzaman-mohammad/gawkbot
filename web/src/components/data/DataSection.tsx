import type { CurrentRoute } from "../../routes/useCurrentRoute";
import { DataIndexPage } from "./index/DataIndexPage";
import { DataSpacePage } from "./index/DataSpacePage";
import { RecordPage } from "./record/RecordPage";
import { RecordsPage } from "./records/RecordsPage";
import { TypeSettingsPage } from "./settings/TypeSettingsPage";

export type DataRoute = Extract<
  CurrentRoute,
  {
    kind:
      | "data-index"
      | "data-space"
      | "data-type"
      | "data-type-settings"
      | "data-record";
  }
>;

interface DataSectionProps {
  route: DataRoute;
}

/**
 * Data section shell. Bots own data spaces (one per use case); each space
 * holds object types, attributes, relationships, and records. The screens
 * follow the Nex data UI: index, records table, record page, type settings.
 * Spec: docs/specs/agent-data-model.md.
 */
export function DataSection({ route }: DataSectionProps) {
  return (
    <div className="app-panel active data-section" data-testid="data-section">
      <DataSectionBody route={route} />
    </div>
  );
}

function DataSectionBody({ route }: DataSectionProps) {
  switch (route.kind) {
    case "data-index":
      return <DataIndexPage />;
    case "data-space":
      return <DataSpacePage spaceId={route.spaceId} />;
    case "data-type":
      return <RecordsPage spaceId={route.spaceId} typeSlug={route.typeSlug} />;
    case "data-type-settings":
      return (
        <TypeSettingsPage
          spaceId={route.spaceId}
          typeSlug={route.typeSlug}
          tab={route.tab}
        />
      );
    case "data-record":
      return <RecordPage spaceId={route.spaceId} recordId={route.recordId} />;
    default: {
      const _exhaustive: never = route;
      void _exhaustive;
      return null;
    }
  }
}
