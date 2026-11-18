// ステージの描画メッシュ。衝突箱と同じ箱から生成し、見た目と衝突を一致させる。
import * as THREE from 'three';
import { Rng } from '../rng';
import type { StageData } from '../stage/build';
import { LIGHTS } from '../stage/layout';
import type { MatId } from '../stage/types';
import type { BarrierRuntime } from '../sim/game';
import { signTexture, textures } from './textures';

interface MatDef {
  tex: keyof ReturnType<typeof textures> | null;
  color: number;
  rough: number;
  metal: number;
  tile: number;
  emissive?: number;
  emissiveIntensity?: number;
}

const MATS: Record<MatId, MatDef> = {
  floor: { tex: 'concrete', color: 0x9a9b9c, rough: 0.92, metal: 0.05, tile: 6 },
  floorDark: { tex: 'concrete', color: 0x76787c, rough: 0.92, metal: 0.05, tile: 6 },
  wall: { tex: 'panel', color: 0x98a4b0, rough: 0.75, metal: 0.2, tile: 8 },
  wallRust: { tex: 'panel', color: 0xa89480, rough: 0.8, metal: 0.15, tile: 8 },
  ceiling: { tex: 'ceiling', color: 0x9aa2ac, rough: 0.9, metal: 0.2, tile: 12 },
  pillar: { tex: 'concrete', color: 0xa6a198, rough: 0.9, metal: 0.05, tile: 4 },
  steel: { tex: 'panel', color: 0x707c88, rough: 0.55, metal: 0.55, tile: 4 },
  containerRed: { tex: 'ribs', color: 0xa8392a, rough: 0.7, metal: 0.3, tile: 3 },
  containerBlue: { tex: 'ribs', color: 0x2f5f94, rough: 0.7, metal: 0.3, tile: 3 },
  containerGreen: { tex: 'ribs', color: 0x437a44, rough: 0.7, metal: 0.3, tile: 3 },
  crate: { tex: 'machine', color: 0x9a7848, rough: 0.9, metal: 0.05, tile: 3 },
  machine: { tex: 'machine', color: 0x98a07c, rough: 0.65, metal: 0.35, tile: 6 },
  machineDark: { tex: 'machine', color: 0x5a636e, rough: 0.6, metal: 0.45, tile: 5 },
  pipe: { tex: 'pipe', color: 0x8e8a80, rough: 0.6, metal: 0.45, tile: 4 },
  hazard: { tex: 'hazard', color: 0xffffff, rough: 0.8, metal: 0.1, tile: 1.6 },
  catwalk: { tex: 'grate', color: 0xb0b8c2, rough: 0.6, metal: 0.5, tile: 2 },
  rust: { tex: 'rust', color: 0xffffff, rough: 0.9, metal: 0.2, tile: 4 },
  tank: { tex: 'panel', color: 0x9cc0b8, rough: 0.55, metal: 0.35, tile: 6 },
  lightPanel: { tex: null, color: 0xffffff, rough: 1, metal: 0, tile: 1, emissive: 0xe8f0ff, emissiveIntensity: 2.5 },
  warning: { tex: null, color: 0x551010, rough: 1, metal: 0, tile: 1, emissive: 0xff3020, emissiveIntensity: 2 },
  concrete: { tex: 'concrete', color: 0xaaa49a, rough: 0.9, metal: 0.05, tile: 4 },
  paint: { tex: null, color: 0xd8a820, rough: 0.8, metal: 0, tile: 1 },
  stain: { tex: 'concrete', color: 0x2e2a26, rough: 0.35, metal: 0.1, tile: 3 },
};

const materialCache = new Map<MatId, THREE.MeshStandardMaterial>();
export function stageMaterial(id: MatId): THREE.MeshStandardMaterial {
  let m = materialCache.get(id);
  if (m) return m;
  const d = MATS[id];
  const tex = d.tex ? textures()[d.tex] : null;
  m = new THREE.MeshStandardMaterial({
    color: d.color,
    map: tex,
    roughness: d.rough,
    metalness: d.metal,
    vertexColors: true,
    emissive: d.emissive ?? 0x000000,
    emissiveIntensity: d.emissiveIntensity ?? 1,
  });
  materialCache.set(id, m);
  return m;
}

/** 箱群を1つのジオメトリへ（面ごとにワールド座標UV） */
function boxesGeometry(list: { min: number[]; max: number[] }[], tile: number, rng: Rng): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const face = (c: number[][], n: number[], uvs: number[][], tint: number) => {
    const base = pos.length / 3;
    for (let i = 0; i < 4; i++) {
      pos.push(c[i][0], c[i][1], c[i][2]);
      nor.push(n[0], n[1], n[2]);
      uv.push(uvs[i][0] / tile, uvs[i][1] / tile);
      // 下ほど暗く（汚れ・陰影）
      const shade = n[1] < 0 ? 0.9 : n[1] > 0 ? 1.0 : 0.95;
      col.push(tint * shade, tint * shade, tint * shade);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (const b of list) {
    const [x0, y0, z0] = b.min;
    const [x1, y1, z1] = b.max;
    const tint = 0.86 + rng.next() * 0.18;
    face([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], [[z1, y0], [z0, y0], [z0, y1], [z1, y1]], tint);
    face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], [[z0, y0], [z1, y0], [z1, y1], [z0, y1]], tint);
    face([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], [[x0, z1], [x1, z1], [x1, z0], [x0, z0]], tint);
    face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], tint);
    face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], tint);
    face([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], [[x1, y0], [x0, y0], [x0, y1], [x1, y1]], tint);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export interface LampInfo {
  pos: THREE.Vector3;
  color: number;
  kind: 'warning' | 'lamp' | 'skylight';
  sprite: THREE.Sprite | null;
  phase: number;
}

export interface BarrierVisual {
  rt: BarrierRuntime;
  mesh: THREE.Mesh;
  lamp: THREE.Mesh;
  lampMat: THREE.MeshBasicMaterial;
  glow: THREE.Sprite;
}

export class StageView {
  group = new THREE.Group();
  lamps: LampInfo[] = [];
  barriers: BarrierVisual[] = [];
  private pointLights: THREE.PointLight[] = [];

  constructor(stage: StageData, scene: THREE.Scene) {
    const rng = new Rng(777);
    const byMat = new Map<MatId, { min: number[]; max: number[] }[]>();
    for (const b of stage.boxes) {
      if (b.hidden) continue;
      if (!byMat.has(b.mat)) byMat.set(b.mat, []);
      byMat.get(b.mat)!.push(b);
    }
    for (const [mat, list] of byMat) {
      const g = boxesGeometry(list, MATS[mat].tile, rng);
      const mesh = new THREE.Mesh(g, stageMaterial(mat));
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
    // 描画のみの塗装面（重なり描画のちらつきを防ぐため深度オフセット付き）
    const decalByMat = new Map<MatId, { min: number[]; max: number[] }[]>();
    for (const d of stage.decals) {
      if (!decalByMat.has(d.mat)) decalByMat.set(d.mat, []);
      decalByMat.get(d.mat)!.push(d);
    }
    for (const [mat, list] of decalByMat) {
      const g = boxesGeometry(list, MATS[mat].tile, rng);
      const m = stageMaterial(mat).clone();
      m.polygonOffset = true;
      m.polygonOffsetFactor = -2;
      m.polygonOffsetUnits = -2;
      if (mat === 'stain') {
        m.transparent = true;
        m.opacity = 0.42;
        m.depthWrite = false;
      }
      const mesh = new THREE.Mesh(g, m);
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
    }

    // 円柱（冷却塔・発電機・炉）
    const tx = textures();
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x9a9488, map: tx.pipe, roughness: 0.55, metalness: 0.5 });
    for (const c of stage.cylinders) {
      const axis = c.axis ?? 'y';
      if (axis !== 'y') {
        // 壁面配管（横向き）
        const geo = new THREE.CylinderGeometry(c.radius, c.radius, c.height, 12, 1);
        const m = new THREE.Mesh(geo, pipeMat);
        if (axis === 'x') {
          m.rotation.z = Math.PI / 2;
          m.position.set(c.base[0] + c.height / 2, c.base[1], c.base[2]);
        } else {
          m.rotation.x = Math.PI / 2;
          m.position.set(c.base[0], c.base[1], c.base[2] + c.height / 2);
        }
        this.group.add(m);
        // 支持金具
        for (let t = 2; t < c.height - 1; t += 6) {
          const br = new THREE.Mesh(new THREE.BoxGeometry(0.3, c.radius * 2.6, 0.3), stageMaterial('steel'));
          if (axis === 'x') br.position.set(c.base[0] + t, c.base[1], c.base[2]);
          else br.position.set(c.base[0], c.base[1], c.base[2] + t);
          this.group.add(br);
        }
        continue;
      }
      const mat = new THREE.MeshStandardMaterial({ color: MATS[c.mat].color, map: tx.panel, roughness: 0.5, metalness: 0.45 });
      const geo = new THREE.CylinderGeometry(c.radius, c.radius, c.height, 28, 1);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(c.base[0], c.base[1] + c.height / 2, c.base[2]);
      this.group.add(m);
      // 補強リング
      for (let y = 2; y < c.height; y += 4) {
        const r = new THREE.Mesh(new THREE.TorusGeometry(c.radius + 0.05, 0.18, 6, 32), stageMaterial('steel'));
        r.rotation.x = Math.PI / 2;
        r.position.set(c.base[0], c.base[1] + y, c.base[2]);
        this.group.add(r);
      }
      // 上面の縁（警告色）
      const rim = new THREE.Mesh(new THREE.TorusGeometry(c.radius - 0.3, 0.3, 6, 32), stageMaterial('hazard'));
      rim.rotation.x = Math.PI / 2;
      rim.position.set(c.base[0], c.base[1] + c.height + 0.05, c.base[2]);
      this.group.add(rim);
    }

    // 看板（区画名・行き先）
    for (const s of stage.signs) {
      const tex = signTexture(s.text, s.sub, s.color ?? '#7fd4ff');
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(s.width, s.height),
        new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
      );
      m.position.set(s.pos[0], s.pos[1], s.pos[2]);
      m.rotation.y = s.yaw;
      this.group.add(m);
    }

    // 照明・警告灯
    const glowTex = tx.glow;
    for (const l of LIGHTS) {
      const pos = new THREE.Vector3(l.pos[0], l.pos[1], l.pos[2]);
      let sprite: THREE.Sprite | null = null;
      if (l.kind === 'skylight') {
        const panel = new THREE.Mesh(
          new THREE.BoxGeometry(10, 0.15, 4),
          new THREE.MeshBasicMaterial({ color: l.color, toneMapped: false }),
        );
        panel.position.copy(pos);
        this.group.add(panel);
      } else {
        const bulb = new THREE.Mesh(
          new THREE.SphereGeometry(l.kind === 'warning' ? 0.35 : 0.25, 10, 8),
          new THREE.MeshBasicMaterial({ color: l.color, toneMapped: false }),
        );
        bulb.position.copy(pos);
        this.group.add(bulb);
        sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: glowTex, color: l.color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.7 }),
        );
        sprite.scale.setScalar(l.kind === 'warning' ? 3.2 : 2.4);
        sprite.position.copy(pos);
        this.group.add(sprite);
      }
      this.lamps.push({ pos, color: l.color, kind: l.kind, sprite, phase: rng.next() * Math.PI * 2 });
    }
    // 近傍の照明だけ実際の点光源で照らす（数は固定）
    for (let i = 0; i < 6; i++) {
      const pl = new THREE.PointLight(0xffffff, 0, 45, 1.6);
      this.pointLights.push(pl);
      scene.add(pl);
    }

    scene.add(this.group);
  }

  addBarriers(rts: BarrierRuntime[]) {
    const tx = textures();
    for (const rt of rts) {
      const mat = new THREE.MeshStandardMaterial({ color: rt.id === 'GATE' ? 0xd8d0c0 : 0xffffff, map: tx.hazard, roughness: 0.6, metalness: 0.4 });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      this.group.add(mesh);
      const lampMat = new THREE.MeshBasicMaterial({ color: 0xff2010, toneMapped: false });
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(1, 0.5, 1), lampMat);
      this.group.add(lamp);
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tx.glow, color: 0xff2010, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
      );
      glow.scale.setScalar(5);
      this.group.add(glow);
      this.barriers.push({ rt, mesh, lamp, lampMat, glow });
    }
  }

  update(time: number, playerPos: THREE.Vector3) {
    // 隔壁：衝突箱と同じ寸法で描画
    for (const b of this.barriers) {
      const w = b.rt.wbox;
      const cb = b.rt.closedBox;
      b.mesh.visible = w.active;
      const sx = w.max[0] - w.min[0],
        sy = w.max[1] - w.min[1],
        sz = w.max[2] - w.min[2];
      b.mesh.scale.set(Math.max(0.01, sx), Math.max(0.01, sy), Math.max(0.01, sz));
      b.mesh.position.set((w.min[0] + w.max[0]) / 2, (w.min[1] + w.max[1]) / 2, (w.min[2] + w.max[2]) / 2);
      // 状態灯（開口上部・両面）
      const open = b.rt.open;
      const col = open ? 0x30ff60 : 0xff2010;
      b.lampMat.color.setHex(col);
      (b.glow.material as THREE.SpriteMaterial).color.setHex(col);
      const thin = b.rt.thinAxis;
      const cx = (cb.min[0] + cb.max[0]) / 2,
        cz = (cb.min[2] + cb.max[2]) / 2;
      if (thin === 1) {
        b.lamp.position.set(cb.min[0] - 0.4, cb.max[1] + 0.3, cz);
        b.lamp.scale.set(0.6, 0.6, cb.max[2] - cb.min[2]);
      } else {
        b.lamp.position.set(cx, cb.max[1] + 0.5, cz);
        b.lamp.scale.set(thin === 0 ? 2.4 : cb.max[0] - cb.min[0], 0.5, thin === 2 ? 2.4 : cb.max[2] - cb.min[2]);
      }
      b.glow.position.copy(b.lamp.position);
      const blink = open ? 1 : 0.55 + 0.45 * Math.sin(time * 6);
      (b.glow.material as THREE.SpriteMaterial).opacity = blink;
    }
    // 警告灯の明滅
    for (const l of this.lamps) {
      if (!l.sprite) continue;
      const m = l.sprite.material as THREE.SpriteMaterial;
      m.opacity = l.kind === 'warning' ? 0.35 + 0.55 * Math.max(0, Math.sin(time * 3 + l.phase)) : 0.6;
    }
    // 近傍の照明6個に点光源を割り当て
    const near = this.lamps
      .map((l) => ({ l, d: l.pos.distanceToSquared(playerPos) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.pointLights.length);
    this.pointLights.forEach((pl, i) => {
      const n = near[i];
      if (!n) {
        pl.intensity = 0;
        return;
      }
      pl.position.copy(n.l.pos);
      pl.color.setHex(n.l.color);
      pl.distance = n.l.kind === 'skylight' ? 60 : 30;
      pl.intensity = n.l.kind === 'skylight' ? 900 : n.l.kind === 'warning' ? 120 * (0.4 + 0.6 * Math.max(0, Math.sin(time * 3 + n.l.phase))) : 160;
    });
  }
}
