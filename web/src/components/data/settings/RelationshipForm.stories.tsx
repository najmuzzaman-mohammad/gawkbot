import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ObjectType } from "../../../api/dataspaces";
import { SEED_RAISE_SPACE_ID } from "../../../api/dataspaces.fixtures";
import { DataStory, pickType, WithSchema } from "../index/storyHarness";
import { RelationshipForm } from "./RelationshipForm";
import {
  DEFAULT_RELATIONSHIP_CARDINALITY,
  type RelationshipDraft,
} from "./relationshipDefaults";

const meta: Meta<typeof RelationshipForm> = {
  title: "Data / Settings / RelationshipForm",
  component: RelationshipForm,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Body of the new attribute dialog for the Relation type. The four named cardinality modes each explain themselves with the two real type names, the default names follow the target and the mode until the operator types their own, and the preview sentence updates live.",
      },
    },
  },
};

export default meta;

type Story = StoryObj<typeof RelationshipForm>;

const EMPTY: RelationshipDraft = {
  targetTypeId: "",
  name: "",
  cardinality: DEFAULT_RELATIONSHIP_CARDINALITY,
  hasInverse: true,
  inverseName: "",
};

interface ControlledProps {
  sourceType: ObjectType;
  objectTypes: readonly ObjectType[];
  initial: RelationshipDraft;
}

function Controlled({ sourceType, objectTypes, initial }: ControlledProps) {
  const [draft, setDraft] = useState(initial);
  return (
    <div style={{ maxWidth: "64ch" }}>
      <RelationshipForm
        sourceType={sourceType}
        objectTypes={objectTypes}
        draft={draft}
        onChange={setDraft}
      />
    </div>
  );
}

export const NoTargetYet: Story = {
  render: () => (
    <DataStory>
      <WithSchema spaceId={SEED_RAISE_SPACE_ID}>
        {(schema) => (
          <Controlled
            sourceType={pickType(schema, "Firm")}
            objectTypes={schema.objectTypes}
            initial={EMPTY}
          />
        )}
      </WithSchema>
    </DataStory>
  ),
};

export const OpenLinkingWithoutInverse: Story = {
  render: () => (
    <DataStory>
      <WithSchema spaceId={SEED_RAISE_SPACE_ID}>
        {(schema) => (
          <Controlled
            sourceType={pickType(schema, "Firm")}
            objectTypes={schema.objectTypes}
            initial={{
              targetTypeId: pickType(schema, "Meeting").id,
              name: "Meetings",
              cardinality: "many_to_many",
              hasInverse: false,
              inverseName: "",
            }}
          />
        )}
      </WithSchema>
    </DataStory>
  ),
};

export const OnlyOneObjectType: Story = {
  render: () => (
    <DataStory>
      <WithSchema spaceId={SEED_RAISE_SPACE_ID}>
        {(schema) => (
          <Controlled
            sourceType={pickType(schema, "Firm")}
            objectTypes={[pickType(schema, "Firm")]}
            initial={EMPTY}
          />
        )}
      </WithSchema>
    </DataStory>
  ),
};
