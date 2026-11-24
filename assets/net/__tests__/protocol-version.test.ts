import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INPUT_FRAME_BYTES, PROTOCOL_RULESET } from '../input-frame.ts';

/**
 * 协议版本「一处改、处处改」的护栏。
 *
 * 这个字符串决定「谁能和谁进同一局」。它有两个消费点，而其中一个必须写死：
 *   - `assets/net/input-frame.ts::PROTOCOL_RULESET`（relay 广播 + 客户端自检）
 *   - `assets/meta/match-client.ts::RULESET_EXTRACT`（排队键，零 import 不能引用）
 *
 * 两边漂移的后果不是报错，而是**静默错位**：relay 用 16 字节布局去解 12 字节的
 * 帧，每个玩家的输入都张冠李戴，画面上只表现为"延迟/漂移"。这种分叉最难查，
 * 所以让它在 `pnpm test` 阶段就红。
 */
describe('协议版本一致性', () => {
  it('撮合排队键与 relay 的 PROTOCOL_RULESET 是同一个字符串', () => {
    const file = fileURLToPath(new URL('../../meta/match-client.ts', import.meta.url));
    const source = readFileSync(file, 'utf8');
    const match = /RULESET_EXTRACT\s*=\s*'([^']+)'/.exec(source);
    expect(match, 'match-client.ts 里找不到 RULESET_EXTRACT').toBeTruthy();
    expect(match![1]).toBe(PROTOCOL_RULESET);
  });

  it('帧长与版本号是绑在一起的（改布局必须改版本）', () => {
    // 这条不是形式主义：v2 → v3 就是「12 字节改 16 字节」，版本没动的话
    // 新旧客户端会配到同一局。改了 INPUT_FRAME_BYTES 就必须递增版本。
    expect(INPUT_FRAME_BYTES).toBe(16);
    expect(PROTOCOL_RULESET).toBe('extract-v3');
  });
});
