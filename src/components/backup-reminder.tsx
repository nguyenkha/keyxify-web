interface BackupReminderProps {
  onBackup: () => void;
}

/** Persistent yellow banner shown when user hasn't backed up their wallet */
export function BackupReminder({ onBackup }: BackupReminderProps) {
  return (
    <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-3">
      <div className="flex items-start gap-3">
        <svg className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
        <div className="flex-1">
          <p className="text-xs font-medium text-yellow-400">Back up your wallet</p>
          <p className="text-[10px] text-yellow-400/70 mt-0.5 leading-relaxed">
            Download your backup file to recover your wallet if you lose this device
          </p>
          <button
            onClick={onBackup}
            className="text-xs text-yellow-400 hover:text-yellow-300 mt-2 font-medium transition-colors"
          >
            Back up now →
          </button>
        </div>
      </div>
    </div>
  );
}
