import { useState, useEffect, useRef } from "react";

/**
 * Stepped progress bar hook.
 *
 * - Main step fills 0→90% over `mainDurationMs`.
 * - Each step after main fills its share of the remaining 10% over 1s.
 * - Holds at each step's target until `currentStep` advances.
 * - When `done` is true, animates remaining → 100% over 1s.
 * - Pass `currentStep = -1` to reset (inactive).
 */
export function useSteppedProgress(
  currentStep: number,
  mainStep: number,
  stepsAfterMain: number,
  mainDurationMs: number,
  done: boolean,
): number {
  const [pct, setPct] = useState(0);
  const pctRef = useRef(0);

  useEffect(() => { pctRef.current = pct; }, [pct]);

  // Reset when inactive
  useEffect(() => {
    if (currentStep < 0) {
      setPct(0);
      pctRef.current = 0;
    }
  }, [currentStep]);

  // Animate toward the current step's target
  useEffect(() => {
    if (currentStep < 0) return;

    // Compute target and fill duration
    let target: number;
    let fillMs: number;

    if (done) {
      target = 100;
      fillMs = 1000;
    } else if (currentStep < mainStep) {
      // Pre-main steps: bar stays at 0, no animation
      return;
    } else if (currentStep === mainStep) {
      target = 90;
      fillMs = mainDurationMs;
    } else {
      // Post-main steps: split remaining 9% (90→99) evenly, 1s each
      const idx = currentStep - mainStep; // 1, 2, ...
      const perStep = stepsAfterMain > 0 ? 9 / stepsAfterMain : 9;
      target = Math.min(99, Math.round(90 + idx * perStep));
      fillMs = 1000;
    }

    const startPct = pctRef.current;
    const distance = target - startPct;
    if (distance <= 0) return;
    if (fillMs <= 0) { setPct(target); return; }

    const msPerPct = fillMs / distance;
    const iv = setInterval(() => {
      setPct((p) => {
        if (p >= target) {
          clearInterval(iv);
          return target;
        }
        return p + 1;
      });
    }, msPerPct);
    return () => clearInterval(iv);
  }, [currentStep, done, mainStep, stepsAfterMain, mainDurationMs]);

  return pct;
}

/** Signing: 4s base + 5s per additional signature */
export function signingDurationMs(signatureCount: number): number {
  return 4000 + Math.max(0, signatureCount - 1) * 5000;
}

/** Wallet creation: 8s */
export const CREATING_DURATION_MS = 8000;

/** Shared progress bar visual component */
export function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="w-full max-w-[240px] mx-auto">
      <div className="h-1.5 bg-surface-tertiary rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] text-text-muted text-center mt-1.5">{pct}%</p>
    </div>
  );
}
