import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from "react"

type Props = {
  children: ReactNode
  fallbackLabel?: string
  /** Applied to the fallback container — use to control visibility (e.g. display:none for tab panels). */
  style?: CSSProperties
  /** Called before re-rendering children. Use to clear upstream state or call window.location.reload(). */
  onReset?: () => void
  /** Called when a child throws — wire to a telemetry sink if needed. */
  onError?: (error: Error, info: ErrorInfo) => void
}

type State = {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[editor] Uncaught error in component tree:", error, info.componentStack)
    this.props.onError?.(error, info)
  }

  reset = () => {
    this.props.onReset?.()
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      return (
        <div style={this.props.style} className="flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground h-full">
          <p className="font-medium text-foreground">
            {this.props.fallbackLabel ?? "Something went wrong"}
          </p>
          <p className="max-w-xs opacity-70 text-xs">{this.state.error.message}</p>
          <button
            type="button"
            onClick={this.reset}
            className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent transition-colors"
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
