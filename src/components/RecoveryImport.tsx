import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { type KeyFileData, isEncryptedKeyFile, decryptKeyFile } from "../lib/crypto";
import { enterRecoveryMode } from "../lib/recovery";
type PeerState =
  | { step: "idle" }
  | { step: "passphrase"; raw: KeyFileData }
  | { step: "ready"; data: KeyFileData };

export function RecoveryImport() {
  const navigate = useNavigate();

  const [peer1, setPeer1] = useState<PeerState>({ step: "idle" });
  const [peer2, setPeer2] = useState<PeerState>({ step: "idle" });
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [error, setError] = useState("");
  const [entering, setEntering] = useState(false);
  const file1Ref = useRef<HTMLInputElement>(null);
  const file2Ref = useRef<HTMLInputElement>(null);

  function handleFile(file: File, setPeer: typeof setPeer1, setPass: typeof setPass1) {
    setError("");
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string) as KeyFileData;
        if (!data.id || !data.share) {
          setError("Invalid key share file");
          return;
        }
        if (isEncryptedKeyFile(data)) {
          setPeer({ step: "passphrase", raw: data });
          setPass("");
        } else {
          setPeer({ step: "ready", data });
        }
      } catch {
        setError("Could not parse file as JSON");
      }
    };
    reader.readAsText(file);
  }

  async function handleDecrypt(
    raw: KeyFileData,
    passphrase: string,
    setPeer: typeof setPeer1,
  ) {
    setError("");
    try {
      const decrypted = await decryptKeyFile(raw, passphrase);
      setPeer({ step: "ready", data: decrypted });
    } catch (err: any) {
      setError(err.message || "Decryption failed");
    }
  }

  function getPeerData(state: PeerState): KeyFileData | null {
    return state.step === "ready" ? state.data : null;
  }

  async function handleEnter() {
    const p1 = getPeerData(peer1);
    const p2 = getPeerData(peer2);
    if (!p1 || !p2) return;

    // Integrity check: public keys must match
    if (p1.publicKey !== p2.publicKey) {
      setError("Public keys do not match — these shares belong to different keys");
      return;
    }
    if (p1.eddsaPublicKey !== p2.eddsaPublicKey) {
      setError("EdDSA public keys do not match — these shares belong to different keys");
      return;
    }

    setEntering(true);
    setError("");
    try {
      await enterRecoveryMode(p1, p2);
      navigate("/accounts");
    } catch (err: any) {
      setError(err.message || "Failed to enter recovery mode");
      setEntering(false);
    }
  }

  const p1Ready = peer1.step === "ready";
  const p2Ready = peer2.step === "ready";
  const canEnter = p1Ready && p2Ready && !entering;

  return (
    <div className="min-h-screen bg-surface-primary text-text-primary flex items-center justify-center">
      <div className="max-w-sm w-full px-4">
        {/* Branding */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight">kexify</h1>
          <p className="text-[11px] text-orange-400 recovery-accent mt-0.5">keys simplified</p>
        </div>

        {/* Recovery header */}
        <div className="recovery-accent bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-3 mb-6">
          <p className="text-xs text-yellow-400 recovery-accent font-medium">Wallet Recovery</p>
          <p className="text-[11px] text-yellow-400/70 mt-1 leading-relaxed">
            Load your two key files to access your wallet without our server.
            Both files are needed — they will be <span className="text-yellow-400/90 font-medium">combined locally in your browser</span> and never sent anywhere.
          </p>
        </div>

        <div className="space-y-4">
          {/* Peer 1 */}
          <div>
            <label className="block text-xs text-text-muted mb-1.5">Your key file</label>
            <PeerImport
              state={peer1}
              passphrase={pass1}
              fileRef={file1Ref}
              onFile={(f) => handleFile(f, setPeer1, setPass1)}
              onPassChange={setPass1}
              onDecrypt={(raw) => handleDecrypt(raw, pass1, setPeer1)}
              onClear={() => { setPeer1({ step: "idle" }); setError(""); }}
            />
          </div>

          {/* Peer 2 */}
          <div>
            <label className="block text-xs text-text-muted mb-1.5">Server key file</label>
            <PeerImport
              state={peer2}
              passphrase={pass2}
              fileRef={file2Ref}
              onFile={(f) => handleFile(f, setPeer2, setPass2)}
              onPassChange={setPass2}
              onDecrypt={(raw) => handleDecrypt(raw, pass2, setPeer2)}
              onClear={() => { setPeer2({ step: "idle" }); setError(""); }}
            />
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          {/* Enter recovery */}
          <button
            onClick={handleEnter}
            disabled={!canEnter}
            className="w-full bg-red-900 hover:bg-red-800 disabled:bg-surface-tertiary disabled:text-text-muted disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors text-red-200"
          >
            {entering ? "Initializing..." : "🔓 Enter Recovery Mode"}
          </button>
        </div>

        <button
          onClick={() => navigate("/login")}
          className="w-full mt-3 text-xs text-text-muted hover:text-text-secondary text-center py-2"
        >
          Back to login
        </button>
      </div>

    </div>
  );
}

function PeerImport({
  state,
  passphrase,
  fileRef,
  onFile,
  onPassChange,
  onDecrypt,
  onClear,
}: {
  state: PeerState;
  passphrase: string;
  fileRef: React.RefObject<HTMLInputElement | null>;
  onFile: (f: File) => void;
  onPassChange: (v: string) => void;
  onDecrypt: (raw: KeyFileData) => void;
  onClear: () => void;
}) {
  if (state.step === "idle") {
    return (
      <>
        <input
          ref={fileRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        />
        <label
          onClick={() => fileRef.current?.click()}
          className="flex items-center justify-center gap-2 w-full bg-surface-secondary border border-border-primary border-dashed rounded-lg px-3 py-4 text-xs text-text-muted hover:border-text-muted hover:text-text-secondary transition-colors cursor-pointer"
        >
          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
          </svg>
          Choose .json file
        </label>
      </>
    );
  }

  if (state.step === "passphrase") {
    return (
      <div className="bg-surface-secondary border border-border-primary rounded-lg p-3 space-y-2">
        <p className="text-xs text-text-tertiary">
          File is encrypted. Enter passphrase:
        </p>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => onPassChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && passphrase && onDecrypt(state.raw)}
          placeholder="Passphrase"
          className="w-full bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-text-tertiary transition-colors"
          autoFocus
        />
        <div className="flex gap-2">
          <button
            onClick={() => onDecrypt(state.raw)}
            disabled={!passphrase}
            className="flex-1 recovery-accent bg-yellow-600 hover:bg-yellow-500 disabled:bg-surface-tertiary disabled:text-text-muted disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium text-white transition-colors"
          >
            Decrypt
          </button>
          <button
            onClick={onClear}
            className="bg-surface-tertiary text-text-secondary hover:bg-border-primary px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ready — loaded state with green checkmark
  return (
    <div className="bg-surface-secondary border border-border-primary rounded-lg px-3 py-2.5 flex items-center gap-2.5">
      <div className="w-7 h-7 rounded-full bg-green-500/10 flex items-center justify-center shrink-0">
        <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-text-secondary truncate">
          {state.data.id.slice(0, 8)}...{state.data.id.slice(-4)}
        </p>
        <p className="text-[10px] text-green-500/70 truncate">
          Key file loaded
        </p>
      </div>
      <button
        onClick={onClear}
        className="p-1 rounded-md hover:bg-surface-tertiary transition-colors"
      >
        <svg className="w-3.5 h-3.5 text-text-muted hover:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
