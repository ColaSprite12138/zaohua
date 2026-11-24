/**
 * 阵亡姿态的护栏（2026-11-25 用户 PVP 实测：「人死了没有倒地动作，血条清零
 * 却不消失」）。
 *
 * 这两个 bug 的根因都不是 `S` 缺字段 —— `hp` / `deathTimer` 早就在
 * `PLAYER_KEYS` 里、进帧进 hash，只是绘制层一处都没读。把判据收成纯函数，
 * 让「死者不挂血条 / 死后要躺下」有单测可守；它们不写任何状态，不进 `step()`。
 */
import { describe, expect, it } from 'vitest';
import { createState, PVP_DEATH_SECONDS, type Player } from '../../combat/state.ts';
import { DOWN_SECONDS, downProgress, isDown, isDownHp, showsHealthBar } from '../death-pose.ts';

function player(): Player {
  return createState().player;
}

describe('阵亡姿态（纯 V 层派生）', () => {
  it('HUD 只认血量代理：不需要再取一次 s.player', () => {
    expect(isDownHp(100)).toBe(false);
    expect(isDownHp(0)).toBe(true);
    expect(showsHealthBar(100)).toBe(true);
    expect(showsHealthBar(0)).toBe(false);
  });

  it('活着：站着、挂血条', () => {
    const p = player();
    expect(isDown(p)).toBe(false);
    expect(downProgress(p)).toBe(0);
    expect(showsHealthBar(p.hp)).toBe(true);
  });

  it('PVP 刚阵亡：从站立开始倒下，血条立刻撤掉', () => {
    const p = player();
    p.hp = 0;
    p.deathTimer = PVP_DEATH_SECONDS;
    expect(isDown(p)).toBe(true);
    expect(downProgress(p)).toBe(0);
    expect(showsHealthBar(p.hp)).toBe(false);
  });

  it('倒下过程线性推进，DOWN_SECONDS 后完全躺平并一直保持', () => {
    const p = player();
    p.hp = 0;
    p.deathTimer = PVP_DEATH_SECONDS - DOWN_SECONDS / 2;
    expect(downProgress(p)).toBeCloseTo(0.5);
    p.deathTimer = PVP_DEATH_SECONDS - DOWN_SECONDS;
    expect(downProgress(p)).toBe(1);
    p.deathTimer = 0;   // 倒计时归零后死者仍留在场上等别人捡装备
    expect(downProgress(p)).toBe(1);
  });

  it('PVE 远端玩家（deathTimer 恒 -1）：直接躺平，不依赖结算时钟', () => {
    const p = player();
    p.hp = 0;
    p.deathTimer = -1;
    expect(isDown(p)).toBe(true);
    expect(downProgress(p)).toBe(1);
    expect(showsHealthBar(p.hp)).toBe(false);
  });

  it('判据只认 hp：deathTimer 是结算时钟，不是死亡标记', () => {
    const p = player();
    p.deathTimer = 0;
    expect(isDown(p)).toBe(false);
    expect(downProgress(p)).toBe(0);
    expect(showsHealthBar(p.hp)).toBe(true);
  });
});
