import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  OPENUI_ARTIFACT_LIBRARY,
  OPENUI_ARTIFACT_LIBRARY_HASH,
  OPENUI_ARTIFACT_VERSION,
  type OpenUIRichArtifactDetail,
} from "../../api/richArtifacts";
import RichArtifactRenderer from "./RichArtifactRenderer";

const detail = {
  artifact: {
    id: "ra_0123456789abcdef",
    kind: "notebook_openui",
    title: "Launch Readiness",
    summary: "A static OpenUI review artifact.",
    trustLevel: "draft",
    representation: "openui",
    contentPath: "wiki/visual-artifacts/ra_0123456789abcdef.openui",
    openuiVersion: OPENUI_ARTIFACT_VERSION,
    openuiLibrary: OPENUI_ARTIFACT_LIBRARY,
    openuiLibraryHash: OPENUI_ARTIFACT_LIBRARY_HASH,
    createdBy: "pm",
    createdAt: "2026-07-10T12:00:00Z",
    updatedAt: "2026-07-10T12:00:00Z",
    contentHash:
      "53ec2f5d8a27617ca1e91b13261bb782b1c02eb6c4049a30528b7fb5f890cd58",
  },
  openui: `root = Stack([title, status, metrics, risks], "l")
title = Heading("Launch Readiness", "1")
status = Callout("Decision", "Proceed after the two blocking risks are owned.", "warning")
metrics = Section("Signals", [adoption, reliability, chart])
adoption = Metric("Pilot adoption", "74%", "Up 11 points week over week", "success")
reliability = Metric("Error budget", "81%", "Healthy but trending down", "info")
chart = BarChart("Readiness by lane", ["Product", "Support", "Security"], [88, 72, 64], "%")
risks = Section("Blocking risks", [riskList])
riskList = List(["Complete the security review", "Publish the support escalation playbook"], true)`,
} satisfies OpenUIRichArtifactDetail;

const meta = {
  title: "Rich Artifacts / OpenUI Renderer",
  component: RichArtifactRenderer,
  parameters: { layout: "padded" },
  args: { detail, surface: "storybook" },
} satisfies Meta<typeof RichArtifactRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ParseFailure: Story = {
  args: {
    detail: {
      ...detail,
      openui: 'root = UnknownComponent("broken")',
    },
  },
};
