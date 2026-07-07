import { writeFileSync, rmSync } from 'fs';
import { join } from 'path';

/**
 * 플러그인(Obsidian) 생존 신호.
 *
 * 같은 vault 를 감시하는 daemon 이 이 파일의 신선도로 "Obsidian 이 vault 를 소유 중"인지 판정한다.
 * 신선하면 daemon 은 commit/merge 를 전면 후퇴하고(플러그인이 wip/저장 흐름을 담당),
 * 낡거나(=크래시) 없으면(=정상 종료) daemon 이 인수해 파일 변경을 main 에 직접 반영한다.
 *
 * - 위치: `.git/ogs-plugin-alive` — `.git` 하위라 동기화되지 않고 기기 로컬.
 * - 내용: epoch ms. daemon 의 `HEARTBEAT_STALE_MS`(30s)와 짝을 이룬다.
 * - 정상 종료(onunload)엔 파일을 삭제해 daemon 이 30s 대기 없이 즉시 인계받게 한다.
 */
const HEARTBEAT_FILE = 'ogs-plugin-alive';
const WRITE_INTERVAL_MS = 10_000; // daemon staleness(30s)의 1/3 — 갱신 누락 한두 번은 견딤

export class Heartbeat {
  private timer = 0;
  private readonly path: string;

  constructor(basePath: string) {
    this.path = join(basePath, '.git', HEARTBEAT_FILE);
  }

  start(): void {
    this.beat(); // 즉시 한 번 — 시작 직후부터 daemon 후퇴
    this.timer = window.setInterval(() => this.beat(), WRITE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
    try {
      rmSync(this.path); // 정상 종료 = 즉시 daemon 인계 (없으면 무시)
    } catch {
      /* 이미 없음/.git 없음 — 무시 */
    }
  }

  private beat(): void {
    try {
      writeFileSync(this.path, `${Date.now()}\n`);
    } catch {
      /* .git 미존재 등 — 다음 주기에 재시도 */
    }
  }
}
