// computeStatus: sync 상태 + outgoing 을 합쳐 text/tooltip 계산.
// [회귀] idle sync 의 set('synced') 가 setOutgoing 이 세운 파일목록 tooltip 을 지우던 버그 방지 —
// outgoing 이 있으면 상태가 'synced'/'syncing' 이어도 tooltip 은 항상 파일목록이어야 한다.
import { computeStatus } from '../src/ui/StatusBar';
import type { OutgoingFile } from '../src/ui/StatusBar';

let fail = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) fail++;
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${label}`);
}

const files: OutgoingFile[] = [
  { status: 'M', path: 'notes/a.md' },
  { status: 'A', path: 'notes/b.md' },
];

// 1) [핵심 회귀] outgoing>0 인데 상태가 'synced' → tooltip 은 파일목록(지워지면 안 됨)
{
  const r = computeStatus('synced', undefined, files);
  ok(r.tooltip.includes('notes/a.md') && r.tooltip.includes('notes/b.md'), 'synced+outgoing → tooltip 에 파일목록 유지');
  ok(r.text === 'Git: 저장 대기 2', 'synced+outgoing → text=저장 대기 2');
  ok(r.cls === 'mod-pending', 'synced+outgoing → mod-pending');
}

// 2) outgoing>0 + 'syncing' → 동기화 중 표기 + tooltip 유지
{
  const r = computeStatus('syncing', undefined, files);
  ok(r.text.includes('동기화 중') && r.text.includes('저장 대기 2'), 'syncing+outgoing → 동기화 중 + 대기 2');
  ok(r.tooltip.includes('notes/a.md'), 'syncing+outgoing → tooltip 파일목록 유지');
  ok(r.cls === 'mod-syncing', 'syncing+outgoing → mod-syncing');
}

// 3) outgoing 0 + synced → 저장됨
{
  const r = computeStatus('synced', undefined, []);
  ok(r.text === 'Git: 저장됨', 'synced+0 → 저장됨');
  ok(r.cls === '', 'synced+0 → 클래스 없음');
}

// 4) error 최우선 — outgoing 있어도 오류 + 원인 tooltip
{
  const r = computeStatus('error', 'auth failed', files);
  ok(r.text === 'Git: 오류(auth failed)', 'error → 오류(detail)');
  ok(r.tooltip === 'auth failed', 'error → tooltip=원인');
  ok(r.cls === 'mod-error', 'error → mod-error');
}

// 5) off → 미연결
{
  const r = computeStatus('off', undefined, []);
  ok(r.text === 'Git: 미연결', 'off → 미연결');
}

// 6) pending + detail → "detail 대기"
{
  const r = computeStatus('pending', '변경', []);
  ok(r.text === 'Git: 변경 대기', 'pending+detail → 변경 대기');
}

console.log(fail === 0 ? 'statusBar: 전부 통과' : `statusBar: ${fail}건 실패`);
if (fail > 0) process.exit(1);
