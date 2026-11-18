/**
 * Stage map exporter (designer's review tool): renders plan views of the factory to stand-alone SVG/HTML.
 *
 *   npx tsx tools/stageMap.ts <outDir> [--json <validator.json>]
 *
 * With --json (a report written by `npx tsx tools/validateStage.ts --json <file>`) the measured routes are
 * drawn as well: the path the walkthrough bot really travelled (V14, cyan) and the explicit shortest
 * free-flight route (V3, magenta).
 *
 * Writes
 *   plan.html            whole facility seen from above with the roofs removed (solids painted low → high)
 *   band_<lo>_<hi>.html  only the solids whose top lies inside an altitude band (stacked floors)
 *   sector_<id>.html     one zoomed view per sector
 *   profile.html         altitude of the recommended route against the distance walked
 * Overlays: sector bounds + ids, barriers / final gate, enemies (guard ●, turret ■, control turret ◆),
 * player start, exit zone, recommended route, flight spots (from → to), branch and loop waypoints.
 * Must not import three.js.
 */
import type { Box, SolidDef, StageDef } from '../src/sim/types';
import { getFactoryStage } from '../src/stage/factory';

declare const process: { argv: string[] };

const COLORS: Record<string, string> = {
  floor: '#3b4048',
  wall: '#15171a',
  roof: '#000000',
  concrete: '#6d7278',
  metal: '#7f8ea0',
  rust: '#9a5b3c',
  hazard: '#e2b714',
  catwalk: '#4f7f86',
  machine: '#56708f',
  container: '#3f8f5a',
  pipe: '#8a7fa8',
  dark: '#050505',
};

/** Measured polylines taken from a validator report (optional). */
interface Measured {
  walked: number[][];
  shortest: number[][];
}
let measured: Measured | null = null;

interface View {
  title: string;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  scale: number;
  /** Only solids whose top is inside [lo, hi] are drawn (default: everything except roofs). */
  band?: [number, number];
}

function render(stage: StageDef, v: View): string {
  const W = (v.x1 - v.x0) * v.scale;
  const H = (v.z1 - v.z0) * v.scale;
  const px = (x: number): string => ((x - v.x0) * v.scale).toFixed(1);
  // z grows upwards on the sheet (north up).
  const pz = (z: number): string => ((v.z1 - z) * v.scale).toFixed(1);
  const rect = (b: Box, attrs: string): string =>
    `<rect x="${px(b.min.x)}" y="${pz(b.max.z)}" width="${((b.max.x - b.min.x) * v.scale).toFixed(1)}" height="${((b.max.z - b.min.z) * v.scale).toFixed(1)}" ${attrs}/>`;
  const inView = (b: Box): boolean => b.max.x > v.x0 && b.min.x < v.x1 && b.max.z > v.z0 && b.min.z < v.z1;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" font-family="sans-serif">`);
  out.push(`<rect width="100%" height="100%" fill="#0b0c0e"/>`);
  const solids: SolidDef[] = stage.solids
    .filter((s) => s.material !== 'roof' && s.tag !== 'roof' && inView(s))
    .filter((s) => !v.band || (s.max.y >= v.band[0] && s.max.y <= v.band[1]))
    .sort((a, b) => a.max.y - b.max.y);
  for (const s of solids) {
    const isWall = s.material === 'wall' || s.tag === 'gatehouse-wall';
    out.push(rect(s, `fill="${COLORS[s.material] ?? '#888'}" stroke="#000" stroke-width="0.4" opacity="${isWall ? 1 : 0.93}"><title>${s.sectorId ?? ''} ${s.tag ?? s.material} y ${s.min.y}..${s.max.y}</title></rect>`.replace('/>', '')));
  }
  // Tops of non-structural solids: print the height when zoomed in.
  if (v.scale >= 5) {
    for (const s of solids) {
      if (s.material === 'wall' || s.material === 'floor' || s.tag === 'floor-patch') continue;
      const w = (s.max.x - s.min.x) * v.scale;
      const h = (s.max.z - s.min.z) * v.scale;
      if (w < 22 || h < 10) continue;
      out.push(`<text x="${px((s.min.x + s.max.x) / 2)}" y="${(Number(pz((s.min.z + s.max.z) / 2)) + 3).toFixed(1)}" font-size="8" fill="#fff" text-anchor="middle" opacity="0.8">${s.max.y}</text>`);
    }
  }
  for (const s of stage.sectors) {
    for (const b of s.bounds) if (inView(b)) out.push(rect(b, `fill="none" stroke="#4fc3f7" stroke-width="1" stroke-dasharray="6 4" opacity="0.7"`));
    const b = s.bounds[0];
    if (inView(b)) {
      out.push(`<text x="${(Number(px(b.min.x)) + 6).toFixed(1)}" y="${(Number(pz(b.max.z)) + 16).toFixed(1)}" font-size="13" fill="#4fc3f7" font-weight="bold">${s.id} ${s.name}${s.combatArena ? ' ★' : ''}</text>`);
    }
  }
  out.push(rect(stage.exitZone, `fill="#00e676" opacity="0.35" stroke="#00e676"`));
  for (const b of stage.barriers) {
    out.push(rect(b.box, `fill="#ff1744" stroke="#fff" stroke-width="1"`));
    out.push(`<text x="${px(b.box.max.x + 1)}" y="${pz(b.box.max.z + 1)}" font-size="12" fill="#ff8a80" font-weight="bold">${b.id}</text>`);
  }
  out.push(rect(stage.finalGate.box, `fill="#ff9100" stroke="#fff" stroke-width="1"`));
  for (const f of stage.flightSpots) {
    out.push(rect(f.cut, `fill="#2979ff" opacity="0.25" stroke="#2979ff" stroke-width="0.6"`));
    out.push(`<line x1="${px(f.from.x)}" y1="${pz(f.from.z)}" x2="${px(f.to.x)}" y2="${pz(f.to.z)}" stroke="#82b1ff" stroke-width="2.5"/>`);
    out.push(`<circle cx="${px(f.to.x)}" cy="${pz(f.to.z)}" r="4" fill="#82b1ff"/>`);
    out.push(`<text x="${px(f.from.x)}" y="${(Number(pz(f.from.z)) - 6).toFixed(1)}" font-size="12" fill="#82b1ff" font-weight="bold">${f.id} +${f.height}</text>`);
  }
  if (measured) {
    const line = (p: number[][], color: string, width: number): void => {
      if (p.length > 1) out.push(`<polyline points="${p.map((q) => `${px(q[0])},${pz(q[2])}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" opacity="0.85"/>`);
    };
    line(measured.shortest, '#ff4dd2', 1.2);
    line(measured.walked, '#18ffff', 1.6);
  }
  const pts = stage.route.map((w) => `${px(w.position.x)},${pz(w.position.z)}`).join(' ');
  out.push(`<polyline points="${pts}" fill="none" stroke="#ffffff" stroke-width="1.4" stroke-dasharray="3 3" opacity="0.9"/>`);
  for (const br of stage.branches) {
    for (const [p, c] of [[br.viaA, '#ffd54f'], [br.viaB, '#ce93d8']] as const) {
      out.push(`<circle cx="${px(p.x)}" cy="${pz(p.z)}" r="5" fill="none" stroke="${c}" stroke-width="2"/>`);
    }
    out.push(`<text x="${px(br.viaA.x + 2)}" y="${pz(br.viaA.z)}" font-size="10" fill="#ffd54f">${br.id}a</text>`);
    out.push(`<text x="${px(br.viaB.x + 2)}" y="${pz(br.viaB.z)}" font-size="10" fill="#ce93d8">${br.id}b</text>`);
  }
  for (const lp of stage.loops) {
    const p = lp.points.map((q) => `${px(q.x)},${pz(q.z)}`).join(' ');
    out.push(`<polygon points="${p}" fill="none" stroke="#69f0ae" stroke-width="1.2" stroke-dasharray="8 3"/>`);
    out.push(`<text x="${px(lp.points[0].x + 2)}" y="${(Number(pz(lp.points[0].z)) + 12).toFixed(1)}" font-size="10" fill="#69f0ae">${lp.id}</text>`);
  }
  for (const e of stage.enemies) {
    const x = Number(px(e.position.x));
    const y = Number(pz(e.position.z));
    if (x < 0 || y < 0 || x > W || y > H) continue;
    if (v.band && (e.position.y < v.band[0] || e.position.y > v.band[1] + 3.2)) continue;
    if (e.kind === 'guard') out.push(`<circle cx="${x}" cy="${y}" r="4" fill="#ff5252" stroke="#fff" stroke-width="0.8"/>`);
    else if (e.isGateControl) out.push(`<rect x="${x - 6}" y="${y - 6}" width="12" height="12" transform="rotate(45 ${x} ${y})" fill="#e040fb" stroke="#fff" stroke-width="1.2"/>`);
    else out.push(`<rect x="${x - 4}" y="${y - 4}" width="8" height="8" fill="#ffab40" stroke="#fff" stroke-width="0.8"/>`);
    out.push(`<text x="${x + 7}" y="${y + 4}" font-size="${v.scale >= 5 ? 11 : 9}" fill="#fff">${e.id}${v.scale >= 5 ? ' y' + e.position.y.toFixed(1) : ''}</text>`);
  }
  const s = stage.playerStart;
  const sx = Number(px(s.position.x));
  const sy = Number(pz(s.position.z));
  out.push(`<circle cx="${sx}" cy="${sy}" r="6" fill="#00e5ff" stroke="#fff"/>`);
  out.push(`<line x1="${sx}" y1="${sy}" x2="${(sx - Math.sin(s.yaw) * 60 * v.scale).toFixed(1)}" y2="${(sy + Math.cos(s.yaw) * 60 * v.scale).toFixed(1)}" stroke="#00e5ff" stroke-width="1" stroke-dasharray="2 3"/>`);
  out.push(`<text x="10" y="${(H - 10).toFixed(0)}" font-size="13" fill="#ddd">${v.title} — x ${v.x0}..${v.x1}, z ${v.z0}..${v.z1}, ${v.scale} px/m — ● guard ■ turret ◆ control turret, red = barrier, blue = flight cut${measured ? ', cyan = walked path (V14), magenta = shortest free-flight route (V3)' : ''}</text>`);
  out.push('</svg>');
  return out.join('\n');
}

function profile(stage: StageDef): string {
  const W = 1500;
  const H = 420;
  let d = 0;
  const pts: Array<[number, number, string]> = [];
  stage.route.forEach((w, i) => {
    if (i > 0) {
      const p = stage.route[i - 1].position;
      d += Math.hypot(w.position.x - p.x, w.position.y - p.y, w.position.z - p.z);
    }
    pts.push([d, w.position.y - 2, w.sectorId]);
  });
  const sx = (W - 80) / d;
  const y = (h: number): number => H - 40 - (h + 15) * 5;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif"><rect width="100%" height="100%" fill="#0b0c0e"/>`];
  for (const h of [-12, 0, 10, 16, 22, 28, 34, 40, 46]) {
    out.push(`<line x1="40" x2="${W - 20}" y1="${y(h)}" y2="${y(h)}" stroke="#333"/><text x="4" y="${y(h) + 4}" font-size="11" fill="#999">${h} m</text>`);
  }
  out.push(`<polyline fill="none" stroke="#fff" stroke-width="2" points="${pts.map((p) => `${(40 + p[0] * sx).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')}"/>`);
  let last = '';
  for (const p of pts) {
    if (p[2] === last) continue;
    last = p[2];
    out.push(`<text x="${(40 + p[0] * sx).toFixed(1)}" y="${(y(p[1]) - 8).toFixed(1)}" font-size="11" fill="#4fc3f7">${p[2]}</text>`);
  }
  out.push(`<text x="40" y="${H - 8}" font-size="13" fill="#ddd">recommended route: floor altitude vs. distance along the waypoints (total ${d.toFixed(0)} m)</text></svg>`);
  return out.join('\n');
}

async function main(): Promise<void> {
  const fsName: string = 'node:fs';
  const fs = await import(fsName);
  const args = process.argv.slice(2);
  const ji = args.indexOf('--json');
  const jsonFile = ji >= 0 ? args[ji + 1] : undefined;
  const outDir = args.find((a, i) => a !== '--json' && (ji < 0 || i !== ji + 1)) ?? '.';
  fs.mkdirSync(outDir, { recursive: true });
  const stage = getFactoryStage();
  if (jsonFile) {
    const rep = JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as { checks: Array<{ id: string; data: Record<string, unknown> }> };
    const v3 = rep.checks.find((c) => c.id === 'V3')?.data ?? {};
    const v14 = rep.checks.find((c) => c.id === 'V14')?.data ?? {};
    const runs = (v14.runs ?? []) as Array<{ path?: number[][] }>;
    measured = { walked: runs[0]?.path ?? [], shortest: (v3.feasibleRoute ?? []) as number[][] };
  }
  const page = (svg: string): string => `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0b0c0e">${svg}</body>`;
  const b = stage.bounds;
  const write = (name: string, svg: string): void => fs.writeFileSync(`${outDir}/${name}.html`, page(svg));
  write('plan', render(stage, { title: `${stage.name} plan`, x0: b.min.x, x1: b.max.x, z0: b.min.z, z1: b.max.z, scale: 3 }));
  for (const [lo, hi] of [[-13, -1.5], [-1.5, 9.5], [9.5, 21.5], [21.5, 33.5], [33.5, 47]] as const) {
    write(`band_${lo}_${hi}`, render(stage, { title: `tops ${lo}..${hi} m`, x0: b.min.x, x1: b.max.x, z0: b.min.z, z1: b.max.z, scale: 3, band: [lo, hi] }));
  }
  for (const s of stage.sectors) {
    const sb = s.bounds[0];
    const scale = Math.min(12, Math.floor(Math.min(1500 / (sb.max.x - sb.min.x + 8), 1100 / (sb.max.z - sb.min.z + 8))));
    write(`sector_${s.id}`, render(stage, { title: `${s.id} ${s.name} (${s.nameEn})`, x0: sb.min.x - 4, x1: sb.max.x + 4, z0: sb.min.z - 4, z1: sb.max.z + 4, scale }));
  }
  write('profile', profile(stage));
  console.log(`stage maps written to ${outDir} (plan, 5 bands, ${stage.sectors.length} sectors, profile)`);
}

void main();
