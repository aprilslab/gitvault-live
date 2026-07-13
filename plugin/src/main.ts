import { Plugin, MarkdownView, FileSystemAdapter, Notice, Platform, Menu, TFile, debounce } from 'obsidian';
import { existsSync } from 'fs';
import { join } from 'path';
import type { EditorView } from '@codemirror/view';
import {
  OgsSettings,
  DEFAULT_SETTINGS,
  GitSyncSettingTab,
  generateDeviceId,
  buildAuthedRemote,
  detectDisplayName,
} from './settings';
import { GitManager } from './git/GitManager';
import { AutoSync } from './sync/AutoSync';
import { Heartbeat } from './sync/Heartbeat';
import { StatusBar, outgoingSummary, statusLabel } from './ui/StatusBar';
import type { OutgoingFile } from './ui/StatusBar';
import { HistoryPanel, VIEW_TYPE_OGS_HISTORY } from './ui/HistoryPanel';
import { collabDecorations, pushHunks } from './editor/CollabDecorations';
import { blameGutter, pushBlame } from './editor/BlameGutter';
import { alignBlame } from './editor/blameLines';
import type { BlameLine } from './git/GitManager';
import { saveKeymap } from './editor/saveKeymap';
import { diffLines } from './editor/lineDiff';
import { mergePeerHunks } from './editor/peerPresence';
import type { PeerWip } from './git/GitManager';

const COMMIT_DEBOUNCE_MS = 3_000;
const DECO_DEBOUNCE_MS = 300; // 타이핑 → 인라인 데코 갱신 지연 (키입력마다가 아닌 잠깐 멈출 때)

export default class GitSyncPlugin extends Plugin {
  settings!: OgsSettings;
  private git?: GitManager;
  private autoSync?: AutoSync;
  private heartbeat?: Heartbeat;
  private statusBar?: StatusBar;
  private saveBadge?: HTMLElement;
  private saveNotice?: Notice;
  private publishing = false;
  private applyChain: Promise<void> = Promise.resolve();
  /** path → origin/main 파일 내용(없으면 null). fetch/커밋/저장 후(refreshCollab) 무효화. */
  private readonly mainCache = new Map<string, string | null>();
  private readonly blameCache = new Map<string, BlameLine[]>();
  /** 자기 제외 타 참여자의 진행 중 wip 브랜치 목록. refreshCollab(sync 시)에서만 갱신. */
  private peerWips: PeerWip[] = [];
  /** peer wip 파일 내용 캐시. key: `${ref}\0${path}`. refreshCollab 에서 무효화 — 타이핑 중엔 git 호출 없음. */
  private readonly peerContentCache = new Map<string, string | null>();
  /** 에디터별 마지막 hunk 직렬화 키 — 불변이면 dispatch/데코 재빌드 생략. */
  private readonly lastHunksKey = new WeakMap<EditorView, string>();
  /** 에디터별 마지막 blame 작성자 직렬화 키 — 불변이면 dispatch/거터 재빌드 생략. */
  private readonly lastBlameKey = new WeakMap<EditorView, string>();
  /** 타이핑 중 데코 갱신 디바운서 (editor-change 마다 타이머 리셋). */
  private readonly decoDebounce = debounce(
    () => {
      void this.refreshActiveDecorations();
      void this.refreshLineBlame();
    },
    DECO_DEBOUNCE_MS,
    true,
  );

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBar = new StatusBar(this.addStatusBarItem(), (files, evt) =>
      this.showOutgoingMenu(files, evt),
    );
    this.addSettingTab(new GitSyncSettingTab(this.app, this));

    // 협업 인라인 데코레이션 + Cmd/Ctrl+S 저장 keymap (CM6, Source/라이브프리뷰).
    this.registerEditorExtension([
      collabDecorations(),
      blameGutter(),
      saveKeymap(() => void this.publishNow()),
    ]);

    // 저장 안 된 변경이 있을 때 우측하단에 뜨는 클릭형 저장 버튼(리본 대체 + 미저장 표시).
    this.saveBadge = document.body.createDiv({ cls: 'ogs-save-badge' });
    this.saveBadge.hide();
    this.saveBadge.addEventListener('click', () => void this.publishNow());
    this.register(() => this.saveBadge?.remove());

    // 파일 이력 패널 (활성 노트의 git 커밋 이력).
    this.registerView(VIEW_TYPE_OGS_HISTORY, (leaf) => new HistoryPanel(leaf, () => this.git));

    this.addRibbonIcon('git-branch', 'GitVault Live: 지금 동기화', () => void this.applySettings());
    this.addRibbonIcon('history', 'GitVault Live: 파일 이력', () => void this.activateHistoryPanel());
    this.addRibbonIcon('save', 'GitVault Live: 저장(공식본에 반영)', () => void this.publishNow());
    this.addCommand({
      id: 'ogs-sync-now',
      name: '지금 동기화 / 다시 연결',
      callback: () => void this.applySettings(),
    });
    this.addCommand({
      id: 'ogs-open-history-panel',
      name: '파일 이력 패널 열기',
      callback: () => void this.activateHistoryPanel(),
    });
    this.addCommand({
      id: 'ogs-save',
      name: '저장 — 공식본에 반영',
      callback: () => void this.publishNow(),
    });
    this.addCommand({
      id: 'ogs-toggle-line-blame',
      name: '라인 작성자(blame) 거터 토글',
      callback: async () => {
        this.settings.showLineBlame = !this.settings.showLineBlame;
        await this.saveSettings();
        new Notice(`라인 blame ${this.settings.showLineBlame ? '켜짐' : '꺼짐'}`);
        void this.refreshLineBlame();
      },
    });
    // Cmd/Ctrl+S 는 위 registerEditorExtension 의 saveKeymap(Prec.highest)이 처리한다.

    // 활성 노트 전환 시 데코레이션 재계산. active-leaf-change 는 같은 탭 내 파일 전환(link/뒤로가기)엔
    // 안 뜨므로 file-open 도 함께 등록 — 안 그러면 이전 파일 데코가 새 문서에 남는다.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        void this.refreshActiveDecorations();
        void this.refreshLineBlame();
      }),
    );
    this.registerEvent(
      this.app.workspace.on('file-open', () => {
        void this.refreshActiveDecorations();
        void this.refreshLineBlame();
      }),
    );
    // 타이핑(엔터 포함)에 즉시 반응 — 버퍼 기준 인메모리 diff 라 디스크 저장을 기다리지 않는다.
    this.registerEvent(this.app.workspace.on('editor-change', () => this.decoDebounce()));

    // 시작 커밋 폭주 방지: 레이아웃 준비 후에 감시 시작. 이후 daemon 설치상태를 1회 조정.
    this.app.workspace.onLayoutReady(() => {
      void this.applySettings().then(() => this.reconcileDaemonOnce());
    });
  }

  onunload(): void {
    this.autoSync?.stop();
    this.heartbeat?.stop(); // heartbeat 파일 삭제 → daemon 즉시 인계
  }

  /** vault 워킹트리 절대경로 (데스크톱 전용 — 아니면 null). */
  getBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  /**
   * 설정으로 GitManager/AutoSync 를 (재)구성하고 repo 를 보장한다. 설정 변경·리본·시작 시 호출.
   * 동시/중첩 호출은 직렬화한다 — 두 GitManager 가 같은 `.git/index.lock` 에서 충돌하는 것 방지.
   */
  applySettings(): Promise<void> {
    this.applyChain = this.applyChain.catch(() => undefined).then(() => this.applySettingsLocked());
    return this.applyChain;
  }

  private async applySettingsLocked(): Promise<void> {
    this.autoSync?.stop();
    this.heartbeat?.stop();

    const base = this.getBasePath();
    if (!base) {
      this.statusBar?.set('error', '데스크톱 전용');
      return;
    }
    // Obsidian 이 이 vault 에 떠 있는 동안 daemon 을 후퇴시킨다 — remote 설정 여부와 무관하게 시작.
    this.heartbeat = new Heartbeat(base);
    this.heartbeat.start();

    const authedRemote = buildAuthedRemote(this.settings);
    // 토큰(및 URL) 없이도 vault 에 이미 origin 이 있으면 그걸로 동작 — 기기의 git 자격증명 재사용.
    const vaultIsRepo = existsSync(join(base, '.git'));
    if (!authedRemote && !vaultIsRepo) {
      this.statusBar?.set('off');
      return;
    }

    const flushEditors = async (): Promise<void> => {
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (view instanceof MarkdownView) await view.save();
      }
    };

    // displayName 비었으면 git global user.name → OS 로그인 이름 → 홈 디렉터리 이름 자동 감지.
    const displayName = this.settings.displayName.trim() || (await detectDisplayName(base));

    this.git = new GitManager({
      basePath: base,
      authedRemote,
      bakeCredentials: !!this.settings.token.trim(), // 토큰 입력 시에만 origin URL 덮어씀
      deviceId: this.settings.deviceId,
      displayName,
      flushEditors,
      log: (m) => console.error('[gitvault-live]', m),
    });

    this.statusBar?.set('syncing');
    try {
      await this.git.ensureRepo();
      this.statusBar?.set('synced');
    } catch (e) {
      this.statusBar?.set('error', e instanceof Error ? e.message.split('\n')[0] : String(e));
      return;
    }

    this.autoSync = new AutoSync({
      app: this.app,
      git: this.git,
      debounceMs: COMMIT_DEBOUNCE_MS,
      syncSeconds: this.settings.autoSyncSeconds,
      onState: (s, d) => this.statusBar?.set(s, d),
      onSynced: () => void this.refreshCollab(),
    });
    this.autoSync.start();
    void this.refreshCollab();
  }

  /** daemon 설치·push 가 가능한 remote 가 갖춰졌는지 — repo URL 입력됐거나 vault 가 이미 git repo(origin 보유). */
  isRemoteConfigured(): boolean {
    const base = this.getBasePath();
    if (!base) return false;
    return !!buildAuthedRemote(this.settings) || existsSync(join(base, '.git'));
  }

  /** 플러그인에 번들된 daemon.js 절대경로 (설치 시 사용자 위치로 복사). */
  private daemonSrcPath(base: string): string {
    const dir = this.manifest.dir ?? join('.obsidian', 'plugins', this.manifest.id);
    return join(base, dir, 'daemon.js');
  }

  /**
   * 로컬 daemon 설치 시도. remote 미설정이면 설치하지 않고 false.
   * 성공 시 daemonEnabled=true, 실패 시 false 로 내려 매 로드마다 재시도하지 않는다.
   */
  async enableDaemon(): Promise<boolean> {
    const base = this.getBasePath();
    if (!base) {
      new Notice('daemon: vault 경로를 얻지 못했습니다(데스크톱 전용).');
      return false;
    }
    if (!this.isRemoteConfigured()) {
      new Notice('daemon 설치 전에 저장소 URL(또는 기존 origin)을 먼저 설정하세요.', 8_000);
      return false;
    }
    try {
      const { installDaemon } = await import('./sync/DaemonInstall');
      // 토큰은 넘기지 않는다 — 데스크톱은 기기 git 자격증명(osxkeychain 등) 재사용. vault 에 origin 있으면 remote 생략.
      const vaultIsRepo = existsSync(join(base, '.git'));
      const remote = vaultIsRepo ? undefined : this.settings.repoUrl.trim() || undefined;
      await installDaemon({
        vaultPath: base,
        daemonSrc: this.daemonSrcPath(base),
        deviceId: this.settings.deviceId,
        remote,
      });
      this.settings.daemonEnabled = true;
      await this.saveSettings();
      new Notice('✓ 로컬 daemon 설치됨 — Obsidian 종료 후에도 변경을 origin/main 에 반영합니다.', 6_000);
      return true;
    } catch (e) {
      this.settings.daemonEnabled = false;
      await this.saveSettings();
      new Notice('daemon 설치 실패: ' + (e instanceof Error ? e.message.split('\n')[0] : String(e)), 10_000);
      return false;
    }
  }

  /** 로컬 daemon 중지·제거 + 토글 off 저장. */
  async disableDaemon(): Promise<void> {
    this.settings.daemonEnabled = false;
    await this.saveSettings();
    const base = this.getBasePath();
    if (!base) return;
    try {
      const { uninstallDaemon } = await import('./sync/DaemonInstall');
      await uninstallDaemon(base);
      new Notice('로컬 daemon 을 중지·제거했습니다.');
    } catch (e) {
      new Notice('daemon 제거 실패(수동 확인 필요): ' + (e instanceof Error ? e.message.split('\n')[0] : String(e)), 8_000);
    }
  }

  /** 세션당 1회만 실행되는 daemon 상태 조정 가드. */
  private daemonReconciled = false;

  private reconcileDaemonOnce(): void {
    if (this.daemonReconciled) return;
    this.daemonReconciled = true;
    void this.reconcileDaemon();
  }

  /**
   * 토글(daemonEnabled)과 실제 설치상태를 일치시킨다.
   * - 설치돼 있으면 토글 on 으로 맞춤.
   * - 미설치 + 토글 on + remote 설정됨 → 기본 동작으로 설치(무음). 실패하면 enableDaemon 이 off 로 내림.
   * - 미설치 + 토글 on + remote 미설정 → 설치 불가 → off.
   * - 미설치 + 토글 off → 사용자가 끈 것, 아무것도 안 함.
   */
  private async reconcileDaemon(): Promise<void> {
    try {
      const { detectDaemon } = await import('./sync/DaemonInstall');
      const status = await detectDaemon(this.getBasePath() ?? undefined);
      if (status === 'unsupported' || status === 'unknown') return;
      if (status === 'installed') {
        if (!this.settings.daemonEnabled) {
          this.settings.daemonEnabled = true;
          await this.saveSettings();
        }
        return;
      }
      // status === 'missing'
      if (!this.settings.daemonEnabled) return;
      if (this.isRemoteConfigured()) {
        await this.enableDaemon();
      } else {
        this.settings.daemonEnabled = false;
        await this.saveSettings();
      }
    } catch {
      /* 감지 실패는 조용히 무시 — 수동 설치 경로 유지 */
    }
  }

  /** 패널 + 활성 에디터 데코레이션 + "저장 대기 N" 상태바를 함께 갱신 (sync/커밋/저장 시). */
  private async refreshCollab(): Promise<void> {
    this.mainCache.clear(); // origin/main 이 움직였을 수 있는 시점 — 데코 diff 기준 무효화
    this.blameCache.clear();
    this.peerContentCache.clear(); // peer wip 내용도 이 시점 이후 stale — 무효화
    this.refreshPanels();
    try {
      this.peerWips = this.git ? await this.git.listPeerWips() : [];
    } catch {
      this.peerWips = [];
    }
    await this.refreshActiveDecorations();
    await this.refreshLineBlame();
    await this.updatePublishStatus();
  }

  /** main 대비 미저장(outgoing) 파일 수를 상태바 + 플로팅 저장 버튼에 반영. */
  private async updatePublishStatus(): Promise<void> {
    if (!this.git) return;
    try {
      const outgoing = await this.git.outgoingFiles();
      this.statusBar?.setOutgoing(outgoing);
      this.updateSaveBadge(outgoing);
    } catch {
      /* 오프라인/일시 오류 — 상태 유지 */
    }
  }

  private updateSaveBadge(files: OutgoingFile[]): void {
    const badge = this.saveBadge;
    if (!badge) return;
    if (files.length > 0) {
      const key = Platform.isMacOS ? '⌘⇧S' : 'Ctrl+Shift+S';
      badge.setText(`● ${files.length}개 저장 안 됨 — 저장 (${key})`);
      // Obsidian 툴팁(aria-label) 사용 — 네이티브 title 은 Electron 에서 안 뜨거나 지연. 상태바와 동일 방식.
      badge.setAttr('aria-label', `클릭하면 저장\n${outgoingSummary(files)}`);
      badge.setAttr('aria-label-position', 'top'); // 하단 고정 배지 위로 표시
      badge.show();
    } else {
      badge.hide();
    }
  }

  /** 상태바 "저장 대기 N" 클릭 → 미저장 파일 목록 메뉴. 파일 클릭 시 열기. */
  private showOutgoingMenu(files: OutgoingFile[], evt: MouseEvent): void {
    const MAX = 15;
    const menu = new Menu();
    for (const f of files.slice(0, MAX)) {
      menu.addItem((item) => {
        item.setTitle(`${statusLabel(f.status)} · ${f.path}`);
        item.setIcon(f.status.startsWith('D') ? 'trash-2' : 'file-text');
        if (!f.status.startsWith('D')) {
          item.onClick(() => {
            const af = this.app.vault.getAbstractFileByPath(f.path);
            if (af instanceof TFile) void this.app.workspace.getLeaf().openFile(af);
          });
        }
      });
    }
    if (files.length > MAX) {
      menu.addItem((item) => item.setTitle(`…외 ${files.length - MAX}개`).setDisabled(true));
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle('지금 저장 — 공식본에 반영').setIcon('save').onClick(() => void this.publishNow()),
    );
    menu.showAtMouseEvent(evt);
  }

  private refreshPanels(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OGS_HISTORY)) {
      const view = leaf.view;
      if (view instanceof HistoryPanel) void view.refresh();
    }
  }

  /**
   * 활성 markdown 노트의 origin/main 대비 hunk 를 CM6 데코레이션으로 반영(설정 켜졌을 때만).
   * 에디터 버퍼를 직접 인메모리 diff — 디스크 저장/git 프로세스에 의존하지 않아 타이핑에 즉시 반응.
   * origin/main 내용은 mainCache 에 캐시(sync 시점 무효화) → 키입력 빈도 갱신은 git spawn 0회.
   */
  private async refreshActiveDecorations(): Promise<void> {
    if (!this.git) return;
    const git = this.git; // await 넘어 좁혀진 타입 유실 방지용 로컬 바인딩
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return;
    const cm = editorViewOf(view);
    if (!cm) return; // 리딩 모드 등 — 무시
    if (!this.settings.showInlineChanges) {
      pushHunks(cm, []); // 꺼졌으면 남은 데코 제거
      return;
    }
    const path = view.file.path;
    try {
      let base = this.mainCache.get(path);
      if (base === undefined) {
        base = await git.mainFileContent(path);
        this.mainCache.set(path, base);
      }
      const buffer = cm.state.doc.toString();
      // (a) 내 편집 하이라이트: origin/main 대비 내가 추가/변경한 줄(newCount>0 훅만)
      const mineHunks = base === null ? [] : diffLines(base, buffer).filter((h) => h.newCount > 0);
      // (b) 작성 중 배지: 타 참여자 wip 내용 vs 공유 base(origin/main) — 내 버퍼가 아니다.
      // [CRITICAL] 버퍼 기준으로 diff 하면 내가 편집 중인 origin/main 줄이 peer 의 원본과 달라져
      // "peer 가 작성 중"으로 오탐된다(실은 내 편집). base 기준이면 peer 배지는 내 편집과 무관해진다.
      // base 가 없으면(신규 노트 등 origin/main 에 없음) 비교할 공유 기준이 없으므로 presence 를 건너뛴다.
      const peers: { author: string; content: string }[] = [];
      if (base !== null) {
        for (const p of this.peerWips) {
          const cacheKey = `${p.ref}\0${path}`;
          let content = this.peerContentCache.get(cacheKey);
          if (content === undefined) {
            content = await git.peerWipContent(p.ref, path);
            this.peerContentCache.set(cacheKey, content);
          }
          if (content !== null) peers.push({ author: p.author, content });
        }
      }
      const peerHunks = base === null ? [] : mergePeerHunks(peers, base);
      const hunks = [...mineHunks, ...peerHunks];
      const key = JSON.stringify(hunks); // hunks 가 author 를 포함 → 별도 키 불필요
      if (this.lastHunksKey.get(cm) === key) return; // 불변 — dispatch/재빌드 생략
      this.lastHunksKey.set(cm, key);
      pushHunks(cm, hunks);
    } catch {
      /* 일시 오류 — 데코레이션 갱신만 건너뜀 */
    }
  }

  /**
   * 활성 노트 각 줄에 origin/main 작성자를 거터로 표시(showLineBlame 켜졌을 때).
   * blame git 페치는 file-open/sync 시점만 → blameCache. 타이핑은 인메모리 alignBlame(git 0회).
   */
  private async refreshLineBlame(): Promise<void> {
    if (!this.git) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return;
    const cm = editorViewOf(view);
    if (!cm) return; // 리딩 모드 등 — 무시
    if (!this.settings.showLineBlame) {
      this.lastBlameKey.set(cm, '[]');
      pushBlame(cm, []); // 꺼졌으면 거터 비움
      return;
    }
    const path = view.file.path;
    try {
      let base = this.mainCache.get(path);
      if (base === undefined) {
        base = await this.git.mainFileContent(path);
        this.mainCache.set(path, base);
      }
      // origin/main 에 없는 신규 노트 → 전부 로컬 → 거터 빈칸 (blame git 페치 자체를 생략)
      let authors: (BlameLine | null)[] = [];
      if (base !== null) {
        let blame = this.blameCache.get(path);
        if (blame === undefined) {
          blame = await this.git.mainBlameLines(path);
          this.blameCache.set(path, blame);
        }
        authors = alignBlame(base, cm.state.doc.toString(), blame);
      }
      const key = JSON.stringify(authors);
      if (this.lastBlameKey.get(cm) === key) return; // 불변 — dispatch/재빌드 생략
      this.lastBlameKey.set(cm, key);
      pushBlame(cm, authors);
    } catch {
      /* 일시 오류 — blame 갱신만 건너뜀 */
    }
  }

  private async activateHistoryPanel(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_OGS_HISTORY)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_OGS_HISTORY, active: true });
    workspace.revealLeaf(leaf);
  }

  /** 확인 모달 없이 바로 발행(squash-to-main). 결과는 단일 토스트(쌓이지 않게 이전 것 교체). */
  private async publishNow(): Promise<void> {
    if (!this.git) {
      this.toast('아직 연결되지 않았습니다 — 설정에서 저장소를 연결하세요.');
      return;
    }
    if (this.publishing) return; // 중복 실행 방지
    this.publishing = true;
    try {
      const files = await this.git.outgoingFiles();
      if (files.length === 0) {
        this.toast('저장할 변경이 없습니다.');
        return;
      }
      this.toast('저장 중…');
      const result = await this.git.squashMergeToMain();
      if (result === 'saved') {
        const shown = files.slice(0, 8).map((f) => `${statusMark(f.status)} ${f.path}`);
        const more = files.length - shown.length;
        const body = shown.join('\n') + (more > 0 ? `\n… 외 ${more}개` : '');
        this.toast(`✓ 저장됨 (${files.length}개)\n${body}`);
      } else {
        this.toast('저장할 변경이 없습니다.');
      }
      await this.refreshCollab();
    } catch (e) {
      this.toast(`저장 실패: ${firstLine(e)}`);
    } finally {
      this.publishing = false;
    }
  }

  /** 단일 토스트 — 이전 것을 숨기고 새로 띄워 쌓이지 않게 한다. 여러 줄(\n)은 줄바꿈 렌더. */
  private toast(text: string): void {
    this.saveNotice?.hide();
    const frag = document.createDocumentFragment();
    text.split('\n').forEach((line, i) => {
      if (i > 0) frag.appendChild(document.createElement('br'));
      frag.appendChild(document.createTextNode(line));
    });
    this.saveNotice = new Notice(frag, 6000);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.deviceId) {
      this.settings.deviceId = generateDeviceId();
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

/** Obsidian 의 MarkdownView 에서 내부 CM6 EditorView 를 꺼낸다(공식 타입 미노출 → 캐스팅). */
function editorViewOf(view: MarkdownView): EditorView | undefined {
  return (view.editor as unknown as { cm?: EditorView }).cm;
}

function firstLine(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split('\n')[0].slice(0, 120);
}

function statusMark(status: string): string {
  const c = status[0];
  if (c === 'A') return '＋';
  if (c === 'D') return '－';
  if (c === 'R') return '↦';
  return '·';
}
