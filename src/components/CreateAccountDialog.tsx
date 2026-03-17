import { useState, useEffect } from "react";
import { Spinner, ErrorBox } from "./ui";
import { getMpcInstance, createHttpTransport, clientKeys, toBase64, toHex, NID_secp256k1, NID_ED25519 } from "../lib/mpc";
import type { ClientKeyHandles } from "../lib/mpc";
import { sensitiveHeaders, authenticatePasskey, fetchPasskeys, isWithinPasskeyGrace } from "../lib/passkey";
import { PasskeyChallenge } from "./PasskeyChallenge";
import { isRecoveryMode } from "../lib/recovery";
import { encryptKeyFile, type KeyFileData } from "../lib/crypto";
import { PassphraseInput } from "./PassphraseInput";
import { PasskeyGate } from "./PasskeyGate";
import {
  saveKeyShareWithPrf,
  saveKeyShareWithPassphrase,
  setStoragePreference,
} from "../lib/keystore";
import { apiUrl } from "../lib/apiBase";
import { useExpertMode, useSetExpertMode } from "../context/ExpertModeContext";
import { getMe } from "../lib/auth";
import { getUserOverrides, setUserOverrides } from "../lib/userOverrides";
import { useSteppedProgress, CREATING_DURATION_MS, ProgressBar } from "./ProgressBar";

type CreateStep = "welcome" | "passkey" | "name" | "creating" | "passphrase" | "backup" | "done";

const EXPERT_TIPS = [
  "You are responsible for your own key share. Keep your downloaded file safe.",
  "Losing your passkey, passphrase, or clearing browser data makes local copies unrecoverable.",
  "Your key share is split between your device and the server — neither side can sign alone.",
  "Your downloaded key file is your primary backup. Store it somewhere secure.",
  "Key shares stored in the browser are encrypted and never leave this device.",
];

const SIMPLE_TIPS = [
  "Your wallet key is being split into two halves — one stays on your device, the other on our server.",
  "Neither half works alone, so your funds stay safe even if one side is compromised.",
  "This uses the same cryptography that secures billions of dollars in institutional wallets.",
  "After setup, you'll get a backup file. Keep it safe — it's your recovery lifeline.",
  "Transactions require both halves to agree, so no one can move your funds without you.",
];

function CreatingProgressBar({ currentStep, done }: { currentStep: number; done: boolean }) {
  // Steps: ECDSA(0) → EdDSA(1) → Save(2). Main step = 0 (ECDSA keygen, 90%).
  const progress = useSteppedProgress(currentStep, 0, 2, CREATING_DURATION_MS, done, 2000);
  return <ProgressBar {...progress} />;
}

function RollingTips({ expert }: { expert: boolean }) {
  const tips = expert ? EXPERT_TIPS : SIMPLE_TIPS;
  const [index, setIndex] = useState(0);
  const [fade, setFade] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setIndex((i) => (i + 1) % tips.length);
        setFade(true);
      }, 300);
    }, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <p
      className={`text-[11px] text-text-muted text-center leading-relaxed transition-opacity duration-300 min-h-[2rem] flex items-center justify-center ${fade ? "opacity-100" : "opacity-0"}`}
    >
      {tips[index]}
    </p>
  );
}

export function CreateAccountDialog({
  keyCount,
  onClose,
  onCreated,
}: {
  keyCount: number;
  onClose: () => void;
  onCreated: () => void;
}) {
  const expert = useExpertMode();
  const setExpertContext = useSetExpertMode();
  const isFirstAccount = keyCount === 0;
  const [step, setStep] = useState<CreateStep>(isFirstAccount ? "welcome" : "name");
  const [name, setName] = useState("");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [rawKeyData, setRawKeyData] = useState<KeyFileData | null>(null);
  const [keyFile, setKeyFile] = useState<{ blob: Blob; fileName: string } | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [creatingDone, setCreatingDone] = useState(false);

  // Preload MPC WASM library as soon as dialog opens
  useEffect(() => { getMpcInstance().catch(() => {}); }, []);
  const [browserSaveState, setBrowserSaveState] = useState<"idle" | "saving" | "passphrase" | "saved" | "error">("idle");
  const [browserSaveError, setBrowserSaveError] = useState("");
  const [escrowStatus, setEscrowStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");

  const [selectedRules, setSelectedRules] = useState<Record<string, boolean>>({
    transfer: true,
    contract_call: true,
    personal_sign: true,
    typed_message: true,
    raw_message: false,
  });

  // Passkey guard before creating
  const [showPasskeyChallenge, setShowPasskeyChallenge] = useState(false);

  const canClose = step === "welcome" || step === "passkey" || step === "name" || step === "passphrase" || step === "done" || (step === "backup" && downloaded) || (step === "creating" && !!error);

  async function chooseMode(isExpert: boolean) {
    // Save preference
    getMe().then((me) => {
      const overrides = getUserOverrides(me?.id);
      const prefs = { ...overrides.preferences, expert_mode: isExpert || undefined };
      setUserOverrides({ ...overrides, preferences: Object.keys(prefs).length ? prefs : undefined }, me?.id);
    });
    setExpertContext(isExpert);

    // Auto-name first account — skip name step
    if (isFirstAccount) {
      setName("My Wallet");
    }

    // Check if user has passkeys — if not, show inline passkey setup as next step
    try {
      const passkeys = await fetchPasskeys();
      if (passkeys.length === 0) {
        setStep("passkey");
        return;
      }
    } catch { /* proceed anyway */ }

    // First account: skip name step, go straight to creating
    if (isFirstAccount) {
      guardedCreate();
      return;
    }
    setStep("name");
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && canClose) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canClose, onClose]);

  function guardedCreate() {
    if (isRecoveryMode()) { create(); return; }
    if (isWithinPasskeyGrace()) { create(); return; }
    setShowPasskeyChallenge(true);
  }

  async function create() {
    setError("");

    try {
      // Pre-flight: check key share limit before starting MPC
      const { authHeaders } = await import("../lib/auth");
      const checkRes = await fetch(apiUrl("/api/keys"), { headers: authHeaders() });
      if (checkRes.ok) {
        const { keys } = await checkRes.json();
        if (Array.isArray(keys) && keys.length >= 3) {
          throw new Error("Maximum 3 accounts. Delete an existing account to create a new one.");
        }
      }

      setStep("creating");
      setCreatingDone(false);
      setProgress(expert ? "Generating ECDSA key..." : "Setting up encryption...");

      const keyName = name.trim() || `Account ${keyCount + 1}`;
      const mpc = await getMpcInstance();
      const headers = sensitiveHeaders();
      const PARTY_NAMES: [string, string] = ["client", "server"];

      // ── Phase 1: ECDSA key generation ──
      // Build policy rules from expert selection (or use server defaults for non-expert)
      const policyRules = expert ? (() => {
        const rules: { priority: number; type: string; effect: string; fraudCheck?: string }[] = [];
        let p = 0;
        if (selectedRules.transfer) rules.push({ priority: p++, type: "transfer", effect: "allow", fraudCheck: "medium" });
        if (selectedRules.contract_call) rules.push({ priority: p++, type: "contract_call", effect: "allow", fraudCheck: "medium" });
        if (selectedRules.personal_sign) rules.push({ priority: p++, type: "personal_sign", effect: "allow" });
        if (selectedRules.typed_message) rules.push({ priority: p++, type: "typed_message", effect: "allow" });
        if (selectedRules.raw_message) rules.push({ priority: p++, type: "raw_message", effect: "allow" });
        return rules;
      })() : undefined;

      const { transport: ecdsaTransport, getServerResult: getEcdsaResult, transportFailed: ecdsaFailed } = createHttpTransport({
        initUrl: apiUrl("/api/generate/init"),
        stepUrl: apiUrl("/api/generate/step"),
        initExtra: { name: keyName, ...(policyRules ? { policyRules } : {}) },
        headers,
      });

      const ecdsaKey = await Promise.race([
        mpc.ecdsa2pDkg(ecdsaTransport, 0, PARTY_NAMES, NID_secp256k1),
        ecdsaFailed,
      ]);
      const ecdsaResult = getEcdsaResult();
      if (!ecdsaResult?.id) throw new Error("Account creation did not complete");

      const keyId = ecdsaResult.id as string;
      const ecdsaInfo = mpc.ecdsa2pKeyInfo(ecdsaKey);

      // ── Phase 2: EdDSA key generation ──
      setProgress(expert ? "Generating EdDSA key..." : "Securing your account...");

      const { transport: eddsaTransport, getServerResult: getEddsaServerResult, transportFailed: eddsaFailed } = createHttpTransport({
        initUrl: apiUrl("/api/generate/eddsa-init"),
        stepUrl: apiUrl("/api/generate/eddsa-step"),
        initExtra: { keyId },
        headers,
      });

      const eddsaKey = await Promise.race([
        mpc.ecKey2pDkg(eddsaTransport, 0, PARTY_NAMES, NID_ED25519),
        eddsaFailed,
      ]);
      const eddsaInfo = mpc.ecKey2pInfo(eddsaKey);
      const party0PubKey = toHex(eddsaInfo.publicKey);

      // Only correct the DB if party-0's pubkey differs from what the server stored (party-1's key).
      const serverEddsaPubKey = getEddsaServerResult()?.eddsaPublicKey as string | undefined;
      if (serverEddsaPubKey && serverEddsaPubKey !== party0PubKey) {
        fetch(apiUrl("/api/generate/eddsa-pubkey-correction"), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ keyId, eddsaPublicKey: party0PubKey }),
        }).catch(() => {});
      }

      // Store key handles in memory for signing
      const entry: ClientKeyHandles = { mpc, ecdsa: ecdsaKey, eddsa: eddsaKey };
      clientKeys.set(keyId, entry);

      // ── Phase 3: Serialize handles for key file backup ──
      const ecdsaSerialized = mpc.serializeEcdsa2p(ecdsaKey);
      const eddsaSerialized = mpc.serializeEcKey2p(eddsaKey);

      const newRawKeyData: KeyFileData = {
        id: keyId,
        peer: 0,
        share: ecdsaSerialized.map((buf: Uint8Array) => toBase64(buf)).join(","),
        publicKey: toHex(ecdsaInfo.publicKey),
        eddsaShare: eddsaSerialized.map((buf: Uint8Array) => toBase64(buf)).join(","),
        eddsaPublicKey: toHex(eddsaInfo.publicKey),
      };
      setRawKeyData(newRawKeyData);

      if (!expert) {
        // Non-expert: auto-save to browser + server escrow, skip passphrase/download
        setProgress("Saving securely...");

        // Re-authenticate passkey (token from keygen may have expired during MPC rounds)
        let freshAuth: { prfKey?: CryptoKey; credentialId?: string } | null = null;
        try {
          freshAuth = await authenticatePasskey({ withPrf: true });
        } catch { /* passkey auth failed — will skip browser save, try escrow with existing token */ }

        // Browser save with passkey PRF
        if (freshAuth?.prfKey && freshAuth?.credentialId) {
          try {
            await saveKeyShareWithPrf(keyId, newRawKeyData, freshAuth.prfKey, freshAuth.credentialId);
            setStoragePreference("browser");
            setBrowserSaveState("saved");
          } catch { /* browser save failed */ }
        }

        setCreatingDone(true);
        await new Promise((r) => setTimeout(r, 1100));

        // First account: skip passphrase/backup — go directly to done
        if (isFirstAccount) {
          setStep("done");
          return;
        }
        setStep("passphrase");
      } else {
        setCreatingDone(true);
        await new Promise((r) => setTimeout(r, 1100));
        setStep("passphrase");
      }
    } catch (err) {
      console.error("[generate] Error:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "passkey_auth_required") {
        setError("Passkey authentication required. Please try again.");
      } else {
        setError(msg);
      }
    }
  }

  function downloadKey() {
    if (!keyFile) return;
    const url = URL.createObjectURL(keyFile.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = keyFile.fileName;
    a.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={canClose ? onClose : undefined} />

      <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
          <h3 className="text-sm font-semibold text-text-primary">
            {step === "welcome" ? "Welcome" : step === "passkey" ? "Security Setup" : step === "backup" ? "Backup Key" : step === "done" ? "You're all set" : "New Account"}
          </h3>
          {canClose && (
            <button
              onClick={step === "done" ? () => { onCreated(); onClose(); } : step === "backup" && downloaded ? () => { onCreated(); onClose(); } : onClose}
              className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-tertiary transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-5">

          {step === "welcome" && (
            <div className="space-y-5">
              {isFirstAccount ? (
                /* Simplified first-account welcome — no mode selector */
                <div className="space-y-4 py-2">
                  <div className="text-center mb-2">
                    <div className="w-14 h-14 rounded-full bg-blue-500/10 flex items-center justify-center mx-auto mb-4">
                      <svg className="w-7 h-7 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
                      </svg>
                    </div>
                    <p className="text-sm font-medium text-text-primary">Let's create your wallet</p>
                    <p className="text-xs text-text-muted mt-1 leading-relaxed max-w-[260px] mx-auto">
                      Your keys are split between this device and our server — neither side can sign alone.
                    </p>
                  </div>
                  <button
                    onClick={() => chooseMode(false)}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
                  >
                    Get Started
                  </button>
                </div>
              ) : (
                /* Full mode selector for subsequent accounts */
                <>
                  <div className="text-center">
                    <p className="text-sm text-text-primary">How would you like to use kexify?</p>
                    <p className="text-xs text-text-muted mt-1.5 leading-relaxed">
                      This helps us set the right defaults for you. You can always change this later in Config.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <button
                      onClick={() => chooseMode(false)}
                      className="w-full bg-surface-primary border border-border-primary hover:border-blue-500/30 rounded-lg px-4 py-4 text-left transition-colors group"
                    >
                      <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0 mt-0.5">
                          <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                          </svg>
                        </div>
                        <div>
                          <p className="text-sm font-medium text-text-primary group-hover:text-blue-400 transition-colors">Simple & Safe</p>
                          <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
                            Best for most users. Clean interface with fraud protection enabled by default.
                            Advanced options are hidden to keep things simple.
                          </p>
                        </div>
                      </div>
                    </button>

                    <button
                      onClick={() => chooseMode(true)}
                      className="w-full bg-surface-primary border border-border-primary hover:border-border-secondary rounded-lg px-4 py-4 text-left transition-colors group"
                    >
                      <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-full bg-surface-tertiary flex items-center justify-center shrink-0 mt-0.5">
                          <svg className="w-5 h-5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                          </svg>
                        </div>
                        <div>
                          <p className="text-sm font-medium text-text-primary group-hover:text-text-secondary transition-colors">Expert Mode</p>
                          <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
                            For developers and power users. Shows gas controls, nonce, raw transaction data,
                            detailed logs, and full key share management.
                          </p>
                        </div>
                      </div>
                    </button>
                  </div>

                  <p className="text-[10px] text-text-muted text-center leading-relaxed">
                    Both modes include fraud protection and policy rules by default.
                  </p>
                </>
              )}
            </div>
          )}

          {/* Step: Passkey (integrated into creation flow for first-time users) */}
          {step === "passkey" && (
            <div className="space-y-4">
              <PasskeyGate
                inline
                onRegistered={() => {
                  if (isFirstAccount) {
                    guardedCreate();
                  } else {
                    setStep("name");
                  }
                }}
                onCancel={() => {
                  if (isFirstAccount) {
                    guardedCreate();
                  } else {
                    setStep("name");
                  }
                }}
              />
              {isFirstAccount && (
                <p className="text-[10px] text-text-muted text-center">
                  You'll need a passkey before sending crypto
                </p>
              )}
            </div>
          )}

          {/* Step: Name */}
          {step === "name" && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-text-tertiary mb-1.5">Account name</label>
                <input
                  autoFocus
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && create()}
                  placeholder={`Account ${keyCount + 1}`}
                  className="w-full bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-blue-500 transition-colors"
                />
              </div>

              {/* Expert: default policy rules */}
              {expert && (
                <div>
                  <label className="block text-xs text-text-tertiary mb-1.5">Default policy rules</label>
                  <div className="space-y-2">
                    {[
                      { key: "transfer", label: "Transfers", desc: "Allow sending tokens to other addresses. Includes strict fraud detection to block risky recipients." },
                      { key: "contract_call", label: "Contract calls", desc: "Allow interacting with smart contracts and dApps. Includes strict fraud detection to block flagged contracts." },
                      { key: "personal_sign", label: "Personal sign (EIP-191)", desc: "Allow signing login messages and off-chain signatures via personal_sign." },
                      { key: "typed_message", label: "Typed data (EIP-712)", desc: "Allow signing structured data like permits, orders, and dApp approvals via signTypedData." },
                      { key: "raw_message", label: "Raw message (catch-all)", desc: "Allow signing arbitrary raw messages. Disabled by default — only enable if you know what you're doing." },
                    ].map((rule) => {
                      const selected = selectedRules[rule.key];
                      return (
                        <button
                          key={rule.key}
                          type="button"
                          onClick={() => setSelectedRules((s) => ({ ...s, [rule.key]: !s[rule.key] }))}
                          className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                            selected
                              ? "bg-blue-500/10 border-blue-500/30"
                              : "bg-surface-primary border-border-secondary hover:border-border-primary"
                          }`}
                          data-rule={rule.key}
                        >
                          <span className={`text-xs font-medium ${selected ? "text-blue-400" : "text-text-primary"}`}>{rule.label}</span>
                          <p className="text-[10px] text-text-muted leading-relaxed mt-0.5">{rule.desc}</p>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-text-muted mt-2">
                    Fraud check (Strict) is enabled by default. These rules take effect immediately.
                    Future changes to policy rules require a 24-hour cooling period.
                  </p>
                </div>
              )}

              {/* Non-expert: safe defaults note */}
              {!expert && (
                <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2.5 space-y-1.5">
                  <p className="text-[11px] text-green-400 font-medium">Protected by default</p>
                  <div className="text-[11px] text-green-400/70 leading-relaxed space-y-0.5">
                    <p>Transfers and dApps — allowed, with fraud detection</p>
                    <p>Message signing — allowed for logins and approvals</p>
                    <p>Raw signing — blocked unless you enable it</p>
                  </div>
                  <p className="text-[10px] text-green-400/50">Customize anytime in Policy Rules.</p>
                </div>
              )}

              {error && <ErrorBox>{error}</ErrorBox>}

              <button
                onClick={guardedCreate}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
              >
                ✨ Create Account
              </button>
            </div>
          )}

          {/* Step: Creating */}
          {step === "creating" && (
            <div className="py-6 space-y-5">
              {error ? (
                /* Error during creation */
                <div className="text-center py-4">
                  <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
                    <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium text-text-primary mb-1">Creation Failed</p>
                  <p className="text-xs text-red-400 break-all mb-5 px-4">{error}</p>
                  <div className="flex gap-3 justify-center">
                    <button
                      onClick={onClose}
                      className="px-4 py-2 rounded-lg text-xs font-medium bg-surface-tertiary text-text-secondary hover:bg-border-primary transition-colors"
                    >
                      Close
                    </button>
                    <button
                      onClick={() => { setError(""); guardedCreate(); }}
                      className="px-4 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                    >
                      Try Again
                    </button>
                  </div>
                </div>
              ) : (
                /* Progress state */
                <>
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium text-text-secondary">{progress}</p>
                    {!expert && (
                      <p className="text-[11px] text-text-muted mt-1">This usually takes 10–20 seconds</p>
                    )}
                  </div>
                  {/* Smooth progress bar */}
                  <CreatingProgressBar
                    currentStep={progress.includes("Saving") ? 2 : progress.includes("EdDSA") || progress.includes("Securing") ? 1 : 0}
                    done={creatingDone}
                  />
                  {/* Progress steps */}
                  <div className="space-y-2 max-w-[220px] mx-auto">
                    {[
                      ...(expert
                        ? [
                            { label: "ECDSA key", match: "ECDSA" },
                            { label: "EdDSA key", match: "EdDSA" },
                            { label: "Save securely", match: "Saving" },
                          ]
                        : [
                            { label: "Setting up encryption", match: "ECDSA" },
                            { label: "Securing your account", match: "EdDSA" },
                            { label: "Saving", match: "Saving" },
                          ]),
                    ].map(({ label, match }) => {
                      const isCurrent = progress.includes(match);
                      const isDone = progress.includes(match)
                        ? false
                        : (match === "ECDSA" && (progress.includes("EdDSA") || progress.includes("Saving")))
                          || (match === "EdDSA" && progress.includes("Saving"));
                      return (
                        <div key={match} className="flex items-center gap-2.5">
                          {isDone ? (
                            <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          ) : isCurrent ? (
                            <div className="w-4 h-4 shrink-0 flex items-center justify-center">
                              <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                            </div>
                          ) : (
                            <div className="w-4 h-4 shrink-0 flex items-center justify-center">
                              <div className="w-1.5 h-1.5 rounded-full bg-surface-tertiary" />
                            </div>
                          )}
                          <span className={`text-xs ${isDone ? "text-text-tertiary" : isCurrent ? "text-text-primary font-medium" : "text-text-muted"}`}>
                            {label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {/* Rolling tips */}
                  <RollingTips expert={expert} />
                </>
              )}
            </div>
          )}

          {/* Step: Passphrase */}
          {step === "passphrase" && rawKeyData && (
            <div className="space-y-4">
              <PassphraseInput
                mode="set"
                submitLabel="Encrypt & Continue"
                onSubmit={async (passphrase) => {
                  const encrypted = await encryptKeyFile(rawKeyData, passphrase);
                  const encryptedJson = JSON.stringify(encrypted, null, 2);
                  const blob = new Blob([encryptedJson], { type: "application/json" });
                  const safeName = (name.trim() || `Account ${keyCount + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "-");
                  setKeyFile({ blob, fileName: `kexify-${safeName}-${rawKeyData.id.slice(0, 8)}.json` });
                  setStep("backup");
                }}
              />
            </div>
          )}

          {/* Step: Backup */}
          {step === "backup" && (
            <div className="space-y-4">
              {!downloaded && (
                <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
                  <p className="text-[11px] text-yellow-500">
                    You need this file to sign transactions. Keep it in a safe place — you are responsible for your own key share.
                  </p>
                </div>
              )}

              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-green-500/10 flex items-center justify-center shrink-0">
                  <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
                <p className="text-sm text-text-secondary">
                  {downloaded ? "Account created successfully." : "Account created. Download your key file to continue."}
                </p>
              </div>

              <button
                onClick={downloadKey}
                className="w-full bg-surface-primary border border-border-primary hover:border-border-secondary rounded-lg px-4 py-3 flex items-center gap-3 transition-colors group"
              >
                <div className="w-9 h-9 rounded-lg bg-surface-tertiary flex items-center justify-center shrink-0">
                  <svg className="w-4.5 h-4.5 text-text-tertiary group-hover:text-text-secondary transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                </div>
                <div className="text-left flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary">{keyFile?.fileName}</p>
                  <p className="text-[11px] text-text-muted">Your key share file</p>
                </div>
                {downloaded && (
                  <svg className="w-5 h-5 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
              </button>

              {/* Server escrow option */}
              {escrowStatus === "idle" && downloaded && (
                <button
                  onClick={async () => {
                    if (!rawKeyData || !keyFile) return;
                    setEscrowStatus("uploading");
                    try {
                      const headers = sensitiveHeaders();
                      const encryptedJson = await keyFile.blob.text();
                      await fetch(apiUrl(`/api/keys/${rawKeyData.id}/backup`), {
                        method: "POST",
                        headers: { ...headers, "Content-Type": "application/json" },
                        body: JSON.stringify({
                          encryptedData: encryptedJson,
                          publicKey: rawKeyData.publicKey,
                          eddsaPublicKey: rawKeyData.eddsaPublicKey,
                        }),
                      });
                      setEscrowStatus("done");
                    } catch {
                      setEscrowStatus("error");
                    }
                  }}
                  className="w-full bg-surface-primary border border-border-primary hover:border-border-secondary rounded-lg px-4 py-3 flex items-center gap-3 transition-colors group"
                >
                  <div className="w-9 h-9 rounded-lg bg-surface-tertiary flex items-center justify-center shrink-0">
                    <svg className="w-4.5 h-4.5 text-text-tertiary group-hover:text-text-secondary transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
                    </svg>
                  </div>
                  <div className="text-left flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary">Save backup to server</p>
                    <p className="text-[11px] text-text-muted">Encrypted copy for recovery if you lose your file</p>
                  </div>
                </button>
              )}
              {escrowStatus === "uploading" && (
                <div className="flex items-center gap-2 px-1">
                  <Spinner size="xs" />
                  <p className="text-[11px] text-text-muted">Uploading server backup...</p>
                </div>
              )}
              {escrowStatus === "done" && (
                <div className="flex items-center gap-2.5 px-1">
                  <div className="w-5 h-5 rounded-full bg-green-500/10 flex items-center justify-center shrink-0">
                    <svg className="w-3 h-3 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  </div>
                  <p className="text-[11px] text-text-secondary">Server backup saved</p>
                </div>
              )}
              {escrowStatus === "error" && (
                <div className="flex items-center gap-2 px-1">
                  <svg className="w-3.5 h-3.5 text-yellow-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                  <p className="text-[11px] text-yellow-400">Server backup failed — your downloaded file is your only backup</p>
                </div>
              )}

              {/* Save to browser option — shown after download */}
              {downloaded && browserSaveState !== "saved" && (
                <div className="border border-border-primary rounded-lg p-3 space-y-3">
                  {browserSaveState === "passphrase" ? (
                    <>
                      <p className="text-xs text-text-secondary">
                        Your browser doesn't support passkey encryption. Set a passphrase to encrypt the browser copy.
                      </p>
                      <PassphraseInput
                        mode="set"
                        submitLabel="Save to Browser"
                        onSubmit={async (passphrase) => {
                          if (!rawKeyData) return;
                          setBrowserSaveState("saving");
                          try {
                            await saveKeyShareWithPassphrase(rawKeyData.id, rawKeyData, passphrase);
                            setStoragePreference("browser");
                            setBrowserSaveState("saved");
                          } catch (err) {
                            setBrowserSaveError(String(err));
                            setBrowserSaveState("error");
                          }
                        }}
                      />
                    </>
                  ) : browserSaveState === "error" ? (
                    <div className="text-center">
                      <p className="text-xs text-red-400 mb-2">{browserSaveError}</p>
                      <button
                        onClick={() => setBrowserSaveState("idle")}
                        className="text-xs text-blue-400 hover:text-blue-300"
                      >
                        Try again
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-start gap-2">
                        <svg className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a9 9 0 11-18 0V5.25" />
                        </svg>
                        <div>
                          <p className="text-xs text-text-secondary">
                            Also save to this browser for quick signing without uploading a file.
                          </p>
                          <p className="text-[11px] text-yellow-500/70 mt-1">
                            Losing your passkey, forgetting your passphrase, or clearing browser data will make this copy unrecoverable.
                            Always keep your downloaded file safe as your primary backup.
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={async () => {
                          if (!rawKeyData) return;
                          setBrowserSaveState("saving");
                          setBrowserSaveError("");
                          try {
                            const result = await authenticatePasskey({ withPrf: true });
                            if (result.prfKey && result.credentialId) {
                              await saveKeyShareWithPrf(rawKeyData.id, rawKeyData, result.prfKey, result.credentialId);
                              setStoragePreference("browser");
                              setBrowserSaveState("saved");
                            } else {
                              // PRF not supported — fall back to passphrase
                              setBrowserSaveState("passphrase");
                            }
                          } catch (err) {
                            setBrowserSaveError(String(err));
                            setBrowserSaveState("error");
                          }
                        }}
                        disabled={browserSaveState === "saving"}
                        className="w-full px-3 py-2 rounded-lg text-xs font-medium bg-surface-tertiary hover:bg-border-primary text-text-secondary transition-colors disabled:opacity-50"
                      >
                        {browserSaveState === "saving" ? "Saving..." : "Save to Browser"}
                      </button>
                    </>
                  )}
                </div>
              )}

              {browserSaveState === "saved" && (
                <div className="flex items-center gap-2.5 px-1">
                  <div className="w-5 h-5 rounded-full bg-green-500/10 flex items-center justify-center shrink-0">
                    <svg className="w-3 h-3 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  </div>
                  <p className="text-[11px] text-text-secondary">Key share saved to browser</p>
                </div>
              )}

              <button
                onClick={() => {
                  if (!expert) {
                    setStep("done");
                  } else {
                    onCreated(); onClose();
                  }
                }}
                disabled={!downloaded}
                className={`w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  downloaded
                    ? "bg-blue-600 hover:bg-blue-700 text-white"
                    : "bg-surface-tertiary text-text-muted cursor-not-allowed"
                }`}
              >
                {expert ? "Done" : "Continue"}
              </button>
            </div>
          )}
          {/* Step: Done — simplified for first account, "What's next?" for subsequent */}
          {step === "done" && isFirstAccount && (
            <div className="text-center py-4">
              <div className="w-14 h-14 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </div>
              <p className="text-sm font-medium text-text-primary mb-1">Your wallet is ready</p>
              <p className="text-xs text-text-muted mb-6">You can receive crypto right away</p>
              <button
                onClick={() => { onCreated(); onClose(); }}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
              >
                Go to Wallet
              </button>
              <p className="text-[10px] text-text-muted mt-3">
                Back up your wallet in Settings to protect against device loss
              </p>
            </div>
          )}
          {/* Step: Done — "What's next?" for non-expert subsequent accounts */}
          {step === "done" && !isFirstAccount && (
            <div className="space-y-5">
              <div className="text-center">
                <div className="w-14 h-14 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-7 h-7 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-text-primary mb-1">Your wallet is ready</p>
                <p className="text-xs text-text-muted leading-relaxed">
                  Your key file is downloaded and{browserSaveState === "saved" ? " saved in this browser" : " ready to use"}.
                </p>
              </div>

              {/* What's next */}
              <div className="space-y-2.5 text-left">
                <p className="text-[11px] text-text-tertiary font-medium uppercase tracking-wider">What's next</p>

                <div className="bg-surface-primary border border-border-primary rounded-lg px-3.5 py-3 flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0 mt-0.5">
                    <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-text-primary">Fund your wallet</p>
                    <p className="text-[11px] text-text-muted leading-relaxed mt-0.5">
                      Send crypto from an exchange or another wallet to your new address. Tap any chain on the next screen to see your receive address.
                    </p>
                  </div>
                </div>

                <div className="bg-surface-primary border border-border-primary rounded-lg px-3.5 py-3 flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-purple-500/10 flex items-center justify-center shrink-0 mt-0.5">
                    <svg className="w-4 h-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.556a4.5 4.5 0 00-1.242-7.244l4.5-4.5a4.5 4.5 0 016.364 6.364L16.243 8.65" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-text-primary">Connect to dApps</p>
                    <p className="text-[11px] text-text-muted leading-relaxed mt-0.5">
                      Use WalletConnect to interact with DeFi apps, NFT marketplaces, and more.
                    </p>
                  </div>
                </div>
              </div>

              {/* Reminder to keep file safe */}
              <div className="bg-green-500/5 border border-green-500/15 rounded-lg px-3.5 py-2.5 flex items-start gap-2.5 text-left">
                <svg className="w-4 h-4 text-green-500/70 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                </svg>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-green-500/80 leading-relaxed">
                    Keep your downloaded key file and passphrase safe. You can also back up to the server via Backup & Recovery.
                  </p>
                </div>
              </div>

              <button
                onClick={() => { onCreated(); onClose(); }}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
              >
                Go to My Wallet
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Passkey challenge overlay — triggered when token expired before creating */}
      {showPasskeyChallenge && (
        <PasskeyChallenge
          onAuthenticated={() => { setShowPasskeyChallenge(false); create(); }}
          onCancel={() => setShowPasskeyChallenge(false)}
          withPrf={false}
          autoStart
        />
      )}
    </div>
  );
}
