import { exec } from 'child_process';
import { promisify } from 'util';

const pExec = promisify(exec);

export type DaemonStatus = 'installed' | 'missing' | 'unsupported' | 'unknown';

/**
 * 로컬 daemon 설치 여부 감지 (플랫폼별 heuristic).
 * - Windows: 작업 스케줄러에 `gitvault-live-*` 등록 여부(`schtasks /Query`).
 * - macOS: `~/Library/LaunchAgents/com.gitvault-live.*.plist` (`launchctl list`).
 * - Linux: systemd 유닛 `gitvault-live@*.service`.
 * 실패/미지원 플랫폼은 unknown/unsupported 로 폴백.
 */
export async function detectDaemon(): Promise<DaemonStatus> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await pExec('schtasks /Query /FO CSV /NH', { timeout: 10_000 });
      return /gitvault-live/i.test(stdout) ? 'installed' : 'missing';
    }
    if (process.platform === 'darwin') {
      // launchctl list 는 grep 실패 시 exit 1 → || true 로 통과
      const { stdout } = await pExec('launchctl list | grep -i gitvault-live || true', {
        timeout: 5_000,
        shell: '/bin/bash',
      });
      return stdout.trim() ? 'installed' : 'missing';
    }
    if (process.platform === 'linux') {
      // 시스템 유닛만 검사(권한 없이 가능). 사용자 유닛은 별도 감지 안 함(edge case).
      const { stdout } = await pExec(
        "systemctl list-units --no-pager --type=service --all 2>/dev/null | grep -i gitvault-live || true",
        { timeout: 5_000, shell: '/bin/bash' },
      );
      return stdout.trim() ? 'installed' : 'missing';
    }
    return 'unsupported';
  } catch {
    return 'unknown';
  }
}

/**
 * Windows 자동 설치: 원격 install.ps1 을 관리자 PowerShell 로 다운로드·실행한다.
 * 사용자에게 UAC prompt 가 뜨고, 승인 시 admin 창이 열려 clone·build·schtasks 등록까지 진행(20~60초).
 * 이 함수는 UAC prompt 후 곧 반환한다 — 완료는 사용자가 로그(C:\gitvault-live\daemon-<name>.log)로 확인.
 * vaultPath 는 홑따옴표(') 를 이중화해 PowerShell 문자열 안에 안전 삽입한다.
 */
export async function installDaemonWindows(vaultPath: string): Promise<void> {
  // 내부 스크립트: install.ps1 다운로드 → 실행. daemon 모드, vault 인자 삽입.
  const safeVault = vaultPath.replace(/'/g, "''");
  const inner = [
    "$ErrorActionPreference='Stop'",
    "$tmp=Join-Path $env:TEMP 'gv-install.ps1'",
    "iwr -useb https://raw.githubusercontent.com/aprilslab/gitvault-live/main/install.ps1 -OutFile $tmp",
    `& $tmp daemon -Vault '${safeVault}'`,
    'Read-Host "완료. Enter 눌러 창 닫기"',
  ].join('; ');

  // Start-Process -Verb RunAs 로 UAC 요청. -ArgumentList 는 배열로 안전 전달.
  // 바깥 powershell 은 즉시 종료(Start-Process 는 새 창을 띄우고 리턴).
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
