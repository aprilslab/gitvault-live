/**
 * relativeTime/absoluteTime 단위 테스트 (순수 — nowMs 주입으로 결정성).
 * 실행: npm run test:relative -w plugin
 */
import { relativeTime, absoluteTime } from '../src/editor/relativeTime';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
}

const NOW = 1_700_000_000_000; // 고정 now(ms)
const nowSec = Math.floor(NOW / 1000);
const at = (secAgo: number) => nowSec - secAgo;

assert(relativeTime(at(30), NOW) === '방금', '30초 전 → 방금');
assert(relativeTime(at(5 * 60), NOW) === '5분 전', '5분 전');
assert(relativeTime(at(3 * 3600), NOW) === '3시간 전', '3시간 전');
assert(relativeTime(at(2 * 86400), NOW) === '2일 전', '2일 전');
assert(relativeTime(at(10 * 86400), NOW) === '1주 전', '10일 → 1주 전');
assert(relativeTime(at(40 * 86400), NOW) === '1개월 전', '40일 → 1개월 전');
assert(relativeTime(at(400 * 86400), NOW) === '1년 전', '400일 → 1년 전');
assert(relativeTime(at(-100), NOW) === '방금', '미래(음수) → 방금');

assert(/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(absoluteTime(nowSec)), 'absoluteTime 포맷 YYYY-MM-DD HH:mm');

console.log('relativeTime: 전부 통과');
