import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import { simpleGit } from 'simple-git';
import { hostname, homedir, userInfo } from 'os';
import type GitSyncPlugin from './main';
import { detectDaemon, installDaemonWindows, type DaemonStatus } from './sync/DaemonInstall';

/**
 * blame·presence 표시이름 자동 감지 (설정의 displayName 이 비었을 때 사용).
 * 우선순위: git global user.name → OS 로그인 이름 → 홈 디렉터리 이름(/Users/jaei → jaei).
 * 전부 실패하면 '' (호출부가 deviceId 로 폴백).
 */
export async function detectDisplayName(basePath?: string): Promise<string> {
  try {
    const name = (await simpleGit(basePath ?? undefined).raw(['config', '--global', 'user.name'])).trim();
    if (name) return name;
  } catch {
    /* git 없음/미설정 — 다음 후보로 */
  }
  try {
    const u = userInfo().username?.trim();
    if (u) return u;
  } catch {
    /* userInfo 불가 */
  }
  try {
    const base = homedir().split(/[/\\]/).filter(Boolean).pop();
    if (base) return base;
  } catch {
    /* homedir 불가 */
  }
  return '';
}

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
  /** 협업 표시이름(blame·작성중 배지에 노출). 비우면 deviceId 사용. git user.name 으로 쓰임. */
  displayName: string;
  /** 로컬 daemon(백그라운드 커밋 상주)을 사용/설치 안내를 활성화. Off 면 daemon 미설치 안내를 표시하지 않는다. */
  daemonEnabled: boolean;
}

export const DEFAULT_SETTINGS: OgsSettings = {
  repoUrl: '',
  username: '',
  token: '',
  deviceId: '',
  autoSyncSeconds: 5,
  showInlineChanges: true,
  showLineBlame: true,
  displayName: '',
  daemonEnabled: true,
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

    new Setting(containerEl).setName('저장소 연결').setHeading();

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
      .setName('액세스 토큰 (선택)')
      .setDesc('대상 repo 쓰기 권한 토큰. 이 기기에만 저장됩니다(공용 PC 주의). 비우면 이 기기에 이미 설정된 git 자격증명(credential helper·SSH 키·기존 origin)을 사용합니다.')
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

    new Setting(containerEl).setName('동기화').setHeading();

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

    // ── 로컬 daemon 토글 + 상태 + 설치 버튼 ──
    // Obsidian 종료 후에도 파일 변경을 감지해 origin/main 에 커밋하는 백그라운드 상주 프로세스.
    // 같은 기기에 설치되면 heartbeat lease 로 플러그인과 자동 교대(중복 커밋 없음, INSTALL.md §3-4).
    new Setting(containerEl)
      .setName('로컬 daemon (백그라운드 커밋)')
      .setDesc('Obsidian 닫혀 있는 동안에도 vault 파일 변경을 감지해 origin/main 에 반영합니다. off 면 감지·설치 안내를 표시하지 않습니다.')
      .addToggle((t) =>
        t.setValue(s.daemonEnabled).onChange(async (v) => {
          s.daemonEnabled = v;
          await this.plugin.saveSettings();
          this.display(); // 감지·설치 UI 즉시 갱신
        }),
      );

    if (s.daemonEnabled) {
      const statusRow = new Setting(containerEl).setName('daemon 상태').setDesc('감지 중…');
      void detectDaemon().then((st) => this.renderDaemonStatus(statusRow, st));
    }

    new Setting(containerEl).setName('표시 · 협업').setHeading();

    new Setting(containerEl)
      .setName('변경 라인 인라인 표시')
      .setDesc('공식본(main)과 다른 라인을 에디터 본문에 파란색으로 표시. 타이핑에 즉시 반응(인메모리 diff).')
      .addToggle((t) =>
        t.setValue(s.showInlineChanges).onChange(async (v) => {
          s.showInlineChanges = v;
          await this.plugin.saveSettings();
          await this.plugin.applySettings();
        }),
      );

    new Setting(containerEl)
      .setName('수정한 사람 표시 (blame 거터)')
      .setDesc('각 줄을 공식본(main)에 마지막으로 저장한 사람과 시각을 좌측 거터에 표시.')
      .addToggle((t) =>
        t.setValue(s.showLineBlame).onChange(async (v) => {
          s.showLineBlame = v;
          await this.plugin.saveSettings();
          await this.plugin.applySettings();
        }),
      );

    new Setting(containerEl)
      .setName('표시 이름')
      .setDesc('blame·작성 중 배지에 보일 이름. 비우면 git user.name → 로그인 이름을 자동 사용합니다.')
      .addText((t) => {
        t.setPlaceholder('(자동 감지)')
          .setValue(s.displayName)
          .onChange(async (v) => {
            s.displayName = v.trim();
            await this.plugin.saveSettings();
            await this.plugin.applySettings(); // identity 재설정 반영
          });
        // 비어 있으면 자동 감지될 이름을 placeholder 로 미리 보여준다.
        if (!s.displayName) {
          void detectDisplayName(this.plugin.getBasePath() ?? undefined).then((name) => {
            if (name) t.setPlaceholder(`(자동: ${name})`);
          });
        }
      });

    new Setting(containerEl).setName('기기').setHeading();

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
    const base = this.plugin.getBasePath();
    try {
      const git = simpleGit(base ?? undefined, { timeout: { block: 15_000 } });
      // URL 있으면 그걸로, 없으면(토큰·URL 미입력) vault 의 기존 origin 으로 테스트.
      await git.listRemote([url || 'origin', 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * daemon 상태에 따라 statusRow 를 갱신 — 설치됨/미설치/미지원.
   * 미설치이고 Windows 라면 자동 설치 버튼을 노출(UAC 승인 필요, 원격 install.ps1 다운로드).
   */
  private renderDaemonStatus(row: Setting, status: DaemonStatus): void {
    if (status === 'installed') {
      row.setDesc('✓ 설치됨 (heartbeat lease 로 플러그인과 자동 교대)');
      return;
    }
    if (status === 'unsupported' || status === 'unknown') {
      row.setDesc(status === 'unsupported' ? '이 플랫폼에서는 감지·자동 설치 미지원' : '감지 실패 — 수동 확인 필요');
      return;
    }
    // status === 'missing'
    row.setDesc('✗ 미설치. Obsidian 종료 후에도 커밋을 이어가려면 daemon 설치 권장.');
    if (process.platform === 'win32') {
      row.addButton((b) =>
        b
          .setButtonText('지금 설치 (관리자 PS)')
          .setCta()
          .onClick(async () => {
            const base = this.plugin.getBasePath();
            if (!base) {
              new Notice('vault 경로를 얻지 못했습니다 (데스크톱 전용).');
              return;
            }
            b.setDisabled(true).setButtonText('UAC 대기…');
            try {
              await installDaemonWindows(base);
              new Notice('설치 요청 전송. UAC 승인 창을 확인하세요. 완료 후 이 화면을 새로 열어 상태 재확인.', 8_000);
            } catch (e) {
              new Notice('설치 실패: ' + (e instanceof Error ? e.message : String(e)), 8_000);
            } finally {
              b.setDisabled(false).setButtonText('지금 설치 (관리자 PS)');
            }
          }),
      );
    } else {
      row.addButton((b) =>
        b.setButtonText('설치 문서 열기').onClick(() => {
          window.open('https://github.com/aprilslab/gitvault-live/blob/main/INSTALL.md#3-daemon-서버--헤드리스-기기', '_blank');
        }),
      );
    }
  }
}
