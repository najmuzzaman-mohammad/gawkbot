import type { Meta, StoryObj } from "@storybook/react-vite";

import { RecordPickerList } from "./RecordPicker";
import { DataStoryShell, SeedData } from "./storyKit";

const meta: Meta<typeof RecordPickerList> = {
  title: "Data / Records / RecordPicker",
  component: RecordPickerList,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The picker body, shown open without its popover. Focus stays in the search box; arrow keys move the active option and Enter picks it. Records that are already linked are never offered.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof RecordPickerList>;

interface PickerStoryProps {
  excludeFirst?: number;
  hasConflict?: boolean;
  isPending?: boolean;
}

function PickerStory({
  excludeFirst = 0,
  hasConflict = false,
  isPending = false,
}: PickerStoryProps) {
  return (
    <DataStoryShell>
      <SeedData typeSlug="firm">
        {({ schema, type, records }) => (
          <div className="dr-popover">
            <RecordPickerList
              spaceId={schema.space.id}
              targetType={type}
              excludeIds={records.slice(0, excludeFirst).map((item) => item.id)}
              onPick={() => undefined}
              isPending={isPending}
              conflict={
                hasConflict
                  ? {
                      targetId: records[0].id,
                      message:
                        "Anneke Brightwater is already linked to Halcyon Spur Ventures, and each Investor can belong to one Firm through Investors.",
                    }
                  : null
              }
              onMoveHere={() => undefined}
              onDismissConflict={() => undefined}
            />
          </div>
        )}
      </SeedData>
    </DataStoryShell>
  );
}

export const Default: Story = { render: () => <PickerStory /> };

export const SomeAlreadyLinked: Story = {
  render: () => <PickerStory excludeFirst={9} />,
};

export const EverythingLinked: Story = {
  render: () => <PickerStory excludeFirst={12} />,
};

export const OtherSideConflict: Story = {
  render: () => <PickerStory hasConflict={true} />,
};

export const Linking: Story = {
  render: () => <PickerStory isPending={true} />,
};
