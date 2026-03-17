import { useState, useEffect, useRef } from "react";

// ── Types ──────────────────────────────────────────────────────────

export type ProgressPhase = "idle" | "indeterminate" | "main" | "post" | "done";

export interface ProgressState {
  pct: number;
  phase: ProgressPhase;
  remainingMs: number;
}

// ── Easing ─────────────────────────────────────────────────────────

/** Quadratic ease-out: fast start, slow finish */
function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

// ── Hook ───────────────────────────────────────────────────────────

/**
 * Stepped progress bar hook with ease-out animation.
 *
 * - Pre-main steps: indeterminate shimmer.
 * - Main step fills 2→90% over `mainDurationMs` with ease-out curve.
 * - Each post-main step fills its share of 90→99% over `postStepDurationMs`.
 * - When `done`, animates remaining → 100% over 1s.
 * - Holds at each step's target until `currentStep` advances.
 * - Pass `currentStep = -1` to reset (inactive).
 */
export function useSteppedProgress(
  currentStep: number,
  mainStep: number,
  stepsAfterMain: number,
  mainDurationMs: number,
  done: boolean,
  postStepDurationMs = 1000,
): ProgressState {
  const [state, setState] = useState<ProgressState>({ pct: 0, phase: "idle", remainingMs: 0 });
  const pctRef = useRef(0);

  useEffect(() => {
    // Reset when inactive
    if (currentStep < 0) {
      pctRef.current = 0;
      setState({ pct: 0, phase: "idle", remainingMs: 0 });
      return;
    }

    // Compute target, duration, and phase
    let target: number;
    let fillMs: number;
    let phase: ProgressPhase;

    if (done) {
      target = 100; fillMs = 1000; phase = "done";
    } else if (currentStep < mainStep) {
      // Indeterminate — no fill animation
      const totalRemaining = mainDurationMs + stepsAfterMain * postStepDurationMs;
      setState({ pct: 0, phase: "indeterminate", remainingMs: totalRemaining });
      return;
    } else if (currentStep === mainStep) {
      target = 90; fillMs = mainDurationMs; phase = "main";
    } else {
      const idx = currentStep - mainStep;
      const perStep = stepsAfterMain > 0 ? 9 / stepsAfterMain : 9;
      target = Math.min(99, Math.round(90 + idx * perStep));
      fillMs = postStepDurationMs;
      phase = "post";
    }

    // Start at 2% minimum for main step (avoids "0%" flash)
    let startPct = pctRef.current;
    if (phase === "main" && startPct < 2) {
      startPct = 2;
      pctRef.current = 2;
    }

    const distance = target - startPct;
    if (distance <= 0) {
      setState((prev) => ({ ...prev, phase }));
      return;
    }
    if (fillMs <= 0) {
      pctRef.current = target;
      setState({ pct: target, phase, remainingMs: 0 });
      return;
    }

    // Remaining time for future post-main steps
    const futurePostSteps =
      phase === "main" ? stepsAfterMain :
      phase === "post" ? Math.max(0, stepsAfterMain - (currentStep - mainStep)) : 0;
    const futureMs = futurePostSteps * postStepDurationMs;

    // Animate with ease-out curve (~60fps)
    const startTime = Date.now();
    const iv = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const t = Math.min(1, elapsed / fillMs);
      const eased = easeOutQuad(t);
      const newPct = Math.min(target, Math.round(startPct + distance * eased));
      pctRef.current = newPct;

      const thisStepRemaining = Math.max(0, fillMs - elapsed);
      setState({ pct: newPct, phase, remainingMs: thisStepRemaining + futureMs });

      if (t >= 1) clearInterval(iv);
    }, 16);

    return () => clearInterval(iv);
  }, [currentStep, done, mainStep, stepsAfterMain, mainDurationMs, postStepDurationMs]);

  return state;
}

// ── Constants ──────────────────────────────────────────────────────

/** Signing: 6s base + 5s per additional signature */
export function signingDurationMs(signatureCount: number): number {
  return 6000 + Math.max(0, signatureCount - 1) * 5000;
}

/** Wallet creation: 10s for ECDSA keygen */
export const CREATING_DURATION_MS = 10000;

// ── Component ──────────────────────────────────────────────────────

/** Shared progress bar visual component */
export function ProgressBar({ pct, phase, remainingMs }: ProgressState) {
  const remainingSec = Math.ceil(remainingMs / 1000);

  return (
    <div className="w-full max-w-[240px] mx-auto">
      <div className="h-1.5 bg-surface-tertiary rounded-full overflow-hidden relative">
        {phase === "indeterminate" ? (
          /* Shimmer bar for pre-main steps */
          <div
            className="absolute inset-0 rounded-full overflow-hidden"
          >
            <div
              className="h-full w-2/5 bg-blue-500/40 rounded-full"
              style={{
                animation: "progress-shimmer 1.5s ease-in-out infinite",
              }}
            />
          </div>
        ) : (
          <div
            className="h-full bg-blue-500 rounded-full transition-[width] duration-150 ease-out"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      <p className="text-[10px] text-text-muted text-center mt-1.5">
        {phase === "indeterminate"
          ? "Preparing..."
          : phase === "main"
            ? `${pct}%${remainingSec > 10 ? ` · ~${remainingSec}s` : ""}`
            : phase === "post"
              ? "Almost done..."
              : phase === "done"
                ? "Complete"
                : `${pct}%`}
      </p>

      {/* Keyframes for shimmer animation */}
      <style>{`
        @keyframes progress-shimmer {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(250%); }
          100% { transform: translateX(-100%); }
        }
      `}</style>
    </div>
  );
}
