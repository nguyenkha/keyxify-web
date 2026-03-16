import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initTheme } from './lib/theme'
import { initSentry } from './lib/sentry'

initSentry()
initTheme()

declare const __BUILD_TIME__: string;
declare const __GIT_HASH__: string;
declare const __GIT_TAG__: string;
const version = __GIT_TAG__ || (__GIT_HASH__ ? `Build ${__GIT_HASH__}` : "Build dev");
console.log(`${version} — ${__BUILD_TIME__}`);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
