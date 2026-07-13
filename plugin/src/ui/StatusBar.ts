export type SyncState = 'synced' | 'syncing' | 'pending' | 'error' | 'off';

export type OutgoingFile = { status: string; path: string };

export function statusLabel(s: string): string {
  if (s.startsWith('A')) return '새 파일';
  if (s.startsWith('D')) return '삭제';
  if (s.startsWith('R')) return '이동';
  return '수정';
}

/** hover 툴팁용 미저장 파일 요약 (최대 max 줄 + "…외 N개"). */
export function outgoingSummary(files: OutgoingFile[], max = 8): string {
  const lines = files.slice(0, max).map((f) => `${statusLabel(f.status)} · ${f.path}`);
  if (files.length > max) lines.push(`…외 ${files.length - max}개`);
  return lines.join('\n');
}

/** 상태바 표시 계산(순수) — sync 상태 + outgoing 파일을 합쳐 text/tooltip 을 낸다.
 * [핵심] tooltip 은 언제나 저장된 outgoing 목록에서 만든다. sync 상태 갱신(set())과 파일 갱신
 * (setOutgoing())이 같은 칸을 각각 쓰면서 서로 덮어 tooltip 이 사라지던 버그를 없앤다. */
export function computeStatus(
  state: SyncState,
  detail: string | undefined,
  outgoing: OutgoingFile[],
): { text: string; tooltip: string; cls: '' | 'mod-error' | 'mod-syncing' | 'mod-pending' } {
  // error 최우선 — 원인을 tooltip 으로 노출.
  if (state === 'error') {
    return { text: detail ? `Git: 오류(${detail})` : 'Git: 오류', tooltip: detail || '동기화 오류', cls: 'mod-error' };
  }
  const n = outgoing.length;
  // outgoing 이 있으면 그게 사용자에게 가장 의미있는 신호 — 파일목록 tooltip 유지(idle sync 가 덮지 않음).
  if (n > 0) {
    const head = state === 'syncing' ? '동기화 중… ' : '';
    return {
      text: `Git: ${head}저장 대기 ${n}`,
      tooltip: `클릭하면 목록\n${outgoingSummary(outgoing)}`,
      cls: state === 'syncing' ? 'mod-syncing' : 'mod-pending',
    };
  }
  // outgoing 0 → sync 상태 문구.
  switch (state) {
    case 'syncing':
      return { text: 'Git: 동기화 중…', tooltip: '', cls: 'mod-syncing' };
    case 'pending':
      return { text: detail ? `Git: ${detail} 대기` : 'Git: 변경 대기', tooltip: '', cls: 'mod-pending' };
    case 'off':
      return { text: 'Git: 미연결', tooltip: '', cls: '' };
    case 'synced':
    default:
      return { text: 'Git: 저장됨', tooltip: '모든 변경이 공식본(main)에 반영됨', cls: '' };
  }
}

/** 상태바 한 칸. 동기화 상태를 비개발자 친화 문구로 표시. */
export class StatusBar {
  private outgoing: OutgoingFile[] = [];
  private state: SyncState = 'off';
  private detail?: string;

  constructor(
    private readonly el: HTMLElement,
    onOutgoingClick?: (files: OutgoingFile[], evt: MouseEvent) => void,
  ) {
    el.addClass('ogs-statusbar');
    if (onOutgoingClick) {
      el.addClass('mod-clickable');
      el.addEventListener('click', (evt) => {
        if (this.outgoing.length > 0) onOutgoingClick(this.outgoing, evt);
      });
    }
    this.render();
  }

  /** 발행 상태: main 대비 미저장 파일. 0 이면 "저장됨", >0 이면 "저장 대기 N" + hover 시 목록. */
  setOutgoing(files: OutgoingFile[]): void {
    this.outgoing = files;
    this.render();
  }

  set(state: SyncState, detail?: string): void {
    this.state = state;
    this.detail = detail;
    this.render();
  }

  /** 저장된 sync 상태 + outgoing 을 합쳐 한 번에 그린다 — 두 갱신 경로가 서로 덮지 않도록 단일 렌더. */
  private render(): void {
    const { text, tooltip, cls } = computeStatus(this.state, this.detail, this.outgoing);
    this.el.removeClass('mod-error', 'mod-syncing', 'mod-pending');
    if (cls) this.el.addClass(cls);
    this.el.setText(text);
    this.el.setAttr('aria-label', tooltip);
  }
}
