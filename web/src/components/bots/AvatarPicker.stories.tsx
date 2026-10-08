import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { MemberAvatar } from "../../api/memberTypes";
import { AvatarPicker } from "./AvatarPicker";

function Controlled({
  slug,
  initial,
  disabled,
}: {
  slug: string;
  initial?: MemberAvatar;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<MemberAvatar | undefined>(initial);
  return (
    <div style={{ maxWidth: 360 }}>
      <AvatarPicker
        slug={slug}
        value={value}
        onChange={setValue}
        disabled={disabled}
      />
      <pre
        style={{
          marginTop: 12,
          fontSize: 11,
          color: "var(--text-tertiary)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {JSON.stringify(value ?? "automatic")}
      </pre>
    </div>
  );
}

const meta: Meta<typeof Controlled> = {
  title: "Bots / AvatarPicker",
  component: Controlled,
  args: { slug: "planner" },
};
export default meta;

type Story = StoryObj<typeof Controlled>;

/** No choice yet: the derived look is checked, reset is disabled. */
export const Automatic: Story = {};

/** A chosen shape and palette colour. */
export const Chosen: Story = {
  args: { initial: { shape: "bean", color: "#3f9c8f" } },
};

/** Shape only: the colour still comes from the slug. */
export const ShapeOnly: Story = {
  args: { initial: { shape: "shield" } },
};

/** A colour off the palette: the Custom chip is the checked one. */
export const CustomColour: Story = {
  args: { initial: { shape: "drop", color: "#e0457b" } },
};

/** A blank wizard, before the bot has a slug. */
export const NoSlugYet: Story = {
  args: { slug: "" },
};

export const Disabled: Story = {
  args: { initial: { shape: "loaf" }, disabled: true },
};
