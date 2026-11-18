import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { STAGE } from '../src/stage.js';
import { CONFIG, WEAPONS } from '../src/config.js';
import { advancePlayerProjectile } from '../src/ballistics.js';

const idle = { direction: [0, 0], cameraForward: [1, 0], spaceHeld: false, fireHeld: false };
const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const center = bounds => bounds.min.map((value, index) => (value + bounds.max[index]) / 2);

function arena({ enemies = true } = {}) {
  return {
    sectors: [{ id: 'TEST', index: 0, name: 'Integration arena', type: 'bay', floorY: 0, ceilingY: 60, bounds: { min: [-100, 0, -150], max: [500, 60, 150] } }],
    boxes: [{ id: 'TEST-FLOOR', kind: 'floor', sectorId: 'TEST', min: [-100, -4, -150], max: [500, 0, 150] }],
    enemies: enemies ? [{ id: 'TEST-TURRET', kind: 'turret', isGateControl: false, sectorId: 'TEST', position: [60, 2.1, 0], velocity: [0, 0, 0], hp: 240 }] : [],
    barriers: [], connections: [], startPosition: [0, 2.1, 0],
    escapeBounds: { min: [490, 0, -8], max: [498, 50, 8] },
  };
}

// A real perspective projection fixture lets the ordinary Game/FCS path acquire
// targets; no lock state is forced in these firing integration tests.
function camera(game) {
  const position = [game.player.position[0] - 5, game.player.position[1] + 3, game.player.position[2]];
  return {
    position, forward: [1, 0, 0], width: 1280, height: 720,
    project(point) {
      const depth = point[0] - position[0];
      return { x: 640 + (point[2] - position[2]) * 600 / depth, y: 360 - (point[1] - position[1]) * 600 / depth, depth };
    },
  };
}

function arenaGame(options = {}) {
  const game = new Game({ stage: arena(options), cameraProvider: camera, muzzleProvider: game => [game.player.position[0] + 1.3, game.player.position[1] + 1, game.player.position[2]], ...options });
  game.state = 'playing';
  return game;
}

test('production stage Game exposes all 45 stable enemy IDs, six controls, and actual initial sector', () => {
  const game = new Game({ seed: 4294967295 });
  const snapshot = game.snapshot();
  assert.equal(snapshot.version, 'AK2-1.2-candidate');
  assert.equal(snapshot.seed, 4294967295);
  assert.equal(snapshot.state, 'garage');
  assert.equal(snapshot.enemies.length, 45);
  assert.equal(new Set(snapshot.enemies.map(enemy => enemy.id)).size, 45);
  assert.equal(snapshot.enemies.filter(enemy => enemy.kind === 'guard').length, 30);
  assert.equal(snapshot.enemies.filter(enemy => enemy.kind === 'turret').length, 15);
  assert.equal(snapshot.enemies.filter(enemy => enemy.isGateControl).length, 6);
  assert.equal(snapshot.stage.sectorCount, 15);
  assert.equal(snapshot.stage.currentSectorId, game.world.sectorAt(game.player.position).id);
  assert.deepEqual(snapshot.stage.visitedSectorIds, [snapshot.stage.currentSectorId]);
  for (const enemy of snapshot.enemies) {
    assert.equal(enemy.hp, enemy.kind === 'guard' ? 120 : 240);
    assert.equal(enemy.alive, true);
    assert.equal(enemy.shotsFired, 0);
    assert.equal(enemy.lastShotAtSeconds, null);
  }
});

test('snapshot returns copies and repeated reads neither mutate nor advance Game', () => {
  const game = arenaGame();
  game.advance(0.85, idle);
  game.fire();
  const pristine = game.snapshot();
  const edited = game.snapshot();
  edited.loadout.legs = 'quadruped';
  edited.player.position[0] = 99999;
  edited.player.en = 0;
  edited.player.movement.desiredHorizontalDirection[0] = 42;
  edited.enemies[0].position[0] = -999;
  edited.enemies[0].hp = 0;
  edited.recentPlayerShots[0].initialVelocity[0] = 0;
  edited.fireControl.launchDirection[0] = 0;
  edited.objective.openBarrierIds.push('FAKE');
  edited.stage.visitedSectorIds.push('FAKE');
  assert.deepEqual(game.snapshot(), pristine);
  assert.deepEqual(game.snapshot(), pristine);
  const visitNumbers = value => {
    if (typeof value === 'number') assert.ok(Number.isFinite(value));
    else if (value && typeof value === 'object') Object.values(value).forEach(visitNumbers);
  };
  visitNumbers(game.snapshot());
});

test('Game preserves individual weapon cooldowns, ammo, EN, and lock on switching', () => {
  const game = arenaGame();
  assert.equal(game.fire(), true);
  close(game.nextFire.machinegun, 0.1);
  game.switchWeapon('beam');
  assert.equal(game.fire(), true);
  close(game.nextFire.beam, 0.25);
  close(game.player.en, 112);
  game.switchWeapon('machinegun');
  assert.equal(game.fire(), false);
  assert.equal(game.player.ammo.machinegun, 299);
  game.advance(0.11, idle);
  assert.equal(game.fire(), true);
  assert.equal(game.player.ammo.machinegun, 298);
  const lockBefore = structuredClone(game.lock);
  game.switchWeapon('beam');
  assert.deepEqual(game.lock, lockBefore);
  assert.equal(game.fire(), false);
  close(game.nextFire.beam, 0.25);
  game.switchWeapon('missile');
  assert.equal(game.fire(), false);
  assert.equal(game.player.ammo.missile, 12);
  assert.equal(game.recentPlayerShots.length, 3);
  close(game.player.en, 112);
});

test('normal Game lock supplies actual machinegun launch and swept collision damage', () => {
  const game = arenaGame();
  game.advance(0.8, idle);
  assert.equal(game.lock.state, 'locked');
  assert.equal(game.fireControl.status, 'solved');
  assert.equal(game.fire(), true);
  const record = structuredClone(game.recentPlayerShots.at(-1));
  const projectile = game.projectiles.find(shot => shot.owner === 'player');
  assert.equal(record.solutionStatus, 'solved');
  assert.equal(record.targetId, 'TEST-TURRET');
  assert.ok(record.predictedFlightSeconds > 0);
  assert.ok(game.fireControl.residualMeters <= 0.01);
  assert.deepEqual(projectile.origin, record.muzzlePosition);
  projectile.direction.forEach((value, index) => close(value, record.launchDirection[index], 1e-12));
  assert.deepEqual(projectile.initialVelocity, record.initialVelocity);
  assert.deepEqual(projectile.acceleration, record.accelerationAtFire);
  close(Math.hypot(...projectile.initialVelocity), 100);
  game.advance(record.predictedFlightSeconds + 0.02, idle);
  assert.equal(game.enemies[0].hp, 228);
  assert.deepEqual(game.recentPlayerShots.at(-1), record);
  assert.ok(!game.projectiles.includes(projectile), 'impact removes the actual projectile');

  game.switchWeapon('beam');
  assert.equal(game.fireControl.predictedFlightSeconds, 0);
  assert.equal(game.fire(), true);
  assert.equal(game.enemies[0].hp, 188);
  const beamRecord = game.recentPlayerShots.at(-1);
  assert.equal(beamRecord.initialVelocity, null);
  assert.deepEqual(beamRecord.targetPositionAtFire, game.enemies[0].position);
  assert.deepEqual(game.fireControl.aimPoint, game.enemies[0].position);
  game.switchWeapon('missile');
  assert.equal(game.fire(), true);
  const missile = game.projectiles.find(shot => shot.owner === 'player' && shot.weapon === 'missile');
  assert.equal(missile.targetId, game.enemies[0].id);
  close(Math.hypot(...missile.initialVelocity), 45);
  game.advance(1.5, idle);
  assert.equal(game.enemies[0].hp, 8);
});

test('new shots advance only their post-fire interval and firing timestamps are frame-rate independent', () => {
  for (const fps of [30, 60, 120]) {
    const game = arenaGame({ enemies: false });
    let advanced = 0;
    while (advanced < 1.04 - 1e-10) {
      const dt = Math.min(1 / fps, 1.04 - advanced);
      game.advance(dt, { ...idle, fireHeld: true });
      advanced += dt;
    }
    assert.equal(game.recentPlayerShots.length, 11);
    assert.equal(game.player.ammo.machinegun, 289);
    game.recentPlayerShots.forEach((record, index) => close(record.firedAtSeconds, index / 10));
    const latest = game.projectiles.find(shot => shot.id === game.projectileId);
    close(latest.age, 0.04);
    const t = latest.age;
    latest.position.forEach((value, index) => close(value, latest.origin[index] + latest.initialVelocity[index] * t + 0.5 * latest.acceleration[index] * t ** 2));
  }
});

test('game combines actual glide, flight, and QB with 100m/s shots from current muzzle', () => {
  for (const mode of ['glide', 'flight', 'quickboost']) {
    const game = arenaGame({ enemies: false });
    let input;
    if (mode === 'glide') input = { ...idle, glidePressed: true, direction: [1, 0] };
    else if (mode === 'flight') input = { ...idle, jumpPressed: true, spaceHeld: true, spaceHeldSeconds: 0, direction: [1, 0] };
    else input = { ...idle, qbPressed: true };
    game.advance(mode === 'quickboost' ? 0.04 : 0.3, input);
    if (mode === 'quickboost') assert.equal(game.player.movement.horizontalMode, 'quickboost');
    if (mode === 'glide') assert.equal(game.player.movement.horizontalMode, 'glide');
    if (mode === 'flight') assert.equal(game.player.movement.verticalMode, 'flying');
    const actualMuzzle = game.getMuzzle();
    assert.equal(game.fire(), true);
    const shot = game.projectiles.find(shot => shot.owner === 'player');
    assert.deepEqual(shot.origin, actualMuzzle);
    close(Math.hypot(...shot.initialVelocity), 100);
    assert.deepEqual(game.recentPlayerShots.at(-1).initialVelocity, shot.initialVelocity);
    assert.ok(Math.hypot(game.player.velocity[0], game.player.velocity[2]) > 0);
  }
});

test('A05: 20 locked actual Game shots per glide/flight/QB mode hit constant-velocity radius0.5 targets', context => {
  for (const mode of ['glide', 'flight', 'quickboost']) {
    let hits = 0;
    let maximumResidual = 0;
    for (let trial = 0; trial < 20; trial++) {
      const flight = mode === 'flight';
      const floorY = flight ? 14.46 : 16.9;
      const movementSeconds = mode === 'quickboost' ? 0.04 : 0.3;
      const movementDistance = mode === 'quickboost' ? 3.2 : flight ? 16 * 0.3 - 16 ** 2 / (2 * 120) : 22 * 0.3 - 22 ** 2 / (2 * CONFIG.groundGlideAcceleration);
      const fixture = arena({ enemies: false });
      fixture.sectors[0].floorY = floorY;
      fixture.sectors[0].bounds.min[1] = floorY;
      fixture.boxes[0].min[1] = floorY - 4;
      fixture.boxes[0].max[1] = floorY;
      fixture.startPosition = [-movementDistance, floorY + 2.1, 0];
      fixture.enemies = [{ id: 'A05-TARGET', kind: 'turret', isGateControl: false, sectorId: 'TEST', position: [-movementDistance, floorY + 3.1, 100], velocity: [0, 0, 0], hp: 240, radius: 0.5 }];
      const muzzleProvider = game => [game.player.position[0], game.player.position[1] + 0.99999, game.player.position[2]];
      const trackingCamera = game => {
        const muzzle = muzzleProvider(game);
        const position = [muzzle[0], muzzle[1] + 3, muzzle[2] - 5];
        return {
          position, forward: [0, 0, 1], width: 1280, height: 720,
          project(point) {
            const depth = point[2] - position[2];
            return { x: 640 + (point[0] - position[0]) * 600 / depth, y: 360 - (point[1] - position[1]) * 600 / depth, depth };
          },
        };
      };
      const game = new Game({ stage: fixture, cameraProvider: trackingCamera, muzzleProvider });
      game.state = 'playing';
      game.advance(0.8, idle);
      assert.equal(game.lock.state, 'locked');
      const input = mode === 'quickboost' ? { ...idle, qbPressed: true }
        : mode === 'glide' ? { ...idle, glidePressed: true, direction: [1, 0] }
          : { ...idle, jumpPressed: true, spaceHeld: true, spaceHeldSeconds: 0, direction: [1, 0] };
      game.advance(movementSeconds, input);
      if (mode === 'flight') {
        assert.equal(game.player.movement.verticalMode, 'flying');
        close(game.player.velocity[1], 8);
        close(game.player.velocity[0], 16);
      } else {
        assert.equal(game.player.movement.horizontalMode, mode);
        close(game.player.velocity[0], mode === 'glide' ? 22 : 80);
      }
      const muzzle = game.getMuzzle();
      muzzle.forEach((value, index) => close(value, [0, 20, 0][index], 2e-5));
      const target = game.enemies[0];
      // The required A05 condition deliberately keeps target motion constant
      // after launch. The production turret AI normally stops, so this fixture
      // supplies the condition at fire time; aim, launch and collision remain
      // the exact production Game/FCS/projectile functions.
      target.position = [muzzle[0], muzzle[1], muzzle[2] + 100];
      target.previousPosition = target.position.slice();
      target.velocity = [8, 0, 0];
      assert.equal(game.fire(), true);
      assert.equal(game.lock.state, 'locked');
      assert.equal(game.fireControl.status, 'solved');
      maximumResidual = Math.max(maximumResidual, game.fireControl.residualMeters);
      assert.ok(game.fireControl.residualMeters <= 0.01);
      const record = game.recentPlayerShots.at(-1);
      const shot = game.projectiles.find(shot => shot.owner === 'player');
      assert.deepEqual(record.muzzlePosition, muzzle);
      assert.deepEqual(shot.origin, muzzle);
      assert.deepEqual(record.targetPositionAtFire, target.position);
      assert.deepEqual(record.targetVelocityAtFire, [8, 0, 0]);
      assert.deepEqual(record.initialVelocity, shot.initialVelocity);
      close(Math.hypot(...shot.initialVelocity), 100);
      close(shot.initialVelocity[0], 8, 1e-8);
      assert.deepEqual(shot.acceleration, [0, -18, 0]);
      assert.equal(game.player.ammo.machinegun, 299);
      let result = null;
      let elapsed = 0;
      while (elapsed < 2 - 1e-10) {
        const dt = Math.min(1 / 120, 2 - elapsed);
        target.previousPosition = target.position.slice();
        target.position = target.position.map((value, index) => value + target.velocity[index] * dt);
        result = advancePlayerProjectile(shot, dt, game.enemies, game.world, game.elapsedSeconds + elapsed);
        elapsed += dt;
        if (result.hit || result.expired) break;
      }
      assert.equal(result.hit?.type, 'enemy', `${mode} trial ${trial + 1} missed`);
      assert.equal(result.hit.enemy.id, target.id);
      hits++;
    }
    assert.equal(hits, 20);
    context.diagnostic(`${mode}: fired20, actual swept hits${hits}, max residual${maximumResidual}m`);
  }
});

test('production geometry permits EN0 glide and regeneration while remaining grounded', () => {
  const game = new Game();
  game.state = 'playing';
  // This is inside the production S01 unobstructed combat rectangle, away from
  // the visible shelter wall, with the production collision solver and enemies.
  game.player.position = [35, 2.1, -20];
  game.player.en = 0;
  game.player.movement.lastEnSpentAtSeconds = 0;
  game.advance(0.75, { ...idle, glidePressed: true });
  assert.equal(game.player.movement.glideEnabled, true);
  assert.equal(game.player.movement.horizontalMode, 'glide');
  assert.equal(game.player.grounded, true);
  close(game.player.en, 0);
  assert.ok(game.player.position[0] > 48);
  game.advance(0.25, idle);
  close(game.player.en, 3.75);
  close(Math.hypot(game.player.velocity[0], game.player.velocity[2]), 22);
  assert.equal(game.player.grounded, true);
});

test('six production controls open their own visible barriers and final gate, escape needs all six', () => {
  const game = new Game();
  const controls = game.enemies.filter(enemy => enemy.isGateControl);
  const activeBox = id => game.world.getBoxes().some(box => box.barrierId === id);
  assert.ok(activeBox('FINAL-GATE'));
  for (let index = 0; index < controls.length; index++) {
    const control = controls[index];
    const barrier = STAGE.barriers.find(barrier => barrier.controlId === control.id);
    assert.ok(activeBox(barrier.id));
    game.damageEnemy(control, control.hp, control.position);
    assert.equal(game.objective.controlsDestroyed, index + 1);
    assert.equal(activeBox(barrier.id), false);
    assert.equal(game.objective.gateOpen, index === 5);
    assert.equal(activeBox('FINAL-GATE'), index < 5);
  }
  const snapshot = game.snapshot();
  assert.equal(snapshot.enemies.length, 45);
  assert.equal(snapshot.enemies.filter(enemy => !enemy.alive).length, 6);
  assert.equal(snapshot.objective.openBarrierIds.length, 7);
  game.state = 'playing';
  game.player.position = center(STAGE.escapeBounds);
  game.player.grounded = false;
  game.advance(CONFIG.simulationStep, idle);
  assert.equal(game.state, 'cleared');

  const closed = new Game();
  closed.state = 'playing';
  closed.player.position = center(STAGE.escapeBounds);
  closed.player.grounded = false;
  closed.advance(CONFIG.simulationStep, idle);
  assert.equal(closed.state, 'playing');
  assert.equal(closed.objective.gateOpen, false);
});

test('zero HP takes priority when final escape and failure occur in the same update', () => {
  const game = new Game();
  for (const enemy of game.enemies.filter(enemy => enemy.isGateControl)) game.damageEnemy(enemy, enemy.hp, enemy.position);
  game.player.position = center(STAGE.escapeBounds);
  game.player.grounded = false;
  game.player.hp = 0;
  game.state = 'playing';
  game.advance(CONFIG.simulationStep, idle);
  assert.equal(game.state, 'failed');
  const frozen = game.snapshot();
  game.advance(2, { ...idle, qbPressed: true, fireHeld: true, spaceHeld: true, spaceHeldSeconds: 0.2 });
  assert.deepEqual(game.snapshot(), frozen);
});

test('pause stops physics, enemies, lock, projectiles, all cooldowns, and elapsed time', () => {
  const game = arenaGame();
  game.advance(0.05, { ...idle, qbPressed: true, fireHeld: true });
  game.state = 'paused';
  const paused = game.snapshot();
  const projectileState = structuredClone(game.projectiles);
  const enemyState = structuredClone(game.enemies);
  const cooldowns = structuredClone(game.nextFire);
  game.advance(5, { ...idle, qbPressed: true, fireHeld: true, spaceHeld: true, spaceHeldSeconds: 0.2 });
  assert.deepEqual(game.snapshot(), paused);
  assert.deepEqual(game.projectiles, projectileState);
  assert.deepEqual(game.enemies, enemyState);
  assert.deepEqual(game.nextFire, cooldowns);
  game.state = 'playing';
  game.advance(0.1, idle);
  close(game.elapsedSeconds, 0.15);
  assert.equal(game.player.movement.qbSuccessfulCount, 1);
  close(game.player.movement.qbImpulseRemainingSeconds, 0);
});

test('production reset restores enemies, gates, shots, timers, and movement while preserving loadout', () => {
  const loadout = { fcs: 'narrow', generator: 'recovery', legs: 'quadruped' };
  const game = new Game({ seed: 19, loadout });
  const initial = game.snapshot();
  game.state = 'playing';
  game.advance(0.1, { ...idle, qbPressed: true, fireHeld: true });
  game.damageEnemy(game.enemies.find(enemy => enemy.isGateControl), 240, [0, 0, 0]);
  game.player.hp = 20;
  game.player.weapon = 'beam';
  game.lock.targetId = game.enemies[0].id;
  game.lock.progress = 0.7;
  game.reset();
  game.state = 'garage';
  assert.deepEqual(game.snapshot(), initial);
  assert.deepEqual(game.nextFire, { machinegun: 0, beam: 0, missile: 0 });
  assert.equal(game.projectiles.length, 0);
  assert.equal(game.effects.length, 0);
  assert.equal(game.recentPlayerShots.length, 0);
  assert.equal(game.shotId, 0);
  assert.equal(game.projectileId, 0);
  assert.equal(game.world.openBarrierIds.size, 0);
  assert.deepEqual(game.loadout, loadout);
  close(game.player.en, 90);
});

test('history retains 32 actual shots in chronological order and rejected fire adds none', () => {
  const game = arenaGame({ enemies: false });
  game.advance(3.3, { ...idle, fireHeld: true });
  assert.equal(game.shotId, 33);
  assert.equal(game.recentPlayerShots.length, 32);
  assert.equal(game.recentPlayerShots[0].id, 2);
  assert.equal(game.recentPlayerShots.at(-1).id, 33);
  for (let index = 1; index < game.recentPlayerShots.length; index++) assert.ok(game.recentPlayerShots[index].firedAtSeconds > game.recentPlayerShots[index - 1].firedAtSeconds);
  game.switchWeapon('missile');
  const history = structuredClone(game.recentPlayerShots);
  assert.equal(game.fire(), false);
  assert.deepEqual(game.recentPlayerShots, history);
  assert.equal(game.player.ammo.missile, WEAPONS.missile.ammo);
});
