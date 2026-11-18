/**
 * PartBuilder: assemble one articulated part out of primitives, merged into ONE mesh per material slot.
 * Used by the mech, the enemies and the wrecks so each moving part costs only a handful of draw calls.
 */
import { Group, Material, Mesh } from 'three';
import { GeoBuilder, trs, type RGB } from './geo';

export interface PartOpts {
  rx?: number;
  ry?: number;
  rz?: number;
  tint?: RGB;
  tile?: number;
  seg?: number;
}

export class PartBuilder {
  private slots = new Map<string, GeoBuilder>();
  private aliases = new Map<string, { to: string; tint: RGB }>();

  /** route primitives written for slot `from` into slot `to`, multiplying their colour by `tint`
   *  (one material + vertex colours instead of many materials => fewer draw calls) */
  alias(from: string, to: string, tint: RGB): this {
    this.aliases.set(from, { to, tint });
    return this;
  }

  private resolve(slot: string, tint?: RGB): { slot: string; tint: RGB } {
    const a = this.aliases.get(slot);
    const t = tint ?? [1, 1, 1];
    if (!a) return { slot, tint: t };
    return { slot: a.to, tint: [t[0] * a.tint[0], t[1] * a.tint[1], t[2] * a.tint[2]] };
  }

  slot(name: string): GeoBuilder {
    let g = this.slots.get(name);
    if (!g) {
      g = new GeoBuilder();
      this.slots.set(name, g);
    }
    return g;
  }

  box(slot: string, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, o: PartOpts = {}): this {
    const m = trs(cx, cy, cz, o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
    const r = this.resolve(slot, o.tint);
    this.slot(r.slot).addBox({ x: -sx / 2, y: -sy / 2, z: -sz / 2 }, { x: sx / 2, y: sy / 2, z: sz / 2 }, { matrix: m, tile: o.tile ?? 1, color: r.tint });
    return this;
  }

  sph(slot: string, cx: number, cy: number, cz: number, rx: number, ry = rx, rz = rx, o: PartOpts = {}): this {
    const m = trs(cx, cy, cz, o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
    const r = this.resolve(slot, o.tint);
    this.slot(r.slot).addSphere({ x: 0, y: 0, z: 0 }, rx, ry, rz, r.tint, o.seg ?? 14, m);
    return this;
  }

  /** cylinder along local Y (then rotated) */
  cyl(slot: string, cx: number, cy: number, cz: number, r: number, h: number, o: PartOpts & { r2?: number } = {}): this {
    const m = trs(cx, cy, cz, o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
    const q = this.resolve(slot, o.tint);
    this.slot(q.slot).addCylinder({ x: 0, y: 0, z: 0 }, r, o.r2 ?? r, h, q.tint, o.seg ?? 12, m, [Math.max(1, r * 4), Math.max(1, h * 2)]);
    return this;
  }

  cone(slot: string, cx: number, cy: number, cz: number, r: number, h: number, o: PartOpts = {}): this {
    const m = trs(cx, cy, cz, o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
    const q = this.resolve(slot, o.tint);
    this.slot(q.slot).addCone({ x: 0, y: 0, z: 0 }, r, h, q.tint, o.seg ?? 10, m);
    return this;
  }

  torus(slot: string, cx: number, cy: number, cz: number, r: number, tube: number, o: PartOpts = {}): this {
    const m = trs(cx, cy, cz, o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
    const q = this.resolve(slot, o.tint);
    this.slot(q.slot).addTorus({ x: 0, y: 0, z: 0 }, r, tube, q.tint, m);
    return this;
  }

  get triangleCount(): number {
    let n = 0;
    for (const g of this.slots.values()) n += g.triangleCount;
    return n;
  }

  /** one Mesh per non-empty slot inside a new Group. Missing materials throw (programmer error). */
  build(name: string, mats: Record<string, Material>): Group {
    const grp = new Group();
    grp.name = name;
    for (const [slot, gb] of this.slots) {
      if (gb.isEmpty) continue;
      const mat = mats[slot];
      if (!mat) throw new Error(`PartBuilder: no material for slot "${slot}" in part "${name}"`);
      const mesh = new Mesh(gb.build(), mat);
      mesh.name = `${name}/${slot}`;
      grp.add(mesh);
    }
    return grp;
  }
}
