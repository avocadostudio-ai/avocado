import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("Tabs", {
  schema: z.object({
    title: z.string().optional(),
    tabs: z.array(z.object({
      label: z.string().min(1),
      content: z.string().min(1),
    })).min(1),
  }),
  meta: {
    displayName: "Tabs",
    description: "Switchable tabbed content panels with rich text in each tab.",
    category: "content",
    fields: { title: f.text("Section title"), headingLevel: f.headingLevel() },
    listFields: {
      tabs: {
        label: "Tabs",
        itemFields: {
          label: f.text("Tab label"),
          content: f.richtext("Tab content"),
        }
      }
    }
  }
})

export function tabsDefaultProps(): Record<string, unknown> {
  return {
    tabs: [
      { label: "Overview", content: "This is the overview tab with **general information** about the topic.\n\nKey highlights:\n\n- Easy to get started\n- Works across all devices\n- Built for teams of any size" },
      { label: "Features", content: "## Core Features\n\n- **Real-time collaboration** — edit together with your team\n- **Version history** — roll back to any previous state\n- **API access** — integrate with your existing tools\n\nAll features are included in every plan." },
      { label: "Pricing", content: "View our flexible pricing plans designed for teams of all sizes.\n\n1. **Starter** — Free for up to 3 users\n2. **Pro** — $12/user/month\n3. **Enterprise** — Custom pricing" },
      { label: "Integrations", content: "Connect with the tools you already use:\n\n- Slack\n- GitHub\n- Jira\n- Figma\n- Google Workspace" },
      { label: "Support", content: "Get help from our team:\n\n- **Live chat** — available 9am–6pm ET\n- **Email** — support@example.com\n- **Community forum** — [Visit the forum](https://example.com)" },
    ],
  }
}
