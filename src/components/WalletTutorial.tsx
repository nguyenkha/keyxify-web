import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

interface Step {
  target: string | null;
  titleKey: string;
  descKey: string;
  waitNav?: boolean; // advance when route changes
}

const STEPS: Step[] = [
  { target: '[data-tour="chain-row"]', titleKey: "tutorial.findAddress", descKey: "tutorial.findAddressDesc", waitNav: true },
  { target: '[data-tour="address-section"]', titleKey: "tutorial.yourAddress", descKey: "tutorial.yourAddressDesc" },
  { target: '[data-tour="send-button"]', titleKey: "tutorial.sendCrypto", descKey: "tutorial.sendCryptoDesc" },
  { target: '[data-tour="wc-nav"]', titleKey: "tutorial.connectDapps", descKey: "tutorial.connectDappsDesc" },
  { target: null, titleKey: "tutorial.ready", descKey: "tutorial.readyDesc" },
];

interface Rect { top: number; left: number; width: number; height: number }

function getRect(selector: string): Rect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function WalletTutorial({ onComplete }: { onComplete: () => void }) {
  const { t } = useTranslation();
  const location = useLocation();
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const prevPath = useRef(location.pathname);

  const current = STEPS[step];
  const PAD = 8;

  const reposition = useCallback(() => {
    if (!current.target) { setRect(null); return; }
    setRect(getRect(current.target));
  }, [current.target]);

  useEffect(() => {
    reposition();
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [reposition]);

  // Auto-advance on navigation for waitNav steps
  /* eslint-disable react-hooks/set-state-in-effect -- navigation-driven step advance */
  useEffect(() => {
    if (!current.waitNav) return;
    if (location.pathname !== prevPath.current) {
      prevPath.current = location.pathname;
      setStep((s) => s + 1);
    }
  }, [location.pathname, current.waitNav]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Re-position after route change (DOM may have changed)
  useEffect(() => {
    const timer = setTimeout(reposition, 150);
    return () => clearTimeout(timer);
  }, [location.pathname, reposition]);

  function done() {
    localStorage.setItem("kxi:tutorial-done", "1");
    onComplete();
  }

  function skip() { done(); }
  function next() {
    if (step >= STEPS.length - 1) { done(); return; }
    setStep((s) => s + 1);
  }

  const isLast = step === STEPS.length - 1;
  const highlight = rect ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 } : null;

  // Tooltip position: below highlight, fallback to center
  const tooltipStyle: React.CSSProperties = highlight
    ? {
        position: "fixed",
        top: Math.min(highlight.top + highlight.height + 12, window.innerHeight - 160),
        left: Math.max(8, Math.min(highlight.left, window.innerWidth - 280)),
        width: 264,
      }
    : { position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 264 };

  return createPortal(
    <div className="fixed inset-0 z-[9999] pointer-events-none" aria-modal="true">
      {/* Dark overlay with cutout */}
      {highlight ? (
        <>
          <div className="absolute inset-0 bg-black/60 pointer-events-none"
            style={{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 ${highlight.top}px, ${highlight.left}px ${highlight.top}px, ${highlight.left}px ${highlight.top + highlight.height}px, ${highlight.left + highlight.width}px ${highlight.top + highlight.height}px, ${highlight.left + highlight.width}px ${highlight.top}px, 0 ${highlight.top}px)` }}
          />
          <div className="absolute pointer-events-none rounded-lg ring-2 ring-blue-400/70 ring-offset-0"
            style={{ top: highlight.top, left: highlight.left, width: highlight.width, height: highlight.height }}
          />
        </>
      ) : (
        <div className="absolute inset-0 bg-black/60 pointer-events-none" />
      )}

      {/* Tooltip card */}
      <div style={tooltipStyle} className="bg-surface-secondary border border-border-primary rounded-xl shadow-2xl p-4 pointer-events-auto">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-text-muted">{t("tutorial.stepOf", { current: step + 1, total: STEPS.length })}</span>
          <button onClick={skip} className="text-[10px] text-text-muted hover:text-text-secondary transition-colors">
            {t("tutorial.skip")}
          </button>
        </div>
        <p className="text-sm font-semibold text-text-primary mb-1">{t(current.titleKey)}</p>
        <p className="text-xs text-text-muted leading-relaxed mb-4">{t(current.descKey)}</p>
        {!current.waitNav && (
          <button
            onClick={next}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium py-2 rounded-lg transition-colors"
          >
            {isLast ? t("tutorial.start") : t("tutorial.gotIt")}
          </button>
        )}
        {current.waitNav && (
          <p className="text-[11px] text-blue-400 text-center animate-pulse">{t("tutorial.findAddressDesc")}</p>
        )}
      </div>
    </div>,
    document.body,
  );
}
