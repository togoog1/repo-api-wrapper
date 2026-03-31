import type { RunSummary } from "../types";
import { formatDate } from "../helpers";

interface RunHistoryItemProps {
  run: RunSummary;
  isActive: boolean;
  onClick: () => void;
}

export function RunHistoryItem({ run, isActive, onClick }: RunHistoryItemProps) {
  return (
    <button
      className={`run-history-item ${isActive ? "active" : ""}`}
      onClick={onClick}
      type="button"
    >
      <div className="run-history-item-top">
        <strong>{run.label ?? run.action}</strong>
        <span className={`status-tag status-${run.status.toLowerCase()}`}>
          {run.status.toLowerCase()}
        </span>
      </div>
      <span className="run-history-item-meta">
        {run.completedItems}/{run.totalItems} done &middot;{" "}
        {run.failedItems} failed &middot; {formatDate(run.createdAt)}
      </span>
    </button>
  );
}
