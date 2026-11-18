/**
 * Campaign stage entry point. OWNER: stage agents.
 * 区画の殻・portal開口・隔壁は StageBuilder が blueprint から自動で作り、各区画の内部は sectors/Sxx.ts の build(kit) が作る。
 * 敵IDは区画順(S01→S20)に G01.. / T01.. と自動採番される。
 */
import type { StageDef } from '../sim/types';
import { SECTORS } from './blueprint';
import { StageBuilder } from './kit';
import type { Kit } from './kit';
import { build as S01 } from './sectors/S01';
import { build as S02 } from './sectors/S02';
import { build as S03 } from './sectors/S03';
import { build as S04 } from './sectors/S04';
import { build as S05 } from './sectors/S05';
import { build as S06 } from './sectors/S06';
import { build as S07 } from './sectors/S07';
import { build as S08 } from './sectors/S08';
import { build as S09 } from './sectors/S09';
import { build as S10 } from './sectors/S10';
import { build as S11 } from './sectors/S11';
import { build as S12 } from './sectors/S12';
import { build as S13 } from './sectors/S13';
import { build as S14 } from './sectors/S14';
import { build as S15 } from './sectors/S15';
import { build as S16 } from './sectors/S16';
import { build as S17 } from './sectors/S17';
import { build as S18 } from './sectors/S18';
import { build as S19 } from './sectors/S19';
import { build as S20 } from './sectors/S20';

export const SECTOR_BUILDERS: Record<string, (kit: Kit) => void> = {
  S01, S02, S03, S04, S05, S06, S07, S08, S09, S10, S11, S12, S13, S14, S15, S16, S17, S18, S19, S20,
};

export function buildStage(): StageDef {
  const sb = new StageBuilder();
  for (const s of SECTORS) {
    const build = SECTOR_BUILDERS[s.id];
    if (!build) throw new Error(`no builder for sector ${s.id}`);
    sb.buildSector(s.id, build);
  }
  return sb.finish();
}
