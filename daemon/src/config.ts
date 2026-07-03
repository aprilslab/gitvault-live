import { hostname } from 'os';

export interface DaemonConfig {
  vaultPath: string;
  /** 표준 호스팅 git remote URL (HTTPS+토큰). 예: https://<user>:<token>@host/owner/repo.git */
  remote: string;
  /** DEVICE_ID env 명시값. 미지정이면 undefined → Committer 가 .git 에 영속화한다. */
  deviceId?: string;
  debounceMs: number;
}

const DEBOUNCE_DEFAULT = 3_000;
const DEBOUNCE_MIN = 100;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'device';
}

/** deviceId 미지정 시 hostname-slug + 랜덤 4자리(base36). 같은 기종 2대의 커밋 identity 충돌 방지. */
export function defaultDeviceId(): string {
  const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${slug(hostname())}-${suffix}`;
}

/** 숫자 env 검증: 유한하고 min 이상이면 채택, 아니면(NaN/빈문자열/음수) 기본값. */
function positiveInt(raw: string | undefined, def: number, min: number): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : def;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const vaultPath = env.VAULT_PATH?.trim();
  if (!vaultPath) throw new Error('VAULT_PATH 환경변수 필수');
  const remote = env.REMOTE?.trim();
  if (!remote) throw new Error('REMOTE 환경변수 필수');

  return {
    vaultPath,
    remote,
    deviceId: env.DEVICE_ID?.trim() || undefined,
    debounceMs: positiveInt(env.DEBOUNCE_MS, DEBOUNCE_DEFAULT, DEBOUNCE_MIN),
  };
}
