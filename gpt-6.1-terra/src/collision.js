/** Swept AABB against visible stage boxes, in metres. Player is represented by
 * feet at position, a horizontal half-width of 1m and a height of 4.5m. */
export function movePlayer(state, displacement, colliders, radius=1, height=4.5) {
  const pos=state.position, vel=state.velocity;
  let d={...displacement};
  for(let iteration=0;iteration<4;iteration++) {
    let best=1, axis=null, normal=0;
    for(const c of colliders) {
      const mins={x:c.min.x-radius,y:c.min.y-height,z:c.min.z-radius};
      const maxs={x:c.max.x+radius,y:c.max.y,z:c.max.z+radius};
      // Broad phase for the whole swept box.
      if(['x','y','z'].some(k=>Math.max(pos[k],pos[k]+d[k])<mins[k]-1e-7 || Math.min(pos[k],pos[k]+d[k])>maxs[k]+1e-7)) continue;
      let enter=-Infinity, exit=Infinity, hitAxis=null, hitNormal=0;
      for(const k of ['x','y','z']) {
        if(Math.abs(d[k])<1e-12) {
          // Touching a floor or wall while sliding is not a collision.
          if(pos[k]<=mins[k]+1e-8 || pos[k]>=maxs[k]-1e-8) { enter=Infinity; break; }
          continue;
        }
        let a=(mins[k]-pos[k])/d[k], b=(maxs[k]-pos[k])/d[k];
        let n=-1;
        if(a>b) { [a,b]=[b,a]; n=1; }
        if(a>enter) { enter=a; hitAxis=k; hitNormal=n; }
        exit=Math.min(exit,b);
      }
      if(hitAxis && enter>=-1e-8 && enter<=best && exit>=Math.max(0,enter) && exit>=0) {
        best=Math.max(0,enter); axis=hitAxis; normal=hitNormal;
      }
    }
    if(!axis) { pos.x+=d.x; pos.y+=d.y; pos.z+=d.z; break; }
    pos.x+=d.x*best; pos.y+=d.y*best; pos.z+=d.z*best;
    const remaining=1-best;
    d.x*=remaining; d.y*=remaining; d.z*=remaining;
    d[axis]=0;
    if(vel[axis]*normal<0) vel[axis]=0;
    if(axis==='y' && normal===1) state.grounded=true;
    if(Math.abs(d.x)+Math.abs(d.y)+Math.abs(d.z)<1e-10) break;
  }
  // Support test ensures walking off ledges starts falling. Any visible solid
  // top can be a landing surface, including an equipment case.
  state.grounded=vel.y<=0 && colliders.some(c =>
    Math.abs(pos.y-c.max.y)<1e-5 && pos.x+radius>c.min.x && pos.x-radius<c.max.x &&
    pos.z+radius>c.min.z && pos.z-radius<c.max.z);
  if(state.grounded && vel.y<0) vel.y=0;
}
