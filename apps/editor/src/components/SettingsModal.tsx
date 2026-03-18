import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { AIProvider, ModelKey } from "@/lib/editor-types"

const MODEL_LABELS: Record<AIProvider, Record<ModelKey, string>> = {
  openai: { fast: "gpt-4o-mini", balanced: "gpt-4o", reasoning: "o1", codex: "o3" },
  anthropic: { fast: "Haiku", balanced: "Sonnet", reasoning: "Sonnet+Thinking", codex: "Opus" },
}

const PROVIDER_LABELS: Record<AIProvider, string> = {
  openai: "OpenAI",
  anthropic: "Claude",
}

function selectionValue(provider: AIProvider, model: ModelKey) {
  return `${provider}:${model}`
}

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  useStreaming: boolean
  onStreamingChange: (value: boolean) => void
  showNestedLabels: boolean
  onNestedLabelsChange: (value: boolean) => void
  chatDarkMode: boolean
  onDarkModeChange: (value: boolean) => void
  showDebugDetails: boolean
  onDebugDetailsChange: (value: boolean) => void
  fieldDraftDebugEnabled: boolean
  onFieldDraftDebugChange: (value: boolean) => void
  provider: AIProvider
  modelKey: ModelKey
  availableProviders: AIProvider[]
  onModelChange: (provider: AIProvider, model: ModelKey) => void
  onClearChat: () => void
}

export function SettingsModal({
  open,
  onOpenChange,
  useStreaming,
  onStreamingChange,
  showNestedLabels,
  onNestedLabelsChange,
  chatDarkMode,
  onDarkModeChange,
  showDebugDetails,
  onDebugDetailsChange,
  fieldDraftDebugEnabled,
  onFieldDraftDebugChange,
  provider,
  modelKey,
  availableProviders,
  onModelChange,
  onClearChat,
}: SettingsModalProps) {
  const currentValue = selectionValue(provider, modelKey)

  const handleModelChange = (value: string) => {
    const [nextProvider, nextModel] = value.split(":") as [AIProvider, ModelKey]
    onModelChange(nextProvider, nextModel)
  }

  const handleClearChat = () => {
    onClearChat()
    onOpenChange(false)
  }

  const providers = availableProviders.length > 0 ? availableProviders : [provider]
  const fastItems = providers.map((p) => ({
    value: selectionValue(p, "fast"),
    label: `${PROVIDER_LABELS[p]} ${MODEL_LABELS[p].fast}`,
  }))
  const advancedItems = providers.flatMap((p) =>
    (Object.keys(MODEL_LABELS[p]) as ModelKey[])
      .filter((m) => m !== "fast")
      .map((m) => ({
        value: selectionValue(p, m),
        label: `${PROVIDER_LABELS[p]} ${MODEL_LABELS[p][m]}`,
      }))
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-w-[340px] gap-0 rounded-2xl p-0 font-sans text-foreground text-sm", chatDarkMode && "editor-dark")} showCloseButton={true}>
        <DialogHeader className="px-4 pt-3.5 pb-2.5 border-b border-border">
          <DialogTitle className="text-base font-bold tracking-tight">Developer mode</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 px-4 py-3">
          <div className="grid gap-1" role="group" aria-label="Developer toggles">
            <ToggleRow label="Streaming" checked={useStreaming} onCheckedChange={onStreamingChange} />
            <ToggleRow label="Nested labels" checked={showNestedLabels} onCheckedChange={onNestedLabelsChange} />
            <ToggleRow label="Dark mode" checked={chatDarkMode} onCheckedChange={onDarkModeChange} />
            <ToggleRow label="Debug mode" checked={showDebugDetails} onCheckedChange={onDebugDetailsChange} />
            <ToggleRow label="Field draft telemetry" checked={fieldDraftDebugEnabled} onCheckedChange={onFieldDraftDebugChange} />
          </div>

          <div className="grid gap-1.5 text-left">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Model</span>
            <Select value={currentValue} onValueChange={handleModelChange}>
              <SelectTrigger className="w-full h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={cn("font-sans text-sm", chatDarkMode && "editor-dark")}>
                {fastItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
                <SelectGroup>
                  <SelectLabel>Advanced</SelectLabel>
                  {advancedItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <Button variant="destructive" size="sm" className="w-full" onClick={handleClearChat}>
            Clear chat
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ToggleRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string
  checked: boolean
  onCheckedChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-secondary/60 px-3 py-2">
      <Label className="text-[13px] font-medium cursor-pointer text-foreground" htmlFor={`toggle-${label}`}>
        {label}
      </Label>
      <Switch id={`toggle-${label}`} size="sm" checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}
