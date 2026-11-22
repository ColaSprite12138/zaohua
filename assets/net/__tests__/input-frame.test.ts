import { describe, expect, it } from 'vitest';
import {
  AUX_HAS_MOUSE, AUX_POINTER_ON_HUD, INPUT_FRAME_BYTES,
  NO_SKILL, NO_SWITCH, PACKET_BATCH,
  decodeInputFrame, decodePacket, emptyInputFrame, encodeBatch, encodeInputFrame,
  toStepInput, type InputFrame,
} from '../input-frame.ts';

function frame(overrides: Partial<InputFrame> = {}): InputFrame {
  return { ...emptyInputFrame(7), ...overrides };
}

describe('输入帧编解码', () => {
  it('帧长固定 12 字节', () => {
    expect(INPUT_FRAME_BYTES).toBe(12);
    expect(encodeInputFrame(frame()).byteLength).toBe(12);
  });

  /**
   * 帧同步里「我」的本机帧不经过网络编解码，远端帧经过。若 `toStepInput`
   * 不把两者统一到同一精度，A 用原始浮点落点走位、B 用 1/4 像素落点模拟 A，
   * 同一个玩家的轨迹就会差出 1e-5 量级。真机分项指纹只报 `players` 分叉、
   * 怪 / 掉落 / 破坏物全一致，根因正是这条。
   */
  it('本机直用与网络往返后的帧，交给 step 的 mouse 必须逐位相同', () => {
    const original = frame({ pointerDown: true, mouse: { x: 1234.567, y: 890.123 } });
    const direct = toStepInput(original);
    const viaNet = toStepInput(decodeInputFrame(new Uint8Array(encodeInputFrame(original).buffer)));
    expect(direct.mouse).toEqual(viaNet.mouse);
    expect(direct.pointerDown).toBe(viaNet.pointerDown);
  });

  it('往返之后每个字段都对得上', () => {
    const original = frame({
      pointerDown: true,
      pointerHeld: true,
      pointerUp: false,
      dodge: true,
      potion: true,
      healPotion: false,
      extractChannel: true,
      skill: 3,
      switchWeapon: 1,
      mouse: { x: 321.25, y: 118.75 },
      pointerOnHud: true,
    });
    const back = decodeInputFrame(new Uint8Array(encodeInputFrame(original).buffer));
    expect(back).toEqual(original);
  });

  it('没有指针时 mouse 回 null，而不是 (0,0)', () => {
    const back = decodeInputFrame(new Uint8Array(encodeInputFrame(frame()).buffer));
    expect(back.mouse).toBeNull();
  });

  it('技能/切枪的「没按」是 255，不会和槽位 0 混淆', () => {
    const back = decodeInputFrame(new Uint8Array(encodeInputFrame(frame()).buffer));
    expect(back.skill).toBe(NO_SKILL);
    expect(back.switchWeapon).toBe(NO_SWITCH);
    // 槽位 0 是合法技能位，必须与 NO_SKILL 区分
    const zero = decodeInputFrame(new Uint8Array(encodeInputFrame(frame({ skill: 0 })).buffer));
    expect(zero.skill).toBe(0);
  });

  it('坐标保留 1/4 像素精度', () => {
    const back = decodeInputFrame(new Uint8Array(
      encodeInputFrame(frame({ mouse: { x: 100.25, y: 0.75 } })).buffer,
    ));
    expect(back.mouse).toEqual({ x: 100.25, y: 0.75 });
  });

  it('越界坐标被夹住，不会回绕成负数', () => {
    const back = decodeInputFrame(new Uint8Array(
      encodeInputFrame(frame({ mouse: { x: 1e9, y: -1e9 } })).buffer,
    ));
    expect(back.mouse!.x).toBeCloseTo(32767 / 4, 5);
    expect(back.mouse!.y).toBeCloseTo(-32768 / 4, 5);
  });

  it('R 重开 / M 大地图不是帧字段：局外动作与纯本地视图都不进帧', () => {
    const back = decodeInputFrame(new Uint8Array(
      encodeInputFrame(frame({ pointerDown: true, pointerOnHud: true })).buffer,
    ));
    expect('restart' in back).toBe(false);
    expect('bigMap' in back).toBe(false);
    expect(back.pointerDown).toBe(true);
    expect(back.pointerOnHud).toBe(true);
    expect(back.dodge).toBe(false);
    expect(back.extractChannel).toBe(false);
  });

  it('批量包能装多帧且顺序不变', () => {
    const frames = [frame({ tick: 1 }), frame({ tick: 2, pointerDown: true }), frame({ tick: 3 })];
    const bytes = encodeBatch(frames);
    expect(bytes[0]).toBe(PACKET_BATCH);
    const decoded = decodePacket(bytes);
    expect(decoded.kind).toBe('batch');
    if (decoded.kind !== 'batch') return;
    expect(decoded.frames.map((f) => f.tick)).toEqual([1, 2, 3]);
    expect(decoded.frames[1]!.pointerDown).toBe(true);
  });

  it('声明帧数大于实际字节数时按实际解，不越界读', () => {
    const bytes = encodeBatch([frame({ tick: 1 })]);
    // 把 count 改成 99，模拟截断/畸形包
    new DataView(bytes.buffer).setUint16(1, 99, true);
    const decoded = decodePacket(bytes);
    expect(decoded.kind).toBe('batch');
    if (decoded.kind !== 'batch') return;
    expect(decoded.frames).toHaveLength(1);
  });

  it('空包和未知标签返回 unknown 而不是抛异常', () => {
    expect(decodePacket(new Uint8Array(0)).kind).toBe('unknown');
    expect(decodePacket(new Uint8Array([0x7f])).kind).toBe('unknown');
  });

  it('toStepInput 把 255 还原成 null，坐标原样透传', () => {
    const input = toStepInput(frame({ mouse: { x: 5, y: 6 }, skill: 2, switchWeapon: 0 }));
    expect(input.skill).toBe(2);
    expect(input.switchWeapon).toBe(0);
    expect(input.mouse).toEqual({ x: 5, y: 6 });
    const idle = toStepInput(frame());
    expect(idle.skill).toBeNull();
    expect(idle.switchWeapon).toBeNull();
    expect(idle.mouse).toBeUndefined();
  });

  it('AUX 位掩码值与协议表一致（bit2 预留，不再编码大地图）', () => {
    expect(AUX_HAS_MOUSE).toBe(1);
    expect(AUX_POINTER_ON_HUD).toBe(2);
  });
});
