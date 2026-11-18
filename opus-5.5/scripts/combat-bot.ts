// 戦闘込みの走破スモークテスト（npm run bot [legs] [generator] [fcs] [seed]）。
// 実ステージ・全45体の敵・閉じた隔壁で、単純な自動操縦がクリアできるかを確認する。
// 戦術：推奨経路をグライドで移動、敵の射撃予告を見たら横へQB、制御砲台はミサイル/ビーム、
// 近い警備はマシンガン、遠い警備はビーム。人間の操作の再現ではなく、戦闘込みで進行が成立するかの確認用。
import { PLAYER, type Loadout, type WeaponId } from '../src/config';
import { Game, EMPTY_INPUT, type StepInput } from '../src/sim/game';
import { forwardFromYaw, rightFromYaw, type V3 } from '../src/math';
import type { Enemy } from '../src/sim/enemies';
import { playerMuzzle } from '../src/sim/weapons';
import { ROUTE } from '../src/stage/layout';

const argLegs = (process.argv[2] as Loadout['legs']) || 'biped';
const argGen = (process.argv[3] as Loadout['generator']) || 'balanced';
const argFcs = (process.argv[4] as Loadout['fcs']) || 'medium';
const seed = Number(process.argv[5] || 20260908);
const verbose = !!process.env.BOTDBG;

export function runBot(lo: Loadout, seedV: number) {
  const g = new Game({ seed: seedV });
  g.sortie(lo);
  const p = g.player;
  let idx = 1;
  let waiting = false;
  let lastSpace = false;
  let lastShift = false;
  let blocked = 0;
  let unstickUntil = -1;
  let unstickSide: 1 | -1 = 1;
  let qbSide: 1 | -1 = 1;
  let engaged = null as { id: string; since: number; hp: number } | null;
  const ignoreUntil = new Map<string, number>();
  let repathAt = 0;
  let climbing = false;
  let navPath: number[] | null = null;
  let navIdx = 0;
  const seenTele = new Set<string>();
  const dmgBy = new Map<string, number>();
  const bySector = new Map<string, number>();
  const log: string[] = [];
  let lastSector = '';

  const aimAt = (t: V3) => {
    const eye: V3 = [p.pos[0], p.pos[1] + 2.9, p.pos[2]];
    const dx = t[0] - eye[0],
      dy = t[1] - eye[1],
      dz = t[2] - eye[2];
    g.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
  };
  const dist = (e: Enemy) => {
    const c = e.center();
    return Math.hypot(c[0] - p.pos[0], c[1] - p.pos[1] - 1.5, c[2] - p.pos[2]);
  };

  while (g.state === 'playing' && g.elapsedSeconds < 60 * 25) {
    const now = g.elapsedSeconds;
    while (idx < ROUTE.length) {
      const t = ROUTE[idx].pos;
      if (Math.hypot(t[0] - p.pos[0], t[2] - p.pos[2]) < 3 && t[1] - p.pos[1] < 1.5) idx++;
      else break;
    }
    if (idx >= ROUTE.length) idx = ROUTE.length - 1;
    // 押し戻されて前の区画に戻った場合は、その区画の最後の経路点へ戻す
    const cs = g.currentSectorId;
    if (cs && ROUTE[idx].sectorId !== cs && ROUTE[idx].pos[1] - p.pos[1] > 2) {
      for (let k = idx - 1; k >= 0 && k >= idx - 8; k--) {
        if (ROUTE[k].sectorId === cs) {
          idx = k;
          break;
        }
      }
    }
    const rt = ROUTE[idx].pos;
    const muzzle = playerMuzzle(p, g.yaw);
    const remainingControls = g.barriers.filter((b) => b.id !== 'GATE' && !b.open).length;

    // 目標選択
    const obj = g.barriers.find((b) => b.id !== 'GATE' && !b.open);
    let target: Enemy | undefined = obj ? g.enemies.byId(obj.controlId!) : undefined;
    if (target) {
      const c = target.center();
      const d = Math.hypot(c[0] - muzzle[0], c[1] - muzzle[1], c[2] - muzzle[2]);
      if (!target.alive || d > 110 || g.world.segmentBlocked(muzzle, c)) target = undefined;
    }
    const threats = g.enemies.enemies.filter((e) => e.alive && e.hasLOS && (ignoreUntil.get(e.id) ?? -1) < now);
    if (!target) {
      let bd = Infinity;
      for (const e of threats) {
        const d = dist(e);
        const w = e.kind === 'guard' ? d : d * 1.3;
        if (w < bd && d < 95) {
          bd = w;
          target = e;
        }
      }
    }
    // 交戦が長引く相手（撃てない位置など）は一時的に無視
    if (target) {
      if (engaged?.id !== target.id) engaged = { id: target.id, since: now, hp: target.hp };
      else if (now - engaged.since > 7) {
        if (target.hp >= engaged.hp) ignoreUntil.set(target.id, now + 8);
        engaged = { id: target.id, since: now, hp: target.hp };
      }
    } else engaged = null;
    if (target) aimAt(target.center());
    else aimAt([rt[0], p.pos[1] + 2.4, rt[2]]);

    // 武器
    let weapon: WeaponId = 'machinegun';
    let fire = false;
    if (target) {
      const d = dist(target);
      const locked = g.fcs.state === 'locked' && g.fcs.targetId === target.id;
      void remainingControls;
      if (locked && target.kind === 'turret' && g.weapons.ammo.missile > 0 && g.weapons.nextFireAt.missile <= now) {
        weapon = 'missile';
        fire = true;
      } else if (locked && g.weapons.ammo.machinegun > 0 && d < 100) {
        // ロック完了中はFCS射撃管制でマシンガンが偏差・落下補正される
        weapon = 'machinegun';
        fire = true;
      } else if (d < 22 && g.weapons.ammo.machinegun > 0) {
        weapon = 'machinegun';
        fire = true;
      } else if (p.grounded && rt[1] - p.pos[1] <= 2 && p.en >= 20) {
        weapon = 'beam';
        fire = true;
      } else if (g.weapons.ammo.machinegun > 0 && d < 30) {
        weapon = 'machinegun';
        fire = true;
      }
    }
    const inp: StepInput = { ...EMPTY_INPUT, weaponSelect: weapon, fireHeld: fire };

    // 移動（経路点へのナビグラフ経路の次ノード方向を、カメラ基準の8方向入力へ）
    let steer: V3 = rt;
    if (Math.abs(rt[1] - p.pos[1]) < 2 && p.grounded) {
      if (now >= repathAt) {
        repathAt = now + 0.4;
        const a = g.nav.nearest(p.pos, 6, 1.5);
        const b = g.nav.nearest(rt, 6, 2);
        navPath = a >= 0 && b >= 0 ? g.nav.findPath(a, b, g.closedBarriers(), 8000) : null;
        navIdx = navPath && navPath.length > 1 ? 1 : 0;
      }
      if (navPath) {
        while (navIdx < navPath.length - 1) {
          const n = g.nav.nodes[navPath[navIdx]];
          if (Math.hypot(n.x - p.pos[0], n.z - p.pos[2]) < 2.2) navIdx++;
          else break;
        }
        const n = g.nav.nodes[navPath[Math.min(navIdx, navPath.length - 1)]];
        if (navIdx < navPath.length - 1 || Math.hypot(n.x - p.pos[0], n.z - p.pos[2]) > 2) steer = [n.x, n.y, n.z];
      }
    } else navPath = null;
    const wx = steer[0] - p.pos[0],
      wz = steer[2] - p.pos[2];
    const wl = Math.hypot(wx, wz) || 1;
    const f = forwardFromYaw(g.yaw),
      r = rightFromYaw(g.yaw);
    const fz = (wx * f[0] + wz * f[1]) / wl,
      fx = (wx * r[0] + wz * r[1]) / wl;
    // 射線のある敵がいる間は進行方向に対して ±45° のジグザグで移動（グライドは0 ENの回避手段）
    let ang = 0;
    if (threats.length > 0 && wl > 6) ang = (Math.floor(now / 0.55) % 2 === 0 ? 1 : -1) * (Math.PI / 4);
    let ca = Math.cos(ang),
      sa = Math.sin(ang);
    let zx = fx * ca - fz * sa,
      zz = fx * sa + fz * ca;
    const need = rt[1] - p.pos[1];
    // 交戦：射線のある敵（または見えている制御砲台）がいれば、前進せず相手に対して横へジグザグしながら撃つ
    const fighting = !!target && (target.hasLOS || target.def.isGateControl) && need <= 2.0 && p.grounded;
    if (fighting) {
      const c = target!.center();
      const tx = c[0] - p.pos[0],
        tz = c[2] - p.pos[2];
      const tl = Math.hypot(tx, tz) || 1;
      const side = Math.floor(now / 0.7) % 2 === 0 ? 1 : -1;
      let mx = (-tz / tl) * side,
        mz = (tx / tl) * side;
      const dd = dist(target!);
      const radial = dd < 22 ? -0.6 : dd > 75 ? 0.6 : 0;
      mx += (tx / tl) * radial;
      mz += (tz / tl) * radial;
      const ml = Math.hypot(mx, mz) || 1;
      zz = (mx * f[0] + mz * f[1]) / ml;
      zx = (mx * r[0] + mz * r[1]) / ml;
      ca = 1;
      sa = 0;
    }
    inp.moveZ = zz > 0.38 ? 1 : zz < -0.38 ? -1 : 0;
    inp.moveX = zx > 0.38 ? 1 : zx < -0.38 ? -1 : 0;
    let ascending = false;
    // 上昇は足場の高さ+1mを超えるまで続ける（ヒステリシス）
    if (need > 2.0 || (climbing && need > -1.0)) {
      ascending = true;
      climbing = true;
      const req = Math.min(g.stats.maxEn, (need / PLAYER.flightRiseSpeed + 0.9) * PLAYER.flightEnPerSecond + 6);
      if (p.grounded && (waiting || p.en < req)) waiting = p.en < req;
      if (!waiting) {
        inp.spaceHeld = true;
        inp.spaceEdge = !lastSpace;
      } else {
        inp.moveX = inp.moveZ = 0;
      }
    } else {
      waiting = false;
      climbing = false;
    }

    // グライド：地上で次の経路点まで遠いときに ON、近づいたら OFF
    const far = (Math.hypot(rt[0] - p.pos[0], rt[2] - p.pos[2]) > 14 || fighting) && !ascending;
    const wantGlide = far && p.grounded;
    if (p.horizontalMode !== 'quickboost' && wantGlide !== p.glideEnabled && !lastShift) inp.shiftEdge = true;
    lastShift = inp.shiftEdge;

    // 回避：新しく射撃予告を始めた敵がいれば、その敵に対して横方向へQB
    for (const e of threats) {
      if (e.telegraphStart !== null && !seenTele.has(e.id + ':' + e.telegraphStart)) {
        seenTele.add(e.id + ':' + e.telegraphStart);
        const reserve = ascending ? 60 : 12;
        if (p.qbCooldownRemaining(now) <= 0 && p.en >= 36 + reserve && !waiting) {
          const c = e.center();
          const ex = c[0] - p.pos[0],
            ez = c[2] - p.pos[2];
          const el = Math.hypot(ex, ez) || 1;
          // 敵方向に垂直な向きをカメラ基準入力へ
          const sx = (-ez / el) * qbSide,
            sz = (ex / el) * qbSide;
          const qz = sx * f[0] + sz * f[1],
            qx = sx * r[0] + sz * r[1];
          inp.moveZ = qz > 0.38 ? 1 : qz < -0.38 ? -1 : 0;
          inp.moveX = qx > 0.38 ? 1 : qx < -0.38 ? -1 : 0;
          inp.qEdge = true;
          qbSide = qbSide === 1 ? -1 : 1;
        }
        break;
      }
    }
    if (unstickUntil > now) {
      inp.moveX = unstickSide;
      inp.moveZ = -1;
    }
    lastSpace = inp.spaceHeld;

    const before: V3 = [p.pos[0], p.pos[1], p.pos[2]];
    const hp0 = p.hp;
    g.step(inp);
    for (const ev of g.events) if (ev.type === 'playerHit') dmgBy.set(ev.ownerId, (dmgBy.get(ev.ownerId) ?? 0) + ev.damage);
    g.events = [];
    if (g.currentSectorId) bySector.set(g.currentSectorId, (bySector.get(g.currentSectorId) ?? 0) + (hp0 - p.hp));
    const moved = Math.hypot(p.pos[0] - before[0], p.pos[1] - before[1], p.pos[2] - before[2]);
    const tryMove = inp.moveX !== 0 || inp.moveZ !== 0;
    blocked = tryMove && p.grounded && moved < 0.02 ? blocked + 1 : 0;
    if (blocked > 40 && unstickUntil < now) {
      unstickSide = unstickSide === 1 ? -1 : 1;
      unstickUntil = now + 0.6;
      blocked = 0;
    }
    if (g.currentSectorId && g.currentSectorId !== lastSector) {
      lastSector = g.currentSectorId;
      log.push(`t=${now.toFixed(1)}s ${lastSector} HP=${p.hp.toFixed(0)} 撃破=${g.kills} 制御=${g.controlsDestroyed}/6 MG=${g.weapons.ammo.machinegun} MS=${g.weapons.ammo.missile}`);
    }
    if (verbose && Math.floor(now) !== Math.floor(now - 1 / 120)) console.log(now.toFixed(0), idx, p.pos.map((v) => v.toFixed(0)).join(','), 'hp', p.hp.toFixed(0), 'en', p.en.toFixed(0), 'tgt', target?.id, weapon, fire);
  }
  return { g, log, dmgBy, bySector };
}

const r = runBot({ fcs: argFcs, generator: argGen, legs: argLegs }, seed);
for (const l of r.log) console.log(l);
const g = r.g;
console.log(
  `結果: ${g.state} 経過 ${g.elapsedSeconds.toFixed(1)}s HP ${g.player.hp.toFixed(0)} 撃破 ${g.kills}/45 制御 ${g.controlsDestroyed}/6 区画 ${g.visited.length}/19 MG ${g.weapons.ammo.machinegun} MS ${g.weapons.ammo.missile} QB ${g.player.qbCount}`,
);
console.log('被ダメージ（敵別）:', [...r.dmgBy.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
console.log('被ダメージ（区画別）:', [...r.bySector.entries()].filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v.toFixed(0)}`).join(' '));
