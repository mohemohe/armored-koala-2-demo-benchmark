import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ZONES, LINKS, BARRIERS, ZONE_BY_ID, type Zone } from './stage';
import { CosmeticRng } from '../core/rng';
import { SpatialHash, makeBox, type Box } from './collision';
import { factoryFloorTexture, factoryWallTexture } from './textures';

export interface DoorInfo {
  index: number;
  a: string;
  b: string;
  axis: 'x' | 'z';
  /** wall plane coordinate (x for axis 'x', z for axis 'z') */
  at: number;
  /** along-wall extent of the opening */
  from: number;
  to: number;
  center: number;
  width: number;
  /** floor height of the opening */
  y: number;
  height: number;
  x: number;
  z: number;
  barrierId?: string;
  finalGate: boolean;
  /** true while a barrier still seals the opening */
  sealed: boolean;
}

export interface NavNode {
  id: string;
  zone: string;
  x: number;
  y: number;
  z: number;
  kind: 'center' | 'door';
  doorIndex?: number;
}

export interface NavEdge {
  a: number;
  b: number;
}

const WALL_T = 1.1;
const SLAB_T = 0.7;

/** rescales the box UVs so that a texture tiles at a fixed world size */
function scaleBoxUv(geo: THREE.BufferGeometry, sx: number, sy: number, sz: number, tile: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const set = (start: number, uScale: number, vScale: number) => {
    for (let i = start; i < start + 4; i++) {
      uv.setXY(i, uv.getX(i) * uScale, uv.getY(i) * vScale);
    }
  };
  set(0, sz / tile, sy / tile);
  set(4, sz / tile, sy / tile);
  set(8, sx / tile, sz / tile);
  set(12, sx / tile, sz / tile);
  set(16, sx / tile, sy / tile);
  set(20, sx / tile, sy / tile);
  uv.needsUpdate = true;
}

export class World {
  solids: Box[] = [];
  hash = new SpatialHash();
  doors: DoorInfo[] = [];
  navNodes: NavNode[] = [];
  navEdges: NavEdge[] = [];
  barrierGroup = new THREE.Group();
  barrierBoxes = new Map<string, Box>();
  private barrierRestore = new Map<string, number>();
  private barrierMeshes = new Map<string, THREE.Object3D>();
  private gateMesh: THREE.Object3D | null = null;
  private gateBox: Box | null = null;
  private gateRestore = 0;
  zoneGroup = new THREE.Group();
  propGroup = new THREE.Group();
  finalGateOpen = false;
  /** set of zone ids the player already entered */
  visited = new Set<string>();

  constructor(scene: THREE.Scene) {
    scene.add(this.zoneGroup);
    scene.add(this.propGroup);
    scene.add(this.barrierGroup);
  }

  addSolid(b: Box): void {
    this.solids.push(b);
    this.hash.insert(b);
  }

  /* ------------------------------------------------------------------ */
  /* doors                                                              */
  /* ------------------------------------------------------------------ */

  buildDoors(): void {
    let index = 0;
    for (const link of LINKS) {
      const a = ZONE_BY_ID.get(link.a)!;
      const b = ZONE_BY_ID.get(link.b)!;
      const edges = this.sharedEdges(a, b);
      for (const e of edges) {
        const width = Math.min(e.hi - e.lo, 26);
        const center = (e.lo + e.hi) / 2;
        const height = Math.min(4.6, e.y1 - e.y0);
        const x = e.axis === 'x' ? e.at : center;
        const z = e.axis === 'z' ? e.at : center;
        this.doors.push({
          index,
          a: link.a,
          b: link.b,
          axis: e.axis,
          at: e.at,
          from: e.lo,
          to: e.hi,
          center,
          width,
          y: e.y0,
          height,
          x,
          z,
          barrierId: link.barrier,
          finalGate: !!link.finalGate,
          sealed: !!link.barrier
        });
        index++;
      }
    }
  }

  private sharedEdges(a: Zone, b: Zone): { axis: 'x' | 'z'; at: number; lo: number; hi: number; y0: number; y1: number }[] {
    const out: { axis: 'x' | 'z'; at: number; lo: number; hi: number; y0: number; y1: number }[] = [];
    for (const la of a.levels) {
      for (const lb of b.levels) {
        const y0 = Math.max(la.y, lb.y);
        const y1 = Math.min(la.y + la.h, lb.y + lb.h);
        if (y1 - y0 <= 0.05) continue;
        if (Math.abs(a.x1 - b.x0) < 0.01 || Math.abs(b.x1 - a.x0) < 0.01) {
          const at = Math.abs(a.x1 - b.x0) < 0.01 ? a.x1 : b.x0;
          const lo = Math.max(a.z0, b.z0);
          const hi = Math.min(a.z1, b.z1);
          if (hi - lo > 0.5) out.push({ axis: 'x', at, lo, hi, y0, y1 });
        }
        if (Math.abs(a.z1 - b.z0) < 0.01 || Math.abs(b.z1 - a.z0) < 0.01) {
          const at = Math.abs(a.z1 - b.z0) < 0.01 ? a.z1 : b.z0;
          const lo = Math.max(a.x0, b.x0);
          const hi = Math.min(a.x1, b.x1);
          if (hi - lo > 0.5) out.push({ axis: 'z', at, lo, hi, y0, y1 });
        }
      }
    }
    return out;
  }

  /** doors that touch a given zone */
  doorsOfZone(zoneId: string): DoorInfo[] {
    return this.doors.filter((d) => d.a === zoneId || d.b === zoneId);
  }

  /* ------------------------------------------------------------------ */
  /* static geometry                                                    */
  /* ------------------------------------------------------------------ */

  buildGeometry(): void {
    const floorGeos: THREE.BufferGeometry[] = [];
    const wallGeos: THREE.BufferGeometry[] = [];
    const trimGeos: THREE.BufferGeometry[] = [];
    const glowGeos: THREE.BufferGeometry[] = [];

    const pushBox = (
      arr: THREE.BufferGeometry[],
      cx: number,
      cy: number,
      cz: number,
      sx: number,
      sy: number,
      sz: number,
      tile = 0
    ) => {
      const g = new THREE.BoxGeometry(sx, sy, sz);
      if (tile > 0) scaleBoxUv(g, sx, sy, sz, tile);
      g.translate(cx, cy, cz);
      arr.push(g);
    };

    for (const zone of ZONES) {
      const isShaft = zone.kind === 'shaft';
      const lower = zone.levels[0];
      const upper = zone.levels[zone.levels.length - 1];
      const wallY0 = lower.y;
      const wallY1 = upper.y + upper.h;

      // ---- floor ----
      if (isShaft) {
        pushBox(floorGeos, (zone.x0 + zone.x1) / 2, lower.y - SLAB_T / 2, (zone.z0 + zone.z1) / 2, zone.x1 - zone.x0, SLAB_T, zone.z1 - zone.z0, 8);
        // upper platform with an opening
        const hx = zone.hole![0];
        const hz = zone.hole![1];
        const hs = zone.holeSize! / 2;
        const px0 = zone.x0;
        const px1 = zone.x1;
        const pz0 = zone.z0;
        const pz1 = zone.z1;
        // platform pieces (rect minus the hole)
        if (hx - hs > px0) pushBox(floorGeos, (px0 + hx - hs) / 2, upper.y - SLAB_T / 2, (pz0 + pz1) / 2, hx - hs - px0, SLAB_T, pz1 - pz0, 8);
        if (px1 > hx + hs) pushBox(floorGeos, (hx + hs + px1) / 2, upper.y - SLAB_T / 2, (pz0 + pz1) / 2, px1 - hx - hs, SLAB_T, pz1 - pz0, 8);
        const zMinSide = hz - hs;
        const zMaxSide = hz + hs;
        if (zMinSide > pz0) pushBox(floorGeos, hx, upper.y - SLAB_T / 2, (pz0 + zMinSide) / 2, hs * 2, SLAB_T, zMinSide - pz0, 8);
        if (pz1 > zMaxSide) pushBox(floorGeos, hx, upper.y - SLAB_T / 2, (zMaxSide + pz1) / 2, hs * 2, SLAB_T, pz1 - zMaxSide, 8);
      } else {
        pushBox(floorGeos, (zone.x0 + zone.x1) / 2, lower.y - SLAB_T / 2, (zone.z0 + zone.z1) / 2, zone.x1 - zone.x0, SLAB_T, zone.z1 - zone.z0, 8);
      }

      // ---- ceiling ----
      pushBox(floorGeos, (zone.x0 + zone.x1) / 2, upper.y + upper.h + SLAB_T / 2, (zone.z0 + zone.z1) / 2, zone.x1 - zone.x0, SLAB_T, zone.z1 - zone.z0, 8);

      // ---- walls (with door openings carved) ----
      const zoneDoors = this.doorsOfZone(zone.id);
      this.buildWall(pushBox, wallGeos, zone, 'x', zone.x0, zone.z0, zone.z1, wallY0, wallY1, zoneDoors);
      this.buildWall(pushBox, wallGeos, zone, 'x', zone.x1, zone.z0, zone.z1, wallY0, wallY1, zoneDoors);
      this.buildWall(pushBox, wallGeos, zone, 'z', zone.z0, zone.x0, zone.x1, wallY0, wallY1, zoneDoors);
      this.buildWall(pushBox, wallGeos, zone, 'z', zone.z1, zone.x0, zone.x1, wallY0, wallY1, zoneDoors);

      // ---- glowing floor trim along the walls (readability) ----
      const trimY = lower.y + 0.06;
      pushBox(glowGeos, zone.x0 + 0.25, trimY, (zone.z0 + zone.z1) / 2, 0.5, 0.12, zone.z1 - zone.z0);
      pushBox(glowGeos, zone.x1 - 0.25, trimY, (zone.z0 + zone.z1) / 2, 0.5, 0.12, zone.z1 - zone.z0);
      pushBox(glowGeos, (zone.x0 + zone.x1) / 2, trimY, zone.z0 + 0.25, zone.x1 - zone.x0, 0.12, 0.5);
      pushBox(glowGeos, (zone.x0 + zone.x1) / 2, trimY, zone.z1 - 0.25, zone.x1 - zone.x0, 0.12, 0.5);
      trimGeos.push(
        ...([] as THREE.BufferGeometry[])
      );
    }

    const mkMesh = (geos: THREE.BufferGeometry[], mat: THREE.Material): THREE.Mesh | null => {
      if (!geos.length) return null;
      const merged = mergeGeometries(geos, false);
      if (!merged) return null;
      for (const g of geos) g.dispose();
      const m = new THREE.Mesh(merged, mat);
      m.matrixAutoUpdate = false;
      return m;
    };

    const floorMat = new THREE.MeshStandardMaterial({ map: factoryFloorTexture(), color: 0xb8bfc7, roughness: 0.9, metalness: 0.18 });
    const wallMat = new THREE.MeshStandardMaterial({ map: factoryWallTexture(), color: 0xa8b0b9, roughness: 0.95, metalness: 0.1 });
    const trimMat = new THREE.MeshBasicMaterial({ color: 0x35d3ff, transparent: true, opacity: 0.55 });

    const floorMesh = mkMesh(floorGeos, floorMat);
    if (floorMesh) this.zoneGroup.add(floorMesh);
    const wallMesh = mkMesh(wallGeos, wallMat);
    if (wallMesh) this.zoneGroup.add(wallMesh);
    const trimMesh = mkMesh(glowGeos, trimMat);
    if (trimMesh) this.zoneGroup.add(trimMesh);

    // ---- ceiling light strips ----
    const lampGeos: THREE.BufferGeometry[] = [];
    for (const zone of ZONES) {
      const lower = zone.levels[0];
      const upper = zone.levels[zone.levels.length - 1];
      const cx = (zone.x0 + zone.x1) / 2;
      const cz = (zone.z0 + zone.z1) / 2;
      const spanX = zone.x1 - zone.x0;
      const spanZ = zone.z1 - zone.z0;
      const n = Math.max(1, Math.round(Math.max(spanX, spanZ) / 26));
      for (let i = 0; i < n; i++) {
        const f = (i + 0.5) / n;
        const lx = spanX > spanZ ? zone.x0 + spanX * f : cx;
        const lz = spanX > spanZ ? cz : zone.z0 + spanZ * f;
        const w = spanX > spanZ ? 9 : 2.4;
        const d = spanX > spanZ ? 2.4 : 9;
        const g = new THREE.BoxGeometry(w, 0.35, d);
        g.translate(lx, upper.y + upper.h - 0.3, lz);
        lampGeos.push(g);
      }
      // a warning lamp over the control turrets
      void lower;
    }
    const lampMesh = mkMesh(lampGeos, new THREE.MeshBasicMaterial({ color: 0xd8e8f5 }));
    if (lampMesh) this.zoneGroup.add(lampMesh);

    // ---- collision solids ----
    for (const zone of ZONES) {
      const isShaft = zone.kind === 'shaft';
      const lower = zone.levels[0];
      const upper = zone.levels[zone.levels.length - 1];
      const wallY0 = lower.y;
      const wallY1 = upper.y + upper.h;
      // floor slab
      this.addSolid(
        makeBox(zone.x0, lower.y - SLAB_T, zone.z0, zone.x1, lower.y, zone.z1, 'floor')
      );
      // ceiling slab
      this.addSolid(
        makeBox(zone.x0, upper.y + upper.h, zone.z0, zone.x1, upper.y + upper.h + SLAB_T, zone.z1, 'ceiling')
      );
      // shaft upper platform
      if (isShaft) {
        const hx = zone.hole![0];
        const hz = zone.hole![1];
        const hs = zone.holeSize! / 2;
        const pieces: Box[] = [
          makeBox(zone.x0, upper.y - SLAB_T, zone.z0, hx - hs, upper.y, zone.z1, 'platform'),
          makeBox(hx + hs, upper.y - SLAB_T, zone.z0, zone.x1, upper.y, zone.z1, 'platform'),
          makeBox(hx - hs, upper.y - SLAB_T, zone.z0, hx + hs, upper.y, hz - hs, 'platform'),
          makeBox(hx - hs, upper.y - SLAB_T, hz + hs, hx + hs, upper.y, zone.z1, 'platform')
        ];
        for (const p of pieces) {
          if (p.maxX - p.minX > 0.05 && p.maxZ - p.minZ > 0.05) this.addSolid(p);
        }
      }
      // walls
      const zoneDoors = this.doorsOfZone(zone.id);
      this.collideWall(zone, 'x', zone.x0, zone.z0, zone.z1, wallY0, wallY1, zoneDoors);
      this.collideWall(zone, 'x', zone.x1, zone.z0, zone.z1, wallY0, wallY1, zoneDoors);
      this.collideWall(zone, 'z', zone.z0, zone.x0, zone.x1, wallY0, wallY1, zoneDoors);
      this.collideWall(zone, 'z', zone.z1, zone.x0, zone.x1, wallY0, wallY1, zoneDoors);
    }
  }

  /** geometry of one wall with the door openings removed */
  private buildWall(
    pushBox: (
      arr: THREE.BufferGeometry[],
      cx: number,
      cy: number,
      cz: number,
      sx: number,
      sy: number,
      sz: number,
      tile?: number
    ) => void,
    out: THREE.BufferGeometry[],
    zone: Zone,
    axis: 'x' | 'z',
    at: number,
    from: number,
    to: number,
    y0: number,
    y1: number,
    doors: DoorInfo[]
  ): void {
    const along = axis === 'x' ? 'z' : 'x';
    const relevant = doors.filter((d) => d.axis === axis && Math.abs(d.at - at) < 1.5 && d.y >= y0 - 0.1 && d.y < y1);
    const sorted = relevant.slice().sort((p, q) => p.center - q.center);
    const segs: { lo: number; hi: number }[] = [];
    let cursor = from;
    for (const d of sorted) {
      const dlo = Math.max(from, d.center - d.width / 2);
      const dhi = Math.min(to, d.center + d.width / 2);
      if (dlo > cursor) segs.push({ lo: cursor, hi: dlo });
      cursor = Math.max(cursor, dhi);
    }
    if (cursor < to) segs.push({ lo: cursor, hi: to });

    const addSeg = (lo: number, hi: number, yy0: number, yy1: number) => {
      if (hi - lo <= 0.05 || yy1 - yy0 <= 0.05) return;
      const cx = axis === 'x' ? at : (lo + hi) / 2;
      const cz = axis === 'z' ? at : (lo + hi) / 2;
      const sx = axis === 'x' ? WALL_T : hi - lo;
      const sz = axis === 'z' ? WALL_T : hi - lo;
      pushBox(out, cx, (yy0 + yy1) / 2, cz, sx, yy1 - yy0, sz, 6);
    };

    for (const s of segs) addSeg(s.lo, s.hi, y0, y1);
    for (const d of sorted) {
      const dlo = Math.max(from, d.center - d.width / 2);
      const dhi = Math.min(to, d.center + d.width / 2);
      const dy0 = Math.max(y0, d.y);
      const dy1 = Math.min(y1, d.y + d.height);
      if (dy0 > y0) addSeg(dlo, dhi, y0, dy0);
      if (dy1 < y1) addSeg(dlo, dhi, dy1, y1);
    }
  }

  /** collision boxes of one wall */
  private collideWall(
    zone: Zone,
    axis: 'x' | 'z',
    at: number,
    from: number,
    to: number,
    y0: number,
    y1: number,
    doors: DoorInfo[]
  ): void {
    const relevant = doors.filter((d) => d.axis === axis && Math.abs(d.at - at) < 1.5 && d.y >= y0 - 0.1 && d.y < y1);
    const sorted = relevant.slice().sort((p, q) => p.center - q.center);
    const add = (lo: number, hi: number, yy0: number, yy1: number) => {
      if (hi - lo <= 0.05 || yy1 - yy0 <= 0.05) return;
      if (axis === 'x') this.addSolid(makeBox(at - WALL_T / 2, yy0, lo, at + WALL_T / 2, yy1, hi, 'wall'));
      else this.addSolid(makeBox(lo, yy0, at - WALL_T / 2, hi, yy1, at + WALL_T / 2, 'wall'));
    };
    let cursor = from;
    for (const d of sorted) {
      const dlo = Math.max(from, d.center - d.width / 2);
      const dhi = Math.min(to, d.center + d.width / 2);
      if (dlo > cursor) add(cursor, dlo, y0, y1);
      cursor = Math.max(cursor, dhi);
    }
    add(cursor, to, y0, y1);
    for (const d of sorted) {
      const dlo = Math.max(from, d.center - d.width / 2);
      const dhi = Math.min(to, d.center + d.width / 2);
      const dy0 = Math.max(y0, d.y);
      const dy1 = Math.min(y1, d.y + d.height);
      if (dy0 > y0) add(dlo, dhi, y0, dy0);
      if (dy1 < y1) add(dlo, dhi, dy1, y1);
    }
  }

  /* ------------------------------------------------------------------ */
  /* props                                                              */
  /* ------------------------------------------------------------------ */

  buildProps(
    seed: number,
    avoid: { x: number; z: number; r: number }[],
    clearRects: { x0: number; x1: number; z0: number; z1: number }[] = []
  ): void {
    const rng = new CosmeticRng(seed ^ 0x5bf03635);
    const crateGeos: THREE.BufferGeometry[] = [];
    const machineGeos: THREE.BufferGeometry[] = [];
    const pipeGeos: THREE.BufferGeometry[] = [];

    const pushBox = (arr: THREE.BufferGeometry[], cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) => {
      const g = new THREE.BoxGeometry(sx, sy, sz);
      g.translate(cx, cy, cz);
      arr.push(g);
    };

    for (const zone of ZONES) {
      const lower = zone.levels[0];
      const area = (zone.x1 - zone.x0) * (zone.z1 - zone.z0);
      const count =
        zone.kind === 'corridor'
          ? Math.max(1, Math.min(6, Math.floor(area / 1500)))
          : zone.kind === 'shaft'
            ? 0
            : Math.max(3, Math.min(18, Math.floor(area / 1300)));
      for (let i = 0; i < count; i++) {
        const x = rng.range(zone.x0 + 3, zone.x1 - 3);
        const z = rng.range(zone.z0 + 3, zone.z1 - 3);
        // keep clear of doors and actors
        let blocked = false;
        for (const d of this.doorsOfZone(zone.id)) {
          if (Math.hypot(x - d.x, z - d.z) < d.width / 2 + 9) blocked = true;
        }
        for (const a of avoid) {
          if (Math.hypot(x - a.x, z - a.z) < a.r) blocked = true;
        }
        for (const r of clearRects) {
          if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) blocked = true;
        }
        if (blocked) continue;
        const kind = zone.kind;
        if (kind === 'piping' || kind === 'cooling' || kind === 'plant') {
          // pipe bundles along the ceiling
          const n = 3;
          for (let k = 0; k < n; k++) {
            const r = 0.35 + k * 0.12;
            const g = new THREE.CylinderGeometry(r, r, zone.x1 - zone.x0, 8, 1);
            g.rotateZ(Math.PI / 2);
            g.translate((zone.x0 + zone.x1) / 2, lower.y + lower.h - 1.1 - k * 0.8, z + k * 1.1);
            pipeGeos.push(g);
          }
          continue;
        }
        if (kind === 'conveyor' || kind === 'assembly') {
          // conveyor segment
          const w = rng.range(9, 20);
          const d = rng.range(2.4, 4);
          const ox = rng.range(zone.x0 + 6, zone.x1 - w - 6);
          const oz = rng.range(zone.z0 + 6, zone.z1 - d - 6);
          pushBox(machineGeos, ox + w / 2, lower.y + 0.9, oz + d / 2, w, 0.35, d);
          pushBox(machineGeos, ox + w / 2, lower.y + 0.45, oz + d / 2 - 0.4, w, 0.9, 0.3);
          this.addSolid(makeBox(ox, lower.y, oz, ox + w, lower.y + 1.1, oz + d, 'prop'));
          continue;
        }
        if (rng.next() < 0.45) {
          const s = rng.range(1.6, 3.0);
          const hh = rng.range(1.6, 3.2);
          pushBox(crateGeos, x, lower.y + hh / 2, z, s, hh, s);
          this.addSolid(makeBox(x - s / 2, lower.y, z - s / 2, x + s / 2, lower.y + hh, z + s / 2, 'prop'));
        } else {
          const w = rng.range(3.5, 7);
          const d = rng.range(2.5, 5);
          const hh = rng.range(2.4, 5.2);
          pushBox(machineGeos, x, lower.y + hh / 2, z, w, hh, d);
          this.addSolid(makeBox(x - w / 2, lower.y, z - d / 2, x + w / 2, lower.y + hh, z + d / 2, 'prop'));
          // small cylinder on top for silhouette variety
          const g = new THREE.CylinderGeometry(Math.min(w, d) * 0.3, Math.min(w, d) * 0.3, 1.6, 10);
          g.translate(x, lower.y + hh + 0.8, z);
          machineGeos.push(g);
        }
      }
    }

    const mk = (geos: THREE.BufferGeometry[], mat: THREE.Material) => {
      if (!geos.length) return;
      const merged = mergeGeometries(geos, false);
      if (!merged) return;
      for (const g of geos) g.dispose();
      const m = new THREE.Mesh(merged, mat);
      m.matrixAutoUpdate = false;
      this.propGroup.add(m);
    };
    mk(crateGeos, new THREE.MeshStandardMaterial({ color: 0xa87f47, roughness: 0.9, metalness: 0.1 }));
    mk(machineGeos, new THREE.MeshStandardMaterial({ color: 0x565f68, roughness: 0.72, metalness: 0.5 }));
    mk(pipeGeos, new THREE.MeshStandardMaterial({ color: 0x8d949c, roughness: 0.55, metalness: 0.7 }));
  }

  /* ------------------------------------------------------------------ */
  /* barriers                                                           */
  /* ------------------------------------------------------------------ */

  buildBarriers(): void {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xff5a2b,
      emissive: 0x501200,
      roughness: 0.5,
      metalness: 0.4
    });
    for (const spec of BARRIERS) {
      const door = this.doors.find((d) => d.barrierId === spec.id);
      if (!door) continue;
      const w = door.width;
      const h = door.height;
      const geo =
        door.axis === 'x'
          ? new THREE.BoxGeometry(1.0, h, w)
          : new THREE.BoxGeometry(w, h, 1.0);
      const mesh = new THREE.Mesh(geo, mat.clone());
      mesh.position.set(door.x, door.y + h / 2, door.z);
      this.barrierGroup.add(mesh);
      this.barrierMeshes.set(spec.id, mesh);
      const box =
        door.axis === 'x'
          ? makeBox(door.x - 0.6, door.y, door.z - w / 2, door.x + 0.6, door.y + h, door.z + w / 2, 'barrier')
          : makeBox(door.x - w / 2, door.y, door.z - 0.6, door.x + w / 2, door.y + h, door.z + 0.6, 'barrier');
      this.barrierBoxes.set(spec.id, box);
      this.barrierRestore.set(spec.id, box.maxY);
      this.addSolid(box);
    }
    // final evacuation gate
    const gate = this.doors.find((d) => d.finalGate);
    if (gate) {
      const geo =
        gate.axis === 'x'
          ? new THREE.BoxGeometry(1.2, gate.height, gate.width)
          : new THREE.BoxGeometry(gate.width, gate.height, 1.2);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: 0xffc23a, emissive: 0x5a3a00, roughness: 0.45, metalness: 0.55 })
      );
      mesh.position.set(gate.x, gate.y + gate.height / 2, gate.z);
      this.barrierGroup.add(mesh);
      this.gateMesh = mesh;
      this.gateBox =
        gate.axis === 'x'
          ? makeBox(gate.x - 0.7, gate.y, gate.z - gate.width / 2, gate.x + 0.7, gate.y + gate.height, gate.z + gate.width / 2, 'gate')
          : makeBox(gate.x - gate.width / 2, gate.y, gate.z - 0.7, gate.x + gate.width / 2, gate.y + gate.height, gate.z + 0.7, 'gate');
      this.gateRestore = this.gateBox.maxY;
      this.addSolid(this.gateBox);
    }
  }

  openBarrier(barrierId: string): void {
    const door = this.doors.find((d) => d.barrierId === barrierId);
    if (door) door.sealed = false;
    const mesh = this.barrierMeshes.get(barrierId);
    if (mesh) {
      mesh.visible = false;
    }
    const box = this.barrierBoxes.get(barrierId);
    if (box) {
      box.maxY = box.minY; // degenerate -> no collision
    }
  }

  /** re-seals every barrier (used when the sortie is restarted) */
  resetBarriers(): void {
    for (const [id, box] of this.barrierBoxes) {
      const maxY = this.barrierRestore.get(id);
      if (maxY !== undefined) box.maxY = maxY;
    }
    if (this.gateBox) this.gateBox.maxY = this.gateRestore;
    for (const d of this.doors) {
      if (d.barrierId) d.sealed = true;
    }
    this.finalGateOpen = false;
  }

  openFinalGate(): void {
    this.finalGateOpen = true;
    if (this.gateMesh) this.gateMesh.visible = false;
    if (this.gateBox) this.gateBox.maxY = this.gateBox.minY;
  }

  /* ------------------------------------------------------------------ */
  /* navigation                                                         */
  /* ------------------------------------------------------------------ */

  buildNavGraph(): void {
    for (const zone of ZONES) {
      const lvl = zone.levels[0];
      this.navNodes.push({
        id: `${zone.id}#c`,
        zone: zone.id,
        x: (zone.x0 + zone.x1) / 2,
        y: lvl.y,
        z: (zone.z0 + zone.z1) / 2,
        kind: 'center'
      });
    }
    for (const d of this.doors) {
      const nodeId = `door#${d.index}`;
      this.navNodes.push({
        id: nodeId,
        zone: d.a,
        x: d.x,
        y: d.y,
        z: d.z,
        kind: 'door',
        doorIndex: d.index
      });
    }
    const centerOf = (zoneId: string) => this.navNodes.findIndex((n) => n.kind === 'center' && n.zone === zoneId);
    for (const d of this.doors) {
      const na = centerOf(d.a);
      const nb = centerOf(d.b);
      const nd = this.navNodes.findIndex((n) => n.kind === 'door' && n.doorIndex === d.index);
      if (na >= 0 && nd >= 0) this.navEdges.push({ a: na, b: nd });
      if (nb >= 0 && nd >= 0) this.navEdges.push({ a: nb, b: nd });
    }
  }

  /** Dijkstra path over the nav graph. Returns node indices. */
  navPath(fromNode: number, toNode: number): number[] {
    const n = this.navNodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const visited = new Uint8Array(n);
    dist[fromNode] = 0;
    for (;;) {
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!visited[i] && dist[i] < best) {
          best = dist[i];
          u = i;
        }
      }
      if (u < 0) break;
      if (u === toNode) break;
      visited[u] = 1;
      for (const e of this.navEdges) {
        const v = e.a === u ? e.b : e.b === u ? e.a : -1;
        if (v < 0) continue;
        const du = dist[u];
        const dv = dist[v];
        const w =
          Math.hypot(
            this.navNodes[u].x - this.navNodes[v].x,
            this.navNodes[u].y - this.navNodes[v].y,
            this.navNodes[u].z - this.navNodes[v].z
          ) + 1;
        if (du + w < dv) {
          dist[v] = du + w;
          prev[v] = u;
        }
      }
    }
    if (!Number.isFinite(dist[toNode])) return [];
    const path: number[] = [];
    let cur = toNode;
    while (cur >= 0) {
      path.unshift(cur);
      if (cur === fromNode) break;
      cur = prev[cur];
    }
    return path;
  }

  nearestNavNode(x: number, y: number, z: number): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.navNodes.length; i++) {
      const n = this.navNodes[i];
      const d = Math.hypot(n.x - x, (n.y - y) * 1.5, n.z - z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Which zone contains the given point (checks every level). */
  zoneAt(x: number, y: number, z: number): string | null {
    for (const zone of ZONES) {
      if (x < zone.x0 || x > zone.x1 || z < zone.z0 || z > zone.z1) continue;
      for (const lvl of zone.levels) {
        if (y >= lvl.y - 0.4 && y <= lvl.y + lvl.h + 0.4) return zone.id;
      }
    }
    return null;
  }
}
