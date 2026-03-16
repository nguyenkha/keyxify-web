import { useState, useEffect } from "react";
import { getMpcInstance, createHttpTransport, clientKeys, toBase64, toHex, NID_secp256k1, NID_ED25519 } from "../lib/mpc";
import type { ClientKeyHandles } from "../lib/mpc";
import { sensitiveHeaders, authenticatePasskey } from "../lib/passkey";
import { encryptKeyFile, type KeyFileData } from "../lib/crypto";
import { PassphraseInput } from "./PassphraseInput";
import {
  saveKeyShareWithPrf,
  saveKeyShareWithPassphrase,
  setStoragePreference,
} from "../lib/keystore";
import { apiUrl } from "../lib/apiBase";
import { useExpertMode, useSetExpertMode } from "../context/ExpertModeContext";
import { getMe } from "../lib/auth";
import { getUserOverrides, setUserOverrides } from "../lib/userOverrides";

type CreateStep = "welcome" | "name" | "creating" | "passphrase" | "backup";

const TIPS = [
  "You are responsible for your own key share. Keep your downloaded file safe.",
  "Losing your passkey, passphrase, or clearing browser data makes local copies unrecoverable.",
  "Your key share is split between your device and the server — neither side can sign alone.",
  "Your downloaded key file is your primary backup. Store it somewhere secure.",
  "Key shares stored in the browser are encrypted and never leave this device.",
];

function RollingTips() {
  const [index, setIndex] = useState(0);
  const [fade, setFade] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setIndex((i) => (i + 1) % TIPS.length);
        setFade(true);
      }, 300);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    <p
      className={`text-[11px] text-text-muted text-center leading-relaxed transition-opacity duration-300 min-h-[2rem] flex items-center justify-center ${fade ? "opacity-100" : "opacity-0"}`}
    >
      {TIPS[index]}
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
  const [browserSaveState, setBrowserSaveState] = useState<"idle" | "saving" | "passphrase" | "saved" | "error">("idle");
  const [browserSaveError, setBrowserSaveError] = useState("");
  const [escrowStatus, setEscrowStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");

  const canClose = step === "welcome" || step === "name" || step === "passphrase" || (step === "backup" && downloaded);

  function chooseMode(isExpert: boolean) {
    // Save preference
    getMe().then((me) => {
      const overrides = getUserOverrides(me?.id);
      const prefs = { ...overrides.preferences, expert_mode: isExpert || undefined };
      setUserOverrides({ ...overrides, preferences: Object.keys(prefs).length ? prefs : undefined }, me?.id);
    });
    setExpertContext(isExpert);
    setStep("name");
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && canClose) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canClose, onClose]);

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
      setProgress("Generating ECDSA key...");

      const keyName = name.trim() || `Account ${keyCount + 1}`;
      const mpc = await getMpcInstance();
      const headers = sensitiveHeaders();
      const PARTY_NAMES: [string, string] = ["client", "server"];

      // ── Phase 1: ECDSA key generation ──
      const { transport: ecdsaTransport, getServerResult: getEcdsaResult } = createHttpTransport({
        initUrl: apiUrl("/api/generate/init"),
        stepUrl: apiUrl("/api/generate/step"),
        initExtra: { name: keyName },
        headers,
      });

      const ecdsaKey = await mpc.ecdsa2pDkg(ecdsaTransport, 0, PARTY_NAMES, NID_secp256k1);
      const ecdsaResult = getEcdsaResult();
      if (!ecdsaResult?.id) throw new Error("Account creation did not complete");

      const keyId = ecdsaResult.id as string;
      const ecdsaInfo = mpc.ecdsa2pKeyInfo(ecdsaKey);

      // ── Phase 2: EdDSA key generation ──
      setProgress("Generating EdDSA key...");

      const { transport: eddsaTransport, getServerResult: getEddsaServerResult } = createHttpTransport({
        initUrl: apiUrl("/api/generate/eddsa-init"),
        stepUrl: apiUrl("/api/generate/eddsa-step"),
        initExtra: { keyId },
        headers,
      });

      const eddsaKey = await mpc.ecKey2pDkg(eddsaTransport, 0, PARTY_NAMES, NID_ED25519);
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

      setRawKeyData({
        id: keyId,
        peer: 0,
        share: ecdsaSerialized.map((buf: Uint8Array) => toBase64(buf)).join(","),
        publicKey: toHex(ecdsaInfo.publicKey),
        eddsaShare: eddsaSerialized.map((buf: Uint8Array) => toBase64(buf)).join(","),
        eddsaPublicKey: toHex(eddsaInfo.publicKey),
      });
      setStep("passphrase");
    } catch (err) {
      console.error("[generate] Error:", err);
      setError(err instanceof Error ? err.message : String(err));
      setStep("name");
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
            {step === "welcome" ? "👋 Welcome" : step === "backup" ? "🔐 Backup Key" : "✨ New Account"}
          </h3>
          {canClose && (
            <button
              onClick={step === "backup" && downloaded ? () => { onCreated(); onClose(); } : onClose}
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
              <div className="text-center">
                <p className="text-sm text-text-primary">How would you like to use kexify?</p>
                <p className="text-xs text-text-muted mt-1.5 leading-relaxed">
                  This helps us set the right defaults for you. You can always change this later in Config.
                </p>
              </div>

              <div className="space-y-3">
                <button
                  onClick={() => chooseMode(false)}
                  className="w-full bg-surface-primary border border-border-primary hover:border-blue-500/30 rounded-xl px-4 py-4 text-left transition-colors group"
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
                  className="w-full bg-surface-primary border border-border-primary hover:border-border-secondary rounded-xl px-4 py-4 text-left transition-colors group"
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
                      { key: "transfer", label: "Transfers", desc: "Send tokens to other addresses" },
                      { key: "contract_call", label: "Contract calls", desc: "Interact with smart contracts and dApps" },
                      { key: "raw_message", label: "Message signing", desc: "Sign messages (personal_sign, signTypedData)" },
                    ].map((rule) => (
                      <label key={rule.key} className="flex items-start gap-2.5 cursor-pointer">
                        <input
                          type="checkbox"
                          defaultChecked={rule.key !== "raw_message"}
                          className="mt-0.5 accent-blue-500"
                          data-rule={rule.key}
                        />
                        <div>
                          <span className="text-xs text-text-primary font-medium">{rule.label}</span>
                          <p className="text-[10px] text-text-muted">{rule.desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                  <p className="text-[10px] text-text-muted mt-2">
                    Fraud check (Strict) is enabled by default on all rules. You can adjust after creation in Policy Rules.
                  </p>
                </div>
              )}

              {/* Non-expert: safe defaults note */}
              {!expert && isFirstAccount && (
                <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
                  <p className="text-[11px] text-green-400 leading-relaxed">
                    Your account will be protected with fraud detection and safe default rules. You can customize these anytime in Policy Rules.
                  </p>
                </div>
              )}

              {error && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  <p className="text-xs text-red-400">{error}</p>
                </div>
              )}

              <button
                onClick={create}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
              >
                ✨ Create Account
              </button>
            </div>
          )}

          {/* Step: Creating */}
          {step === "creating" && (
            <div className="py-6 space-y-5">
              <div className="flex justify-center">
                <div className="w-10 h-10 relative">
                  <div className="absolute inset-0 rounded-full border-2 border-surface-tertiary" />
                  <div className="absolute inset-0 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                </div>
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-text-secondary">{progress}</p>
              </div>
              {/* Progress steps */}
              <div className="space-y-2 max-w-[220px] mx-auto">
                {[
                  { label: "ECDSA key", match: "ECDSA" },
                  { label: "EdDSA key", match: "EdDSA" },
                  { label: "Save securely", match: "Saving" },
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
              <RollingTips />
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
                  <div className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
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
                onClick={() => { onCreated(); onClose(); }}
                disabled={!downloaded}
                className={`w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  downloaded
                    ? "bg-blue-600 hover:bg-blue-700 text-white"
                    : "bg-surface-tertiary text-text-muted cursor-not-allowed"
                }`}
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
