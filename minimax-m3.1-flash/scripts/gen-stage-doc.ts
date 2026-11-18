/**
 * Generates the stage documentation tables (markdown) from the stage data so
 * that README and code never drift apart.
 * Run: node scripts/gen-stage-doc.mjs  (writes /tmp/opencode/stage-doc.md)
 */
import { ZONES, LINKS, BARRIERS, ENEMY_SPAWNS, ZONE_BY_ID, CLEAR_POINT, PLAYER_START } from '../src/game/stage.ts';

const out = [];
out.push('### Zones\n');
out.push('| id | name | kind | X range (m) | Z range (m) | floor Y (m) | clear height (m) |');
out.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const z of ZONES) {
  const levels = z.levels.map((l) => l.y).join('/');
  const heights = z.levels.map((l) => l.h).join('/');
  out.push(
    `| \`${z.id}\` | ${z.name} | ${z.kind} | ${z.x0} – ${z.x1} | ${z.z0} – ${z.z1} | ${levels} | ${heights} |`
  );
}

out.push('\n### Connections (doors)\n');
out.push('| # | zone A | zone B | shared wall | opening (centre) | width | barrier |');
out.push('| --- | --- | --- | --- | --- | --- | --- |');
LINKS.forEach((l, i) => {
  const a = ZONE_BY_ID.get(l.a);
  const b = ZONE_BY_ID.get(l.b);
  let desc = '';
  let width = '';
  if (Math.abs(a.x1 - b.x0) < 0.01 || Math.abs(b.x1 - a.x0) < 0.01) {
    const at = Math.abs(a.x1 - b.x0) < 0.01 ? a.x1 : b.x0;
    const lo = Math.max(a.z0, b.z0);
    const hi = Math.min(a.z1, b.z1);
    desc = `x = ${at}`;
    width = `${Math.min(hi - lo, 26).toFixed(0)} m`;
  } else {
    const at = Math.abs(a.z1 - b.z0) < 0.01 ? a.z1 : b.z0;
    const lo = Math.max(a.x0, b.x0);
    const hi = Math.min(a.x1, b.x1);
    desc = `z = ${at}`;
    width = `${Math.min(hi - lo, 26).toFixed(0)} m`;
  }
  const barrier = l.barrier ? `**${l.barrier}**` : l.finalGate ? 'final gate' : '';
  out.push(`| ${i + 1} | \`${l.a}\` | \`${l.b}\` | ${desc} | ${width} | ${width} | ${barrier} |`);
});

out.push('\n### Barrier doors and their control turrets\n');
out.push('| barrier | door | control turret | turret sector |');
out.push('| --- | --- | --- | --- |');
for (const b of BARRIERS) {
  const link = LINKS.find((l) => l.barrier === b.id)!;
  const turret = ENEMY_SPAWNS.find((e) => e.id === b.controlEnemyId)!;
  out.push(`| ${b.id} | \`${link.a}\` ↔ \`${link.b}\` | ${b.controlEnemyId} | \`${turret.zone}\` |`);
}

out.push('\n### Hostiles\n');
out.push('| id | kind | sector | X | Z | control turret |');
out.push('| --- | --- | --- | --- | --- | --- |');
for (const e of ENEMY_SPAWNS) {
  out.push(
    `| ${e.id} | ${e.kind} | \`${e.zone}\` | ${e.x} | ${e.z} | ${e.control ? 'yes' : ''} |`
  );
}
out.push(
  `\nTotals: ${ENEMY_SPAWNS.filter((e) => e.kind === 'guard').length} guards, ${
    ENEMY_SPAWNS.filter((e) => e.kind === 'turret').length
  } turrets (${BARRIERS.length} of them gate controls).`
);
out.push(`\nPlayer start: \`${PLAYER_START.zone}\` (${PLAYER_START.x}, ${PLAYER_START.z}), yaw ${PLAYER_START.yaw}.`);
out.push(`Evacuation trigger: \`${CLEAR_POINT.zone}\` (${CLEAR_POINT.x}, ${CLEAR_POINT.z}), tier y = 24.`);

console.log(out.join('\n'));
