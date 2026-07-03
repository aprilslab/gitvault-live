import { Prec, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';

/**
 * Cmd/Ctrl+S → 저장(squash-to-main) 콜백. Obsidian 기본 동작보다 먼저 처리(Prec.highest).
 * Mod-s 외에는 어떤 키도 바인딩하지 않는다 — Enter 등 기본 입력 동작에 관여 금지.
 */
export function saveKeymap(onSave: () => void): Extension {
  return Prec.highest(
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          onSave();
          return true;
        },
      },
    ]),
  );
}
