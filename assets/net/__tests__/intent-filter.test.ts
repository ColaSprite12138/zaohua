import { describe, expect, it } from 'vitest';
import { hasActivity } from '../intent-filter.ts';
import { NO_SKILL, NO_SWITCH, emptyInputFrame, type InputFrame } from '../input-frame.ts';

function at(seq: number, patch: Partial<InputFrame> = {}): InputFrame {
  return { ...emptyInputFrame(seq), ...patch };
}

const MOUSE = { x: 100, y: 50 };

describe('intent-filter：没有操作就不发', () => {
  it('开局什么都不做：不发', () => {
    expect(hasActivity(at(0), null)).toBe(false);
    expect(hasActivity(at(0), at(1))).toBe(false);
  });

  it('鼠标停在同一位置：不发', () => {
    const prev = at(0, { mouse: MOUSE });
    expect(hasActivity(at(1, { mouse: { ...MOUSE } }), prev)).toBe(false);
  });

  it('亚像素抖动（量化后同一点）：不发', () => {
    const prev = at(0, { mouse: { x: 100.0, y: 50.0 } });
    // 1/4 像素精度：差 0.1px 量化后还是 100 / 50。
    expect(hasActivity(at(1, { mouse: { x: 100.1, y: 50.1 } }), prev)).toBe(false);
  });
});

describe('intent-filter：一次性动作必须发', () => {
  it.each([
    ['按下', { pointerDown: true }],
    ['松开', { pointerUp: true }],
    ['闪避', { dodge: true }],
    ['蓝药', { potion: true }],
    ['红药', { healPotion: true }],
    ['撤离引导', { extractChannel: true }],
    ['技能键', { skill: 2 }],
    ['切枪', { switchWeapon: 1 }],
  ])('%s 要发', (_name, patch) => {
    const prev = at(0, { mouse: MOUSE });
    expect(hasActivity(at(1, { mouse: { ...MOUSE }, ...patch }), prev)).toBe(true);
  });

  it('技能哨兵值不算操作', () => {
    const prev = at(0);
    expect(hasActivity(at(1, { skill: NO_SKILL, switchWeapon: NO_SWITCH }), prev)).toBe(false);
  });
});

describe('intent-filter：持续态每帧都要发', () => {
  it('按住期间一直发（哪怕鼠标不动）', () => {
    const held = at(0, { mouse: MOUSE, pointerHeld: true });
    expect(hasActivity(at(1, { mouse: { ...MOUSE }, pointerHeld: true }), held)).toBe(true);
  });

  it('按住结束的那一帧要发（true → false 不能靠缺席隐式表达）', () => {
    const held = at(0, { mouse: MOUSE, pointerHeld: true });
    expect(hasActivity(at(1, { mouse: { ...MOUSE }, pointerHeld: false }), held)).toBe(true);
  });

  it('指针压在 HUD 上要发，离开也要发', () => {
    const onHud = at(0, { mouse: MOUSE, pointerOnHud: true });
    expect(hasActivity(at(1, { mouse: { ...MOUSE }, pointerOnHud: true }), onHud)).toBe(true);
    expect(hasActivity(at(1, { mouse: { ...MOUSE }, pointerOnHud: false }), onHud)).toBe(true);
  });
});

describe('intent-filter：鼠标移动要发（hover / 下一次落点）', () => {
  it('位置变了要发', () => {
    const prev = at(0, { mouse: MOUSE });
    expect(hasActivity(at(1, { mouse: { x: 104, y: 50 } }), prev)).toBe(true);
  });

  it('从有指针到没有指针要发', () => {
    const prev = at(0, { mouse: MOUSE });
    expect(hasActivity(at(1, { mouse: null }), prev)).toBe(true);
  });

  it('这一局第一次出现指针要发（hover 要用它）', () => {
    expect(hasActivity(at(0, { mouse: MOUSE }), null)).toBe(true);
  });
});
