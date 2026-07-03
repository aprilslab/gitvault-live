/**
 * epoch(초) → 한국어 상대시간. nowMs 주입 → 순수·테스트 결정성.
 * "방금"/"N분 전"/"N시간 전"/"N일 전"/"N주 전"/"N개월 전"/"N년 전".
 */
export function relativeTime(epochSec: number, nowMs: number): string {
  const diffSec = Math.floor(nowMs / 1000) - epochSec;
  if (diffSec < 60) return '방금';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  if (day < 30) return `${Math.floor(day / 7)}주 전`;
  if (day < 365) return `${Math.floor(day / 30)}개월 전`;
  return `${Math.floor(day / 365)}년 전`;
}

/** epoch(초) → 로컬 "YYYY-MM-DD HH:mm". title 툴팁용. */
export function absoluteTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
