import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { NameCell } from "./NameCell";
import { DataStoryShell, SeedData } from "./storyKit";

interface FrameProps {
  children: ReactNode;
}

/** One table row, so the row-hover and focus-within reveal can be seen. */
function Frame({ children }: FrameProps) {
  return (
    <div className="dr-region">
      <table className="dr-table" style={{ width: "auto" }}>
        <tbody>
          <tr className="dr-tr">
            <td className="dr-td dr-td--name">{children}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const meta: Meta<typeof NameCell> = {
  title: "Data / Records / NameCell",
  component: NameCell,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The name is a real link. Rename with F2 on the link or the pencil button. The rename and Preview controls appear on row hover and on focus within the row, and are always visible where there is no hovering pointer.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof NameCell>;

function story(
  name: string,
  extra: { isPending?: boolean; readOnly?: boolean },
) {
  return (
    <DataStoryShell>
      <SeedData>
        {({ type }) => {
          const [primary] = type.attributes.filter((item) => item.isPrimary);
          return (
            <Frame>
              <NameCell
                spaceId={SEED_RAISE_SPACE_ID}
                recordId="rec_seed_13"
                attribute={primary}
                value={name}
                name={name}
                isPending={extra.isPending}
                onPreview={() => undefined}
                onRename={extra.readOnly ? undefined : () => undefined}
              />
            </Frame>
          );
        }}
      </SeedData>
    </DataStoryShell>
  );
}

export const Default: Story = {
  render: () => story("Mirela Okonjo-Hart", {}),
};

export const LongName: Story = {
  render: () =>
    story("Wilhelmina Storrs-Achterberg of the Northlantern Partners fund", {}),
};

export const Saving: Story = {
  render: () => story("Mirela Okonjo-Hart", { isPending: true }),
};

export const ReadOnly: Story = {
  render: () => story("Mirela Okonjo-Hart", { readOnly: true }),
};
