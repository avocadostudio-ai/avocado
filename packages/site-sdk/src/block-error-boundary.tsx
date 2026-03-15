"use client"

import { Component, type ReactNode } from "react"

type Props = { blockId: string; blockType: string; children: ReactNode }
type State = { error: Error | null }

export class BlockErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <section
          style={{
            padding: "2rem",
            margin: "1rem 0",
            background: "#fef2f2",
            border: "1px solid #fee2e2",
            borderRadius: "0.5rem",
            color: "#991b1b",
            fontSize: "0.875rem"
          }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>
            Failed to render {this.props.blockType} block
          </p>
          <p style={{ margin: "0.5rem 0 0", color: "#b91c1c", fontFamily: "monospace", fontSize: "0.75rem" }}>
            {this.state.error.message}
          </p>
        </section>
      )
    }
    return this.props.children
  }
}
