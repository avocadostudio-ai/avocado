import { Component, type ErrorInfo, type ReactNode } from "react"

type Props = {
  children: ReactNode
  fallbackLabel?: string
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
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground h-full">
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
