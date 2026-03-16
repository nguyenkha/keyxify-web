import { useState, useEffect } from "react";
import { authHeaders } from "../lib/auth";
import { sensitiveHeaders } from "../lib/passkey";
import { PasskeyChallenge } from "./PasskeyChallenge";
import type { PolicyRuleBody, PolicyVersion } from "../shared/types";
import { useFrozen } from "../context/FrozenContext";
import { apiUrl } from "../lib/apiBase";

type RuleType = PolicyRuleBody["type"];
type RuleEffect = PolicyRuleBody["effect"];

const EMPTY_RULE: PolicyRuleBody = {
  priority: 0,
  type: "transfer",
  effect: "allow",
  asset: null,
  amountMax: null,
  usdMax: null,
  toAddress: null,
  fraudCheck: null,
};

const FRAUD_LEVEL_LABELS: Record<string, string> = {
  high: "High (sanctions & crime)",
  medium: "Medium (+ phishing & laundering)",
  low: "Low (all flags)",
};

function formatCountdown(effectiveAt: string): string {
  const diff = new Date(effectiveAt).getTime() - Date.now();
  if (diff <= 0) return "activating soon…";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `${h}h ${m}m remaining`;
}

export function PolicyRules({
  keyId,
  keyName,
  onClose,
}: {
  keyId: string;
  keyName?: string | null;
  onClose: () => void;
}) {
  const frozen = useFrozen();
  const [active, setActive] = useState<PolicyVersion | null>(null);
  const [pending, setPending] = useState<PolicyVersion | null>(null);
  const [loading, setLoading] = useState(true);

  // Draft editing state
  const [draft, setDraft] = useState<PolicyRuleBody[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [newRule, setNewRule] = useState<PolicyRuleBody>({ ...EMPTY_RULE });

  // Passkey challenge
  const [showPasskey, setShowPasskey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Countdown refresh
  const [, setTick] = useState(0);

  useEffect(() => {
    fetchPolicy();
  }, [keyId]);

  // Refresh countdown every 30s while pending exists
  useEffect(() => {
    if (!pending) return;
    const interval = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(interval);
  }, [pending]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (draft) setDraft(null);
        else onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, draft]);

  async function fetchPolicy() {
    setLoading(true);
    const res = await fetch(apiUrl(`/api/keys/${keyId}/rules`), {
      headers: authHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      setActive(data.active);
      setPending(data.pending);
    }
    setLoading(false);
  }

  function startEditing() {
    const rules = active?.rules ?? [];
    setDraft(rules.map((r, i) => ({ ...r, priority: i })));
    setAdding(false);
    setNewRule({ ...EMPTY_RULE });
  }

  function addRuleToDraft() {
    if (!draft) return;
    setDraft([...draft, { ...newRule, priority: draft.length }]);
    setNewRule({ ...EMPTY_RULE });
    setAdding(false);
  }

  function removeFromDraft(idx: number) {
    if (!draft) return;
    setDraft(draft.filter((_, i) => i !== idx).map((r, i) => ({ ...r, priority: i })));
  }

  function moveDraft(idx: number, direction: "up" | "down") {
    if (!draft) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= draft.length) return;
    const next = [...draft];
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    setDraft(next.map((r, i) => ({ ...r, priority: i })));
  }

  // After passkey auth, submit the draft
  async function submitDraft() {
    if (!draft) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(apiUrl(`/api/keys/${keyId}/rules/pending`), {
        method: "POST",
        headers: sensitiveHeaders(),
        body: JSON.stringify({ rules: draft }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to submit policy changes");
        setSubmitting(false);
        return;
      }
      setDraft(null);
      await fetchPolicy();
    } catch (err) {
      setError(String(err));
    }
    setSubmitting(false);
  }

  async function cancelPending() {
    setError("");
    try {
      const res = await fetch(apiUrl(`/api/keys/${keyId}/rules/pending`), {
        method: "DELETE",
        headers: sensitiveHeaders(),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to cancel");
        return;
      }
      await fetchPolicy();
    } catch (err) {
      setError(String(err));
    }
  }

  const effectColor = (effect: string) =>
    effect === "allow"
      ? "text-green-400 bg-green-500/10"
      : "text-red-400 bg-red-500/10";

  function renderRuleRow(rule: PolicyRuleBody, idx: number, opts?: {
    editable?: boolean;
    total?: number;
  }) {
    return (
      <div
        key={idx}
        className="flex items-center gap-2 px-3 py-2.5 bg-surface-primary rounded-lg border border-border-secondary"
      >
        <span className="text-[10px] text-text-muted w-5 text-center shrink-0">
          {rule.priority}
        </span>

        <span
          className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${effectColor(rule.effect)} shrink-0`}
        >
          {rule.effect.toUpperCase()}
        </span>

        <div className="flex-1 min-w-0 text-xs text-text-secondary">
          {rule.type === "raw_message" ? (
            <span>Raw message signing</span>
          ) : rule.type === "contract_call" ? (
            <span>
              Contract call
              {rule.toAddress ? (
                <span className="text-text-muted font-mono text-[10px]">
                  {" "}contract={rule.toAddress.slice(0, 10)}…
                </span>
              ) : (
                <span className="text-text-muted"> (any contract)</span>
              )}
              {rule.fraudCheck && (
                <span className="text-orange-400 text-[10px]"> fraud={rule.fraudCheck}</span>
              )}
            </span>
          ) : (
            <span>
              Transfer
              {rule.asset && <span className="text-text-muted"> asset={rule.asset}</span>}
              {rule.amountMax && <span className="text-text-muted"> max={rule.amountMax}</span>}
              {rule.usdMax && <span className="text-text-muted"> usd_max=${rule.usdMax}</span>}
              {rule.toAddress && (
                <span className="text-text-muted font-mono text-[10px]">
                  {" "}to={rule.toAddress.slice(0, 10)}…
                </span>
              )}
              {rule.fraudCheck && (
                <span className="text-orange-400 text-[10px]"> fraud={rule.fraudCheck}</span>
              )}
            </span>
          )}
        </div>

        {opts?.editable && (
          <>
            <div className="flex flex-col shrink-0">
              <button
                onClick={() => moveDraft(idx, "up")}
                disabled={idx === 0}
                className="text-text-muted hover:text-text-secondary disabled:opacity-20 p-0.5"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                </svg>
              </button>
              <button
                onClick={() => moveDraft(idx, "down")}
                disabled={idx === (opts.total ?? 0) - 1}
                className="text-text-muted hover:text-text-secondary disabled:opacity-20 p-0.5"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>

            <button
              onClick={() => removeFromDraft(idx)}
              className="text-text-muted hover:text-red-400 p-1 shrink-0 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </>
        )}
      </div>
    );
  }

  function renderAddForm() {
    return (
      <div className="bg-surface-primary rounded-lg border border-blue-500/30 p-3 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-text-muted block mb-1">Type</label>
            <select
              value={newRule.type}
              onChange={(e) => setNewRule({ ...newRule, type: e.target.value as RuleType })}
              className="w-full bg-surface-secondary border border-border-primary rounded px-2 py-1.5 text-xs text-text-primary"
            >
              <option value="transfer">Transfer</option>
              <option value="contract_call">Contract Call</option>
              <option value="raw_message">Raw Message</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] text-text-muted block mb-1">Effect</label>
            <select
              value={newRule.effect}
              onChange={(e) => setNewRule({ ...newRule, effect: e.target.value as RuleEffect })}
              className="w-full bg-surface-secondary border border-border-primary rounded px-2 py-1.5 text-xs text-text-primary"
            >
              <option value="allow">Allow</option>
              <option value="block">Block</option>
            </select>
          </div>
        </div>

        {newRule.type === "transfer" && (
          <div className="space-y-2">
            <div>
              <label className="text-[10px] text-text-muted block mb-1">
                Asset <span className="text-text-muted/50">(symbol or * for any)</span>
              </label>
              <input
                value={newRule.asset || ""}
                onChange={(e) => setNewRule({ ...newRule, asset: e.target.value || null })}
                placeholder="ETH, USDC, *, ..."
                className="w-full bg-surface-secondary border border-border-primary rounded px-2 py-1.5 text-xs text-text-primary"
              />
            </div>
            <div>
              <label className="text-[10px] text-text-muted block mb-1">
                Max Amount <span className="text-text-muted/50">(leave empty for unlimited)</span>
              </label>
              <input
                value={newRule.amountMax || ""}
                onChange={(e) => setNewRule({ ...newRule, amountMax: e.target.value || null })}
                placeholder="1.0"
                className="w-full bg-surface-secondary border border-border-primary rounded px-2 py-1.5 text-xs text-text-primary"
              />
            </div>
            <div>
              <label className="text-[10px] text-text-muted block mb-1">
                Max USD Value <span className="text-text-muted/50">(leave empty for unlimited)</span>
              </label>
              <input
                value={newRule.usdMax || ""}
                onChange={(e) => setNewRule({ ...newRule, usdMax: e.target.value || null })}
                placeholder="100"
                className="w-full bg-surface-secondary border border-border-primary rounded px-2 py-1.5 text-xs text-text-primary"
              />
            </div>
            <div>
              <label className="text-[10px] text-text-muted block mb-1">
                To Address <span className="text-text-muted/50">(or * for any)</span>
              </label>
              <input
                value={newRule.toAddress || ""}
                onChange={(e) => setNewRule({ ...newRule, toAddress: e.target.value || null })}
                placeholder="0x..."
                className="w-full bg-surface-secondary border border-border-primary rounded px-2 py-1.5 text-xs text-text-primary font-mono"
              />
            </div>
            <div>
              <label className="text-[10px] text-text-muted block mb-1">
                Fraud Check <span className="text-text-muted/50">(block flagged addresses)</span>
              </label>
              <select
                value={newRule.fraudCheck || ""}
                onChange={(e) => setNewRule({ ...newRule, fraudCheck: (e.target.value || null) as PolicyRuleBody["fraudCheck"] })}
                className="w-full bg-surface-secondary border border-border-primary rounded px-2 py-1.5 text-xs text-text-primary"
              >
                <option value="">Disabled</option>
                <option value="high">{FRAUD_LEVEL_LABELS.high}</option>
                <option value="medium">{FRAUD_LEVEL_LABELS.medium}</option>
                <option value="low">{FRAUD_LEVEL_LABELS.low}</option>
              </select>
            </div>
          </div>
        )}

        {newRule.type === "contract_call" && (
          <div className="space-y-2">
            <div>
              <label className="text-[10px] text-text-muted block mb-1">
                Contract Address <span className="text-text-muted/50">(leave empty for any)</span>
              </label>
              <input
                value={newRule.toAddress || ""}
                onChange={(e) => setNewRule({ ...newRule, toAddress: e.target.value || null })}
                placeholder="0x..."
                className="w-full bg-surface-secondary border border-border-primary rounded px-2 py-1.5 text-xs text-text-primary font-mono"
              />
            </div>
            <div>
              <label className="text-[10px] text-text-muted block mb-1">
                Fraud Check <span className="text-text-muted/50">(block flagged contracts)</span>
              </label>
              <select
                value={newRule.fraudCheck || ""}
                onChange={(e) => setNewRule({ ...newRule, fraudCheck: (e.target.value || null) as PolicyRuleBody["fraudCheck"] })}
                className="w-full bg-surface-secondary border border-border-primary rounded px-2 py-1.5 text-xs text-text-primary"
              >
                <option value="">Disabled</option>
                <option value="high">{FRAUD_LEVEL_LABELS.high}</option>
                <option value="medium">{FRAUD_LEVEL_LABELS.medium}</option>
                <option value="low">{FRAUD_LEVEL_LABELS.low}</option>
              </select>
            </div>
          </div>
        )}

        {newRule.amountMax && !newRule.asset && (
          <p className="text-[10px] text-red-400">Asset is required when max amount is set</p>
        )}
        <div className="flex gap-2">
          <button
            onClick={addRuleToDraft}
            disabled={!!(newRule.amountMax && !newRule.asset)}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs px-3 py-1.5 rounded transition-colors"
          >
            Add Rule
          </button>
          <button
            onClick={() => setAdding(false)}
            className="text-text-tertiary hover:text-text-secondary text-xs px-3 py-1.5 rounded hover:bg-surface-tertiary transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Passkey challenge overlay ──
  if (showPasskey) {
    return (
      <PasskeyChallenge
        onAuthenticated={() => {
          setShowPasskey(false);
          submitDraft();
        }}
        onCancel={() => setShowPasskey(false)}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface-secondary border border-border-primary rounded-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-primary">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              {draft ? "Edit Policy" : "Policy Rules"}
            </h3>
            <p className="text-[11px] text-text-muted mt-0.5">
              {keyName || `Account ${keyId.slice(0, 8)}`}
              {draft ? " — editing draft" : " — first match wins"}
            </p>
          </div>
          <button
            onClick={() => { if (draft) setDraft(null); else onClose(); }}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-tertiary transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {loading ? (
            <div className="text-xs text-text-muted text-center py-8">Loading…</div>
          ) : draft ? (
            // ── Draft editing mode ──
            <>
              {draft.length === 0 ? (
                <div className="text-center py-4">
                  <p className="text-xs text-text-muted">No rules — all signing blocked by default</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {draft.map((rule, idx) =>
                    renderRuleRow(rule, idx, { editable: true, total: draft.length }),
                  )}
                </div>
              )}

              {adding ? renderAddForm() : (
                <button
                  onClick={() => setAdding(true)}
                  className="w-full text-xs text-blue-400 hover:text-blue-300 py-2 rounded-lg border border-dashed border-border-secondary hover:border-blue-500/30 transition-colors"
                >
                  + Add Rule
                </button>
              )}
            </>
          ) : (
            // ── View mode ──
            <>
              {/* Pending version banner */}
              {pending && pending.effectiveAt && (
                <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2.5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-yellow-400">Pending policy change</p>
                      <p className="text-[10px] text-yellow-400/70 mt-0.5">
                        Activates in {formatCountdown(pending.effectiveAt)}
                      </p>
                    </div>
                    {!frozen && (
                      <button
                        onClick={cancelPending}
                        className="text-[10px] text-yellow-400 hover:text-yellow-300 px-2 py-1 rounded bg-yellow-500/10 hover:bg-yellow-500/20 transition-colors"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {(pending.rules as PolicyRuleBody[]).map((rule, idx) =>
                      renderRuleRow(rule, idx),
                    )}
                  </div>
                </div>
              )}

              {/* Active rules */}
              {active ? (
                <div className="space-y-2">
                  <p className="text-[10px] text-text-muted uppercase tracking-wide">Active rules</p>
                  {(active.rules as PolicyRuleBody[]).length === 0 ? (
                    <p className="text-xs text-text-muted text-center py-4">No rules — all signing blocked</p>
                  ) : (
                    (active.rules as PolicyRuleBody[]).map((rule, idx) =>
                      renderRuleRow(rule, idx),
                    )
                  )}
                </div>
              ) : (
                <div className="text-center py-8">
                  <p className="text-xs text-text-muted">No policy configured</p>
                  <p className="text-[10px] text-text-muted/60 mt-1">
                    Without rules, all signing requests are blocked by default
                  </p>
                </div>
              )}
            </>
          )}

          {error && (
            <p className="text-[10px] text-red-400 text-center">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border-primary flex items-center justify-between">
          <p className="text-[10px] text-text-muted leading-relaxed max-w-[60%]">
            {draft
              ? "Requires passkey. Takes effect after 24h."
              : "First match wins. No match = blocked."}
          </p>

          {draft ? (
            <div className="flex gap-2">
              <button
                onClick={() => setDraft(null)}
                className="text-text-tertiary hover:text-text-secondary text-xs px-3 py-1.5 rounded hover:bg-surface-tertiary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => setShowPasskey(true)}
                disabled={submitting || frozen}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs px-4 py-1.5 rounded transition-colors"
              >
                {submitting ? "Submitting…" : "Submit"}
              </button>
            </div>
          ) : !pending && !frozen ? (
            <button
              onClick={startEditing}
              className="text-blue-400 hover:text-blue-300 text-xs px-3 py-1.5 rounded hover:bg-blue-500/10 transition-colors"
            >
              Edit Policy
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
