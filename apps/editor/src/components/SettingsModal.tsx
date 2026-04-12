import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
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
import { Eraser } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AIProvider, ModelKey } from "@/lib/editor-types"
import { useT, LOCALE_LABELS, type Locale } from "@/i18n"


const MODEL_LABELS: Record<AIProvider, Record<ModelKey, string>> = {
  openai: { fast: "gpt-4o-mini", balanced: "gpt-4o", reasoning: "o1", codex: "o3" },
  anthropic: { fast: "Haiku", balanced: "Sonnet", reasoning: "Sonnet+Thinking", codex: "Opus" },
  gemini: { fast: "Flash 2.5", balanced: "Flash 2.5", reasoning: "Pro 2.5", codex: "Pro 2.5" },
}

const PROVIDER_LABELS: Record<AIProvider, string> = {
  openai: "OpenAI",
  anthropic: "Claude",
  gemini: "Gemini",
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
  agentModeEnabled?: boolean
  /**
   * When true, show developer-only toggles (Streaming, Nested labels, Field
   * draft telemetry, Debug mode) and switch the title to "Developer mode".
   * See resolveDevOptionsEnabled() in lib/defaults.ts.
   */
  showDevOptions?: boolean
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
  agentModeEnabled,
  showDevOptions = false,
}: SettingsModalProps) {
  const { t, locale, setLocale } = useT()
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
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={cn("w-full max-w-none gap-0 p-0 font-sans text-foreground text-sm", chatDarkMode && "editor-dark")} showCloseButton={true}>
        <SheetHeader className="px-5 pt-4 pb-3 border-b border-border">
          <SheetTitle className="text-base font-bold tracking-tight">
            {showDevOptions ? t("settings.devTitle") : t("settings.title")}
          </SheetTitle>
        </SheetHeader>

        <div className="grid gap-5 px-5 py-5">
          <div className="grid gap-1.5 text-left">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{t("settings.language")}</span>
            <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
              <SelectTrigger className="w-full h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={cn("font-sans text-sm", chatDarkMode && "editor-dark")}>
                {(Object.entries(LOCALE_LABELS) as [Locale, string][]).map(([code, label]) => (
                  <SelectItem key={code} value={code}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-0" role="group" aria-label="Settings toggles">
            {showDevOptions ? (
              <ToggleRow label={t("settings.streaming")} checked={useStreaming} onCheckedChange={onStreamingChange} />
            ) : null}
            {showDevOptions ? (
              <ToggleRow label={t("settings.nestedLabels")} checked={showNestedLabels} onCheckedChange={onNestedLabelsChange} />
            ) : null}
            {showDevOptions ? (
              <ToggleRow label={t("settings.fieldDraftTelemetry")} checked={fieldDraftDebugEnabled} onCheckedChange={onFieldDraftDebugChange} />
            ) : null}
            <ToggleRow label={t("settings.darkMode")} checked={chatDarkMode} onCheckedChange={onDarkModeChange} />
            {showDevOptions ? (
              <ToggleRow label={t("settings.debugMode")} checked={showDebugDetails} onCheckedChange={onDebugDetailsChange} />
            ) : null}
          </div>

          <div className="grid gap-1.5 text-left">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{t("settings.model")}</span>
            <Select value={currentValue} onValueChange={handleModelChange}>
              <SelectTrigger className="w-full h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={cn("font-sans text-sm", chatDarkMode && "editor-dark")}>
                {fastItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
                <SelectGroup>
                  <SelectLabel>{t("settings.advanced")}</SelectLabel>
                  {advancedItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5 text-left">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Agent Mode</span>
              <p className="text-[11px] text-muted-foreground">
                {agentModeEnabled
                  ? "Agent mode enabled — uses tools to edit your site directly."
                  : "Set AGENT_API_KEY in the orchestrator .env to enable agent mode."}
              </p>
            </div>

          <Button variant="destructive" size="sm" className="w-full" onClick={handleClearChat}>
            <Eraser className="size-4" />
            {t("settings.clearChat")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
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
    <div className="flex items-center justify-between gap-3 py-3 border-b border-border last:border-0">
      <Label className="text-[14px] font-normal cursor-pointer text-foreground" htmlFor={`toggle-${label}`}>
        {label}
      </Label>
      <Switch id={`toggle-${label}`} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}
