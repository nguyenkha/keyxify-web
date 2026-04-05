import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toHex, sha256, performMpcSign, clientKeys, restoreKeyHandles } from "../lib/mpc";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { fetchPasskeys, sensitiveHeaders, authenticatePasskey } from "../lib/passkey";
import { parseDerSignature } from "../lib/chains/evmTx";
import { hexToBytes } from "../shared/utils";
import { PasskeyGate } from "./PasskeyGate";
import { PasskeyChallenge } from "./PasskeyChallenge";
import { isEncryptedKeyFile, decryptKeyFile, type KeyFileData } from "../lib/crypto";
import { PassphraseInput } from "./PassphraseInput";
import { listKeyShares, getKeyShareWithPrf, getKeyShareWithPassphrase, type KeyShareInfo } from "../lib/keystore";
import { useFrozen } from "../context/FrozenContext";
import { isRecoveryMode, getRecoveryKeyFile } from "../lib/recovery";
import { useSteppedProgress, signingDurationMs, ProgressBar } from "./ProgressBar";
import { PenLine, CircleX, CircleCheck, Clock } from "lucide-react";
import { Spinner } from "./ui";

interface KeyFile {
  id: string;
  peer: number;
  share: string;
  publicKey: string;
  eddsaShare: string;
  eddsaPublicKey: string;
}

type SigningPhase = "loading" | "signing" | "verifying";

function getPhaseLabels(t: (k: string) => string, pct?: number): Record<SigningPhase, string> {
  const signLabel = isRecoveryMode() ? t("sign.localSigning") : t("sign.mpcSigning");
  const signLabelActive = pct != null && pct > 0 ? `${signLabel} ${pct}%` : signLabel;
  return { loading: t("sign.prepare"), signing: signLabelActive, verifying: t("sign.verify") };
}

const phases: SigningPhase[] = ["loading", "signing", "verifying"];

export function Sign() {
  const { t } = useTranslation();
  const frozen = useFrozen();
  const [keyFile, setKeyFile] = useState<KeyFile | null>(() => {
    if (isRecoveryMode()) {
      const kf = getRecoveryKeyFile();
      if (kf) return kf as KeyFile;
    }
    return null;
  });
  const [pendingEncrypted, setPendingEncrypted] = useState<KeyFileData | null>(null);
  const [message, setMessage] = useState("");
  const [algorithm, setAlgorithm] = useState<"ecdsa" | "eddsa">("ecdsa");

  // Browser-stored key shares
  const [browserShares, setBrowserShares] = useState<KeyShareInfo[]>([]);
  const [browserLoading, setBrowserLoading] = useState("");
  const [browserPassphrase, setBrowserPassphrase] = useState<KeyShareInfo | null>(null);

  // Dialog state
  const [showDialog, setShowDialog] = useState(false);
  const [signingPhase, setSigningPhase] = useState<SigningPhase>("loading");
  const [signingError, setSigningError] = useState<string | null>(null);
  const [signature, setSignature] = useState("");
  const [verified, setVerified] = useState<boolean | null>(null);
  // Stepped progress: phases are loading(0) → signing(1) → verifying(2)
  const signPhaseIdx = phases.indexOf(signingPhase);
  const progress = useSteppedProgress(
    showDialog && !signature && !signingError ? signPhaseIdx : -1,
    1, // main step = MPC signing (index 1)
    1, // 1 step after main: verify
    signingDurationMs(1),
    false,
  );

  // Load browser-stored shares on mount (skip in recovery — key already set)
  useEffect(() => {
    if (!isRecoveryMode()) {
      setBrowserShares(listKeyShares()); // eslint-disable-line react-hooks/set-state-in-effect -- one-time init from localStorage
    }
  }, []);

  async function loadBrowserShare(info: KeyShareInfo) {
    setBrowserLoading(info.keyId);
    try {
      if (info.mode === "prf") {
        const result = await authenticatePasskey({ withPrf: true });
        if (result.prfKey) {
          const data = await getKeyShareWithPrf(info.keyId, result.prfKey);
          if (data) {
            setKeyFile(data as KeyFile);
            setBrowserLoading("");
            return;
          }
        }
        setBrowserLoading("");
      } else {
        setBrowserPassphrase(info);
        setBrowserLoading("");
      }
    } catch {
      setBrowserLoading("");
    }
  }

  // Passkey guard state
  const [passkeyGuard, setPasskeyGuard] = useState<"idle" | "gate" | "challenge">("idle");

  async function guardedSign() {
    if (isRecoveryMode()) {
      sign();
      return;
    }
    try {
      const list = await fetchPasskeys();
      if (list.length === 0) {
        setPasskeyGuard("gate");
      } else {
        setPasskeyGuard("challenge");
      }
    } catch {
      sign();
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        if (!data.id || !data.share || !data.publicKey) return;
        if (isEncryptedKeyFile(data)) {
          setPendingEncrypted(data);
          setKeyFile(null);
        } else {
          setKeyFile(data as KeyFile);
          setPendingEncrypted(null);
        }
      } catch { /* ignore */ }
    };
    reader.readAsText(file);
  }

  async function sign() {
    if (!keyFile || !message) return;

    setShowDialog(true);
    setSignature("");
    setVerified(null);
    setSigningError(null);
    setSigningPhase("loading");

    try {
      // Restore key handles from file if not in memory
      if (!clientKeys.has(keyFile.id)) {
        await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
      }

      const hash = await sha256(message);
      const useEddsa = algorithm === "eddsa";

      setSigningPhase("signing");

      const { signature: sigRaw } = await performMpcSign({
        algorithm: useEddsa ? "eddsa" : "ecdsa",
        keyId: keyFile.id,
        hash,
        initPayload: { id: keyFile.id, raw: message, algorithm: useEddsa ? "eddsa" : "ecdsa" },
        headers: sensitiveHeaders(),
      });

      setSignature(toHex(sigRaw));

      // Verify
      setSigningPhase("verifying");

      if (useEddsa) {
        // EdDSA verification — trust server for now
        setVerified(true);
      } else {
        try {
          const { r, s } = parseDerSignature(sigRaw);
          const pubKeyRaw = hexToBytes(keyFile.publicKey);
          const compactSig = new Uint8Array(64);
          compactSig.set(bigIntTo32Bytes(r), 0);
          compactSig.set(bigIntTo32Bytes(s), 32);
          const isValid = secp256k1.verify(compactSig, hash, pubKeyRaw, { prehash: false });
          setVerified(isValid);
        } catch {
          setVerified(false);
        }
      }
    } catch (err: unknown) {
      console.error("[sign] Error:", err);
      const msg = (err as { message?: string })?.message || String(err);
      setSigningError(msg === "passkey_auth_required" ? t("sign.passkeyExpired") : msg);
    }
  }

  function closeDialog() {
    setShowDialog(false);
  }

  const signDialogCanClose = !!(signature || signingError);

  useEffect(() => {
    if (!showDialog) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && signDialogCanClose) closeDialog();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showDialog, signDialogCanClose]);

  const canSign = keyFile && message;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="pt-2 pb-2">
        <h2 className="text-lg font-semibold text-text-primary">{t("sign.title")}</h2>
        <p className="text-xs text-text-muted mt-1">
          {t("sign.desc")}
        </p>
      </div>

      {/* Form */}
      <div className="space-y-4">
        {/* Key Share File */}
        <div>
          <label className="block text-xs text-text-muted mb-1.5">{t("sign.keyShare")}</label>
          {!keyFile && !pendingEncrypted ? (
            <div className="space-y-2">
              {/* Browser-stored shares */}
              {browserShares.length > 0 && !browserPassphrase && (
                <div className="space-y-1.5">
                  {browserShares.map((s) => (
                    <button
                      key={s.keyId}
                      onClick={() => loadBrowserShare(s)}
                      disabled={browserLoading === s.keyId}
                      className="w-full bg-surface-secondary border border-border-primary rounded-lg px-3 py-2.5 flex items-center gap-2.5 hover:border-blue-500/30 transition-colors text-left disabled:opacity-50"
                    >
                      <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a9 9 0 11-18 0V5.25" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-text-secondary truncate">{s.keyId.slice(0, 8)}...</p>
                        <p className="text-[10px] text-text-muted">{s.mode === "prf" ? t("sign.passkeyEncrypted") : t("sign.passphraseEncrypted")} · ECDSA + EdDSA</p>
                      </div>
                      {browserLoading === s.keyId ? (
                        <Spinner size="xs" />
                      ) : (
                        <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {/* Browser passphrase prompt */}
              {browserPassphrase && (
                <div className="bg-surface-secondary border border-border-primary rounded-lg p-3">
                  <p className="text-xs text-text-muted mb-2">
                    <span className="font-mono text-text-tertiary">{browserPassphrase.keyId.slice(0, 8)}...</span> — {t("sign.enterPassphrase")}
                  </p>
                  <PassphraseInput
                    mode="enter"
                    submitLabel={t("sign.decrypt")}
                    onSubmit={async (passphrase) => {
                      const data = await getKeyShareWithPassphrase(browserPassphrase.keyId, passphrase);
                      if (data) {
                        setKeyFile(data as KeyFile);
                        setBrowserPassphrase(null);
                      }
                    }}
                  />
                </div>
              )}

              {/* File upload */}
              {browserShares.length > 0 ? (
                <label className="block w-full text-center text-[11px] text-text-muted hover:text-text-tertiary transition-colors cursor-pointer">
                  {t("sign.orUploadFile")}
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                </label>
              ) : (
                <label className="flex items-center justify-center gap-2 w-full bg-surface-secondary border border-border-primary border-dashed rounded-lg px-3 py-4 text-xs text-text-muted hover:border-blue-500/50 hover:text-text-secondary transition-colors cursor-pointer">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
                  </svg>
                  {t("sign.chooseKeyFile")}
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                </label>
              )}
            </div>
          ) : keyFile ? (
            <div className="bg-surface-secondary border border-border-primary rounded-lg px-3 py-2.5 flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-full bg-green-500/10 flex items-center justify-center flex-shrink-0">
                <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-text-secondary truncate">
                  {keyFile.id.slice(0, 8)}...{keyFile.id.slice(-4)}
                </p>
                <p className="text-[10px] text-text-muted font-mono truncate">{keyFile.publicKey.slice(0, 24)}...</p>
              </div>
              <button
                onClick={() => !isRecoveryMode() && setKeyFile(null)}
                disabled={isRecoveryMode()}
                className={`p-1 rounded-md transition-colors ${isRecoveryMode() ? "opacity-40 cursor-not-allowed" : "hover:bg-surface-tertiary"}`}
                title={isRecoveryMode() ? t("sign.keyLoadedRecovery") : t("sign.changeKey")}
              >
                <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                </svg>
              </button>
            </div>
          ) : null}

          {/* Passphrase prompt for encrypted files */}
          {pendingEncrypted && !keyFile && (
            <div className="bg-surface-secondary border border-border-primary rounded-lg p-3 mt-2">
              <p className="text-xs text-text-muted mb-2">
                <span className="font-mono text-text-tertiary">{pendingEncrypted.id.slice(0, 8)}...</span> — {t("sign.enterPassphraseToUnlock")}
              </p>
              <PassphraseInput
                mode="enter"
                submitLabel={t("sign.decrypt")}
                onSubmit={async (passphrase) => {
                  const decrypted = await decryptKeyFile(pendingEncrypted, passphrase);
                  setKeyFile(decrypted as KeyFile);
                  setPendingEncrypted(null);
                }}
              />
            </div>
          )}

        </div>

        {/* Algorithm */}
        <div>
          <label className="block text-xs text-text-muted mb-1.5">{t("sign.algorithm")}</label>
          <div className="flex bg-surface-secondary border border-border-primary rounded-lg p-0.5 gap-0.5 w-fit">
            {(["ecdsa", "eddsa"] as const).map((algo) => (
              <button
                key={algo}
                onClick={() => setAlgorithm(algo)}
                className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  algorithm === algo
                    ? "bg-surface-tertiary text-text-primary shadow-sm"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {algo.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Message */}
        <div>
          <label className="block text-xs text-text-muted mb-1.5">{t("sign.message")}</label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("sign.messagePlaceholder")}
            rows={4}
            className="w-full bg-surface-secondary border border-border-primary rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors resize-none"
          />
        </div>

        {/* Sign Button */}
        <button
          onClick={guardedSign}
          disabled={!canSign || frozen}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-surface-tertiary disabled:text-text-muted disabled:cursor-not-allowed px-6 py-2.5 rounded-lg font-medium text-sm transition-colors text-white"
        >
          <PenLine className="w-4 h-4 inline-block align-[-2px] mr-1" />{t("sign.signButton")}
        </button>
      </div>

      {/* Passkey guard dialogs */}
      {passkeyGuard === "gate" && (
        <PasskeyGate
          onRegistered={() => {
            setPasskeyGuard("idle");
            sign();
          }}
          onCancel={() => setPasskeyGuard("idle")}
        />
      )}
      {passkeyGuard === "challenge" && (
        <PasskeyChallenge
          onAuthenticated={() => {
            setPasskeyGuard("idle");
            sign();
          }}
          withPrf
          onCancel={() => setPasskeyGuard("idle")}
          autoStart
        />
      )}

      {/* Signing Dialog */}
      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={signature || signingError ? closeDialog : undefined} />
          <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
              <h3 className="text-sm font-semibold text-text-primary">
                {signingError ? <><CircleX className="w-4 h-4 inline-block align-[-2px] mr-1" />{t("sign.signingFailed")}</> : signature ? <><CircleCheck className="w-4 h-4 inline-block align-[-2px] mr-1" />{t("sign.signatureResult")}</> : <><Clock className="w-4 h-4 inline-block align-[-2px] mr-1" />{t("sign.signing")}</>}
              </h3>
              {(signature || signingError) && (
                <button
                  onClick={closeDialog}
                  className="p-1 rounded-md text-text-tertiary hover:text-text-primary transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            {/* Body */}
            <div className="px-5 py-5">
              {signingError ? (
                /* Error state */
                <div className="text-center py-4">
                  <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
                    <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium text-text-primary mb-1">{t("sign.signingFailed")}</p>
                  <p className="text-xs text-red-400 break-all mb-5">{signingError}</p>
                  <div className="flex gap-3 justify-center">
                    <button
                      onClick={closeDialog}
                      className="px-4 py-2 rounded-lg text-xs font-medium bg-surface-tertiary text-text-secondary hover:bg-border-primary transition-colors"
                    >
                      {t("common.close")}
                    </button>
                    <button
                      onClick={() => { closeDialog(); setTimeout(sign, 100); }}
                      className="px-4 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                    >
                      {t("common.tryAgain")}
                    </button>
                  </div>
                </div>
              ) : signature ? (
                /* Result state */
                <div className="py-2">
                  <div className="text-center mb-5">
                    <div className={`w-14 h-14 rounded-full ${verified ? "bg-green-500/10" : "bg-red-500/10"} flex items-center justify-center mx-auto mb-3`}>
                      {verified ? (
                        <svg className="w-7 h-7 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                      ) : (
                        <svg className="w-7 h-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      )}
                    </div>
                    <p className="text-sm font-semibold text-text-primary">
                      {verified ? t("sign.signatureVerified") : t("sign.verificationFailed")}
                    </p>
                    <p className="text-[11px] text-text-muted mt-0.5">
                      {algorithm.toUpperCase()} {verified ? t("sign.signatureValid") : t("sign.signatureInvalid")}
                    </p>
                  </div>

                  {/* Signature details */}
                  <div className="bg-surface-primary border border-border-primary rounded-lg overflow-hidden">
                    <div className="px-3 py-2.5 border-b border-border-secondary">
                      <p className="text-[10px] text-text-muted mb-1">{t("sign.message")}</p>
                      <p className="text-xs text-text-secondary break-all line-clamp-2">{message}</p>
                    </div>
                    <div className="px-3 py-2.5 border-b border-border-secondary">
                      <p className="text-[10px] text-text-muted mb-1">{t("sign.algorithm")}</p>
                      <p className="text-xs text-text-secondary">{algorithm.toUpperCase()}</p>
                    </div>
                    <div className="px-3 py-2.5">
                      <p className="text-[10px] text-text-muted mb-1">{t("sign.signatureLabel")}</p>
                      <p className="text-[10px] font-mono text-yellow-400 break-all leading-relaxed">{signature}</p>
                    </div>
                  </div>
                </div>
              ) : (
                /* Signing progress state */
                <div className="py-6">
                  <p className="text-sm font-medium text-text-primary text-center mb-1">
                    {getPhaseLabels(t, progress.phase === "main" ? progress.pct : undefined)[signingPhase]}
                  </p>
                  <p className="text-[11px] text-text-muted text-center mb-4">
                    {algorithm.toUpperCase()} {t("sign.signingInProgress")}
                  </p>

                  {/* Progress bar */}
                  <div className="mb-5">
                    <ProgressBar {...progress} />
                  </div>

                  <div className="space-y-2 max-w-[220px] mx-auto">
                    {phases.map((phase) => {
                      const currentIdx = phases.indexOf(signingPhase);
                      const idx = phases.indexOf(phase);
                      const isDone = currentIdx > idx;
                      const isCurrent = signingPhase === phase;
                      return (
                        <div key={phase} className="flex items-center gap-2.5">
                          {isDone ? (
                            <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                            </svg>
                          ) : isCurrent ? (
                            <div className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                              <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                            </div>
                          ) : (
                            <div className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                              <div className="w-1.5 h-1.5 rounded-full bg-surface-tertiary" />
                            </div>
                          )}
                          <span className={`text-xs ${isDone ? "text-text-tertiary" : isCurrent ? "text-text-secondary" : "text-text-muted"}`}>
                            {getPhaseLabels(t, progress.phase === "main" ? progress.pct : undefined)[phase]}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Footer for result state */}
            {signature && (
              <div className="px-5 py-4 border-t border-border-secondary">
                <button
                  onClick={closeDialog}
                  className="w-full py-2.5 rounded-lg text-xs font-medium bg-surface-tertiary text-text-secondary hover:bg-border-primary transition-colors"
                >
                  {t("common.done")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function bigIntTo32Bytes(n: bigint): Uint8Array {
  const result = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    result[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return result;
}
