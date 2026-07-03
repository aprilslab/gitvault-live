import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import { simpleGit } from 'simple-git';
import { hostname } from 'os';
import type GitSyncPlugin from './main';

export interface OgsSettings {
  /** 대상 repo URL (토큰 없이 표시용). 예: https://github.com/owner/repo.git */
  repoUrl: string;
  /** 인증 username. 비우면 토큰 단독(GitHub/Gitea). GitLab 은 oauth2 권장. */
  username: string;
  /** 액세스 토큰 (기기 로컬 저장). */
  token: string;
  /** 안정적 기기 식별자 — 최초 로드시 생성·영속. wip/<deviceId> 및 커밋 identity. */
  deviceId: string;
  /** 자동 fetch/sync 주기(초). */
  autoSyncSeconds: number;
  /** 에디터 본문에 변경 라인 인라인 하이라이트 표시(에디터 버퍼 기준 인메모리 diff — 타이핑 즉시 반영). */
  showInlineChanges: boolean;
  /** 라인 작성자(blame) 거터 표시. 커맨드 ogs-toggle-line-blame 로 토글. */
  showLineBlame: boolean;
}

export const DEFAULT_SETTINGS: OgsSettings = {
  repoUrl: '',
  username: '',
  token: '',
  deviceId: '',
  autoSyncSeconds: 5,
  showInlineChanges: false,
  showLineBlame: true,
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'device';
}

/** hostname-slug + 랜덤 4자리(base36). 같은 기종 2대의 wip 브랜치 상호 파괴 방지. */
export function generateDeviceId(): string {
  const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  let host = 'device';
  try {
    host = slug(hostname());
  } catch {
    /* hostname 불가 시 기본값 */
  }
  return `${host}-${suffix}`;
}

/**
 * 표시용 repoUrl + 자격증명 → 인증 포함 remote URL. 플랫폼 무관(순수 URL 조작).
 * - username 있으면 `https://<user>:<token>@host/path`
 * - username 없으면 `https://<token>@host/path` (GitHub/Gitea; GitLab 은 username=oauth2 권장)
 * URL 파서가 host/path 를 그대로 보존하므로 on-prem 사내 도메인도 지원.
 */
export function buildAuthedRemote(s: Pick<OgsSettings, 'repoUrl' | 'username' | 'token'>): string {
  const raw = s.repoUrl.trim();
  if (!raw) return '';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw; // scp-형(git@host:path) 등은 그대로 — 토큰 인증 대상 아님
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return raw;
  if (s.token) {
    if (s.username.trim()) {
      u.username = s.username.trim(); // URL setter 가 특수문자 percent-encode
      u.password = s.token;
    } else {
      u.username = s.token;
      u.password = '';
    }
  }
  return u.toString();
}

export class GitSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: GitSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName('저장소 URL')
      .setDesc('HTTPS 주소. 예: https://github.com/owner/vault.git · https://gitlab.example.com/team/vault.git')
      .addText((t) =>
        t
          .setPlaceholder('https://host/owner/repo.git')
          .setValue(s.repoUrl)
          .onChange(async (v) => {
            s.repoUrl = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('사용자명 (선택)')
      .setDesc('비우면 토큰 단독(GitHub/Gitea). GitLab 은 oauth2 를 권장.')
      .addText((t) =>
        t
          .setPlaceholder('(비움) 또는 oauth2')
          .setValue(s.username)
          .onChange(async (v) => {
            s.username = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('액세스 토큰')
      .setDesc('대상 repo 쓰기 권한 토큰. 이 기기에만 저장됩니다(공용 PC 주의).')
      .addText((t) => {
        t.setPlaceholder('ghp_… / glpat-…')
          .setValue(s.token)
          .onChange(async (v) => {
            s.token = v.trim();
            await this.plugin.saveSettings();
          });
        t.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('연결 테스트')
      .setDesc('git ls-remote 로 접속을 확인합니다.')
      .addButton((b) =>
        b.setButtonText('테스트').onClick(async () => {
          b.setDisabled(true).setButtonText('확인 중…');
          const ok = await this.testConnection();
          b.setDisabled(false).setButtonText('테스트');
          new Notice(ok ? '연결 성공 ✓' : '연결 실패 — URL/토큰/권한을 확인하세요.');
        }),
      );

    new Setting(containerEl)
      .setName('자동 동기화 주기(초)')
      .setDesc('원격 변경을 가져오고 패널을 갱신하는 주기. 최소 3초(낮출수록 git 부하↑).')
      .addText((t) =>
        t.setValue(String(s.autoSyncSeconds)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 3) {
            s.autoSyncSeconds = Math.floor(n);
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName('변경 라인 인라인 표시 (실험적)')
      .setDesc('공식본(main)과 다른 라인을 에디터 본문에 파란색으로 표시. 타이핑에 즉시 반응(인메모리 diff).')
      .addToggle((t) =>
        t.setValue(s.showInlineChanges).onChange(async (v) => {
          s.showInlineChanges = v;
          await this.plugin.saveSettings();
          await this.plugin.applySettings();
        }),
      );

    new Setting(containerEl)
      .setName('이 기기 ID')
      .setDesc('작업 브랜치 wip/<id> 및 커밋 작성자에 사용됩니다.')
      .addText((t) => t.setValue(s.deviceId).setDisabled(true));

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText('지금 다시 연결/동기화')
        .setCta()
        .onClick(async () => {
          await this.plugin.applySettings();
          new Notice('다시 연결했습니다.');
        }),
    );
  }

  private async testConnection(): Promise<boolean> {
    const s = this.plugin.settings;
    const url = buildAuthedRemote(s);
    if (!url) return false;
    const base = this.plugin.getBasePath();
    try {
      const git = simpleGit(base ?? undefined, { timeout: { block: 15_000 } });
      await git.listRemote([url, 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }
}
