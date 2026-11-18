/**
 * Sector (区画) visibility: which sectors can possibly be seen from the camera.
 *
 * The campaign stage is one big connected factory, but every sector is a closed shell (floor / walls / ceiling) that is only
 * open toward its neighbours through portals (doors, tunnels, catwalks...). So from inside sector A the only other sectors
 * that can show up on screen are those reached THROUGH an open portal that lies inside the view frustum. Sectors behind
 * a wall, above / below the camera's sector, or behind a closed barrier are never drawn.
 *
 *  - camera sector + player sector are always visible
 *  - a neighbour (through portal P) is visible when P is open, its opening is inside the part of the screen that the portal we
 *    came through lets us see (screen-space rectangle narrowing, the classic portal-culling scheme; the camera next to P always
 *    sees through it) and it is within the fog distance; the search continues from that neighbour (portal chain, bounded depth)
 *  - a closed barrier blocks the portal (the shutter is an opaque box that fills the opening)
 *
 * Pure math (no DOM / GL): runs in Node for the tests. Uses only StageDef data.
 */
import { Box3, Matrix4, Vector3 } from 'three';
import type { PortalDef, SectorDef, StageDef, V3 } from '../sim/types';

export interface PortalLink {
  id: string;
  a: number;
  b: number;
  barrierId: string | null;
  /** opening volume (padded), used for the frustum test */
  box: Box3;
  center: Vector3;
}

const AXES = ['x', 'y', 'z'] as const;
const WALL_PAD = 2.6;
const OPENING_PAD = 1.2;
/** the camera closer than this to an open portal always sees through it (near-plane / frustum-edge safety) [m] */
const NEAR_PORTAL = 7;
const MAX_DEPTH = 6;
/** clip-space w below this = the point is at / behind the camera plane */
const NEAR_W = 0.05;
/** NDC margin around a portal's projected rectangle */
const RECT_PAD = 0.03;
const MAX_REQUEUES = 48;

export function sectorContains(s: SectorDef, p: V3, eps = 1e-6): boolean {
  const b = s.bounds;
  return p.x >= b.min.x - eps && p.x <= b.max.x + eps && p.y >= b.min.y - eps && p.y <= b.max.y + eps && p.z >= b.min.z - eps && p.z <= b.max.z + eps;
}

function distToBounds(s: SectorDef, p: V3): number {
  const b = s.bounds;
  const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
  const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y);
  const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
  return Math.hypot(dx, dy, dz);
}

/** portal opening volume: thin along the wall normal (the axis on which the two sectors touch), width x height across it */
export function portalBox(p: PortalDef, a: SectorDef, b: SectorDef): Box3 {
  let axis = 0;
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const k = AXES[i];
    const g1 = Math.abs(a.bounds.max[k] - b.bounds.min[k]);
    const g2 = Math.abs(a.bounds.min[k] - b.bounds.max[k]);
    const plane = g1 <= g2 ? (a.bounds.max[k] + b.bounds.min[k]) / 2 : (a.bounds.min[k] + b.bounds.max[k]) / 2;
    const score = Math.min(g1, g2) + Math.abs(p.center[k] - plane);
    if (score < best) {
      best = score;
      axis = i;
    }
  }
  const hw = p.width / 2 + OPENING_PAD;
  const hh = p.height / 2 + OPENING_PAD;
  const c = p.center;
  // half extents [x, y, z]: thin along the wall normal, `hw` along the horizontal tangent(s), `hh` in height
  const half = axis === 1 ? [hw, WALL_PAD, hw] : axis === 0 ? [WALL_PAD, hh, hw] : [hw, hh, WALL_PAD];
  return new Box3(new Vector3(c.x - half[0], c.y - half[1], c.z - half[2]), new Vector3(c.x + half[0], c.y + half[1], c.z + half[2]));
}

export class SectorVisibility {
  readonly sectors: readonly SectorDef[];
  readonly indexById = new Map<string, number>();
  readonly portals: PortalLink[] = [];
  /** portal indices per sector */
  readonly byS: number[][];
  private hintCam = -1;
  private hintPlayer = -1;
  private queue: number[] = [];
  private depth: number[] = [];
  private tmpBox = new Box3();
  private tmpV = new Vector3();
  private tmpRect = new Float32Array(4);
  private cx = new Float64Array(8);
  private cy = new Float64Array(8);
  private cw = new Float64Array(8);
  /** per sector: NDC rectangle [x0, x1, y0, y1] through which the sector can be seen */
  private rect = new Float32Array(0);

  constructor(stage: Pick<StageDef, 'sectors' | 'portals'>) {
    this.sectors = stage.sectors;
    stage.sectors.forEach((s, i) => this.indexById.set(s.id, i));
    this.byS = stage.sectors.map(() => []);
    for (const p of stage.portals) {
      const a = this.indexById.get(p.a);
      const b = this.indexById.get(p.b);
      if (a === undefined || b === undefined) continue;
      const link: PortalLink = { id: p.id, a, b, barrierId: p.barrierId, box: portalBox(p, stage.sectors[a], stage.sectors[b]), center: new Vector3(p.center.x, p.center.y, p.center.z) };
      const i = this.portals.push(link) - 1;
      this.byS[a].push(i);
      this.byS[b].push(i);
    }
  }

  get count(): number {
    return this.sectors.length;
  }

  /** sector the camera was in at the last compute() (-1 before the first call) */
  get camSector(): number {
    return this.hintCam;
  }
  /** sector the player was in at the last compute() */
  get playerSector(): number {
    return this.hintPlayer;
  }

  /** sector containing `p` (3D AABB; prefers the previous answer near shared faces), else the nearest sector, else -1 */
  sectorAt(p: V3, which: 'cam' | 'player' | 'none' = 'none'): number {
    const hint = which === 'cam' ? this.hintCam : which === 'player' ? this.hintPlayer : -1;
    let r = -1;
    if (hint >= 0 && sectorContains(this.sectors[hint], p)) r = hint;
    else {
      for (let i = 0; i < this.sectors.length; i++) {
        if (sectorContains(this.sectors[i], p)) {
          r = i;
          break;
        }
      }
      if (r < 0) {
        let bd = Infinity;
        for (let i = 0; i < this.sectors.length; i++) {
          const d = distToBounds(this.sectors[i], p);
          if (d < bd) {
            bd = d;
            r = i;
          }
        }
      }
    }
    if (which === 'cam') this.hintCam = r;
    else if (which === 'player') this.hintPlayer = r;
    return r;
  }

  /**
   * NDC rectangle [x0, x1, y0, y1] covered by a portal opening box, expanded a little; false when it is completely off screen
   * (or completely behind the camera). The box is clipped against the camera plane first: the 8 corners in front plus the points
   * where the 12 edges cross the plane, so a box that straddles the camera plane still gets a correct (huge but finite) rectangle.
   */
  private portalRect(box: Box3, vp: Matrix4, out: Float32Array): boolean {
    const e = vp.elements;
    const cx = this.cx;
    const cy = this.cy;
    const cw = this.cw;
    let inFront = 0;
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? box.max.x : box.min.x;
      const y = i & 2 ? box.max.y : box.min.y;
      const z = i & 4 ? box.max.z : box.min.z;
      cw[i] = e[3] * x + e[7] * y + e[11] * z + e[15];
      cx[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
      cy[i] = e[1] * x + e[5] * y + e[9] * z + e[13];
      if (cw[i] > NEAR_W) inFront++;
    }
    if (inFront === 0) return false;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    const add = (px: number, py: number, pw: number): void => {
      const nx = px / pw;
      const ny = py / pw;
      if (nx < x0) x0 = nx;
      if (nx > x1) x1 = nx;
      if (ny < y0) y0 = ny;
      if (ny > y1) y1 = ny;
    };
    for (let i = 0; i < 8; i++) {
      if (cw[i] > NEAR_W) add(cx[i], cy[i], cw[i]);
      if (inFront === 8) continue;
      for (const bit of [1, 2, 4]) {
        if (i & bit) continue;
        const j = i | bit;
        if (cw[i] > NEAR_W === cw[j] > NEAR_W) continue;
        const t = (NEAR_W - cw[i]) / (cw[j] - cw[i]);
        add(cx[i] + t * (cx[j] - cx[i]), cy[i] + t * (cy[j] - cy[i]), NEAR_W);
      }
    }
    if (x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1) return false;
    out[0] = Math.max(-1, x0 - RECT_PAD);
    out[1] = Math.min(1, x1 + RECT_PAD);
    out[2] = Math.max(-1, y0 - RECT_PAD);
    out[3] = Math.min(1, y1 + RECT_PAD);
    return true;
  }

  /**
   * Fill `out[i] = 1` for every visible sector. `viewProj` = projection * inverse(camera world); `blocked(barrierId)` is true while
   * that barrier is shut. Returns the number of visible sectors.
   *
   * Each visible sector carries the screen rectangle through which it can be seen (the union over every way in); a portal of
   * that sector is only followed when its opening overlaps the rectangle, and the neighbour then inherits the overlap.
   */
  compute(cam: V3, player: V3, viewProj: Matrix4, blocked: (barrierId: string) => boolean, farDistance: number, out: Uint8Array): number {
    out.fill(0);
    const n = this.sectors.length;
    if (n === 0) return 0;
    if (this.rect.length !== n * 4) this.rect = new Float32Array(n * 4);
    const R = this.rect;
    const sc = this.sectorAt(cam, 'cam');
    const sp = this.sectorAt(player, 'player');
    const q = this.queue;
    const dep = this.depth;
    q.length = 0;
    dep.length = 0;
    let count = 0;
    const pushFull = (s: number): void => {
      if (s < 0 || out[s]) return;
      out[s] = 1;
      count++;
      R[s * 4] = -1;
      R[s * 4 + 1] = 1;
      R[s * 4 + 2] = -1;
      R[s * 4 + 3] = 1;
      q.push(s);
      dep.push(0);
    };
    pushFull(sc);
    pushFull(sp);
    const box = this.tmpBox;
    const pr = this.tmpRect;
    let requeues = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const s = q[qi];
      const d = dep[qi];
      if (d >= MAX_DEPTH) continue;
      for (const pi of this.byS[s]) {
        const pl = this.portals[pi];
        const other = pl.a === s ? pl.b : pl.a;
        if (pl.barrierId !== null && blocked(pl.barrierId)) continue;
        box.copy(pl.box);
        const dist = box.distanceToPoint(this.tmpV.set(cam.x, cam.y, cam.z));
        if (dist > farDistance) continue;
        if (dist > NEAR_PORTAL) {
          if (!this.portalRect(box, viewProj, pr)) continue;
        } else {
          pr[0] = -1;
          pr[1] = 1;
          pr[2] = -1;
          pr[3] = 1;
        }
        const ix0 = Math.max(pr[0], R[s * 4]);
        const ix1 = Math.min(pr[1], R[s * 4 + 1]);
        const iy0 = Math.max(pr[2], R[s * 4 + 2]);
        const iy1 = Math.min(pr[3], R[s * 4 + 3]);
        if (!(ix0 < ix1 && iy0 < iy1)) continue; // the opening is not inside what we can see through the way in
        const o4 = other * 4;
        if (!out[other]) {
          out[other] = 1;
          count++;
          R[o4] = ix0;
          R[o4 + 1] = ix1;
          R[o4 + 2] = iy0;
          R[o4 + 3] = iy1;
          q.push(other);
          dep.push(d + 1);
        } else {
          // seen before through another way: widen the rectangle; when it grew, look through its portals again
          let grew = false;
          if (ix0 < R[o4] - 1e-4) {
            R[o4] = ix0;
            grew = true;
          }
          if (ix1 > R[o4 + 1] + 1e-4) {
            R[o4 + 1] = ix1;
            grew = true;
          }
          if (iy0 < R[o4 + 2] - 1e-4) {
            R[o4 + 2] = iy0;
            grew = true;
          }
          if (iy1 > R[o4 + 3] + 1e-4) {
            R[o4 + 3] = iy1;
            grew = true;
          }
          if (grew && requeues < MAX_REQUEUES && d + 1 < MAX_DEPTH) {
            requeues++;
            q.push(other);
            dep.push(d + 1);
          }
        }
      }
    }
    return count;
  }
}
