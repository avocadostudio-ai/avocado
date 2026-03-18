import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { PasswordGate } from "./components/PasswordGate"
import "./app.css"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PasswordGate>
      <App />
    </PasswordGate>
  </StrictMode>
)
