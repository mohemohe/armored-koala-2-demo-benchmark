import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { createPlayer, stepMovement, spendEN, stats, KeyInput, FCS, GENERATORS, LEGS } from '../src/movement.js';

const forward = new Vector3(0, 0, 1);
const flatFloor = {
  move(pos, delta, velocity) {
    pos.add(delta);
    if (pos.y > 1e-12 || velocity.y > 0) return false;
    pos.y = velocity.y = 0;
    return true;
  }
};
function rig(legs = 'biped', world = flatFloor) {
  const player = createPlayer({ legs, fcs: 'medium', generator: 'balanced' }, new Vector3());
  const keys = new KeyInput();
  let tick = 0;
  return {
    player, keys,
    run(ticks, callback) {
      for (let n = 0; n < ticks; n++, tick++) {
        stepMovement(player, keys.sample(forward), 1 / 120, tick / 120, world,
          callback && (() => callback(player, tick / 120)));
      }
    }
  };
}
const near = (a, b, eps = 1e-8) => assert.ok(Math.abs(a-b) <= eps, `${a} vs ${b}`);
function report(label, p) {
  console.log(label, JSON.stringify({pos:p.pos.toArray(), vel:p.vel.toArray(), en:p.en, qb:p.movement.qbSuccessfulCount, mode:p.movement.horizontalMode}));
}

for (const legs of ['biped', 'quadruped']) {
  const r = rig(legs);
  r.keys.down('KeyQ', true);
  r.run(1);
  r.keys.up('KeyQ');
  near(r.player.en, 84);
  r.run(17);
  report(legs + ' released, t=.15', r.player);
  const factor = legs === 'biped' ? 1 : .8;
  near(r.player.pos.z, 12 * factor);
  near(r.player.vel.z, 80 * factor);
  assert.equal(r.player.movement.horizontalMode,'glide');
  r.run(72);
  near(r.player.pos.z, 42.6 * factor);
  near(r.player.vel.z, 22 * factor);
  report(legs + ' released, t=.75', r.player);
  r.run(30);
  near(r.player.en,84+.25*r.player.stats.regenPerSecond);
  report(legs + ' released, t=1',r.player);
}
{
  const r = rig();
  r.keys.down('KeyQ',true);
  for (let i=0;i<600;i++) {
    if (i>0 && i%4===0) r.keys.down('KeyQ',true,true);
    r.run(1);
  }
  assert.equal(r.player.movement.qbSuccessfulCount,1);
  assert.equal(r.player.movement.qbLastStartedAtSeconds,0);
  report('Q held + repeated, t=5',r.player);
}
for (const en of [35,36]) {
  const r=rig();
  r.player.en=en;
  r.keys.down('KeyQ',true);
  r.run(1);
  assert.equal(r.player.movement.qbSuccessfulCount,Number(en===36));
  assert.equal(r.player.movement.lastEnSpentAtSeconds,en===36?0:null);
  report('initial EN '+en+', t=1/120',r.player);
  r.run(89);
  if (en===36) {
    near(r.player.pos.z,42.6);
    near(r.player.en,0);
    r.run(30);
    near(r.player.en,3.75);
    report('initial EN 36, t=1',r.player);
  }
}
{
  const r=rig();
  r.player.en=0; r.player.movement.lastEnSpentAtSeconds=0;
  r.keys.down('ShiftLeft',true); r.run(1); r.keys.up('ShiftLeft');
  r.run(89);
  near(r.player.en,0);
  near(r.player.vel.z,22);
  r.run(30);
  near(r.player.en,3.75);
  report('manual glide from EN 0, t=1',r.player);
  r.keys.down('ControlLeft',true); r.keys.down('KeyW',true); r.keys.down('KeyQ',true);
  r.run(1);
  assert.equal(r.player.movement.horizontalMode,'walk');
  assert.equal(r.player.movement.qbSuccessfulCount,0);
  near(r.player.vel.z,21);
}
for (const startEn of [36, 43, 44, 44.1, 60]) {
  const r=rig();
  r.keys.down('Space',true); r.run(24);
  r.player.en=startEn;
  r.keys.down('KeyQ',true);
  let beam;
  const y = r.player.pos.y;
  r.run(1,(p,t)=>beam=spendEN(p,8,t));
  assert.equal(beam,startEn>=44);
  near(r.player.en,Math.max(0,startEn-36-(beam?8:0)-20/120));
  if (startEn===44.1) {
    const coast=1/120-0.1/20;
    near(r.player.pos.y-y,8/120-9*coast*coast);
  }
  report('simultaneous QB/beam/flight initial EN '+startEn,r.player);
}
{
  const r=rig();
  r.keys.down('KeyQ',true);r.run(1);r.keys.clear();
  r.keys.down('KeyQ',true,true);r.run(200);
  assert.equal(r.player.movement.qbSuccessfulCount,1);
  r.keys.up('KeyQ');r.keys.down('KeyQ',true);r.run(1);
  assert.equal(r.player.movement.qbSuccessfulCount,2);
}
{
  const wall = {
    move(pos,d,v) {
      const grounded=flatFloor.move(pos,d,v);
      if(pos.z>=4) {pos.z=4;v.z=0;}
      return grounded;
    }
  };
  const r=rig('biped',wall);
  r.keys.down('KeyQ',true);r.run(12);
  near(r.player.pos.z,4);
  near(r.player.vel.z,0);
  assert.ok(r.player.movement.qbImpulseRemainingSeconds>0);
}
for (const legs of Object.keys(LEGS)) for(const fcs of Object.keys(FCS)) for(const generator of Object.keys(GENERATORS)) {
  const s = stats({legs, fcs, generator});
  near(s.maxEn*s.regenPerSecond/LEGS[legs].regen,1800);
  near(s.lockSeconds*LEGS[legs].lockSpeed,FCS[fcs].seconds);
}
console.log('All movement assertions passed.');
