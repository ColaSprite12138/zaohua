// 渲染成本探针：只回答一个问题 —— **画面慢是「没拿到帧」还是「画得慢」**。
//
// Run: pnpm exec forgeax project play scripts/probe-render-cost.mjs --json
//
// 读的是 `game.state` 里的只读诊断字段（`frameGapMs` / `paintMs`），
// 两者都不进 S、不进 hash、不参与判定。玩家被点着走起来再采样，
// 因为静止时迷雾与实体绘制都不是峰值。
export default async function probeRenderCost(play) {
  const samples = [];
  await play.step('render cost: 走位途中采 6 次', async () => {
    // 点画面右下的空地：够远，会触发寻路 + 持续走位（绘制峰值）。
    await play.mouse.click([0.82, 0.62]);
    for (let i = 0; i < 6; i += 1) {
      await play.advance(0.5);
      const s = await play.state('game.state');
      samples.push({
        tick: s.tick,
        frameGapMs: Number((s.frameGapMs ?? 0).toFixed(2)),
        paintMs: Number((s.paintMs ?? 0).toFixed(2)),
        moveMode: s.moveMode,
      });
    }
    await play.screenshot('render-cost');
  });
  // 汇总：paint 占帧间隔的比例直接说明责任方。
  const gaps = samples.map((x) => x.frameGapMs).filter((n) => n > 0);
  const paints = samples.map((x) => x.paintMs).filter((n) => n > 0);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  console.log(JSON.stringify({
    samples,
    avgFrameGapMs: Number(avg(gaps).toFixed(2)),
    avgPaintMs: Number(avg(paints).toFixed(2)),
    impliedFps: avg(gaps) > 0 ? Number((1000 / avg(gaps)).toFixed(1)) : null,
    paintShare: avg(gaps) > 0 ? Number((avg(paints) / avg(gaps)).toFixed(2)) : null,
  }));
}
