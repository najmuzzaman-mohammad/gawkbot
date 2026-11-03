import type { Meta, StoryObj } from "@storybook/react-vite";

import { PaginationFooter } from "./PaginationFooter";

const meta: Meta<typeof PaginationFooter> = {
  title: "Data / Records / PaginationFooter",
  component: PaginationFooter,
  parameters: { layout: "padded" },
  args: { onPageChange: () => undefined, onPageSizeChange: () => undefined },
};

export default meta;

type Story = StoryObj<typeof PaginationFooter>;

export const FirstPage: Story = { args: { page: 1, pageSize: 30, total: 212 } };

export const MiddlePage: Story = {
  args: { page: 4, pageSize: 30, total: 212 },
};

export const LastPage: Story = { args: { page: 8, pageSize: 30, total: 212 } };

export const SinglePage: Story = { args: { page: 1, pageSize: 30, total: 22 } };

export const LargeTotal: Story = {
  args: { page: 120, pageSize: 100, total: 98431 },
};
