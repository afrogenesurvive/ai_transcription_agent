/**
 * formatElapsedHMS — format a millisecond duration as zero-padded `hh:mm:ss`.
 * Always includes hours regardless of magnitude (e.g. `00:12:34`, `01:02:03`).
 * Purely presentational — never feeds back into status/progress logic.
 */
export function formatElapsedHMS(ms: number): string {
  const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
