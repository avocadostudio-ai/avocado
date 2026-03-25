import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { PasswordGate } from "./components/PasswordGate"
import { LocaleProvider } from "./i18n"
import { installOrchestratorFetchAuthShim } from "./lib/access-auth"
import "./app.css"
import "./styles.css"

installOrchestratorFetchAuthShim()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <PasswordGate>
        <App />
      </PasswordGate>
    </LocaleProvider>
  </StrictMode>
)
