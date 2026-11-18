import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { solveFireControl, projectilePosition, segmentMovingSphere, steerMissile, polynomialRootsInInterval } from '../src/combat.js';

const v = (x,y,z) => new Vector3(x,y,z);
const cases = [
  [v(0,0,20),v(0,0,0)], [v(0,0,60),v(0,0,0)], [v(0,0,100),v(0,0,0)], [v(0,0,120),v(0,0,0)],
  [v(0,0,100),v(8,0,0)], [v(0,0,100),v(-8,0,0)], [v(0,0,100),v(0,0,8)], [v(0,0,100),v(0,0,-8)],
  [v(0,16,100),v(6,0,0)], [v(0,-16,100),v(-6,0,0)], [v(0,0,100),v(6,3,0)], [v(0,0,100),v(6,-3,0)], [v(0,0,120),v(6,3,4)],
];
const muzzle = v(0,20,0), step = 1/120;
function simulateGun(r, velocity) {
  const target = muzzle.clone().add(r);
  const solution = solveFireControl('machinegun', muzzle, target, velocity);
  assert.equal(solution.status, 'solved');
  const shot = { origin:muzzle.clone(), velocity:solution.direction.clone().multiplyScalar(100), acceleration:v(0,-18,0) };
  assert.ok(Math.abs(shot.velocity.length()-100)<.001);
  assert.ok(solution.residual <= .01);
  let hit = false;
  for (let t=0; t<2-1e-10; t+=step) {
    const t2=Math.min(2,t+step);
    if (segmentMovingSphere(projectilePosition(shot,t), projectilePosition(shot,t2), target.clone().addScaledVector(velocity,t),target.clone().addScaledVector(velocity,t2), .5) !== null) { hit=true; break; }
  }
  return {hit,solution};
}

test('machinegun A01-A13, twenty actual swept-sphere projectile runs per case', () => {
  for (let i=0;i<cases.length;i++) {
    let hits=0;
    for (let n=0;n<20;n++) if(simulateGun(...cases[i]).hit) hits++;
    assert.equal(hits,20,`A${String(i+1).padStart(2,'0')}`);
  }
  const a03=simulateGun(...cases[2]).solution;
  const a05=simulateGun(...cases[4]).solution;
  const a13=simulateGun(...cases[12]).solution;
  assert.ok(Math.abs(a03.time-1.004108529)<1e-8);
  assert.ok(Math.abs(a05.time-1.007391236)<1e-8);
  assert.ok(Math.abs(a13.time-1.266137996)<1e-8);
});

test('beam uses current center for each A01-A13, twenty runs each', () => {
  for (const [r,velocity] of cases) for(let i=0;i<20;i++) {
    const target=muzzle.clone().add(r), solution=solveFireControl('beam',muzzle,target,velocity);
    const end=muzzle.clone().addScaledVector(solution.direction,120);
    assert.notEqual(segmentMovingSphere(muzzle,end,target,target,.5),null);
    assert.equal(solution.time,0);
  }
});

test('missile lead and angular speed A05-A07, twenty runs each', () => {
  for (const [r,velocity] of cases.slice(4,7)) for(let n=0;n<20;n++) {
    const target=muzzle.clone().add(r), solution=solveFireControl('missile',muzzle,target,velocity);
    let position=muzzle.clone(), direction=solution.direction.clone(), hit=false;
    for(let t=0;t<4-1e-10;t+=step) {
      const p=target.clone().addScaledVector(velocity,t);
      const desired=solveFireControl('missile',position,p,velocity).direction;
      const nextDirection=steerMissile(direction,desired,step);
      assert.ok(direction.angleTo(nextDirection)<=2*Math.PI/3*step+1e-7);
      direction=nextDirection;
      const next=position.clone().addScaledVector(direction,45*step);
      if(segmentMovingSphere(position,next,p,p.clone().addScaledVector(velocity,step),.5)!==null) {hit=true;break;}
      position=next;
    }
    assert.ok(hit);
  }
});

test('stationary root and upper boundary are retained', () => {
  assert.ok(polynomialRootsInInterval([1,-2,1],0,2).some(x=>Math.abs(x-1)<1e-9));
  assert.ok(polynomialRootsInInterval([-2,1],0,2).some(x=>Math.abs(x-2)<1e-9));
});
