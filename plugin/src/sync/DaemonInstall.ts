import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, copyFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

const pExec = promisify(exec);
const pExecFile = promisify(execFile);

export type DaemonStatus = 'installed' | 'missing' | 'unsupported' | 'unknown';

/** launchd/systemd 인스턴스·데몬 실행에 물려줄 최소 PATH (git·node 탐색용). */
const BASE_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * 로컬 daemon 설치 여부 감지 (플랫폼별 heuristic).
 * vaultPath 를 주면 그 vault 의 인스턴스(com.gitvault-live.<name> / gitvault-live@<name>)만 검사한다.
 * 여러 vault 를 쓸 때 다른 vault 의 daemon 을 자기 것으로 오판하지 않도록 인스턴스 단위로 좁힌다.
 * 실패/미지원 플랫폼은 unknown/unsupported 로 폴백.
 */
export async function detectDaemon(vaultPath?: string): Promise<DaemonStatus> {
  const name = vaultPath ? instanceName(vaultPath) : null;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await pExec('schtasks /Query /FO CSV /NH', { timeout: 10_000 });
      const needle = (name ? `gitvault-live-${name}` : 'gitvault-live').toLowerCase();
      return stdout.toLowerCase().includes(needle) ? 'installed' : 'missing';
    }
    if (process.platform === 'darwin') {
      const needle = name ? `com.gitvault-live.${name}` : 'gitvault-live';
      const { stdout } = await pExec(`launchctl list | grep -F ${shq(needle)} || true`, {
        timeout: 5_000,
        shell: '/bin/bash',
      });
      return stdout.trim() ? 'installed' : 'missing';
    }
    if (process.platform === 'linux') {
      // system 유닛 + 사용자(--user) 유닛 둘 다 검사 (데스크톱은 --user 로 설치됨).
      const needle = name ? `gitvault-live@${name}` : 'gitvault-live';
      const { stdout } = await pExec(
        '{ systemctl list-units --no-pager --type=service --all 2>/dev/null; ' +
          'systemctl --user list-units --no-pager --type=service --all 2>/dev/null; } ' +
          `| grep -F ${shq(needle)} || true`,
        { timeout: 5_000, shell: '/bin/bash' },
      );
      return stdout.trim() ? 'installed' : 'missing';
    }
    return 'unsupported';
  } catch {
    return 'unknown';
  }
}

/** install.sh 와 동일한 slug 규칙 (소문자화 → 비영숫자 런을 '-' 로 축약 → 양끝 '-' 제거). */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** vault 폴더명 기반 인스턴스 이름 (install.sh 기본값과 일치 — 감지/제거가 서로 맞물리게). */
export function instanceName(vaultPath: string): string {
  const base = vaultPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
  return slug(base) || 'vault';
}

export interface DesktopInstallOpts {
  /** 감시 대상 vault 워킹트리 절대경로. */
  vaultPath: string;
  /** 플러그인에 번들된 daemon.js 절대경로 (사용자 위치로 복사됨). */
  daemonSrc: string;
  /** 커밋 주체 식별자. */
  deviceId: string;
  /** 대상 repo URL (토큰 없이). 비우면 daemon 이 vault 의 기존 origin 을 재사용. 토큰은 절대 넣지 않는다. */
  remote?: string;
}

/**
 * 데스크톱(사용자 권한, sudo 없음) daemon 설치 — macOS launchd / Linux systemd --user.
 * daemon.js 를 사용자 소유 경로로 복사하고, 로그인 사용자 세션에서 상주 실행되는 서비스로 등록한다.
 * 자격증명은 심지 않는다 — REMOTE 는 토큰 없는 URL, 인증은 기기의 git credential helper(osxkeychain 등) 재사용.
 */
export async function installDaemonDesktop(opts: DesktopInstallOpts): Promise<void> {
  if (process.platform === 'darwin') return installDarwin(opts);
  if (process.platform === 'linux') return installLinux(opts);
  throw new Error('데스크톱 자동 설치는 macOS·Linux 만 지원합니다.');
}

/**
 * 플랫폼 통합 설치 진입점.
 * - Windows: 기존 UAC 기반 install.ps1 경로(clone·build·schtasks).
 * - macOS·Linux: 번들 daemon.js 로 sudo 없는 사용자 권한 설치.
 */
export async function installDaemon(opts: DesktopInstallOpts): Promise<void> {
  if (process.platform === 'win32') return installDaemonWindows(opts.vaultPath, opts.remote);
  return installDaemonDesktop(opts);
}

/** 플랫폼 통합 제거 진입점. */
export async function uninstallDaemon(vaultPath: string): Promise<void> {
  if (process.platform === 'win32') {
    const name = instanceName(vaultPath);
    await pExec(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process schtasks -Verb RunAs -ArgumentList '/Delete','/TN','gitvault-live-${name}','/F'"`,
      { timeout: 15_000 },
    );
    return;
  }
  return uninstallDaemonDesktop(vaultPath);
}

/** 데스크톱 daemon 제거 — 서비스 중지·등록 해제. 실패는 호출측에서 안내. */
export async function uninstallDaemonDesktop(vaultPath: string): Promise<void> {
  const name = instanceName(vaultPath);
  if (process.platform === 'darwin') {
    const plist = darwinPlistPath(name);
    await pExecFile('bash', ['-c', `launchctl unload ${shq(plist)} 2>/dev/null; rm -f ${shq(plist)}`], {
      timeout: 15_000,
    });
    return;
  }
  if (process.platform === 'linux') {
    await pExecFile('bash', ['-c', `systemctl --user disable --now gitvault-live@${name} 2>/dev/null || true`], {
      timeout: 30_000,
    });
    return;
  }
  throw new Error('데스크톱 제거는 macOS·Linux 만 지원합니다.');
}

// ── macOS (launchd 사용자 에이전트) ──────────────────────────────────────

function darwinPlistPath(name: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `com.gitvault-live.${name}.plist`);
}

async function installDarwin(opts: DesktopInstallOpts): Promise<void> {
  const name = instanceName(opts.vaultPath);
  const dataDir = join(homedir(), 'Library', 'Application Support', 'gitvault-live');
  mkdirSync(dataDir, { recursive: true });
  const daemonJs = join(dataDir, 'daemon.js');
  copyFileSync(opts.daemonSrc, daemonJs);

  const node = await resolveNode();
  const env: Record<string, string> = {
    ...node.env,
    PATH: pathWith(node.program),
    VAULT_PATH: opts.vaultPath,
    DEVICE_ID: opts.deviceId,
  };
  if (opts.remote?.trim()) env.REMOTE = opts.remote.trim();

  const label = `com.gitvault-live.${name}`;
  const log = join('/tmp', `ogs-daemon-${name}.log`);
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(node.program)}</string><string>${xml(daemonJs)}</string>
  </array>
  <key>EnvironmentVariables</key><dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
  const plistPath = darwinPlistPath(name);
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist);
  await pExecFile('bash', ['-c', `launchctl unload ${shq(plistPath)} 2>/dev/null; launchctl load ${shq(plistPath)}`], {
    timeout: 15_000,
  });
}

// ── Linux (systemd --user) ───────────────────────────────────────────────

async function installLinux(opts: DesktopInstallOpts): Promise<void> {
  const name = instanceName(opts.vaultPath);
  const dataDir = join(homedir(), '.local', 'share', 'gitvault-live');
  mkdirSync(dataDir, { recursive: true });
  const daemonJs = join(dataDir, 'daemon.js');
  copyFileSync(opts.daemonSrc, daemonJs);

  const node = await resolveNode();
  const cfgDir = join(homedir(), '.config', 'gitvault-live');
  mkdirSync(cfgDir, { recursive: true });
  const envLines = [`VAULT_PATH=${opts.vaultPath}`, `DEVICE_ID=${opts.deviceId}`, 'DEBOUNCE_MS=3000'];
  if (opts.remote?.trim()) envLines.push(`REMOTE=${opts.remote.trim()}`);
  const nodeEnvLine = node.env.ELECTRON_RUN_AS_NODE ? 'ELECTRON_RUN_AS_NODE=1' : '';
  if (nodeEnvLine) envLines.push(nodeEnvLine);
  envLines.push(`PATH=${pathWith(node.program)}`);
  writeFileSync(join(cfgDir, `${name}.env`), envLines.join('\n') + '\n');

  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  const unit = `[Unit]
Description=gitvault-live daemon (%i vault)
After=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/gitvault-live/%i.env
ExecStart=${node.program} ${daemonJs}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
  writeFileSync(join(unitDir, 'gitvault-live@.service'), unit);
  await pExecFile(
    'bash',
    ['-c', `systemctl --user daemon-reload && systemctl --user enable --now gitvault-live@${name}`],
    { timeout: 30_000 },
  );
}

// ── 공용 헬퍼 ─────────────────────────────────────────────────────────────

/**
 * daemon 을 돌릴 node 실행부를 정한다.
 * 1) 시스템 node 가 있으면 그걸 사용.
 * 2) 없으면 Obsidian(Electron) 바이너리를 ELECTRON_RUN_AS_NODE=1 로 node 처럼 실행 → 별도 node 설치 불필요.
 */
async function resolveNode(): Promise<{ program: string; env: Record<string, string> }> {
  // 1) PATH 상의 node (GUI 실행 앱은 PATH 가 빈약할 수 있어 실패할 수 있음).
  try {
    const { stdout } = await pExecFile('bash', ['-c', 'command -v node'], { timeout: 5_000 });
    const p = stdout.trim();
    if (p) return { program: p, env: {} };
  } catch {
    /* PATH 에 없음 → 절대경로 탐색 */
  }
  // 2) 흔한 설치 경로 (homebrew arm/intel, 시스템).
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (existsSync(p)) return { program: p, env: {} };
  }
  // 3) 시스템 node 부재 시 Obsidian(Electron) 바이너리를 node 처럼 실행 → 별도 설치 불필요.
  return { program: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** 실행 프로그램 디렉터리를 최소 PATH 앞에 붙인다 (git·node 탐색 보장). */
function pathWith(program: string): string {
  const dir = dirname(program);
  return dir && !BASE_PATH.split(':').includes(dir) ? `${dir}:${BASE_PATH}` : BASE_PATH;
}

/** POSIX 셸 single-quote 안전 삽입. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** XML 텍스트/속성 이스케이프 (plist 값 안전 삽입). */
function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Windows 자동 설치: 원격 install.ps1 을 관리자 PowerShell 로 다운로드·실행한다.
 * 사용자에게 UAC prompt 가 뜨고, 승인 시 admin 창이 열려 clone·build·schtasks 등록까지 진행(20~60초).
 * 이 함수는 UAC prompt 후 곧 반환한다 — 완료는 사용자가 로그(C:\gitvault-live\daemon-<name>.log)로 확인.
 * vaultPath 는 홑따옴표(') 를 이중화해 PowerShell 문자열 안에 안전 삽입한다.
 */
export async function installDaemonWindows(vaultPath: string, remote?: string): Promise<void> {
  const safeVault = vaultPath.replace(/'/g, "''");
  const remoteArg = remote?.trim() ? ` -Remote '${remote.trim().replace(/'/g, "''")}'` : '';
  const inner = [
    "$ErrorActionPreference='Stop'",
    "$tmp=Join-Path $env:TEMP 'gv-install.ps1'",
    "iwr -useb https://raw.githubusercontent.com/aprilslab/gitvault-live/main/install.ps1 -OutFile $tmp",
    `& $tmp daemon -Vault '${safeVault}'${remoteArg}`,
    'Read-Host "완료. Enter 눌러 창 닫기"',
  ].join('; ');

  const cmd = [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-Command','${inner.replace(/'/g, "''")}'`,
  ];
  await pExec(cmd.map(quoteArg).join(' '), { timeout: 15_000 });
}

/** PowerShell 인자 안전 이스케이프 (공백 포함 시 큰따옴표로 감싸고 내부 큰따옴표는 이중화). */
function quoteArg(a: string): string {
  if (!/[\s"']/.test(a)) return a;
  return '"' + a.replace(/"/g, '""') + '"';
}
