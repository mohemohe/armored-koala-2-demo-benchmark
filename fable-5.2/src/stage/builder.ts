/**
 * StageBuilder — small composable helpers used by src/stage/factory.ts to assemble the factory out of
 * axis-aligned boxes. Pure data generation, deterministic, no three.js.
 *
 * Conventions used by every helper:
 *  - A "room" is a closed shell: floor slab, roof slab and four walls of thickness `t` around an interior.
 *    Rooms abut each other with their outer faces, so two interiors are always separated by 2·t of wall.
 *  - Openings (doors, flight bays, pits) are made with `carve()`, which subtracts a box from every
 *    structural ("carvable") solid created so far. Collision therefore always equals what is drawn.
 *  - Decor never lives inside the volume the player's box can occupy. It is placed (a) above solid trays /
 *    truss chords that leave less than 4 m to the ceiling, (b) inside wall racks whose slot is lower than the
 *    player, or (c) as thin (< 0.25 m) lamps, cables and warning plates at least 5 m above the floor.
 */
import { ENEMIES } from '../config';
import { v3 } from '../core/vec';
import type { BarrierDef, Box, DecorDef, EnemyDef, MarkingDef, SectorDef, SectorKind, SolidDef, SolidMaterial } from '../sim/types';

export type DecorMaterial = DecorDef['material'];

interface BSolid extends SolidDef {
  carvable: boolean;
}

export interface RoomSpec {
  /** Outer footprint (walls included). */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Top of the floor slab / underside of the roof slab. */
  floor: number;
  ceil: number;
  /** Wall, floor and roof thickness (default 2). */
  t?: number;
  wallMat?: SolidMaterial;
  floorMat?: SolidMaterial;
  roofMat?: SolidMaterial;
}

export interface Room extends Required<Pick<RoomSpec, 'x0' | 'x1' | 'z0' | 'z1' | 'floor' | 'ceil' | 't'>> {
  /** Interior footprint. */
  ix0: number;
  ix1: number;
  iz0: number;
  iz1: number;
  sectorId: string;
}

export const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box => ({
  min: v3(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)),
  max: v3(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)),
});

export class StageBuilder {
  readonly solids: BSolid[] = [];
  readonly decor: DecorDef[] = [];
  readonly enemies: EnemyDef[] = [];
  readonly sectors: SectorDef[] = [];
  readonly barriers: BarrierDef[] = [];
  /** Render-only wayfinding markings (paint / illuminated sign faces); see MarkingDef. */
  readonly markings: MarkingDef[] = [];
  /** Sector id attached to everything created from now on. */
  sectorId = '';
  private rngState = 0x2f6e2b1;

  /** Deterministic uniform float in [0, 1) for dressing variety (never gameplay). */
  rnd(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Picks one element deterministically. */
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rnd() * items.length)] as T;
  }

  // ───────────────────────────── primitives ─────────────────────────────
  /** Adds a solid box (corner order is free). Degenerate boxes are ignored. */
  solid(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, material: SolidMaterial, tag?: string, carvable = false): void {
    const b = box(x0, y0, z0, x1, y1, z1);
    if (b.max.x - b.min.x < 1e-6 || b.max.y - b.min.y < 1e-6 || b.max.z - b.min.z < 1e-6) return;
    const s: BSolid = { min: b.min, max: b.max, material, carvable };
    if (this.sectorId) s.sectorId = this.sectorId;
    if (tag) s.tag = tag;
    this.solids.push(s);
  }

  /** A structural solid that later `carve()` calls may cut (walls, floors, roofs, slabs). */
  shell(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, material: SolidMaterial, tag?: string): void {
    this.solid(x0, y0, z0, x1, y1, z1, material, tag, true);
  }

  /** Non-colliding detail. */
  dec(shape: DecorDef['shape'], material: DecorMaterial, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, blink = false): void {
    const b = box(x0, y0, z0, x1, y1, z1);
    const d: DecorDef = { min: b.min, max: b.max, shape, material };
    if (blink) d.blink = true;
    if (this.sectorId) d.sectorId = this.sectorId;
    this.decor.push(d);
  }

  // ───────────────────────────── markings (render-only paint / sign faces) ─────────────────────────────
  /**
   * Flat marking centred on (x, y, z) of a wall face ('x+' 'x-' 'z+' 'z-' = its outward normal) or of a floor
   * ('y+', `top` = direction its upper edge points to). `text` omitted = plain rectangle. No collision, no
   * thickness: it is paint (styles 'yellow' 'white' 'hazard' 'dark') or an illuminated sign face ('glow-*').
   */
  mark(
    facing: MarkingDef['facing'],
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    style: MarkingDef['style'],
    text?: string,
    opts: { top?: MarkingDef['top']; chase?: number; until?: string; after?: string } = {},
  ): void {
    const m: MarkingDef = { position: v3(x, y, z), facing, width, height, style };
    if (text !== undefined) m.text = text;
    if (opts.top) m.top = opts.top;
    if (opts.chase !== undefined) m.chase = opts.chase;
    if (opts.until) m.untilBarrierOpen = opts.until;
    if (opts.after) m.afterBarrierOpen = opts.after;
    if (this.sectorId) m.sectorId = this.sectorId;
    this.markings.push(m);
  }

  /** Marking on a wall face given like the other wall helpers: `axis` = direction along the wall, `face` = its coordinate, `dir` = into the room, `a` = position along the wall. */
  wallMark(axis: 'x' | 'z', face: number, dir: 1 | -1, a: number, y: number, width: number, height: number, style: MarkingDef['style'], text?: string, opts: { chase?: number; until?: string; after?: string } = {}): void {
    if (axis === 'x') this.mark(dir > 0 ? 'z+' : 'z-', a, y, face, width, height, style, text, opts);
    else this.mark(dir > 0 ? 'x+' : 'x-', face, y, a, width, height, style, text, opts);
  }

  /**
   * Signposts a climb that needs flight on the wall below its landing bay: a hazard band under the sill and
   * (optionally) up both jambs, two columns of illuminated up-chevrons running upwards, the id in stencil paint
   * under the sill, and the id painted on the take-off pad. `axis` = direction along the wall, `face` = wall face coordinate,
   * `dir` = into the room, a0..a1 = extent of the bay along the wall, y0 = take-off floor, y1 = sill of the bay
   * (landing level), `c` = centre of the sign along the wall (default: middle of the bay).
   */
  flightSign(id: string, axis: 'x' | 'z', face: number, dir: 1 | -1, a0: number, a1: number, y0: number, y1: number, opts: { c?: number; jambs?: 'both' | 'low' | 'high' | 'none'; bayHeight?: number; pad?: boolean } = {}): void {
    const c = opts.c ?? (a0 + a1) / 2;
    const jambs = opts.jambs ?? 'both';
    const bh = opts.bayHeight ?? 8;
    // hazard frame of the bay: sill band + jamb bands
    const low = jambs === 'both' || jambs === 'low';
    const high = jambs === 'both' || jambs === 'high';
    const s0 = a0 - (low ? 0.8 : 0);
    const s1 = a1 + (high ? 0.8 : 0);
    this.wallMark(axis, face, dir, (s0 + s1) / 2, y1 - 0.45, s1 - s0, 0.9, 'hazard');
    if (low) this.wallMark(axis, face, dir, a0 - 0.4, y1 + bh / 2, 0.8, bh, 'hazard');
    if (high) this.wallMark(axis, face, dir, a1 + 0.4, y1 + bh / 2, 0.8, bh, 'hazard');
    // Seen from the take-off pad the mech covers the middle of the wall: the id sits right under the sill and
    // the running chevrons climb the wall in two columns left and right of it.
    this.wallMark(axis, face, dir, c, y1 - 2.2, 4.2, 2.2, 'yellow', id);
    const z0 = y0 + 2.4;
    const z1 = y1 - 1.2;
    const n = Math.max(1, Math.min(5, Math.floor((z1 - z0) / 2)));
    const step = (z1 - z0) / n;
    for (let i = 0; i < n; i++) {
      for (const side of [-1, 1]) this.wallMark(axis, face, dir, c + side * 4.3, z0 + step * (i + 0.5), 3, Math.min(1.5, step * 0.78), 'glow-amber', '^', { chase: (i / n) * 0.8 });
    }
    if (opts.pad !== false) {
      // take-off pad: dark plate with the id, read while walking towards the wall
      const top = (axis === 'x' ? (dir > 0 ? 'z-' : 'z+') : dir > 0 ? 'x-' : 'x+') as MarkingDef['top'];
      const d = face + dir * 9.5;
      const px = axis === 'x' ? c : d;
      const pz = axis === 'x' ? d : c;
      this.mark('y+', px, y0, pz, 7.6, 3.4, 'dark', undefined, { top });
      this.mark('y+', px, y0, pz, 6.6, 2.4, 'white', `^ ${id}`, { top });
    }
  }

  /**
   * Barrier id above its doorway (on the wall face the door is approached from): illuminated red while the
   * barrier is closed, green once it has opened. `a` = centre of the doorway along the wall, y = top of the doorway.
   */
  doorSign(id: string, axis: 'x' | 'z', face: number, dir: 1 | -1, a: number, y: number, size = 1.7): void {
    const w = size * 1.7;
    this.wallMark(axis, face, dir, a, y + 0.75 + size / 2, w + 0.9, size + 0.7, 'dark');
    this.wallMark(axis, face, dir, a, y + 0.75 + size / 2, w, size, 'glow-red', id, { until: id });
    this.wallMark(axis, face, dir, a, y + 0.75 + size / 2, w, size, 'glow-green', id, { after: id });
  }

  /**
   * Id of the barrier a control turret opens, stacked vertically ('B' over '1') on the four faces of its mast or
   * tower: a dark plate with illuminated red glyphs that go out when the barrier opens. cx, cz = centre of the
   * column, half = half its width, yc = centre height of the plate, gw = glyph width.
   */
  columnTag(id: string, cx: number, cz: number, half: number, yc: number, gw: number): void {
    const gh = gw * 1.4;
    const gap = gw * 0.25;
    const plateH = id.length * gh + (id.length + 1) * gap;
    const faces: Array<[MarkingDef['facing'], number, number]> = [
      ['x+', cx + half, cz],
      ['x-', cx - half, cz],
      ['z+', cx, cz + half],
      ['z-', cx, cz - half],
    ];
    for (const [f, x, z] of faces) {
      this.mark(f, x, yc, z, Math.min(half * 2, gw + 0.5), plateH, 'dark');
      for (let i = 0; i < id.length; i++) {
        const y = yc + plateH / 2 - gap - gh / 2 - i * (gh + gap);
        this.mark(f, x, y, z, gw, gh, 'glow-red', id[i]!, { until: id });
      }
    }
  }

  /** Subtracts the box from every carvable solid created so far (each cut solid becomes up to 6 boxes). */
  carve(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const c = box(x0, y0, z0, x1, y1, z1);
    const out: BSolid[] = [];
    for (const s of this.solids) {
      const hit =
        s.carvable &&
        s.min.x < c.max.x && s.max.x > c.min.x &&
        s.min.y < c.max.y && s.max.y > c.min.y &&
        s.min.z < c.max.z && s.max.z > c.min.z;
      if (!hit) {
        out.push(s);
        continue;
      }
      const piece = (ax0: number, ay0: number, az0: number, ax1: number, ay1: number, az1: number): void => {
        if (ax1 - ax0 < 1e-6 || ay1 - ay0 < 1e-6 || az1 - az0 < 1e-6) return;
        out.push({ ...s, min: v3(ax0, ay0, az0), max: v3(ax1, ay1, az1) });
      };
      const xa = Math.max(s.min.x, c.min.x);
      const xb = Math.min(s.max.x, c.max.x);
      const za = Math.max(s.min.z, c.min.z);
      const zb = Math.min(s.max.z, c.max.z);
      const ya = Math.max(s.min.y, c.min.y);
      const yb = Math.min(s.max.y, c.max.y);
      piece(s.min.x, s.min.y, s.min.z, xa, s.max.y, s.max.z);
      piece(xb, s.min.y, s.min.z, s.max.x, s.max.y, s.max.z);
      piece(xa, s.min.y, s.min.z, xb, s.max.y, za);
      piece(xa, s.min.y, zb, xb, s.max.y, s.max.z);
      piece(xa, s.min.y, za, xb, ya, zb);
      piece(xa, yb, za, xb, s.max.y, zb);
    }
    this.solids.length = 0;
    for (const s of out) this.solids.push(s);
  }

  // ───────────────────────────── sectors / rooms ─────────────────────────────
  sector(id: string, name: string, nameEn: string, kind: SectorKind, bounds: Box[], combatArena = false): void {
    const s: SectorDef = { id, name, nameEn, kind, bounds };
    if (combatArena) s.combatArena = true;
    this.sectors.push(s);
  }

  /** Closed shell: floor slab, roof slab, four walls. Returns the interior description. */
  room(spec: RoomSpec): Room {
    const t = spec.t ?? 2;
    const { x0, x1, z0, z1, floor, ceil } = spec;
    const wall = spec.wallMat ?? 'wall';
    const y0 = floor - t;
    const y1 = ceil + t;
    this.shell(x0 + t, y0, z0 + t, x1 - t, floor, z1 - t, spec.floorMat ?? 'floor', 'floor');
    this.shell(x0 + t, ceil, z0 + t, x1 - t, y1, z1 - t, spec.roofMat ?? 'roof', 'roof');
    this.shell(x0, y0, z0, x0 + t, y1, z1, wall, 'wall-w');
    this.shell(x1 - t, y0, z0, x1, y1, z1, wall, 'wall-e');
    this.shell(x0 + t, y0, z0, x1 - t, y1, z0 + t, wall, 'wall-s');
    this.shell(x0 + t, y0, z1 - t, x1 - t, y1, z1, wall, 'wall-n');
    return { x0, x1, z0, z1, floor, ceil, t, ix0: x0 + t, ix1: x1 - t, iz0: z0 + t, iz1: z1 - t, sectorId: this.sectorId };
  }

  /** Bounds box of a room including its own walls, floor and roof (abutting rooms therefore tile). */
  roomBounds(r: Room): Box {
    return box(r.x0, r.floor - r.t, r.z0, r.x1, r.ceil + r.t, r.z1);
  }

  // ───────────────────────────── structural pieces ─────────────────────────────
  /**
   * Horizontal slab with its top at `top`. `hazard` lists the sides ('n', 's', 'e', 'w' = +z, -z, +x, -x)
   * whose outermost metre is drawn as a hazard-striped edge (same collision, flush surface).
   */
  platform(x0: number, z0: number, x1: number, z1: number, top: number, thick = 1, material: SolidMaterial = 'catwalk', hazard = '', tag = 'platform'): void {
    let ax0 = x0;
    let ax1 = x1;
    let az0 = z0;
    let az1 = z1;
    const y0 = top - thick;
    if (hazard.includes('w')) {
      this.shell(ax0, y0, az0, ax0 + 1, top, az1, 'hazard', tag);
      ax0 += 1;
    }
    if (hazard.includes('e')) {
      this.shell(ax1 - 1, y0, az0, ax1, top, az1, 'hazard', tag);
      ax1 -= 1;
    }
    if (hazard.includes('s')) {
      this.shell(ax0, y0, az0, ax1, top, az0 + 1, 'hazard', tag);
      az0 += 1;
    }
    if (hazard.includes('n')) {
      this.shell(ax0, y0, az1 - 1, ax1, top, az1, 'hazard', tag);
      az1 -= 1;
    }
    this.shell(ax0, y0, az0, ax1, top, az1, material, tag);
  }

  /** Replaces the top 0.4 m of the (carvable) floor in the rectangle by a flush patch of another material. */
  floorPatch(x0: number, z0: number, x1: number, z1: number, top: number, material: SolidMaterial = 'hazard'): void {
    this.carve(x0, top - 0.4, z0, x1, top, z1);
    this.shell(x0, top - 0.4, z0, x1, top, z1, material, 'floor-patch');
  }

  /**
   * Bottomless pit: a hole through the floor slab (thickness t) with a closed shaft below it reaching
   * `bottom` (below killY), ringed by a flush hazard border.
   */
  pit(x0: number, z0: number, x1: number, z1: number, floorTop: number, t: number, bottom: number): void {
    const b = 1.5;
    this.floorPatch(x0 - b, z0 - b, x1 + b, z1 + b, floorTop, 'hazard');
    this.carve(x0, floorTop - t, z0, x1, floorTop, z1);
    const y1 = floorTop - t;
    this.solid(x0 - 1, bottom, z0 - 1, x0, y1, z1 + 1, 'dark', 'pit-shaft');
    this.solid(x1, bottom, z0 - 1, x1 + 1, y1, z1 + 1, 'dark', 'pit-shaft');
    this.solid(x0, bottom, z0 - 1, x1, y1, z0, 'dark', 'pit-shaft');
    this.solid(x0, bottom, z1, x1, y1, z1 + 1, 'dark', 'pit-shaft');
  }

  /** Square column centred on (x, z). */
  pillar(x: number, z: number, size: number, y0: number, y1: number, material: SolidMaterial = 'concrete', tag = 'pillar'): void {
    const h = size / 2;
    this.solid(x - h, y0, z - h, x + h, y1, z + h, material, tag);
  }

  /** Box standing on `floor`. */
  block(x0: number, z0: number, x1: number, z1: number, floor: number, height: number, material: SolidMaterial, tag?: string): void {
    this.solid(x0, floor, z0, x1, floor + height, z1, material, tag);
  }

  /** Roughly round tank (three boxes forming a plus-shaped footprint). */
  tank(cx: number, cz: number, r: number, floor: number, height: number, material: SolidMaterial = 'pipe'): void {
    const a = Math.round(r * 0.6 * 2) / 2;
    this.solid(cx - r, floor, cz - a, cx + r, floor + height, cz + a, material, 'tank');
    this.solid(cx - a, floor, cz - r, cx + a, floor + height, cz - a, material, 'tank');
    this.solid(cx - a, floor, cz + a, cx + a, floor + height, cz + r, material, 'tank');
  }

  /**
   * Roof truss: a solid bottom chord 3.4 m below the ceiling (the player cannot fit above it) with decor
   * webbing above. `axis` is the direction the truss runs along; `pos` its centre on the other axis.
   */
  truss(axis: 'x' | 'z', pos: number, a0: number, a1: number, ceil: number, material: SolidMaterial = 'rust'): void {
    const w = 0.6;
    const yc0 = ceil - 3.4;
    const yc1 = ceil - 3.0;
    if (axis === 'x') this.solid(a0, yc0, pos - w, a1, yc1, pos + w, material, 'truss');
    else this.solid(pos - w, yc0, a0, pos + w, yc1, a1, material, 'truss');
    const n = Math.max(2, Math.round((a1 - a0) / 8));
    for (let i = 0; i <= n; i++) {
      const a = a0 + 0.4 + ((a1 - a0 - 0.8) * i) / n;
      if (axis === 'x') this.dec('box', material, a - 0.2, yc1, pos - 0.2, a + 0.2, ceil - 0.4, pos + 0.2);
      else this.dec('box', material, pos - 0.2, yc1, a - 0.2, pos + 0.2, ceil - 0.4, a + 0.2);
    }
    if (axis === 'x') this.dec('box', material, a0, ceil - 0.4, pos - 0.3, a1, ceil, pos + 0.3);
    else this.dec('box', material, pos - 0.3, ceil - 0.4, a0, pos + 0.3, ceil, a1);
  }

  /**
   * Pipe tray under the ceiling along a wall: solid shelf 3.9 m below the ceiling, pipes (decor) on it.
   * `axis` = direction of the run, `face` = coordinate of the wall face, `dir` = +1/-1 direction into the room.
   */
  wallTray(axis: 'x' | 'z', face: number, dir: 1 | -1, a0: number, a1: number, ceil: number, lamp: DecorMaterial | null = null): void {
    const depth = 2.2;
    const y0 = ceil - 3.9;
    const y1 = ceil - 3.5;
    const f0 = Math.min(face, face + dir * depth);
    const f1 = Math.max(face, face + dir * depth);
    if (axis === 'x') this.solid(a0, y0, f0, a1, y1, f1, 'metal', 'tray');
    else this.solid(f0, y0, a0, f1, y1, a1, 'metal', 'tray');
    // [distance of the axis from the wall, height of the axis above the tray, radius]: two pipes lie on the
    // tray, the third is clamped to the wall above them (nothing hovers).
    const pipes: Array<[number, number, number, DecorMaterial]> = [
      [0.55, 0.45, 0.45, 'pipe'],
      [1.5, 0.3, 0.3, 'rust'],
      [0.25, 1.6, 0.25, 'metal'],
    ];
    for (const [off, up, r, m] of pipes) {
      const c = face + dir * off;
      const y = y1 + up;
      if (axis === 'x') this.dec('cylinder-x', m, a0 + 0.2, y - r, c - r, a1 - 0.2, y + r, c + r);
      else this.dec('cylinder-z', m, c - r, y - r, a0 + 0.2, c + r, y + r, a1 - 0.2);
    }
    // Cable hangers from the tray to the roof and (optionally) a 3 m lamp strip clamped onto every hanger.
    const n = Math.max(1, Math.round((a1 - a0) / 10));
    for (let i = 0; i <= n; i++) {
      const a = a0 + 0.5 + ((a1 - a0 - 1) * i) / n;
      const c = face + dir * 2.0;
      if (axis === 'x') this.dec('box', 'metal', a - 0.1, y1, c - 0.1, a + 0.1, ceil, c + 0.1);
      else this.dec('box', 'metal', c - 0.1, y1, a - 0.1, c + 0.1, ceil, a + 0.1);
      if (lamp && a1 - a0 >= 3.4) {
        // The strip (0.5 m wide, centred 1.9 m from the wall) stays inside the tray's footprint; the hanger runs through it.
        const l0 = Math.min(Math.max(a - 1.5, a0 + 0.2), a1 - 3.2);
        const lc = face + dir * 1.9;
        if (axis === 'x') this.dec('box', lamp, l0, y1 + 2.2, lc - 0.25, l0 + 3, y1 + 2.5, lc + 0.25);
        else this.dec('box', lamp, lc - 0.25, y1 + 2.2, l0, lc + 0.25, y1 + 2.5, l0 + 3);
      }
    }
  }

  /**
   * Floor-level pipe rack against a wall: solid plinth + solid cap, with pipes in the 2.6 m slot between
   * them (too low for the player's 4 m box). The cap top is `floor + height` (default 5; plinth = height - 3).
   */
  wallRack(axis: 'x' | 'z', face: number, dir: 1 | -1, a0: number, a1: number, floor: number, height = 5): void {
    const depth = 1.5;
    const slot = floor + height - 3;
    const f0 = Math.min(face, face + dir * depth);
    const f1 = Math.max(face, face + dir * depth);
    const put = (m: SolidMaterial, y0: number, y1: number, b0: number, b1: number): void => {
      if (axis === 'x') this.solid(b0, y0, f0, b1, y1, f1, m, 'rack');
      else this.solid(f0, y0, b0, f1, y1, b1, m, 'rack');
    };
    put('concrete', floor, slot, a0, a1);
    put('metal', slot + 2.6, slot + 3, a0, a1);
    put('metal', slot, slot + 2.6, a0, a0 + 0.5);
    put('metal', slot, slot + 2.6, a1 - 0.5, a1);
    const pipes: Array<[number, number, number, DecorMaterial]> = [
      [0.5, 0.55, 0.42, 'pipe'],
      [1.05, 1.45, 0.3, 'rust'],
      [0.45, 2.1, 0.22, 'metal'],
    ];
    for (const [off, up, r, m] of pipes) {
      const c = face + dir * off;
      const y = slot + up;
      if (axis === 'x') this.dec('cylinder-x', m, a0 + 0.5, y - r, c - r, a1 - 0.5, y + r, c + r);
      else this.dec('cylinder-z', m, c - r, y - r, a0 + 0.5, c + r, y + r, a1 - 0.5);
    }
  }

  /** Thin lamp panels flush under a ceiling on a regular grid (>= 5 m above any floor). */
  lamps(x0: number, z0: number, x1: number, z1: number, ceil: number, stepX: number, stepZ: number, material: DecorMaterial = 'light-warm'): void {
    for (let x = x0; x <= x1 + 1e-6; x += stepX) {
      for (let z = z0; z <= z1 + 1e-6; z += stepZ) {
        this.dec('box', material, x - 2, ceil - 0.15, z - 0.6, x + 2, ceil, z + 0.6);
      }
    }
  }

  /**
   * Blinking warning plates on a wall face above an opening. `axis` = direction along the wall,
   * `face` = wall face coordinate, `dir` = into the room, a0..a1 = extent of the opening, y = opening top.
   */
  warnLights(axis: 'x' | 'z', face: number, dir: 1 | -1, a0: number, a1: number, y: number, material: DecorMaterial = 'light-red'): void {
    const f0 = Math.min(face, face + dir * 0.2);
    const f1 = Math.max(face, face + dir * 0.2);
    for (const a of [a0 + 0.5, a1 - 2.5]) {
      if (axis === 'x') this.dec('box', material, a, y + 0.5, f0, a + 2, y + 1.3, f1, true);
      else this.dec('box', material, f0, y + 0.5, a, f1, y + 1.3, a + 2, true);
    }
    if (axis === 'x') this.dec('box', 'hazard', a0, y + 0.1, f0, a1, y + 0.4, f1);
    else this.dec('box', 'hazard', f0, y + 0.1, a0, f1, y + 0.4, a1);
  }

  /** Beacon hanging from the ceiling above a point of interest (thin cable + thin blinking plate). */
  beacon(x: number, z: number, surfaceY: number, ceil: number, material: DecorMaterial = 'light-red'): void {
    const yb = Math.min(ceil - 0.6, Math.max(surfaceY + 6.2, ceil - 4));
    if (yb < surfaceY + 5.2) return;
    this.dec('cylinder-y', 'metal', x - 0.06, yb, z - 0.06, x + 0.06, ceil, z + 0.06);
    this.dec('box', material, x - 0.7, yb - 0.2, z - 0.7, x + 0.7, yb, z + 0.7, true);
  }

  /** Full-height wall piers (1 m deep, 2 m wide) at the given positions along a wall. */
  pilasters(axis: 'x' | 'z', face: number, dir: 1 | -1, at: readonly number[], y0: number, y1: number, material: SolidMaterial = 'concrete'): void {
    const f0 = Math.min(face, face + dir);
    const f1 = Math.max(face, face + dir);
    for (const a of at) {
      if (axis === 'x') this.solid(a - 1, y0, f0, a + 1, y1, f1, material, 'pilaster');
      else this.solid(f0, y0, a - 1, f1, y1, a + 1, material, 'pilaster');
    }
  }

  /**
   * Low rubble blocks (0.5..maxH m, jumpable) scattered deterministically inside a rectangle. A block never
   * overlaps or touches a rubble block placed before it (no interpenetrating boxes, no coplanar faces): a
   * candidate that does is drawn again, and dropped after 12 attempts.
   */
  rubble(x0: number, z0: number, x1: number, z1: number, floor: number, n: number, maxH = 1.4): void {
    for (let i = 0; i < n; i++) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const w = 1 + Math.round(this.rnd() * 4) / 2;
        const d = 1 + Math.round(this.rnd() * 4) / 2;
        const x = x0 + Math.round(this.rnd() * Math.max(0, x1 - x0 - w) * 2) / 2;
        const z = z0 + Math.round(this.rnd() * Math.max(0, z1 - z0 - d) * 2) / 2;
        const h = 0.5 + Math.round(this.rnd() * (maxH - 0.5) * 10) / 10;
        const material = this.pick(['concrete', 'concrete', 'rust'] as const);
        const g = 0.25; // keep a visible gap between neighbouring blocks
        const clash = this.solids.some((s) => s.tag === 'rubble' && s.min.y < floor + h && s.max.y > floor && s.min.x < x + w + g && s.max.x > x - g && s.min.z < z + d + g && s.max.z > z - g);
        if (clash) continue;
        this.solid(x, floor, z, x + w, floor + h, z + d, material, 'rubble');
        break;
      }
    }
  }

  /** Large ventilation duct hung directly under the ceiling (solid; nothing can stand on it). */
  duct(axis: 'x' | 'z', pos: number, a0: number, a1: number, ceil: number, size = 2.4, material: SolidMaterial = 'pipe'): void {
    const h = size / 2;
    if (axis === 'x') this.solid(a0, ceil - 2, pos - h, a1, ceil, pos + h, material, 'duct');
    else this.solid(pos - h, ceil - 2, a0, pos + h, ceil, a1, material, 'duct');
  }

  // ───────────────────────────── enemies / barriers ─────────────────────────────
  guard(id: string, x: number, z: number, floorY: number, yaw = 0): void {
    this.enemies.push({ id, kind: 'guard', sectorId: this.sectorId, position: v3(x, floorY + ENEMIES.guard.centerHeight, z), yaw, isGateControl: false });
  }

  turret(id: string, x: number, z: number, surfaceY: number, yaw = 0, barrierId?: string): void {
    const e: EnemyDef = { id, kind: 'turret', sectorId: this.sectorId, position: v3(x, surfaceY + ENEMIES.turret.centerHeight, z), yaw, isGateControl: !!barrierId };
    if (barrierId) e.barrierId = barrierId;
    this.enemies.push(e);
  }

  /** Turret on its own pedestal (solid block of `height` standing on `floor`). */
  turretOnPedestal(id: string, x: number, z: number, floor: number, height: number, yaw = 0, barrierId?: string): void {
    if (height > 0) this.solid(x - 2, floor, z - 2, x + 2, floor + height, z + 2, barrierId ? 'hazard' : 'metal', 'pedestal');
    this.turret(id, x, z, floor + height, yaw, barrierId);
  }

  /**
   * Turret on a slim mast (1.6 m square on a 2.8 m footing) that ends 3.4 m below the ceiling: the turret fits
   * under the roof, the player's 4 m box does not — nobody can rest up there, however high it is. Keep it
   * >= 12 m away from roof trusses, whose bottom chords would otherwise shadow the floor. A control turret's
   * mast is hazard-striped and carries blinking warning plates.
   */
  mastTurret(id: string, x: number, z: number, floor: number, ceil: number, yaw = 0, barrierId?: string): void {
    const top = ceil - 3.4;
    this.solid(x - 0.8, floor + 1, z - 0.8, x + 0.8, top, z + 0.8, barrierId ? 'hazard' : 'metal', 'turret-mast');
    this.solid(x - 1.4, floor, z - 1.4, x + 1.4, floor + 1, z + 1.4, 'concrete', 'turret-mast');
    // Work lights flush under the roof around the mast head: from the floor the turret shows as a silhouette
    // against a lit patch of ceiling instead of disappearing into the dark roof.
    for (const [dx, dz] of [[2.6, 0], [-2.6, 0], [0, 2.6], [0, -2.6]] as const) {
      const hx = dx !== 0 ? 0.4 : 1.3;
      const hz = dz !== 0 ? 0.4 : 1.3;
      this.dec('box', 'light-warm', x + dx - hx, ceil - 0.12, z + dz - hz, x + dx + hx, ceil, z + dz + hz);
    }
    if (barrierId) {
      // control turret: blinking warning plates on all four faces of the mast (thin, clamped to it, >= 6 m up)
      for (const y of [floor + 6, top - 2.4]) {
        this.dec('box', 'light-red', x - 0.6, y, z - 0.9, x + 0.6, y + 1.2, z - 0.8, true);
        this.dec('box', 'light-red', x - 0.6, y, z + 0.8, x + 0.6, y + 1.2, z + 0.9, true);
        this.dec('box', 'light-red', x - 0.9, y, z - 0.6, x - 0.8, y + 1.2, z + 0.6, true);
        this.dec('box', 'light-red', x + 0.8, y, z - 0.6, x + 0.9, y + 1.2, z + 0.6, true);
      }
    }
    this.turret(id, x, z, top, yaw, barrierId);
  }

  barrier(id: string, name: string, b: Box, controlEnemyId: string, fromSectorId: string, toSectorId: string): void {
    this.barriers.push({ id, name, box: b, controlEnemyId, fromSectorId, toSectorId });
  }

  /** Final solids without the builder-only flag. */
  finishSolids(): SolidDef[] {
    return this.solids.map((s) => {
      const o: SolidDef = { min: s.min, max: s.max, material: s.material };
      if (s.sectorId) o.sectorId = s.sectorId;
      if (s.tag) o.tag = s.tag;
      return o;
    });
  }
}
