import { StateEffect, StateField, type Extension, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import type { DiffHunk } from './diffHunks';

/**
 * 활성 파일의 origin/main 대비 hunk 를 CM6 에디터에 오버레이한다 (컨플루언스/구글docs 식 "상대 편집 보기").
 * - 로컬과 origin/main 이 다른 라인 → `ogs-incoming-line` 하이라이트.
 * - origin/main 에만 있고 로컬엔 없는 내용(도착 예정) → 라인 끝 `ogs-incoming-ghost` 위젯.
 * 라인 단위(char offset 아님) — 프리뷰 목적이라 근사면 충분하고, 실제 병합은 sync-down 이 수행한다.
 */
export const setIncomingHunks = StateEffect.define<DiffHunk[]>();

const MAX_GHOST_LEN = 80;

class GhostWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'ogs-incoming-ghost';
    el.textContent = `  ⟢ ${this.text}`;
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function firstNonEmpty(lines: string[]): string {
  const s = lines.find((l) => l.trim().length > 0) ?? '';
  return s.length > MAX_GHOST_LEN ? `${s.slice(0, MAX_GHOST_LEN)}…` : s;
}

function build(hunks: DiffHunk[], doc: Text): DecorationSet {
  const total = doc.lines;
  const ranges = [];
  // RangeSet 은 위치 오름차순을 요구 — newStart 순으로 정렬 후 Decoration.set(_, true) 로 안전 정렬.
  const sorted = [...hunks].sort((a, b) => a.newStart - b.newStart);

  for (const h of sorted) {
    if (h.newCount > 0) {
      const from = clamp(h.newStart, 1, total);
      const to = clamp(h.newStart + h.newCount - 1, 1, total);
      for (let ln = from; ln <= to; ln++) {
        const line = doc.line(ln);
        ranges.push(Decoration.line({ class: 'ogs-incoming-line' }).range(line.from));
      }
    } else if (h.removedLines.length > 0) {
      // 순수 삭제(로컬에 없음) → -U0 에서 newStart 는 삭제 지점 직전 라인. 그 라인 끝에 ghost.
      const anchor = clamp(h.newStart, 1, total);
      const line = doc.line(anchor);
      ranges.push(
        Decoration.widget({ widget: new GhostWidget(firstNonEmpty(h.removedLines)), side: 1 }).range(line.to),
      );
    }
  }
  return Decoration.set(ranges, true);
}

const incomingField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setIncomingHunks)) next = build(e.value, tr.state.doc);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** main.ts 의 registerEditorExtension 에 넘길 확장. */
export function collabDecorations(): Extension {
  return incomingField;
}

/** 활성 에디터에 hunk 데코레이션을 반영. reading 모드 등 EditorView 없으면 무시. */
export function pushHunks(view: EditorView | undefined, hunks: DiffHunk[]): void {
  if (!view) return;
  view.dispatch({ effects: setIncomingHunks.of(hunks) });
}
