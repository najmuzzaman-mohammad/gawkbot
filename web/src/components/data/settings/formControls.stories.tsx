import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "../DataButton";
import {
  CheckField,
  FormError,
  ReadOnlyValue,
  TextAreaField,
  TextField,
} from "./formControls";

import "../../../styles/data.css";

const meta: Meta = {
  title: "Data / Settings / FormControls",
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "The plain form pieces the schema dialogs share: labelled text input, text area, checkbox with a hint, a read-only value (mono for identifiers), and the inline error.",
      },
    },
  },
};

export default meta;

type Story = StoryObj;

function Sheet() {
  const [name, setName] = useState("Investor");
  const [description, setDescription] = useState("");
  const [isRequired, setIsRequired] = useState(true);
  return (
    <div className="data-form" style={{ width: "calc(var(--space-8) * 10)" }}>
      <TextField
        label="Name"
        value={name}
        isRequired={true}
        onChange={setName}
      />
      <TextAreaField
        label="Description"
        value={description}
        placeholder="What one record of this type stands for."
        onChange={setDescription}
      />
      <CheckField
        label="Required"
        checked={isRequired}
        hint="A record cannot be saved without a value."
        onChange={setIsRequired}
      />
      <CheckField
        label="Multiple values"
        checked={false}
        disabled={true}
        hint="A unique attribute holds one value."
        onChange={() => undefined}
      />
      <ReadOnlyValue
        label="Slug"
        value="investor"
        isMono={true}
        hint="A rename never changes it."
        action={
          <Button type="button" variant="outline" size="sm">
            Copy
          </Button>
        }
      />
      <FormError message='An object type named "Investor" already exists.' />
    </div>
  );
}

export const AllControls: Story = { render: () => <Sheet /> };
