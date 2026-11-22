/**
 * 输入帧：把一帧的操作意图压成定长 12 字节。
 *
 * 为什么必须是定长的二进制而不是 JSON：
 * - JSON 每帧 100+ 字节，20 帧/秒 × 16 人 = 32KB/s 光是括号和字段名；定长帧
 *   12 字节，同样的量级降到 3.8KB/s，且解析不需要 `JSON.parse`（每帧都 parse
 *   会在低端机上肉眼可见地掉帧）。
 * - 字段顺序一旦写死，两端就不可能出现「A 发的是 mouseX、B 读成 mouseY」这类
 *   只能靠日志猜的错位。
 *
 * 布局（小端，共 12 字节）：
 * ```
 *   0  u32  seq               意图序号（客户端自增；**不是帧号**）
 *   4  u8   flags             见 FLAG_*
 *   5  u8   skill             技能槽 0..6；NO_SKILL=255 表示这一帧没按技能
 *   6  u8   switchWeapon      0/1；NO_SWITCH=255 表示没切枪
 *   7  u8   aux               见 AUX_*
 *   8  i16  mouseX * 4        世界坐标 × 4（1/4 像素精度，不是屏幕像素）
 *  10  i16  mouseY * 4
 * ```
 *
 * **为什么是世界坐标而不是屏幕坐标**：点击落点最终要参与「打到哪只怪」的判定，
 * 那是世界空间的判定。传屏幕像素的话，16:9 与 4:3、1x 与 2x 的窗口会把同一次
 * 点击解出不同的世界点，两端第一枪就打偏。
 *
 * **为什么第一个字段是 `seq` 而不是帧号**：帧号归服务器所有。客户端只能申报
 * 「我按了什么、这是第几次申报」，落在哪一帧由服务器决定（见
 * `docs/net-sync-v2.md` §1）。如果客户端自己带帧号，服务器就得信它 —— 那等于
 * 把帧号归属又还给了客户端，v1 的分叉/卡死会原样复现。
 *
 * **为什么 ×4 而不是直接取整**：1 像素误差会让 `hitTestEnemy` 在半径边界上
 * 给出不同结果（我砍到了 / 我没砍到）。1/4 像素的误差远小于任何判定半径，
 * 而 int16 在 ×4 精度下仍能表示 ±8191 像素，比最宽的地图还宽一倍。
 */

/** 一帧的操作意图。字段与 `StepInput` 一一对应，唯独坐标是世界空间。 */
export type InputFrame = {
  /** 客户端自增的意图序号。服务器只用来去重与诊断，**不决定落在哪一帧**。 */
  readonly seq: number;
  readonly pointerDown: boolean;
  readonly pointerHeld: boolean;
  readonly pointerUp: boolean;
  readonly dodge: boolean;
  readonly potion: boolean;
  readonly healPotion: boolean;
  readonly extractChannel: boolean;
  /** 0..6；`NO_SKILL` = 这一帧没按技能键。 */
  readonly skill: number;
  /** 0/1；`NO_SWITCH` = 这一帧没按切换键。 */
  readonly switchWeapon: number;
  /** 世界坐标；`null` = 这一帧没有指针位置（鼠标移出窗口 / 没有鼠标）。 */
  readonly mouse: { readonly x: number; readonly y: number } | null;
  /** 指针停在 HUD（小地图 / 大地图）上：不能穿透成移动或攻击。 */
  readonly pointerOnHud: boolean;
};

/** 输入帧的字节数。改布局必须同时改 `RULESET_EXTRACT`。 */
export const INPUT_FRAME_BYTES = 12;

export const NO_SKILL = 255;
export const NO_SWITCH = 255;
export const MOUSE_SCALE = 4;

export const FLAG_POINTER_DOWN = 1 << 0;
export const FLAG_POINTER_HELD = 1 << 1;
export const FLAG_POINTER_UP = 1 << 2;
export const FLAG_DODGE = 1 << 3;
export const FLAG_POTION = 1 << 4;
export const FLAG_HEAL_POTION = 1 << 5;
export const FLAG_EXTRACT = 1 << 6;
/* bit7 预留：R 重开功能已按产品决定彻底删除，不再有帧字段。 */

export const AUX_HAS_MOUSE = 1 << 0;
export const AUX_POINTER_ON_HUD = 1 << 1;
/* bit2 预留：M 大地图是纯本地视图状态，不进帧。 */

/** 一帧「什么都没按」的输入。远端玩家这一帧没有意图时用它。 */
export function emptyInputFrame(seq: number): InputFrame {
  return {
    seq,
    pointerDown: false,
    pointerHeld: false,
    pointerUp: false,
    dodge: false,
    potion: false,
    healPotion: false,
    extractChannel: false,
    skill: NO_SKILL,
    switchWeapon: NO_SWITCH,
    mouse: null,
    pointerOnHud: false,
  };
}

/** 把坐标夹进 int16 的表示范围（×4 之后）。越界说明地图尺寸变了，不是玩家的错。 */
function clampCoord(value: number): number {
  const scaled = Math.round(value * MOUSE_SCALE);
  if (scaled > 32767) return 32767;
  if (scaled < -32768) return -32768;
  return scaled;
}

export function encodeInputFrame(frame: InputFrame, out?: DataView): DataView {
  const view = out ?? new DataView(new ArrayBuffer(INPUT_FRAME_BYTES));
  let flags = 0;
  if (frame.pointerDown) flags |= FLAG_POINTER_DOWN;
  if (frame.pointerHeld) flags |= FLAG_POINTER_HELD;
  if (frame.pointerUp) flags |= FLAG_POINTER_UP;
  if (frame.dodge) flags |= FLAG_DODGE;
  if (frame.potion) flags |= FLAG_POTION;
  if (frame.healPotion) flags |= FLAG_HEAL_POTION;
  if (frame.extractChannel) flags |= FLAG_EXTRACT;

  let aux = 0;
  if (frame.mouse) aux |= AUX_HAS_MOUSE;
  if (frame.pointerOnHud) aux |= AUX_POINTER_ON_HUD;

  view.setUint32(0, frame.seq >>> 0, true);
  view.setUint8(4, flags);
  view.setUint8(5, frame.skill & 0xff);
  view.setUint8(6, frame.switchWeapon & 0xff);
  view.setUint8(7, aux);
  view.setInt16(8, frame.mouse ? clampCoord(frame.mouse.x) : 0, true);
  view.setInt16(10, frame.mouse ? clampCoord(frame.mouse.y) : 0, true);
  return view;
}

export function decodeInputFrame(bytes: Uint8Array, offset = 0): InputFrame {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, INPUT_FRAME_BYTES);
  const flags = view.getUint8(4);
  const aux = view.getUint8(7);
  const skill = view.getUint8(5);
  const switchWeapon = view.getUint8(6);
  const hasMouse = (aux & AUX_HAS_MOUSE) !== 0;
  return {
    seq: view.getUint32(0, true),
    pointerDown: (flags & FLAG_POINTER_DOWN) !== 0,
    pointerHeld: (flags & FLAG_POINTER_HELD) !== 0,
    pointerUp: (flags & FLAG_POINTER_UP) !== 0,
    dodge: (flags & FLAG_DODGE) !== 0,
    potion: (flags & FLAG_POTION) !== 0,
    healPotion: (flags & FLAG_HEAL_POTION) !== 0,
    extractChannel: (flags & FLAG_EXTRACT) !== 0,
    skill: skill === NO_SKILL ? NO_SKILL : skill,
    switchWeapon: switchWeapon === NO_SWITCH ? NO_SWITCH : switchWeapon,
    mouse: hasMouse
      ? { x: view.getInt16(8, true) / MOUSE_SCALE, y: view.getInt16(10, true) / MOUSE_SCALE }
      : null,
    pointerOnHud: (aux & AUX_POINTER_ON_HUD) !== 0,
  };
}

/** 单帧包：`[0x01][12B frame]`。只在「一帧一个包」的稀疏输入下用（技能/切枪）。 */
export const PACKET_FRAME = 0x01;
/**
 * 批量包：`[0x02][u16 count][12B × count]`。常态走这个 —— 网络栈按包收
 * 50 个小包的开销远大于 1 个 600 字节的大包，尤其在有丢包重传的链路上。
 */
export const PACKET_BATCH = 0x02;

/** 把一组帧打成批量包。`frames` 必须按 tick 升序，接收端靠这一点做去重。 */
export function encodeBatch(frames: readonly InputFrame[]): Uint8Array {
  const count = frames.length;
  const out = new Uint8Array(3 + count * INPUT_FRAME_BYTES);
  out[0] = PACKET_BATCH;
  new DataView(out.buffer).setUint16(1, count, true);
  const view = new DataView(out.buffer);
  for (let i = 0; i < count; i += 1) {
    const frame = frames[i]!;
    encodeInto(frame, view, 3 + i * INPUT_FRAME_BYTES);
  }
  return out;
}

function encodeInto(frame: InputFrame, view: DataView, offset: number): void {
  let flags = 0;
  if (frame.pointerDown) flags |= FLAG_POINTER_DOWN;
  if (frame.pointerHeld) flags |= FLAG_POINTER_HELD;
  if (frame.pointerUp) flags |= FLAG_POINTER_UP;
  if (frame.dodge) flags |= FLAG_DODGE;
  if (frame.potion) flags |= FLAG_POTION;
  if (frame.healPotion) flags |= FLAG_HEAL_POTION;
  if (frame.extractChannel) flags |= FLAG_EXTRACT;
  let aux = 0;
  if (frame.mouse) aux |= AUX_HAS_MOUSE;
  if (frame.pointerOnHud) aux |= AUX_POINTER_ON_HUD;
  view.setUint32(offset, frame.seq >>> 0, true);
  view.setUint8(offset + 4, flags);
  view.setUint8(offset + 5, frame.skill & 0xff);
  view.setUint8(offset + 6, frame.switchWeapon & 0xff);
  view.setUint8(offset + 7, aux);
  view.setInt16(offset + 8, frame.mouse ? clampCoord(frame.mouse.x) : 0, true);
  view.setInt16(offset + 10, frame.mouse ? clampCoord(frame.mouse.y) : 0, true);
}

export type DecodedPacket =
  | { kind: 'frame'; frame: InputFrame }
  | { kind: 'batch'; frames: InputFrame[] }
  | { kind: 'unknown'; tag: number };

/** 解包。坏包不抛异常 —— 网络层不该因为一个畸形包把整局打断。 */
export function decodePacket(bytes: Uint8Array): DecodedPacket {
  if (bytes.length < 1) return { kind: 'unknown', tag: -1 };
  const tag = bytes[0]!;
  if (tag === PACKET_FRAME) {
    if (bytes.length < 1 + INPUT_FRAME_BYTES) return { kind: 'unknown', tag };
    return { kind: 'frame', frame: decodeInputFrame(bytes, 1) };
  }
  if (tag === PACKET_BATCH) {
    if (bytes.length < 3) return { kind: 'unknown', tag };
    const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(1, true);
    const available = Math.floor((bytes.length - 3) / INPUT_FRAME_BYTES);
    const n = Math.min(count, available);
    const frames: InputFrame[] = [];
    for (let i = 0; i < n; i += 1) frames.push(decodeInputFrame(bytes, 3 + i * INPUT_FRAME_BYTES));
    return { kind: 'batch', frames };
  }
  return { kind: 'unknown', tag };
}

/** 把输入帧还原成模拟层吃的 `StepInput`（坐标已经是世界空间）。 */
export function toStepInput(frame: InputFrame): {
  mouse: { x: number; y: number } | undefined;
  pointerDown: boolean;
  pointerHeld: boolean;
  pointerUp: boolean;
  dodge: boolean;
  switchWeapon: 0 | 1 | null;
  skill: number | null;
  potion: boolean;
  healPotion: boolean;
  extractChannel: boolean;
  pointerOnHud: boolean;
} {
  return {
    // **本机帧也必须走网络帧的 1/4 像素量化**：帧同步里「我」的帧留在本地、
    // 不经过 encode/decode，而对方的帧是解码出来的。直接透传原始浮点会让
    // A 用 1234.567 的落点走位、B 用 1234.5 去模拟 A —— 同一个玩家的
    // 轨迹两端差出 1e-5~0.1px，hash 里只有 players 分项分叉（2026-11-21
    // 真机 divergedTick=600 的分项指纹实测）。统一精度后两端逐位一致。
    //
    // 只做量化，**不做 clampCoord 的 int16 截断**：那是编码层的溢出保护，
    // 而 worldmap 大地图的路点会到 x=8192（> 8191.75 上限）。在转换层截断
    // 会把它挪到相邻格、直接把寻路打断（verify-all 的 worldmap 实测）。
    mouse: frame.mouse
      ? {
          x: Math.round(frame.mouse.x * MOUSE_SCALE) / MOUSE_SCALE,
          y: Math.round(frame.mouse.y * MOUSE_SCALE) / MOUSE_SCALE,
        }
      : undefined,
    pointerDown: frame.pointerDown,
    pointerHeld: frame.pointerHeld,
    pointerUp: frame.pointerUp,
    dodge: frame.dodge,
    switchWeapon: frame.switchWeapon === NO_SWITCH ? null : (frame.switchWeapon as 0 | 1),
    skill: frame.skill === NO_SKILL ? null : frame.skill,
    potion: frame.potion,
    healPotion: frame.healPotion,
    extractChannel: frame.extractChannel,
    pointerOnHud: frame.pointerOnHud,
  };
}
