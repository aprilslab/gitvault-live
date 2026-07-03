import { hostname } from 'os';

export interface DaemonConfig {
  vaultPath: string;
  remote: string;
  /** DEVICE_ID env 명시값. 미지정이면 undefined → Committer 가 .git 에 영속화한다. */
  deviceId?: string;
  debounceMs: number;
  autosaveIdleMs: number;
}

const DEBOUNCE_DEFAULT = 3_000;
const DEBOUNCE_MIN = 100;
const IDLE_DEFAULT = 300_000;
const IDLE_MIN = 1_000;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'device';
}

/** deviceId 미지정 시 hostname-slug + 랜덤 4자리(base36). 같은 기종 2대의 wip 충돌 방지. */
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
    autosaveIdleMs: positiveInt(env.AUTOSAVE_IDLE_MS, IDLE_DEFAULT, IDLE_MIN),
  };
}
