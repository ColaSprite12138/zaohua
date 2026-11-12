/**
 * Engine root: owns the World, reads InputSnapshot, and paints the 2.5D scene
 * into a CanvasTexture on a screen-filling quad. Engine pixels (not the HUD
 * overlay) are what `project play` samples, so this is the render authority.
 */

import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import type { Plugin } from '@forgeax/engine/plugin';
import type {} from '@forgeax/engine/app';
import { Time, Update } from '@forgeax/engine/ecs';
import {
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputSnapshot,
} from '@forgeax/engine/input';
import { Transform } from '@forgeax/engine/scene';
import {
  Camera,
  CanvasTexture,
  Materials,
  MeshFilter,
  MeshRenderer,
  orthographic,
} from '@forgeax/engine/render';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';

import {
  createState, deployRun, projection, reset, setArena, step,
  MINIMAP, VIEW_H, VIEW_W, screenToWorld, worldToScreen,
  type Deployment,
} from './simulation.ts';
import { paint } from './paint.ts';
import { resolvePickupAck } from '../combat/weapons.ts';
import { arena } from '../resource/maps/arena.generated.ts';
import { testArena } from '../resource/maps/arena-test.ts';

const PACKAGE_ID = definePackageId('019fb7ce-3d00-7000-8000-000000000001');

/**
 * Same-origin channel between the single-page meta shell (main window) and
 * this Engine Worker. BroadcastChannel is a Web standard available in both
 * realms, so no engine-private API or extra frontend root is required.
 */
export const RUN_CHANNEL = 'forgeax-arena-run';

// `type` (not `interface`) so it satisfies the JSON-shaped GameProjectionValue
// index signature required by registerRead.
export type RunResult = {
  outcome: 'cleared' | 'gameOver';
  carriedItems: string[];
  lootLog: { monsterId: string; itemId: string; name: string; quality: string }[];
  kills: number;
  bagLootUids: string[];
  slotLootItemIds: string[];
};

export const game: Plugin = {
  name: 'game/arena',
  inject: ['world', 'assets', 'gameHost'],
  apply(ctx) {
    const world = ctx.world;
    const assets = ctx.assets;
    const host = ctx.gameHost;
    if (assets === undefined) throw new Error('game/arena requires the Assets service');

    // Mouse-driven games need a free cursor, not pointer lock.
    host?.setPointerLockAllowed?.(false);

    const surface = new OffscreenCanvas(VIEW_W, VIEW_H);
    const context = surface.getContext('2d');
    if (context === null) throw new Error('game/arena requires a Canvas 2D context');
    const painter = context as unknown as CanvasRenderingContext2D;
    // The small flat fixture keeps automated acceptance runs alive; the real
    // playable LDtk arena is selected by `deploy` below.
    const state = createState({ map: testArena });

    // Meta <-> run bridge. `lastResult` is posted to the shell exactly once
    // per run (on cleared / gameOver) and read back by playthrough assertions.
    let lastResult: RunResult | null = null;
    let resultSent = false;
    // While the mandatory login overlay is up the arena must not advance:
    // otherwise the skeletons would quietly kill an unattended player before
    // anyone has logged in. `unlock` resets to a clean run on successful auth.
    let locked = false;
    // Platform lifecycle pause (publishing validation). Kept INDEPENDENT of
    // `locked`: `unlock` resets to a fresh run, which a resume must never do.
    let paused = false;
    let pickupSent: string | null = null;
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(RUN_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        const msg = event.data as {
          type?: string;
          deployment?: Deployment;
          requestId?: number;
          slots?: (boolean | null)[];
          activeWeaponSlot?: 0 | 1;
          uid?: string;
          ok?: boolean;
        } | null;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'deploy') {
          // Real play always comes through the meta shell's deploy step, so
          // this is the single switch from the acceptance fixture to arena.ldtk.
          setArena(state, arena);
          deployRun(state, msg.deployment ?? {});
          lastResult = null;
          resultSent = false;
          pickupSent = null;
          channel?.postMessage({ type: 'deployed' });
        } else if (msg.type === 'hello') {
          channel?.postMessage({ type: 'ready' });
        } else if (msg.type === 'lock') {
          locked = true;
        } else if (msg.type === 'unlock') {
          // One-shot: never reset a live run just because another `hello`
          // handshake arrived. Only a real auth transition sends `unlock`.
          if (locked) {
            locked = false;
            reset(state);
            lastResult = null;
            resultSent = false;
          }
        } else if (msg.type === 'pause') {
          paused = true;
        } else if (msg.type === 'resume') {
          paused = false;
        } else if (msg.type === 'equip') {
          // In-run bag changes. `null` = leave that slot's BORROWED weapon
          // alone; true/false = the player armed/unarmed that slot in the bag.
          const slots = msg.slots;
          if (Array.isArray(slots)) {
            if (slots[0] === true) state.weaponSlots[0] = 'longsword';
            else if (slots[0] === false) state.weaponSlots[0] = null;
            if (slots[1] === true) state.weaponSlots[1] = 'longsword';
            else if (slots[1] === false) state.weaponSlots[1] = null;
          }
          if (msg.activeWeaponSlot === 0 || msg.activeWeaponSlot === 1) {
            state.activeWeaponSlot = msg.activeWeaponSlot;
          }
        } else if (msg.type === 'pickupAck') {
          // The main window owns the bag grid; only it can confirm a pickup.
          pickupSent = null;
          if (typeof msg.uid === 'string') {
            resolvePickupAck(state, msg.ok === true, msg.uid);
          }
        } else if (msg.type === 'probe') {
          // Read-only observability seam for REAL 4174 acceptance runs. The
          // projection registry lives in this Worker's module scope, so an
          // external harness cannot call `game.state` directly. This branch
          // only serialises the current state; it never mutates gameplay and
          // deliberately does NOT register another read projection, which
          // would break `project play`'s "single projection" resolution.
          const extent = host?.drawingBufferSize?.() ?? null;
          channel?.postMessage({
            type: 'state',
            requestId: msg.requestId,
            state: projection(state),
            // `projection()` exposes only the first drop (a legacy playthrough
            // field). A real multi-monster run needs every drop location to
            // walk over and pick the loot up.
            drops: state.drops.map((d) => {
              const v = worldToScreen(state.camera, d.x, d.y);
              return {
                x: v.x / VIEW_W,
                y: v.y / VIEW_H,
                itemId: d.itemId ?? null,
                name: d.name ?? null,
                quality: d.quality ?? null,
              };
            }),
            extent,
          });
        }
      };
      // Main-window scripts (including the login overlay) run BEFORE this
      // Worker boots. A `hello` sent at DOMContentLoaded is therefore lost,
      // and so is the overlay's initial `lock`. Proactively announce readiness
      // so the overlay can reassert the lock as soon as this channel exists.
      channel?.postMessage({ type: 'ready' });
    }

    const settleIfFinished = (): void => {
      if (resultSent || (!state.cleared && !state.gameOver)) return;
      resultSent = true;
      lastResult = {
        outcome: state.gameOver ? 'gameOver' : 'cleared',
        carriedItems: [...state.carriedItems],
        lootLog: state.lootLog.map((r) => ({
          monsterId: r.monsterId, itemId: r.itemId, name: r.name, quality: r.quality,
        })),
        kills: state.kills,
        bagLootUids: [...state.runBagUids],
        slotLootItemIds: [...state.slotLootItemIds],
      };
      channel?.postMessage({ type: 'result', result: lastResult });
    };

    ctx.effect(function* () {
      yield () => { channel?.close(); channel = null; };
      const texture = new CanvasTexture(surface, { flipY: false });
      yield () => texture.dispose();

      const materialHandle = assets
        .create(Materials.unlit('#ffffff', { baseColorTexture: { source: texture.source } }))
        .unwrap();
      const meshHandle = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

      const quad = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0], scale: [2, 2, 1] } },
          { component: MeshFilter, data: { assetHandle: meshHandle } },
          { component: MeshRenderer, data: { materials: [materialHandle] } },
        )
        .unwrap();
      // The spawned components hold their own references.
      assets.release(materialHandle).unwrap();
      assets.release(meshHandle).unwrap();
      yield () => world.despawn(quad).unwrap();

      const camera = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 5] } },
          {
            component: Camera,
            data: {
              ...orthographic({ left: -1, right: 1, bottom: -1, top: 1, near: 0.1, far: 20 }),
              clearColor: [0.03, 0.06, 0.1, 1],
              tonemap: 0,
            },
          },
        )
        .unwrap();
      yield () => world.despawn(camera).unwrap();

      world
        .addSystem(Update, {
          name: 'game/arena-frame',
          queries: [],
          fn: () => {
            const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
            const raw = world.getResource(Time).delta;
            const dt = Math.min(Math.max(raw, 0), 0.05);
            const pointer = snapshot?.mouse?.position;
            // InputSnapshot.mouse.position is in canvas *physical* pixels: the
            // browser backend scales client coords by canvas.width / rect.width.
            // This Engine realm is a Worker: it has neither `document` nor
            // `gameHost.canvas`, so the authoritative extent is the Host's
            // drawingBufferSize() -- documented as "current input-coordinate
            // extent, including source realms without a canvas". Read it every
            // frame so resize / DPR changes stay aligned. Dividing by a fixed
            // 1280x720 instead scales the pointer away from the visual cursor
            // and makes the player walk in the wrong direction on any window
            // whose drawing buffer is not exactly 1280x720.
            const extent = host?.drawingBufferSize?.();
            const canvasW = extent?.width || VIEW_W;
            const canvasH = extent?.height || VIEW_H;
            const screenX = pointer ? (pointer.x / canvasW) * VIEW_W : 0;
            const screenY = pointer ? (pointer.y / canvasH) * VIEW_H : 0;
            // The minimap is READ ONLY: pointer orders inside it are dropped,
            // so it can never be clicked to move or to follow the cursor.
            const onMinimap = screenX >= MINIMAP.x
              && screenX <= MINIMAP.x + MINIMAP.w
              && screenY >= MINIMAP.y
              && screenY <= MINIMAP.y + MINIMAP.h;
            const worldMouse = pointer
              ? screenToWorld(state.camera, screenX, screenY)
              : undefined;
            // press / held / release let the simulation classify a short click
            // (order: move to ground, or attack one enemy) vs. a long hold
            // (the only state with continuous cursor following). Hovering with
            // no button produces no order at all.
            const mouse = snapshot?.mouse;
            const restart = snapshot?.keyboard?.justPressedCode('KeyR') ?? false;
            // Login overlay AND platform lifecycle pause: freeze simulation and
            // settlement, but keep painting so the canvas shows a live frame.
            if (!locked && !paused) {
              step(state, dt, {
                mouse: worldMouse,
                pointerDown: !onMinimap && (mouse?.justPressed(0) ?? false),
                pointerHeld: !onMinimap && (mouse?.button(0) ?? false),
                pointerUp: !onMinimap && (mouse?.justReleased(0) ?? false),
                switchWeapon: snapshot?.keyboard?.justPressedCode('Digit1') ?? false
                  ? 0
                  : (snapshot?.keyboard?.justPressedCode('Digit2') ?? false) ? 1 : null,
                dodge: snapshot?.keyboard?.justPressedCode('Space') ?? false,
                restart,
              });
              // An in-run restart (R) starts a fresh settlement window.
              if (restart) {
                lastResult = null;
                resultSent = false;
                pickupSent = null;
              }
              // A loot item equipped into an empty weapon slot must also
              // appear in the in-run character panel. That panel renders the
              // main window's InventoryState, so forward the pure-logic event
              // over the run channel and drain it exactly once.
              if (state.weaponLootEvents.length > 0) {
                for (const ev of state.weaponLootEvents.splice(0)) {
                  channel?.postMessage({
                    type: 'weaponLoot',
                    uid: ev.uid,
                    itemId: ev.itemId,
                    slot: ev.slot,
                  });
                }
              }
              // Both weapon slots were full: ask the main window to find a
              // free bag cell. It answers with `pickupAck`; the drop stays on
              // the ground until then (and forever if the bag is full).
              if (state.pendingPickup !== null && pickupSent === null) {
                pickupSent = state.pendingPickup.uid;
                channel?.postMessage({
                  type: 'pickup',
                  uid: state.pendingPickup.uid,
                  itemId: state.pendingPickup.itemId,
                  name: state.pendingPickup.name,
                });
              }
              settleIfFinished();
            }
            paint(painter, state);
            texture.update();
          },
        })
        .unwrap();
      yield () => world.removeSystem(Update, 'game/arena-frame').unwrap();

      const unregister = host?.gameProjection?.registerRead({
        id: 'game.state',
        title: '2.5D arena state',
        description:
          'Player position, health, kills, living skeletons, drops, equipped main weapon, cooldowns and loot log.',
        read: () => projection(state),
      });
      if (unregister !== undefined) yield unregister;

      // `game.state` MUST stay the ONLY read projection. ForgeAX `project play`
      // resolves an unqualified read by "the single registered projection"; a
      // second one makes every playthrough step fail with state-unavailable,
      // even though the scripts pass 'game.state' explicitly. Run results and
      // deployments travel over BroadcastChannel (see the bridge above), so
      // they need no projection seam here.
    }, 'game/arena');
  },
};

export default definePack({
  schemaVersion: '2.0.0',
  plugins: true,
  packageId: PACKAGE_ID,
  build: () =>
    ok({
      'plugin/engine': {
        kind: 'plugin',
        module: { specifier: './game.pack.ts', export: 'game' },
      },
    }),
});
