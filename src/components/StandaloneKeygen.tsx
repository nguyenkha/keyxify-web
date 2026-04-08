// Standalone keygen wizard — creates a key without email/user account
// Flow: Turnstile → Name → MPC Keygen → Passphrase → Passkey → Backup → Done

import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useExpertMode } from "../context/ExpertModeContext";
import { getMpcInstance, createHttpTransport, clientKeys, toBase64, toHex, NID_secp256k1, NID_ED25519 } from "../lib/mpc";
import type { ClientKeyHandles } from "../lib/mpc";
import { encryptKeyFile, decryptKeyFile, isEncryptedKeyFile, type KeyFileData } from "../lib/crypto";
import { saveKeyShareWithPassphrase, saveKeyShareWithPrf } from "../lib/keystore";
import { fetchPasskeys, authenticatePasskey } from "../lib/passkey";
import { setToken } from "../lib/auth";
import { authPublicKeyHex, performShareAuth } from "../lib/share-auth";
import { apiUrl } from "../lib/apiBase";
import { Spinner, ErrorBox } from "./ui";
import { PassphraseInput } from "./PassphraseInput";
import { PasskeyGate } from "./PasskeyGate";
import { useSteppedProgress, CREATING_DURATION_MS, ProgressBar } from "./ProgressBar";
import { getStandaloneShares, deleteKeyShare } from "../lib/keystore";
import { StandaloneUnlock } from "./StandaloneUnlock";
import { LangSwitcher } from "./LangSwitcher";
import { getStoredTheme, setTheme } from "../lib/theme";
import { Link } from "react-router-dom";

type Step = "hub" | "import" | "name" | "creating" | "passphrase" | "passkey" | "backup" | "done";

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

function CreatingProgressBar({ currentStep, done }: { currentStep: number; done: boolean }) {
  const progress = useSteppedProgress(currentStep, 0, 2, CREATING_DURATION_MS, done, 2000);
  return <ProgressBar {...progress} />;
}

const TIP_KEYS = ["standalone.tip1", "standalone.tip2", "standalone.tip3", "standalone.tip4", "standalone.tip5"];

function RollingTips() {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [fade, setFade] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setIndex((i) => (i + 1) % TIP_KEYS.length);
        setFade(true);
      }, 300);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    <p className={`text-[11px] text-text-muted text-center leading-relaxed transition-opacity duration-300 min-h-[2rem] flex items-center justify-center ${fade ? "opacity-100" : "opacity-0"}`}>
      {t(TIP_KEYS[index])}
    </p>
  );
}

export function StandaloneKeygen() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const expert = useExpertMode();
  const [standaloneShares, setStandaloneShares] = useState(() => getStandaloneShares());
  const [unlockKeyId, setUnlockKeyId] = useState<string | null>(null);
  const [deleteKeyId, setDeleteKeyId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("hub");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [rawKeyData, setRawKeyData] = useState<KeyFileData | null>(null);
  const [keyFile, setKeyFile] = useState<{ blob: Blob; fileName: string } | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [creatingStep, setCreatingStep] = useState(0);
  const [creatingDone, setCreatingDone] = useState(false);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const [importFileData, setImportFileData] = useState<KeyFileData | null>(null);
  const [importLoading, setImportLoading] = useState(false);

  // Preload MPC WASM
  useEffect(() => { getMpcInstance().catch(() => {}); }, []);

  // Warn on page leave during keygen/passphrase/passkey/backup steps
  useEffect(() => {
    const inProgress = step === "creating" || step === "passphrase" || step === "passkey" || step === "backup";
    if (!inProgress) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [step]);

  // Load Turnstile
  const renderTurnstile = useCallback(() => {
    if (!TURNSTILE_SITE_KEY || !turnstileRef.current) return;
    const w = window as unknown as { turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string; remove: (id: string) => void } };
    if (!w.turnstile) return;
    if (widgetIdRef.current) w.turnstile.remove(widgetIdRef.current);
    widgetIdRef.current = w.turnstile.render(turnstileRef.current, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: "dark",
      callback: (token: string) => setCaptchaToken(token),
      "expired-callback": () => setCaptchaToken(null),
    });
  }, []);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || step !== "name") return;
    if (document.querySelector('script[src*="turnstile"]')) {
      renderTurnstile();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = renderTurnstile;
    document.head.appendChild(script);
  }, [renderTurnstile, step]);

  async function startKeygen() {
    setError("");
    setStep("creating");
    setCreatingDone(false);
    setCreatingStep(0);
    setProgress("Setting up encryption...");

    try {
      // Default name set after keygen completes (need keyShareId for short ID)
      const keyName = name.trim();
      const mpc = await getMpcInstance();
      const PARTY_NAMES: [string, string] = ["client", "server"];

      // Phase 1: ECDSA keygen (no auth — standalone-init)
      const { transport: ecdsaTransport, getSessionId: getEcdsaSessionId, getServerResult: getEcdsaResult, transportFailed: ecdsaFailed } = createHttpTransport({
        initUrl: apiUrl("/api/generate/standalone-init"),
        stepUrl: apiUrl("/api/generate/step"),
        initExtra: { name: keyName || undefined, captchaToken },
        headers: { }, // no auth
      });

      const ecdsaMpcPromise = mpc.ecdsa2pDkg(ecdsaTransport, 0, PARTY_NAMES, NID_secp256k1);
      const ecdsaKey = await Promise.race([ecdsaMpcPromise, ecdsaFailed]);
      const ecdsaKeyInfo = mpc.ecdsa2pKeyInfo(ecdsaKey);
      const ecdsaSerialized = mpc.serializeEcdsa2p(ecdsaKey);
      const ecdsaShareData = ecdsaSerialized.map((buf: Uint8Array) => toBase64(buf)).join(",");

      const ecdsaResult = getEcdsaResult();
      const newKeyId = ecdsaResult?.id as string;

      // Register auth public key → get JWT
      const authPubKey = authPublicKeyHex(ecdsaShareData);
      const registerRes = await fetch(apiUrl("/api/generate/register-auth"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: getEcdsaSessionId(),
          authPublicKey: authPubKey,
        }),
      });
      if (!registerRes.ok) {
        const data = await registerRes.json().catch(() => null);
        throw new Error((data?.error as string) || "Failed to register auth key");
      }
      const registerData = await registerRes.json();
      setToken(registerData.token);

      const jwtHeaders = { Authorization: `Bearer ${registerData.token}` };

      // Set default name with short keyshare ID if user didn't provide one
      const finalName = keyName || `Anonymous ${registerData.keyShareId.slice(0, 6)}`;
      fetch(apiUrl(`/api/keys/${newKeyId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...jwtHeaders },
        body: JSON.stringify({ name: finalName }),
      }).catch(() => {});

      setCreatingStep(1);
      setProgress("Securing your account...");

      // Phase 2: EdDSA keygen (now authenticated with standalone JWT)
      const { transport: eddsaTransport, transportFailed: eddsaFailed } = createHttpTransport({
        initUrl: apiUrl("/api/generate/eddsa-init"),
        stepUrl: apiUrl("/api/generate/eddsa-step"),
        initExtra: { keyId: newKeyId },
        headers: jwtHeaders,
      });

      const eddsaKey = await Promise.race([
        mpc.ecKey2pDkg(eddsaTransport, 0, PARTY_NAMES, NID_ED25519),
        eddsaFailed,
      ]);
      const eddsaKeyInfo = mpc.ecKey2pInfo(eddsaKey);
      const eddsaSerialized = mpc.serializeEcKey2p(eddsaKey);
      const eddsaShareData = eddsaSerialized.map((buf: Uint8Array) => toBase64(buf)).join(",");

      // Correct EdDSA public key (party-0 view)
      const eddsaPubHex = toHex(eddsaKeyInfo.publicKey);
      await fetch(apiUrl("/api/generate/eddsa-pubkey-correction"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jwtHeaders },
        body: JSON.stringify({ keyId: newKeyId, eddsaPublicKey: eddsaPubHex }),
      });

      // Cache key handles
      const entry: ClientKeyHandles = { mpc, ecdsa: ecdsaKey, eddsa: eddsaKey };
      clientKeys.set(newKeyId, entry);

      setCreatingStep(2);
      setProgress("Saving...");

      // Build key file data
      const keyData: KeyFileData = {
        id: newKeyId,
        peer: 1,
        share: ecdsaShareData,
        publicKey: toHex(ecdsaKeyInfo.publicKey),
        eddsaShare: eddsaShareData,
        eddsaPublicKey: eddsaPubHex,
        type: "standalone",
      };
      setRawKeyData(keyData);

      // Prepare encrypted backup file
      setCreatingDone(true);
      setStep("passphrase");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handlePassphrase(passphrase: string) {
    if (!rawKeyData) return;
    setError("");

    try {
      // Save to localStorage with passphrase encryption
      await saveKeyShareWithPassphrase(rawKeyData.id, rawKeyData, passphrase, "standalone");

      // Prepare encrypted backup file for download
      const encrypted = await encryptKeyFile(rawKeyData, passphrase);
      const fileData = { ...encrypted, type: "standalone" as const };
      const blob = new Blob([JSON.stringify(fileData, null, 2)], { type: "application/json" });
      const fileName = `kexify-${(name.trim() || "anonymous").toLowerCase().replace(/\s+/g, "-")}-${rawKeyData.id.slice(0, 8)}.json`;
      setKeyFile({ blob, fileName });

      setStep("passkey");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handlePasskeyComplete() {
    // No PRF key available — share stays passphrase-encrypted
    // If importing, go to dashboard; if creating, go to backup
    if (importFileData) {
      navigate("/", { replace: true });
    } else {
      setStep("backup");
    }
  }

  async function handlePasskeyWithPrf(prfKey: CryptoKey, credentialId: string) {
    // Re-encrypt share with PRF so signing uses passkey tap instead of passphrase
    if (rawKeyData) {
      try {
        await saveKeyShareWithPrf(rawKeyData.id, rawKeyData, prfKey, credentialId, "standalone");
      } catch { /* PRF save failed — passphrase encryption remains */ }
    }
    if (importFileData) {
      navigate("/", { replace: true });
    } else {
      setStep("backup");
    }
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string) as KeyFileData;
        if (!data.share || !data.publicKey) throw new Error("Invalid key file");
        setImportFileData(data);
        setStep("import");
        setError("");
      } catch {
        setError(t("standalone.invalidFile"));
      }
    };
    reader.readAsText(file);
    e.target.value = ""; // reset for re-select
  }

  async function handleImportPassphrase(passphrase: string) {
    if (!importFileData) return;
    setImportLoading(true);
    setError("");

    try {
      // Decrypt if encrypted
      let keyData = importFileData;
      if (isEncryptedKeyFile(importFileData)) {
        keyData = await decryptKeyFile(importFileData, passphrase);
      }

      // Perform share-auth → JWT
      await performShareAuth(keyData.share);

      // Save to localStorage with passphrase (will be re-encrypted with PRF after passkey)
      await saveKeyShareWithPassphrase(keyData.id, keyData, passphrase, "standalone");

      // Store for PRF re-encryption
      setRawKeyData(keyData);

      // Check if passkeys already exist (e.g. synced via iCloud)
      try {
        const existing = await fetchPasskeys();
        if (existing.length > 0) {
          // Passkey already registered — authenticate for PRF and save
          try {
            const auth = await authenticatePasskey({ withPrf: true });
            if (auth.prfKey && auth.credentialId) {
              await saveKeyShareWithPrf(keyData.id, keyData, auth.prfKey, auth.credentialId, "standalone");
            }
          } catch { /* PRF failed — passphrase stays */ }
          navigate("/", { replace: true });
          return;
        }
      } catch { /* can't check — proceed to registration */ }

      setStep("passkey");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportLoading(false);
    }
  }

  function handleDownload() {
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
    <div className="min-h-dvh bg-surface-primary text-text-primary flex items-center justify-center pb-16">
      <div className="max-w-sm w-full px-4">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight">kexify</h1>
          <p className="text-[11px] text-text-muted mt-0.5">{t("standalone.title")}</p>
        </div>

        {/* Step: Hub — show existing shares + create/import options */}
        {step === "hub" && (
          <div className="space-y-4">
            {standaloneShares.length > 0 && (
              <div className="space-y-1.5 max-h-[180px] overflow-y-auto">
                {standaloneShares.map((share) => (
                  <div key={share.keyId} className="flex items-center bg-surface-secondary border border-border-primary rounded-lg hover:border-blue-500/30 transition-colors">
                    <div className="flex-1 px-3 py-2.5 min-w-0">
                      <span className="text-xs text-text-secondary truncate block">
                        {share.name || t("login.anonymousWallet")}
                        <span className="text-text-muted ml-1 font-mono">{share.keyId.slice(0, 6)}</span>
                      </span>
                    </div>
                    <button
                      onClick={() => setDeleteKeyId(share.keyId)}
                      className="px-2 py-2.5 text-text-muted hover:text-red-400 transition-colors"
                      title={t("common.delete")}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                      </svg>
                    </button>
                    <button
                      onClick={() => setUnlockKeyId(share.keyId)}
                      className="px-3 py-2.5 text-text-muted hover:text-blue-400 transition-colors"
                      title={t("login.unlock")}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => setStep("name")}
              className="w-full bg-blue-600 hover:bg-blue-700 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors text-white"
            >
              {t("standalone.createWallet")}
            </button>

            <input
              ref={importFileRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleImportFile}
            />
            <div className="flex items-center justify-center gap-3 text-[11px]">
              <button
                onClick={() => importFileRef.current?.click()}
                className="text-text-muted hover:text-text-secondary transition-colors"
              >
                {t("login.importFile")}
              </button>
              <span className="text-border-primary">|</span>
              <Link to="/login" className="text-text-muted hover:text-text-secondary transition-colors">
                {t("standalone.backToLogin")}
              </Link>
            </div>
          </div>
        )}

        {/* Step: Import — decrypt file + share-auth */}
        {step === "import" && importFileData && (
          <div className="space-y-4">
            <div className="bg-surface-secondary border border-border-primary rounded-lg px-3 py-2.5">
              <p className="text-xs text-text-secondary truncate">{importFileData.id.slice(0, 8)}...</p>
              <p className="text-[10px] text-text-muted">{t("standalone.importedFile")}</p>
            </div>

            {isEncryptedKeyFile(importFileData) ? (
              <>
                <p className="text-xs text-text-muted text-center">{t("standalone.enterPassphraseToImport")}</p>
                <PassphraseInput
                  mode="enter"
                  onSubmit={handleImportPassphrase}
                  submitLabel={importLoading ? t("common.loading") : t("login.unlock")}
                />
              </>
            ) : (
              <button
                onClick={() => handleImportPassphrase("")}
                disabled={importLoading}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-surface-tertiary px-4 py-2.5 rounded-lg text-sm font-medium transition-colors text-white"
              >
                {importLoading ? t("common.loading") : t("login.unlock")}
              </button>
            )}

            {error && <ErrorBox>{error}</ErrorBox>}
            <button
              onClick={() => { setStep("hub"); setImportFileData(null); setError(""); }}
              className="w-full text-xs text-text-muted hover:text-text-secondary transition-colors py-1"
            >
              &larr; {t("common.back")}
            </button>
          </div>
        )}

        {/* Standalone unlock dialog */}
        {unlockKeyId && (
          <StandaloneUnlock
            keyId={unlockKeyId}
            onClose={() => setUnlockKeyId(null)}
            onSuccess={() => navigate("/", { replace: true })}
          />
        )}

        {/* Delete confirmation dialog */}
        {deleteKeyId && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setDeleteKeyId(null)}>
            <div className="bg-surface-secondary border border-border-primary rounded-xl p-6 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
              <p className="text-sm font-medium mb-2">{t("standalone.confirmDeleteTitle")}</p>
              <p className="text-xs text-text-muted mb-4">{t("standalone.confirmDelete")}</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setDeleteKeyId(null)}
                  className="flex-1 px-4 py-2 bg-surface-tertiary rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={() => {
                    deleteKeyShare(deleteKeyId);
                    setStandaloneShares(getStandaloneShares());
                    setDeleteKeyId(null);
                  }}
                  className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-xs font-medium text-white transition-colors"
                >
                  {t("common.delete")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step: Name (with optional inline turnstile) */}
        {step === "name" && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-text-muted mb-1.5">{t("standalone.keyName")}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("standalone.keyNamePlaceholder")}
                autoFocus
                className="w-full bg-surface-secondary border border-border-primary rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>
            {TURNSTILE_SITE_KEY && (
              <div ref={turnstileRef} className="flex justify-center" />
            )}
            <button
              onClick={startKeygen}
              disabled={TURNSTILE_SITE_KEY ? !captchaToken : false}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-surface-tertiary disabled:text-text-muted disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors text-white"
            >
              {t("standalone.createWallet")}
            </button>
            <button
              onClick={() => setStep("hub")}
              className="w-full text-xs text-text-muted hover:text-text-secondary transition-colors py-1"
            >
              &larr; {t("common.back")}
            </button>
          </div>
        )}

        {/* Step: Creating */}
        {step === "creating" && (
          <div className="py-6 space-y-5">
            {error ? (
              <div className="text-center py-4">
                <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-text-primary mb-1">{t("standalone.creationFailed")}</p>
                <p className="text-xs text-red-400 break-all mb-5 px-4">{error}</p>
                <div className="flex gap-3 justify-center">
                  <button
                    onClick={() => navigate("/login")}
                    className="px-4 py-2 rounded-lg text-xs font-medium bg-surface-tertiary text-text-secondary hover:bg-border-primary transition-colors"
                  >
                    {t("common.back")}
                  </button>
                  <button
                    onClick={() => { setError(""); startKeygen(); }}
                    className="px-4 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                  >
                    {t("common.tryAgain")}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex justify-center">
                  <Spinner className="w-8 h-8" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium text-text-secondary">{progress}</p>
                  <p className="text-[11px] text-text-muted mt-1">{t("standalone.creatingTime")}</p>
                </div>
                <CreatingProgressBar currentStep={creatingStep} done={creatingDone} />
                {/* Step indicators */}
                <div className="space-y-2 max-w-[220px] mx-auto">
                  {[
                    { label: t("standalone.stepEncryption"), match: "encryption" },
                    { label: t("standalone.stepSecuring"), match: "Securing" },
                    { label: t("standalone.stepSaving"), match: "Saving" },
                  ].map(({ label, match }) => {
                    const isCurrent = progress.includes(match);
                    const isDone = !isCurrent && (
                      (match === "encryption" && (progress.includes("Securing") || progress.includes("Saving")))
                      || (match === "Securing" && progress.includes("Saving"))
                    );
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
                {expert && <RollingTips />}
              </>
            )}
          </div>
        )}

        {/* Step: Passphrase */}
        {step === "passphrase" && (
          <div className="space-y-4">
            <p className="text-xs text-text-muted text-center">{t("standalone.setPassphrase")}</p>
            <PassphraseInput
              mode="set"
              onSubmit={handlePassphrase}
              submitLabel={t("common.continue")}
            />
            <p className="text-[10px] text-text-muted text-center">
              {t("standalone.passphraseHelp")}
            </p>
            {error && <ErrorBox>{error}</ErrorBox>}
          </div>
        )}

        {/* Step: Passkey */}
        {step === "passkey" && (
          <div className="space-y-4">
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3">
              <p className="text-xs text-blue-400 font-medium mb-1">{t("standalone.passkeyTitle")}</p>
              <p className="text-[11px] text-blue-400/70 leading-relaxed">
                {t("standalone.passkeyDesc")}
              </p>
            </div>
            <PasskeyGate
              onRegistered={handlePasskeyComplete}
              onRegisteredWithPrf={handlePasskeyWithPrf}
              onCancel={() => navigate("/login", { replace: true })}
              inline
            />
          </div>
        )}

        {/* Step: Backup */}
        {step === "backup" && (
          <div className="space-y-4">
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
              <p className="text-xs text-yellow-400 font-medium mb-1">{t("standalone.backupRequired")}</p>
              <p className="text-[11px] text-yellow-400/70 leading-relaxed">
                {t("standalone.backupDesc")}
              </p>
            </div>

            {/* Download button — styled like email flow */}
            <button
              onClick={handleDownload}
              className="w-full bg-surface-secondary border border-border-primary hover:border-border-secondary rounded-lg px-4 py-3 flex items-center gap-3 transition-colors group"
            >
              <div className="w-9 h-9 rounded-lg bg-surface-tertiary flex items-center justify-center shrink-0">
                <svg className="w-4.5 h-4.5 text-text-tertiary group-hover:text-text-secondary transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
              </div>
              <div className="text-left flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary truncate">{keyFile?.fileName}</p>
                <p className="text-[11px] text-text-muted">{t("standalone.keyShareFile")}</p>
              </div>
              {downloaded && (
                <svg className="w-5 h-5 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              )}
            </button>

            <button
              onClick={() => navigate("/", { replace: true })}
              disabled={!downloaded}
              className="w-full bg-green-600 hover:bg-green-700 disabled:bg-surface-tertiary disabled:text-text-muted disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors text-white"
            >
              {t("standalone.goToDashboard")}
            </button>
          </div>
        )}
      </div>

      {/* Theme & language toggle - bottom left */}
      <div className="fixed bottom-4 left-4 flex items-center gap-1">
        <ThemeToggleBtn />
        <LangSwitcher />
      </div>
    </div>
  );
}

function ThemeToggleBtn() {
  const [current, setCurrent] = useState(getStoredTheme);
  return (
    <button
      onClick={() => { const next = current === "dark" ? "light" : "dark"; setTheme(next); setCurrent(next); }}
      className="p-2 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-tertiary transition-colors"
    >
      {current === "dark" ? (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
        </svg>
      )}
    </button>
  );
}
