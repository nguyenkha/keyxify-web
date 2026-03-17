import { useState, useEffect, useRef } from "react";
import { performMpcSign, clientKeys, restoreKeyHandles } from "../lib/mpc";
import { parseDerSignature } from "../lib/chains/evmTx";
import { hexToBytes, bytesToHex } from "../shared/utils";
import { fetchPasskeys, sensitiveHeaders } from "../lib/passkey";
import { PasskeyGate } from "./PasskeyGate";
import { PasskeyChallenge } from "./PasskeyChallenge";
import { isEncryptedKeyFile, decryptKeyFile, type KeyFileData } from "../lib/crypto";
import { PassphraseInput } from "./PassphraseInput";
import { listKeyShares, getKeyShareWithPrf, getKeyShareWithPassphrase, type KeyShareInfo } from "../lib/keystore";
import { useFrozen } from "../context/FrozenContext";
import { isRecoveryMode, getRecoveryKeyFile } from "../lib/recovery";

interface KeyFile {
  id: string;
  peer: number;
  share: string;
  publicKey: string;
  eddsaShare: string;
  eddsaPublicKey: string;
}

export function SignTx() {
  const frozen = useFrozen();
  const recovery = isRecoveryMode();
  const [keyFile, setKeyFile] = useState<KeyFile | null>(() => {
    if (recovery) {
      const kf = getRecoveryKeyFile();
      if (kf) return kf as KeyFile;
    }
    return null;
  });
  const [pendingEncrypted, setPendingEncrypted] = useState<KeyFileData | null>(null);
  const [sighash, setSighash] = useState("");
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<{ r: string; s: string; der: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Browser-stored key shares
  const [browserShares, setBrowserShares] = useState<KeyShareInfo[]>([]);
  const [browserLoading, setBrowserLoading] = useState("");
  const [browserPassphrase, setBrowserPassphrase] = useState<KeyShareInfo | null>(null);

  // Passkey guard
  const [passkeyGuard, setPasskeyGuard] = useState<"idle" | "gate" | "challenge">("idle");
  const pendingSignRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!recovery) {
      setBrowserShares(listKeyShares());
    }
  }, []);

  async function guardedSign(action: () => void) {
    if (recovery) { action(); return; }
    try {
      const list = await fetchPasskeys();
      if (list.length === 0) {
        pendingSignRef.current = action;
        setPasskeyGuard("gate");
      } else {
        pendingSignRef.current = action;
        setPasskeyGuard("challenge");
      }
    } catch {
      action();
    }
  }

  function onPasskeyComplete() {
    setPasskeyGuard("idle");
    pendingSignRef.current?.();
    pendingSignRef.current = null;
  }

  async function loadBrowserShare(share: KeyShareInfo) {
    setBrowserLoading(share.keyId);
    try {
      if (share.mode === "prf") {
        const { authenticatePasskey } = await import("../lib/passkey");
        const result = await authenticatePasskey({ withPrf: true });
        if (result.prfKey) {
          const data = await getKeyShareWithPrf(share.keyId, result.prfKey);
          if (data) { setKeyFile(data as KeyFile); setBrowserLoading(""); return; }
        }
      } else if (share.mode === "passphrase") {
        setBrowserPassphrase(share);
      }
    } catch (err) {
      console.error(err);
    }
    setBrowserLoading("");
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text) as KeyFileData;
      if (isEncryptedKeyFile(data)) {
        setPendingEncrypted(data);
      } else {
        setKeyFile(data as unknown as KeyFile);
      }
    } catch {
      setError("Invalid key file");
    }
    e.target.value = "";
  }

  async function handleSign() {
    if (!keyFile || !sighash.trim()) return;
    const hashHex = sighash.trim().replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hashHex)) {
      setError("Sighash must be exactly 32 bytes (64 hex chars)");
      return;
    }

    guardedSign(async () => {
      setSigning(true);
      setError(null);
      setSignature(null);
      try {
        if (!clientKeys.has(keyFile.id)) {
          await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
        }
        const hashBytes = hexToBytes(hashHex);
        const { signature: sig } = await performMpcSign({
          algorithm: "ecdsa",
          keyId: keyFile.id,
          hash: hashBytes,
          initPayload: {
            id: keyFile.id,
            chainType: "evm",
            message: hashHex,
            from: "sign-tx",
          },
          headers: recovery ? {} : sensitiveHeaders(),
        });
        const { r, s } = parseDerSignature(sig);
        setSignature({
          r: r.toString(16).padStart(64, "0"),
          s: s.toString(16).padStart(64, "0"),
          der: bytesToHex(sig),
        });
      } catch (err: any) {
        setError(err.message || String(err));
      } finally {
        setSigning(false);
      }
    });
  }

  return (
    <div className="max-w-lg mx-auto space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">🔏 Sign Transaction Hash</h2>
        <p className="text-xs text-text-muted mt-1">Sign a pre-computed sighash (32 bytes) with ECDSA via MPC. Use the Send dialog with "Sign only" for full transaction signing.</p>
      </div>

      {/* Key share loading */}
      {!keyFile ? (
        <div className="space-y-3">
          <label className="block text-xs text-text-muted mb-1.5">Key Share</label>

          {browserShares.length > 0 && (
            <div className="space-y-1.5">
              {browserShares.map((share) => (
                <button
                  key={share.keyId}
                  onClick={() => loadBrowserShare(share)}
                  disabled={!!browserLoading}
                  className="w-full flex items-center gap-3 px-3 py-2.5 bg-surface-secondary border border-border-primary rounded-lg hover:border-blue-500/50 transition-colors text-left disabled:opacity-50"
                >
                  <span className="text-sm">🖥️</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-text-primary font-mono truncate">{share.keyId.slice(0, 8)}...{share.keyId.slice(-4)}</p>
                    <p className="text-[10px] text-text-muted">{share.mode === "prf" ? "Passkey" : "Passphrase"}</p>
                  </div>
                  {browserLoading === share.keyId && (
                    <svg className="w-4 h-4 text-blue-400 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}

          {browserPassphrase && (
            <PassphraseInput
              mode="enter"
              onSubmit={async (passphrase) => {
                const data = await getKeyShareWithPassphrase(browserPassphrase.keyId, passphrase);
                if (data) { setKeyFile(data as KeyFile); setBrowserPassphrase(null); }
                else setError("Incorrect passphrase");
              }}
            />
          )}

          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full py-2.5 rounded-lg text-sm font-medium border-2 border-dashed border-border-primary text-text-muted hover:border-blue-500/50 hover:text-text-secondary transition-colors"
          >
            Upload key share file
          </button>
          <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleFileUpload} />

          {pendingEncrypted && (
            <PassphraseInput
              mode="enter"
              onSubmit={async (passphrase) => {
                try {
                  const decrypted = await decryptKeyFile(pendingEncrypted, passphrase);
                  setKeyFile(decrypted as unknown as KeyFile);
                  setPendingEncrypted(null);
                } catch {
                  setError("Incorrect passphrase");
                }
              }}
            />
          )}
        </div>
      ) : (
        <div className="flex items-center gap-3 px-3 py-2.5 bg-surface-secondary border border-border-primary rounded-lg">
          <span className="text-sm text-green-400">✓</span>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-text-primary font-mono truncate">{keyFile.id.slice(0, 8)}...{keyFile.id.slice(-4)}</p>
          </div>
          <button onClick={() => setKeyFile(null)} className="text-xs text-text-muted hover:text-text-secondary transition-colors">Change</button>
        </div>
      )}

      {/* Sighash input */}
      <div>
        <label className="block text-xs text-text-muted mb-1.5">Sighash (32 bytes hex)</label>
        <input
          type="text"
          value={sighash}
          onChange={(e) => setSighash(e.target.value)}
          placeholder="0x... or raw hex (64 chars)"
          className="w-full bg-surface-secondary border border-border-primary rounded-lg px-3 py-2.5 text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-blue-500 transition-colors"
        />
      </div>

      <button
        onClick={handleSign}
        disabled={!keyFile || !sighash.trim() || signing || frozen}
        className="w-full py-2.5 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {signing ? "Signing..." : "🔏 Sign"}
      </button>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          <p className="text-xs text-red-400 break-all">{error}</p>
        </div>
      )}

      {signature && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2.5 space-y-2">
          <p className="text-xs text-green-400 font-medium">Signature</p>
          <div>
            <p className="text-[10px] text-text-muted uppercase tracking-wider">r</p>
            <p className="text-[11px] text-text-primary font-mono break-all">{signature.r}</p>
          </div>
          <div>
            <p className="text-[10px] text-text-muted uppercase tracking-wider">s</p>
            <p className="text-[11px] text-text-primary font-mono break-all">{signature.s}</p>
          </div>
          <div>
            <p className="text-[10px] text-text-muted uppercase tracking-wider">DER</p>
            <p className="text-[11px] text-text-primary font-mono break-all">{signature.der}</p>
          </div>
          <button
            onClick={() => navigator.clipboard.writeText(signature.der)}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium"
          >
            Copy DER
          </button>
        </div>
      )}

      {passkeyGuard === "gate" && (
        <PasskeyGate onRegistered={onPasskeyComplete} onCancel={() => { setPasskeyGuard("idle"); pendingSignRef.current = null; }} />
      )}
      {passkeyGuard === "challenge" && (
        <PasskeyChallenge autoStart onAuthenticated={onPasskeyComplete} onCancel={() => { setPasskeyGuard("idle"); pendingSignRef.current = null; }} />
      )}
    </div>
  );
}
