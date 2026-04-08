import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

interface Props {
  onBackup: () => void;
  onDismiss: () => void;
}

export function BackupNudge({ onBackup, onDismiss }: Props) {
  const { t } = useTranslation();

  return (
    <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-3 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-yellow-400">{t("backup.nudgeTitle")}</p>
        <p className="text-[10px] text-yellow-400/70 mt-0.5 leading-relaxed">{t("backup.nudgeDesc")}</p>
        <button
          onClick={onBackup}
          className="mt-2 text-[11px] font-medium text-yellow-400 hover:text-yellow-300 transition-colors"
        >
          {t("backup.nudgeAction")}
        </button>
      </div>
      <button
        onClick={onDismiss}
        className="p-0.5 text-yellow-400/50 hover:text-yellow-400 transition-colors shrink-0"
        aria-label="Dismiss"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
