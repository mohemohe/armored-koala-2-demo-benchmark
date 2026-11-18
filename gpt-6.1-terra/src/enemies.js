import { segmentMovingSphere } from './combat.js';

// First contact with a solid box along a finite segment.
function boxFraction(a,b,box) {
  let lo=0,hi=1;
  for (const axis of ['x','y','z']) {
    const d=b[axis]-a[axis];
    if (Math.abs(d)<1e-9) { if(a[axis]<box.min[axis] || a[axis]>box.max[axis]) return null; }
    else {
      let u=(box.min[axis]-a[axis])/d, v=(box.max[axis]-a[axis])/d;
      if(u>v) [u,v]=[v,u];
      lo=Math.max(lo,u); hi=Math.min(hi,v); if(lo>hi) return null;
    }
  }
  return lo;
}
export function solidFraction(a,b,colliders) {
  let best=null;
  for (const box of colliders) {
    const f=boxFraction(a,b,box);
    if(f!==null && (best===null || f<best)) best=f;
  }
  return best;
}
export function clearSight(a,b,colliders) {
  const f=solidFraction(a,b,colliders);
  return f===null || f>=.999999;
}

export class EnemySystem {
  constructor({THREE,scene,stage,player,onDamage=()=>{}}) {
    this.THREE=THREE; this.scene=scene; this.stage=stage; this.player=player; this.onDamage=onDamage;
    this.enemies=[]; this.bullets=[]; this.controlsDestroyed=0;
    this.projectileGeometry=new THREE.SphereGeometry(.26,7,5);
    this.bulletMaterial=new THREE.MeshBasicMaterial({color:0xff8157});
    this.guardMat=new THREE.MeshStandardMaterial({color:0x9c5951,metalness:.55,roughness:.6});
    this.turretMat=new THREE.MeshStandardMaterial({color:0xa18257,metalness:.55,roughness:.55});
    this.controlMat=new THREE.MeshStandardMaterial({color:0xd28b37,metalness:.5,roughness:.5,emissive:0x361000});
    this.warningMat=new THREE.MeshBasicMaterial({color:0xff5f29});
    this.cube=new THREE.BoxGeometry(1,1,1);
    this.sphere=new THREE.SphereGeometry(1,12,8);
    for (const def of stage.enemies) {
      const turret=def.kind==='turret';
      const mesh=new THREE.Group();
      const mat=def.isGateControl?this.controlMat:turret?this.turretMat:this.guardMat;
      const part=(geom,material,x,y,z,sx,sy,sz)=>{ const m=new THREE.Mesh(geom,material);m.position.set(x,y,z);m.scale.set(sx,sy,sz);mesh.add(m);return m; };
      part(this.cube,mat,0,0,0,turret?3.8:2.8,turret?2.6:3.2,2.8);
      part(this.sphere,mat,0,1.4,0,1.5,1,1.5);
      part(this.cube,mat,-1.9,-1.2,0,.8,1.5,2);
      part(this.cube,mat,1.9,-1.2,0,.8,1.5,2);
      part(this.cube,this.guardMat,0,.4,-2.0,.5,.5,2.8);
      const warning=part(this.sphere,this.warningMat,0,1.6,-1.3,.35,.35,.35); warning.visible=false;
      if(def.isGateControl) part(this.cube,this.warningMat,0,3.1,0,.5,1.2,.5);
      const position=new THREE.Vector3(...def.position);mesh.position.copy(position);scene.add(mesh);
      this.enemies.push({...def,position,velocity:new THREE.Vector3(),hp:turret?240:120,alive:true,
        radius:turret?2.4:2,mesh,warning,alert:false,hasLineOfSight:false,shotsFired:0,lastShotAtSeconds:null,
        lastKnown:null,lastSeenAt:null,firstSeen:false,nextBurstAt:null,burstNextAt:null,burstRemaining:0,
        turnSign:def.id.charCodeAt(def.id.length-1)%2?1:-1});
    }
  }
  damage(enemy,amount) {
    if(!enemy || !enemy.alive) return;
    enemy.hp=Math.max(0,enemy.hp-amount);
    if(enemy.hp>0) return;
    enemy.alive=false; enemy.velocity.set(0,0,0);enemy.mesh.visible=false;enemy.warning.visible=false;
    if(enemy.isGateControl){
      this.controlsDestroyed++; this.stage.removeBarrier(enemy.barrierId);
      if(this.controlsDestroyed===6) this.stage.removeBarrier('FINAL');
    }
  }
  getSnapshot() {
    return this.enemies.map(e => ({id:e.id, kind:e.kind, isGateControl:e.isGateControl,
      sectorId:e.sectorId, position:e.position.toArray(), velocity:e.velocity.toArray(), hp:e.hp,
      alive:e.alive, alert:e.alert, hasLineOfSight:e.hasLineOfSight,
      shotsFired:e.shotsFired, lastShotAtSeconds:e.lastShotAtSeconds}));
  }
  dispose() {
    for(const e of this.enemies) this.scene.remove(e.mesh);
    for(const b of this.bullets) this.scene.remove(b.mesh);
    this.bullets=[];
  }
  // Movement is confined to reachable floor and uses local obstacle avoidance.
  moveGuard(e,direction,speed,dt) {
    if(direction.lengthSq()<1e-8) {e.velocity.set(0,0,0);return;}
    direction.y=0; direction.normalize();
    const T=this.THREE, old=e.position.clone();
    const candidates=[0,.55,-.55,1.1,-1.1,1.57,-1.57,2.4,-2.4];
    let best=null,bestScore=-Infinity;
    for(const a of candidates){
      const c=Math.cos(a),s=Math.sin(a),dx=direction.x*c-direction.z*s,dz=direction.x*s+direction.z*c;
      const next=old.clone().add(new T.Vector3(dx*speed*dt,0,dz*speed*dt));
      const ahead=old.clone().add(new T.Vector3(dx*3,0,dz*3));
      if(!this.canOccupy(next,e) || !this.canOccupy(ahead,e)) continue;
      // Small tie-break establishes consistent wall-following around an obstacle.
      const score=dx*direction.x+dz*direction.z + Math.sign(a)*e.turnSign*.015;
      if(score>bestScore){bestScore=score;best=next;}
    }
    if(best){e.position.copy(best);e.velocity.copy(best).sub(old).multiplyScalar(1/dt);}
    else e.velocity.set(0,0,0);
    e.mesh.position.copy(e.position);
  }
  canOccupy(p,e) {
    const feet=p.y-2;
    for(const b of this.stage.colliders){
      if(b.type==='floor' || b.type==='ceiling') continue;
      if(p.x+1.2>b.min.x && p.x-1.2<b.max.x && p.z+1.2>b.min.z && p.z-1.2<b.max.z && feet+3.5>b.min.y && feet<b.max.y) return false;
    }
    for(const other of this.enemies){if(other!==e && other.alive && Math.abs(other.position.y-p.y)<3 && Math.hypot(other.position.x-p.x,other.position.z-p.z)<3.1)return false;}
    const sec=this.stage.sectorAt(p);return !!sec && Math.abs(sec.floorY-feet)<.5;
  }
  fire(e,target,velocity,time) {
    const T=this.THREE, speed=e.kind==='guard'?70:60;
    const rel=target.clone().sub(e.position), a=velocity.lengthSq()-speed*speed,b=2*rel.dot(velocity),c=rel.lengthSq();
    let t=Math.sqrt(c)/speed;
    const disc=b*b-4*a*c;
    if(Math.abs(a)<1e-9){if(Math.abs(b)>1e-9 && -c/b>0)t=-c/b;}
    else if(disc>=0){const roots=[(-b-Math.sqrt(disc))/(2*a),(-b+Math.sqrt(disc))/(2*a)].filter(x=>x>0);if(roots.length)t=Math.min(...roots);}
    t=Math.min(1.2,Math.max(0,t));
    const dir=target.clone().addScaledVector(velocity,t).sub(e.position).normalize();
    const mesh=new T.Mesh(this.projectileGeometry,this.bulletMaterial);mesh.position.copy(e.position);this.scene.add(mesh);
    this.bullets.push({position:e.position.clone(),velocity:dir.multiplyScalar(speed),age:0,life:e.kind==='guard'?2:3,damage:e.kind==='guard'?18:40,mesh});
    e.shotsFired++;e.lastShotAtSeconds=time;
  }
  update(dt,time) {
    const T=this.THREE, p=this.player;
    const playerCenter=new T.Vector3(p.position.x,p.position.y+2,p.position.z);
    const playerVelocity=new T.Vector3(p.velocity.x,p.velocity.y,p.velocity.z);
    for(const e of this.enemies){
      if(!e.alive) continue;
      const guard=e.kind==='guard', dist=e.position.distanceTo(playerCenter), range=guard?90:120;
      const visible=dist<=range && clearSight(e.position,playerCenter,this.stage.colliders);
      const hadSight=e.hasLineOfSight;e.hasLineOfSight=visible;
      if(visible){
        e.lastKnown=playerCenter.clone();e.lastSeenAt=time;e.alert=true;
        if(!e.firstSeen){e.firstSeen=true;e.nextBurstAt=time+(guard?.5:.7);}
        else if(!hadSight && e.nextBurstAt!==null) e.nextBurstAt=Math.max(e.nextBurstAt,time+(guard?.15:.35));
        if(guard){
          for(const ally of this.enemies){
            if(ally!==e && ally.alive && ally.kind==='guard' && ally.sectorId===e.sectorId && ally.position.distanceTo(e.position)<=60 && clearSight(ally.position,e.position,this.stage.colliders)){
              ally.lastKnown=playerCenter.clone();ally.lastSeenAt=time;ally.alert=true;
            }
          }
        }
      } else if(e.lastSeenAt===null || time-e.lastSeenAt>8) e.alert=false;
      if(guard && e.alert && e.lastKnown){
        const dir=e.lastKnown.clone().sub(e.position);dir.y=0;
        const horizontal=dir.length();
        if(visible && dist<15) dir.negate();
        else if(visible && dist>=25 && dist<=55){const x=dir.x;dir.x=-dir.z*e.turnSign;dir.z=x*e.turnSign;}
        else if(visible && dist>=15 && dist<25) dir.multiplyScalar(dist<20?-1:1);
        if(horizontal>2) this.moveGuard(e,dir,visible && dist>=25 && dist<=55?6:8,dt);
        else e.velocity.set(0,0,0);
      } else e.velocity.set(0,0,0);
      if(visible){
        e.mesh.rotation.y=Math.atan2(e.position.x-playerCenter.x,e.position.z-playerCenter.z);
        if(e.nextBurstAt!==null && time+1e-9>=e.nextBurstAt){
          e.burstRemaining=guard?3:2;e.burstNextAt=e.nextBurstAt;e.nextBurstAt+=guard?1.2:1.6;
        }
        while(e.burstRemaining>0 && time+1e-9>=e.burstNextAt){
          if(clearSight(e.position,playerCenter,this.stage.colliders)) this.fire(e,playerCenter,playerVelocity,e.burstNextAt);
          e.burstRemaining--;e.burstNextAt+=guard?.12:.25;
        }
      } else if(e.burstRemaining>0){
        while(e.burstRemaining>0 && time+1e-9>=e.burstNextAt){e.burstRemaining--;e.burstNextAt+=guard?.12:.25;}
      }
      e.warning.visible=visible && e.nextBurstAt!==null && time>=e.nextBurstAt-(guard?.15:.35);
    }
    const prevCenter=playerCenter.clone().addScaledVector(playerVelocity,-dt);
    for(let i=this.bullets.length-1;i>=0;i--){
      const b=this.bullets[i], h=Math.min(dt,b.life-b.age), start=b.position.clone(), end=start.clone().addScaledVector(b.velocity,h);
      const wall=solidFraction(start,end,this.stage.colliders);
      const hit=segmentMovingSphere(start,end,prevCenter,playerCenter,2.1);
      if(hit!==null && (wall===null || hit<wall)){
        p.hp-=b.damage;this.onDamage(b.damage,b.velocity.clone().normalize());this.scene.remove(b.mesh);this.bullets.splice(i,1);continue;
      }
      b.position.copy(end);b.mesh.position.copy(end);b.age+=h;
      if(wall!==null || b.age>=b.life-1e-9){this.scene.remove(b.mesh);this.bullets.splice(i,1);}
    }
  }
}
