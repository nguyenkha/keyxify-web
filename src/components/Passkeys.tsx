import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchPasskeys,
  registerPasskey,
  renamePasskey,
  deletePasskey,
  type PasskeyInfo,
} from "../lib/passkey";
import { ErrorBox } from "./ui";
import { KeyRound } from "lucide-react";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function PasskeyNameLabel({
  name,
  onRename,
}: {
  name: string | null;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name || "");

  function commit() {
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    else setValue(name || "");
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setValue(name || "");
            setEditing(false);
          }
        }}
        className="text-sm font-medium bg-transparent border-b border-border-primary text-text-primary outline-none px-0 py-0.5 w-40"
      />
    );
  }

  return (
    <span
      onClick={() => {
        setValue(name || "");
        setEditing(true);
      }}
      className="text-sm font-medium text-text-primary cursor-pointer hover:text-text-secondary transition-colors"
    >
      {name || "Unnamed"}
    </span>
  );
}

export function Passkeys() {
  const { t } = useTranslation();
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function formatTimeAgo(dateStr: string | null): string {
    if (!dateStr) return t("passkey.never");
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return t("passkey.justNow");
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  async function loadData() {
    try {
      const list = await fetchPasskeys();
      setPasskeys(list);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function handleAdd() {
    setAdding(true);
    setError("");
    try {
      const info = await registerPasskey();
      setPasskeys((prev) => [...prev, info]);
    } catch (err) {
      setError(String(err));
    } finally {
      setAdding(false);
    }
  }

  async function handleRename(id: string, name: string) {
    try {
      await renamePasskey(id, name);
      setPasskeys((prev) =>
        prev.map((p) => (p.id === id ? { ...p, name } : p))
      );
    } catch {
      /* ignore */
    }
  }

  async function handleDelete(id: string) {
    try {
      await deletePasskey(id);
      setPasskeys((prev) => prev.filter((p) => p.id !== id));
      setDeletingId(null);
    } catch (err) {
      setError(String(err));
      setDeletingId(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div
            key={i}
            className="bg-surface-secondary rounded-lg border border-border-primary h-[68px] flex items-center px-5 gap-3"
          >
            <div className="w-9 h-9 rounded-full bg-surface-tertiary animate-pulse" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-24 bg-surface-tertiary rounded animate-pulse" />
              <div className="h-3 w-16 bg-surface-tertiary/60 rounded animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (passkeys.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="w-14 h-14 rounded-full bg-surface-tertiary flex items-center justify-center mb-5">
          <svg
            className="w-7 h-7 text-text-muted"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M7.864 4.243A7.5 7.5 0 0119.5 10.5c0 2.92-.556 5.709-1.568 8.268M5.742 6.364A7.465 7.465 0 004 10.5a7.464 7.464 0 01-1.15 3.993m1.989 3.559A11.209 11.209 0 008.25 10.5a3.75 3.75 0 117.5 0c0 .527-.021 1.049-.064 1.565M12 10.5a14.94 14.94 0 01-3.6 9.75m6.633-4.596a18.666 18.666 0 01-2.485 5.33"
            />
          </svg>
        </div>
        <p className="text-sm font-medium text-text-secondary mb-1">{t("passkey.noPasskeysYet")}</p>
        <p className="text-xs text-text-muted mb-4">
          {t("passkey.addFirst")}
        </p>
        <button
          onClick={handleAdd}
          disabled={adding}
          className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-60"
        >
          {adding ? t("passkey.registering") : <><KeyRound className="w-4 h-4 inline-block align-[-2px] mr-1" />{t("passkey.addFirstButton")}</>}
        </button>
        {error && <ErrorBox className="mt-4">{error}</ErrorBox>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="pt-2 pb-2">
        <h2 className="text-lg font-semibold text-text-primary">{t("passkey.title")}</h2>
        <p className="text-xs text-text-muted mt-1">
          {t("passkey.description")}
        </p>
      </div>

      <div className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden divide-y divide-border-secondary">
        {passkeys.map((pk) => (
          <div
            key={pk.id}
            className="flex items-center h-[68px] px-3 md:px-5 group"
          >
            {/* Icon */}
            <div className="w-9 h-9 rounded-full bg-surface-tertiary flex items-center justify-center shrink-0 mr-3">
              <svg
                className="w-4 h-4 text-text-muted"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M7.864 4.243A7.5 7.5 0 0119.5 10.5c0 2.92-.556 5.709-1.568 8.268M5.742 6.364A7.465 7.465 0 004 10.5a7.464 7.464 0 01-1.15 3.993m1.989 3.559A11.209 11.209 0 008.25 10.5a3.75 3.75 0 117.5 0c0 .527-.021 1.049-.064 1.565M12 10.5a14.94 14.94 0 01-3.6 9.75m6.633-4.596a18.666 18.666 0 01-2.485 5.33"
                />
              </svg>
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              {deletingId === pk.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-muted">{t("passkey.deleteThisPasskey")}</span>
                  <button
                    onClick={() => setDeletingId(null)}
                    className="text-[10px] px-2 py-1 rounded bg-surface-tertiary text-text-secondary hover:bg-border-primary transition-colors"
                  >
                    {t("passkey.cancel")}
                  </button>
                  <button
                    onClick={() => handleDelete(pk.id)}
                    className="text-[10px] px-2 py-1 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                  >
                    {t("passkey.delete")}
                  </button>
                </div>
              ) : (
                <>
                  <PasskeyNameLabel
                    name={pk.name}
                    onRename={(name) => handleRename(pk.id, name)}
                  />
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className="text-[11px] text-text-muted">
                      {t("passkey.createdOn")} {formatDate(pk.createdAt)}
                    </span>
                    <span className="text-[11px] text-text-muted">
                      {t("passkey.lastUsed")}: {formatTimeAgo(pk.lastUsedAt)}
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* Delete button */}
            {deletingId !== pk.id && (
              <button
                onClick={() => setDeletingId(pk.id)}
                disabled={passkeys.length <= 1}
                className="p-1.5 rounded-md text-text-muted hover:text-red-400 hover:bg-surface-tertiary transition-colors md:opacity-0 md:group-hover:opacity-100 disabled:opacity-20 disabled:cursor-not-allowed shrink-0"
                title={passkeys.length <= 1 ? "Cannot delete last passkey" : "Delete passkey"}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      {/* Add passkey button */}
      <button
        onClick={handleAdd}
        disabled={adding}
        className="w-full border border-dashed border-border-primary rounded-lg py-3 text-sm text-text-muted hover:text-text-secondary hover:border-border-secondary transition-colors flex items-center justify-center gap-1.5 disabled:opacity-60"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        {adding ? t("passkey.registering") : t("passkey.addPasskey")}
      </button>
    </div>
  );
}
