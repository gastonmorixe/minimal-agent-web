import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"

import { ThemeProvider } from "@/components/theme-provider.tsx"

import { App } from "./App.tsx"
import { initToken } from "./api/token.ts"

const root = document.getElementById("root")
if (root === null) throw new Error("index.html has no #root element")

// Read the API token from the URL fragment before anything renders or fetches.
initToken()

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
)
