export type SyncState = 'synced' | 'syncing' | 'pending' | 'error' | 'off';

/** 상태바 한 칸. 동기화 상태를 비개발자 친화 문구로 표시. */
export class StatusBar {
  constructor(private readonly el: HTMLElement) {
    el.addClass('ogs-statusbar');
    this.set('off');
  }

  set(state: SyncState, detail?: string): void {
    this.el.removeClass('mod-error', 'mod-syncing');
    let text: string;
    switch (state) {
      case 'synced':
        text = 'Git: 동기화됨';
        break;
      case 'syncing':
        text = 'Git: 동기화 중…';
        this.el.addClass('mod-syncing');
        break;
      case 'pending':
        text = detail ? `Git: ${detail} 대기` : 'Git: 변경 대기';
        break;
      case 'error':
        text = detail ? `Git: 오류(${detail})` : 'Git: 오류';
        this.el.addClass('mod-error');
        break;
      default:
        text = 'Git: 미연결';
    }
    this.el.setText(text);
    if (detail && state === 'error') this.el.setAttr('aria-label', detail);
  }
}
