import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initTheme } from './lib/theme'

initTheme()

const buildHash = (import.meta.env.VITE_GIT_HASH as string | undefined)?.slice(0, 7) ?? "dev";
console.log(`Build ${buildHash} — ${new Date().toISOString()}`);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
