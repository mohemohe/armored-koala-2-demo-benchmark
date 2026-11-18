// Game orchestrator: fixed-step simulation, objectives, snapshot API.
// Step order per §9: enemies -> player horizontal/QB -> firing (EN) ->
// flight EN -> vertical+collision -> projectiles -> FCS -> regen/objectives.

import { PARAMS, effectiveStats } from './params.js';
import { Player } from './player.js';
import { makeEnemies, updateEnemy } from './enemies.js';
import { Projectiles, beamHitscan } from './weapons.js';
import { FCS } from './fcs.js';
import { makeRng } from './rng.js';
import { solveMachinegun, solveBeam, solveMissile } from './ballistics.js';

const W = PARAMS.weapons;
const SIM_DT = PARAMS.simDt;

export class Game {
  constructor(stage, loadout, seed) {
    this.stage = stage;
    this.loadout = { ...loadout };
    this.stats = effectiveStats(loadout);
    this.seed = seed >>> 0;
    this.rng = makeRng(this.seed);
    this.projectiles = new Projectiles();
    this.player = new Player(loadout, this.stats, stage.start);
    this.fcs = new FCS(this.stats);
    this.events = [];
    this.reset();
  }

  reset() {
    const st = this.stage;
    this.now = 0;
    this.state = 'playing';
    this.player.reset(st.start);
    this.enemies = makeEnemies(st.spawns);
    this.projectiles.clear();
    this.fcs.reset();
    this.nextFireAt = { machinegun: 0, beam: 0, missile: 0 };
    this.denyMsg = null; this.denyUntil = 0;
    this.fcsUnlocked = false;   // salvaged from first destroyed gate-control turret
    this.controlsDestroyed = 0;
    this.gateOpen = false;
    for (const b of st.barriers) { b.open = false; for (const bx of st.barrierBoxes[b.id]) bx.disabled = false; }
    this.visited = new Set();
    this.currentSector = null;
    this.recentPlayerShots = [];
    this.shotSeq = 0;
    this.playerPrevCenter = this.player.center();
    this.events.length = 0;
    this.rng = makeRng(this.seed);
    this.result = null;
    this.hitNotices = [];  // damage direction indicators {dir:[x,z], at}
  }

  isBarrierOpen = (id) => {
    const b = this.stage.barriers.find(x => x.id === id);
    return b ? b.open : true;
  };

  // ------------- fixed step -------------
  step(input) {
    if (this.state !== 'playing') return;
    const dt = SIM_DT;
    const now = this.now;
    const world = this.stage.world;
    const player = this.player;
    this.playerPrevCenter = player.center();

    // 1. enemies AI + firing
    const ctx = {
      now, world, enemies: this.enemies, stage: this.stage, rng: this.rng,
      playerAlive: this.state === 'playing',
      playerCenter: () => this.player.center(),
      playerVelocity: () => this.player.vel,
      isBarrierOpen: this.isBarrierOpen,
      spawnEnemyBullet: (m, dir, spec) => {
        this.projectiles.spawnEnemyBullet(m, dir, spec);
        this.events.push({ type: 'enemyShot', at: m.slice(), dir: dir.slice(), kind: spec.kind });
      },
    };
    for (const en of this.enemies) updateEnemy(en, dt, ctx);

    // 2. player: QB edge + horizontal steering (+jump edge)
    const wantFly = this.player.update(dt, input, now, world);

    // 3. player firing (EN order: after QB cost, before flight cost)
    if (input.fireHeld) this.tryFire(input.view, now);

    // 4. flight EN debit (after QB and beam spends)
    let powered = 0;
    if (wantFly && player.en > 0) {
      powered = Math.min(dt, player.en / PARAMS.player.flyCost);
      if (powered > 0) {
        player.en -= PARAMS.player.flyCost * powered;
        player.lastEnSpentAt = now;
      }
    }

    // 5. vertical + integrate
    player.applyVertical(dt, powered, world);
    player.move(dt, world);

    // 6. projectiles
    const pctx = {
      world, enemies: this.enemies, now,
      playerAlive: this.state === 'playing',
      playerPrevCenter: this.playerPrevCenter,
      playerCenter: () => this.player.center(),
      damageEnemy: (en, dmg, at, weapon) => this.damageEnemy(en, dmg, at, weapon),
      damagePlayer: (dmg, fromVel) => this.damagePlayer(dmg, fromVel),
      events: this.events,
    };
    this.projectiles.update(dt, pctx);

    // 7. FCS (inert until the module is salvaged)
    if (this.fcsUnlocked && input.view) {
      this.fcs.update(dt, { player, enemies: this.enemies, world, now }, input.view, player.weapon);
    } else {
      this.fcs.reset();
    }

    // 8. regen + sector + objectives
    player.regen(dt, now);
    const sec = this.stage.sectorAt(player.center());
    if (sec) { this.currentSector = sec; this.visited.add(sec); }

    // escape check / fail check (fail wins)
    if (player.hp <= 0 || player.pos[1] < PARAMS.player.killY) {
      this.state = 'failed';
      this.result = 'failed';
      this.events.push({ type: 'failed' });
    } else if (this.gateOpen && this._inside(this.stage.escapeZone, player.pos)) {
      this.state = 'cleared';
      this.result = 'cleared';
      this.events.push({ type: 'cleared' });
    }

    this.now = now + dt;
    // expire hit notices
    this.hitNotices = this.hitNotices.filter(h => now - h.at < 0.8);
  }

  _inside(zone, p) {
    return p[0] >= zone.min[0] && p[0] <= zone.max[0] &&
           p[1] >= zone.min[1] && p[1] <= zone.max[1] &&
           p[2] >= zone.min[2] && p[2] <= zone.max[2];
  }

  // ------------- firing -------------
  tryFire(view, now) {
    if (!view) return;
    const player = this.player;
    const wkey = player.weapon;
    const spec = W[wkey];
    if (now < this.nextFireAt[wkey]) return;

    const locked = this.fcsUnlocked && this.fcs.state === 'locked' && this.fcs.validateTarget(
      { player, enemies: this.enemies, world: this.stage.world }, view);

    if (wkey === 'missile' && !locked) { this._deny('LOCK REQUIRED', now); return; }
    if (wkey === 'machinegun' && player.ammo.machinegun <= 0) { this._deny('NO AMMO', now); return; }
    if (wkey === 'beam' && player.en < spec.enCost - 1e-9) { this._deny('LOW EN', now); return; }
    if (wkey === 'missile' && player.ammo.missile <= 0) { this._deny('NO AMMO', now); return; }

    const muzzle = player.muzzle();
    let record = null;

    if (locked) {
      // re-evaluate solution at this instant
      const fc = this.fcs.evaluateFireControl(
        { player, enemies: this.enemies, world: this.stage.world, now }, wkey, muzzle);
      const target = this.fcs.target;
      if (wkey === 'machinegun') {
        const v0 = fc.status === 'solved' ? fc.initialVelocity : this._directVel(muzzle, target.center(), 100);
        this.projectiles.spawnMachinegun(muzzle, v0);
        player.ammo.machinegun--;
        record = this._shotRecord(now, wkey, fc, muzzle, v0);
      } else if (wkey === 'beam') {
        const hit = beamHitscan(this.stage.world, this.enemies, muzzle, fc.launchDirection, spec.range);
        player.en -= spec.enCost; player.lastEnSpentAt = now;
        this.projectiles.spawnBeamFx(muzzle, hit.point);
        if (hit.enemy) this.damageEnemy(hit.enemy, spec.damage, hit.point, 'beam');
        this.events.push({ type: 'beam', from: muzzle.slice(), to: hit.point.slice() });
        record = this._shotRecord(now, wkey, fc, muzzle, null);
      } else {
        const v0 = fc.status === 'solved' ? fc.initialVelocity : this._directVel(muzzle, target.center(), 45);
        this.projectiles.spawnMissile(muzzle, v0, target.id);
        player.ammo.missile--;
        record = this._shotRecord(now, wkey, fc, muzzle, v0);
      }
    } else {
      // free fire toward camera-center aim point
      const aim = this._freeAimPoint(view);
      let dir = [aim[0] - muzzle[0], aim[1] - muzzle[1], aim[2] - muzzle[2]];
      const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      dir = [dir[0] / l, dir[1] / l, dir[2] / l];
      if (wkey === 'machinegun') {
        const v0 = [dir[0] * 100, dir[1] * 100, dir[2] * 100];
        this.projectiles.spawnMachinegun(muzzle, v0);
        player.ammo.machinegun--;
        record = this._shotRecord(now, wkey, null, muzzle, v0, dir);
      } else if (wkey === 'beam') {
        const hit = beamHitscan(this.stage.world, this.enemies, muzzle, dir, spec.range);
        player.en -= spec.enCost; player.lastEnSpentAt = now;
        this.projectiles.spawnBeamFx(muzzle, hit.point);
        if (hit.enemy) this.damageEnemy(hit.enemy, spec.damage, hit.point, 'beam');
        this.events.push({ type: 'beam', from: muzzle.slice(), to: hit.point.slice() });
        record = this._shotRecord(now, wkey, null, muzzle, null, dir);
      }
      // missile can't happen (locked required, handled above)
    }

    if (record) {
      this.nextFireAt[wkey] = now + spec.interval;
      this.recentPlayerShots.push(record);
      if (this.recentPlayerShots.length > 32) this.recentPlayerShots.shift();
      this.events.push({ type: 'shot', weapon: wkey, muzzle: muzzle.slice(), dir: record.launchDirection });
    }
  }

  _directVel(muzzle, target, speed) {
    const d = [target[0] - muzzle[0], target[1] - muzzle[1], target[2] - muzzle[2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / l * speed, d[1] / l * speed, d[2] / l * speed];
  }

  _freeAimPoint(view) {
    // ray from camera through screen center -> first world hit (or far point)
    const o = view.camPos, d = view.camForward;
    const end = [o[0] + d[0] * 400, o[1] + d[1] * 400, o[2] + d[2] * 400];
    const hit = this.stage.world.raycastSegment(o, end);
    return hit ? hit.point : end;
  }

  _shotRecord(now, wkey, fc, muzzle, v0, freeDir) {
    const base = {
      id: ++this.shotSeq, firedAtSeconds: now, weapon: wkey,
      targetId: fc ? fc.targetId : null,
      solutionStatus: fc ? fc.status : 'inactive',
      muzzlePosition: muzzle.slice(),
      targetPositionAtFire: fc ? fc.targetPosition : null,
      targetVelocityAtFire: fc ? fc.targetVelocity : null,
      launchDirection: (fc ? fc.launchDirection : freeDir).slice(),
      initialVelocity: v0 ? v0.slice() : null,
      accelerationAtFire: wkey === 'machinegun' ? [0, -18, 0] : [0, 0, 0],
      predictedFlightSeconds: fc ? fc.predictedFlightSeconds : null,
      predictedInterceptPosition: fc ? fc.predictedInterceptPosition : null,
      residualMeters: fc ? fc.residualMeters : null,
    };
    return base;
  }

  _deny(msg, now) {
    this.denyMsg = msg; this.denyUntil = now + 0.5;
    this.events.push({ type: 'deny', msg });
  }

  damageEnemy(en, dmg, at, weapon) {
    if (!en.alive) return;
    en.hp -= dmg;
    this.events.push({ type: 'enemyHit', id: en.id, at: at ? at.slice() : null });
    if (en.hp <= 0) {
      en.alive = false;
      en.hp = 0;
      this.events.push({ type: 'enemyDown', id: en.id, at: en.center() });
      if (en.isGateControl) {
        this.controlsDestroyed++;
        if (!this.fcsUnlocked) {
          this.fcsUnlocked = true;
          this.events.push({ type: 'fcsUnlock' });
        }
        for (const b of this.stage.barriers) {
          if (b.open) continue;
          if (b.id === 'B6') {
            if (this.controlsDestroyed >= 6) this._openBarrier(b);
          } else if (b.controlId === en.id) {
            this._openBarrier(b);
          }
        }
      }
    }
  }

  _openBarrier(b) {
    b.open = true;
    for (const bx of this.stage.barrierBoxes[b.id]) bx.disabled = true;
    this.events.push({ type: 'barrierOpen', id: b.id, label: b.label });
    if (b.id === 'B6') { this.gateOpen = true; this.events.push({ type: 'gateOpen' }); }
  }

  damagePlayer(dmg, fromVel) {
    if (this.state !== 'playing') return;
    this.player.hp -= dmg;
    const l = Math.hypot(fromVel[0], fromVel[2]) || 1;
    this.hitNotices.push({ dir: [fromVel[0] / l, fromVel[2] / l], at: this.now });
    this.events.push({ type: 'playerHit', dmg });
  }

  // ------------- snapshot -------------
  getSnapshot() {
    const p = this.player;
    const fc = this.fcs.fireControl;
    const locked = this.fcs.state === 'locked';
    return {
      version: 'AK2-1.2-candidate',
      seed: this.seed,
      state: this.state,
      elapsedSeconds: this.now,
      loadout: { ...this.loadout },
      player: {
        position: p.pos.slice(),
        velocity: p.vel.slice(),
        grounded: p.grounded,
        hp: p.hp,
        en: p.en,
        weapon: p.weapon,
        ammo: { machinegun: p.ammo.machinegun, missile: p.ammo.missile },
        movement: {
          horizontalMode: p.horizontalMode,
          verticalMode: p.verticalMode,
          glideEnabled: p.glideEnabled,
          desiredHorizontalDirection: p.glideEnabled ? p.glideDir.slice() :
            (p.qbImpulseRemaining > 0 ? p.qbDir.slice() : [0, 0]),
          qbSuccessfulCount: p.qbSuccessfulCount,
          qbLastStartedAtSeconds: p.qbLastStartedAt,
          qbImpulseRemainingSeconds: Math.max(0, p.qbImpulseRemaining),
          qbCooldownRemainingSeconds: p.qbLastStartedAt === null ? 0 :
            Math.max(0, PARAMS.player.qbCooldown - (this.now - p.qbLastStartedAt)),
          lastEnSpentAtSeconds: p.lastEnSpentAt,
        },
      },
      effectiveStats: {
        maxEn: this.stats.maxEn,
        regenPerSecond: this.stats.regenPerSecond,
        lockSeconds: this.stats.lockSeconds,
        horizontalSpeedMultiplier: this.stats.horizontalSpeedMultiplier,
      },
      lock: {
        state: this.fcs.state,
        targetId: this.fcs.target ? this.fcs.target.id : null,
        progress: this.stats.lockSeconds > 0 ? Math.min(1, this.fcs.progress / this.stats.lockSeconds) : 0,
        radiusCssPx: this.fcs.radiusCssPx,
      },
      fireControl: locked && fc ? {
        status: fc.status, weapon: fc.weapon, targetId: fc.targetId,
        evaluatedAtSeconds: fc.evaluatedAtSeconds,
        muzzlePosition: fc.muzzlePosition, targetPosition: fc.targetPosition,
        targetVelocity: fc.targetVelocity, launchDirection: fc.launchDirection,
        predictedFlightSeconds: fc.predictedFlightSeconds,
        predictedInterceptPosition: fc.predictedInterceptPosition,
        aimPoint: fc.aimPoint, residualMeters: fc.residualMeters,
      } : {
        status: 'inactive', weapon: p.weapon, targetId: null,
        evaluatedAtSeconds: null, muzzlePosition: null, targetPosition: null,
        targetVelocity: null, launchDirection: null, predictedFlightSeconds: null,
        predictedInterceptPosition: null, aimPoint: null, residualMeters: null,
      },
      recentPlayerShots: this.recentPlayerShots.map(s => JSON.parse(JSON.stringify(s))),
      enemies: this.enemies.map(en => ({
        id: en.id, kind: en.kind, isGateControl: en.isGateControl,
        sectorId: en.sectorId, position: en.pos.slice(), velocity: en.vel.slice(),
        hp: en.hp, alive: en.alive, alert: en.alert,
        hasLineOfSight: en.hasLineOfSight,
        shotsFired: en.shotsFired, lastShotAtSeconds: en.lastShotAt,
      })),
      objective: {
        controlsDestroyed: this.controlsDestroyed,
        controlsRequired: 6,
        openBarrierIds: this.stage.barriers.filter(b => b.open).map(b => b.id),
        gateOpen: this.gateOpen,
      },
      stage: {
        sectorCount: this.stage.sectors.length,
        currentSectorId: this.currentSector,
        visitedSectorIds: [...this.visited],
        totalEnemies: 45,
      },
    };
  }
}
