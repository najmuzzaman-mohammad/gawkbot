import type { Meta, StoryObj } from "@storybook/react-vite";

import { DataValidationError } from "../../../api/dataspaces";
import { SpaceLoadError } from "./SpaceLoadError";
import { DataStory } from "./storyHarness";

const meta: Meta<typeof SpaceLoadError> = {
  title: "Data / Index / SpaceLoadError",
  component: SpaceLoadError,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "A schema that failed to load. An unknown space id reads as not found; any other failure says it did not load and shows the store's message. Both link back to Data.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof SpaceLoadError>;

export const NotFound: Story = {
  render: () => (
    <DataStory>
      <SpaceLoadError
        error={new DataValidationError('Unknown data space "space_missing".')}
      />
    </DataStory>
  ),
};

export const LoadFailure: Story = {
  render: () => (
    <DataStory>
      <SpaceLoadError error={new Error("The broker did not answer.")} />
    </DataStory>
  ),
};
