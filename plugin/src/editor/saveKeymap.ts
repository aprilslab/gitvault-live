import { Prec, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';

/**
 * 저장(squash-to-main) 단축키. Obsidian 기본 동작보다 먼저 처리(Prec.highest).
 * - Mod-Shift-s (Cmd/Ctrl+Shift+S): 충돌 없는 확실한 조합 — 이게 주 단축키.
 * - Mod-s (Cmd/Ctrl+S): Obsidian 코어 "현재 파일 저장"이 먼저 삼키는 환경이 많아 폴백.
 */
export function saveKeymap(onSave: () => void): Extension {
  const run = (): boolean => {
    onSave();
    return true;
  };
  return Prec.highest(
    keymap.of([
      { key: 'Mod-Shift-s', preventDefault: true, run },
      { key: 'Mod-s', preventDefault: true, run },
    ]),
  );
}
