/**
 * AK2 本編ステージ「廃工場 コアラ重工 第3工場」の定義。
 * 設計記録は docs/STAGE.md、検証は src/stage/verify.ts（tests/stage.test.ts から実行）。
 *
 * 座標系: 1 単位 = 1 m、Y 上。X 東、Z 南。3 層（地下 −14 m、地上 0 m、上層 +14 m）。
 * 4 列の蛇行配置:
 *   列A（z 0〜90, 地上 0）  搬入口 → 資材ヤード → 圧延棟 → 搬送縦坑（降下）
 *   列B（z 101〜201, 地下 −14） 地下搬送区画 → 動力棟 → 冷却設備 → 排気縦坑（2 段上昇）
 *   列C（z 213〜313, 上層 +14） 保守用配管区画 → 組立ライン（降下・再上昇）→ 検査棟（降下）
 *   列D（z 314〜414, 地上 0）  主製造ホール → 出荷倉庫 → 搬出ゲート → 搬出ヤード（脱出）
 * 飛行必須箇所は全て「壊れた昇降ダクト」（底の入口から入り頂上の扉へ出る縦穴）で、
 * 歩行・ジャンプでは上がれない。
 */
import { PLAYER } from '../params';
import type { AABB, BarrierDef, BranchDef, EnemyDef, FlightPointDef, LightDef, LoopDef, RouteWaypoint, SectorDef, SectorKind, StageData, Vec3 } from '../types';
import { StageBuilder, aabb, doorX, doorZ, grow, type RoomSpec } from './builders';

// ---------------------------------------------------------------------------
// 区画（部屋）の内側範囲
// ---------------------------------------------------------------------------

interface RoomDef extends RoomSpec {
  name: string;
  kind: SectorKind;
  description: string;
}

const R: Record<string, RoomDef> = {
  S01: { id: 'S01', name: '搬入口', kind: 'gate', x0: 0, x1: 40, z0: 30, z1: 70, floorY: 0, height: 12, description: '開始地点。遮蔽壁で L 字に折れた搬入前室', floor: 'floorPlate' },
  S02: { id: 'S02', name: '資材ヤード', kind: 'yard', x0: 41, x1: 171, z0: 0, z1: 90, floorY: 0, height: 24, description: '木箱とコンテナが散在する屋根付きヤード', floor: 'concrete' },
  S03: { id: 'S03', name: '圧延棟', kind: 'factory', x0: 172, x1: 302, z0: 0, z1: 90, floorY: 0, height: 20, description: '圧延機と搬送台。北東に制御室 T-02', floor: 'floorPlate' },
  S16: { id: 'S16', name: '南側搬送路', kind: 'corridor', x0: 120, x1: 290, z0: 91, z1: 99, floorY: 0, height: 8, description: '資材ヤードと圧延棟を南から結ぶ柱付き搬送路（分岐の遮蔽経路）', floor: 'grate' },
  // 隣室と共有する壁（S03/S04, S07/S08, S09/S10）は wallMaterials で同じ材質にし、resolveOverlaps() で重なりを差し引く
  S04: { id: 'S04', name: '搬送縦坑', kind: 'shaft', x0: 303, x1: 333, z0: 50, z1: 100, floorY: -14, height: 30, description: '+8 m の入口足場から −14 m の坑底へ降りる搬送縦坑', floor: 'concreteDark', wall: 'concreteDark', wallMaterials: { w: 'brick' } },
  S05: { id: 'S05', name: '地下搬送区画', kind: 'corridor', x0: 190, x1: 333, z0: 101, z1: 131, floorY: -14, height: 10, description: '地下のコンベア搬送トンネル', floor: 'concreteDark', wall: 'concreteDark' },
  S17: { id: 'S17', name: '地下保守通路', kind: 'piping', x0: 40, x1: 300, z0: 80, z1: 100, floorY: -14, height: 8, description: '配管の並ぶ細い保守通路（分岐の迂回経路）', floor: 'grate', wall: 'concreteDark' },
  S06: { id: 'S06', name: '動力棟', kind: 'power', x0: 40, x1: 189, z0: 101, z1: 201, floorY: -14, height: 20, description: '発電機が並ぶ地下の動力棟。西に制御室 T-05', floor: 'floorPlate', wall: 'concreteDark' },
  S07: { id: 'S07', name: '冷却設備', kind: 'power', x0: 190, x1: 302, z0: 132, z1: 201, floorY: -14, height: 20, description: '冷却塔と配管。南東に制御室 T-07', floor: 'concreteDark', wall: 'concreteDark' },
  S08: { id: 'S08', name: '排気縦坑', kind: 'shaft', x0: 303, x1: 333, z0: 132, z1: 212, floorY: -4, height: 30, description: '3 段のファン室を昇降ダクトで登る排気縦坑', floor: 'grate', wall: 'steelDark', wallMaterials: { w: 'concreteDark' } },
  S09: { id: 'S09', name: '保守用配管区画', kind: 'piping', x0: 190, x1: 333, z0: 213, z1: 253, floorY: 14, height: 12, description: '上層の配管回廊', floor: 'grate', wall: 'steelDark' },
  S10: { id: 'S10', name: '組立ライン', kind: 'multilevel', x0: 60, x1: 189, z0: 213, z1: 313, floorY: 0, height: 30, description: '上層デッキ（+14）と下層の組立ライン（0）。デッキ下南東に制御室 T-09', floor: 'floorPlate', wallMaterials: { e: 'steelDark' } },
  S11: { id: 'S11', name: '検査棟', kind: 'multilevel', x0: 0, x1: 59, z0: 213, z1: 313, floorY: 0, height: 26, description: '検査デッキ（+10）と地上階。デッキ南端が崩落している', floor: 'concrete' },
  S18: { id: 'S18', name: '外周搬送路', kind: 'corridor', x0: -30, x1: -1, z0: 250, z1: 380, floorY: 0, height: 8, description: '検査棟と主製造ホールを西外周で結ぶ搬送路（分岐の遮蔽経路）', floor: 'grate' },
  S12: { id: 'S12', name: '主製造ホール', kind: 'factory', x0: 0, x1: 130, z0: 314, z1: 414, floorY: 0, height: 26, description: 'プレス機の並ぶ主製造ホール。南西に制御室 T-12', floor: 'floorPlate' },
  S13: { id: 'S13', name: '出荷倉庫', kind: 'warehouse', x0: 131, x1: 261, z0: 314, z1: 414, floorY: 0, height: 24, description: 'コンテナ積みの出荷倉庫。北東に制御室 T-14', floor: 'concrete' },
  S14: { id: 'S14', name: '搬出ゲート', kind: 'gate', x0: 262, x1: 302, z0: 370, z1: 414, floorY: 8, height: 12, description: '最終ゲート前室', floor: 'floorPlate' },
  S15: { id: 'S15', name: '搬出ヤード', kind: 'yard', x0: 303, x1: 343, z0: 370, z1: 414, floorY: 8, height: 12, description: 'ゲートの先の脱出領域', floor: 'concrete' },
};

const ROOM_ORDER = ['S01', 'S02', 'S03', 'S16', 'S04', 'S05', 'S17', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S18', 'S12', 'S13', 'S14', 'S15'];

const b = new StageBuilder();

for (const id of ROOM_ORDER) b.room(R[id]);

// ---------------------------------------------------------------------------
// 扉（壁の切り抜き）
// ---------------------------------------------------------------------------
const DOOR_H = 6;
const door = (box: AABB): AABB => {
  b.carve(box);
  return box;
};

// 列A
door(doorX(40, 41, 46, 54, 0, DOOR_H)); // S01 → S02
door(doorX(171, 172, 8, 16, 0, DOOR_H)); // S02 → S03
door(doorZ(90, 91, 150, 158, 0, DOOR_H)); // S02 → S16
door(doorZ(90, 91, 270, 278, 0, DOOR_H)); // S16 → S03
door(doorZ(100, 101, 316, 324, -14, -14 + DOOR_H)); // S04 → S05
// 列B
door(doorX(189, 190, 108, 116, -14, -14 + DOOR_H)); // S05 → S06（西扉）
door(doorZ(100, 101, 200, 208, -14, -14 + DOOR_H)); // S05 → S17
door(doorZ(100, 101, 60, 68, -14, -14 + DOOR_H)); // S17 → S06（北扉）
const B2_BOX = door(doorX(189, 190, 180, 188, -14, -14 + DOOR_H)); // S06 → S07（隔壁 B-02）
// 列C
door(doorZ(212, 213, 312, 320, 14, 14 + DOOR_H)); // S08 → S09
door(doorX(189, 190, 220, 228, 14, 14 + DOOR_H)); // S09 → S10（上層デッキ）
door(doorZ(313, 314, 20, 28, 0, DOOR_H)); // S11 → S12
door(doorX(-1, 0, 260, 268, 0, DOOR_H)); // S11 → S18
door(doorX(-1, 0, 360, 368, 0, DOOR_H)); // S18 → S12
// 最終ゲート
const GATE_BOX = door(doorX(302, 303, 384, 396, 8, 16)); // S14 → S15

// ---------------------------------------------------------------------------
// 区画内の構造（足場・デッキ・制御室・昇降ダクト）
// ---------------------------------------------------------------------------

// S01: 遮蔽壁（開始地点を扉から隠す）
b.box(20, 0, 30, 21, 12, 56, 'concrete', 'S01', 'S01:baffle');

// S03: 制御室 T-02（北東角、開口は西向き z 12〜30）
b.box(276, 0, 0, 277, 20, 12, 'steelDark', 'S03', 'S03:ctrlW');
b.box(276, 0, 30, 302, 20, 31, 'steelDark', 'S03', 'S03:ctrlS');
// S03: 圧延機（西扉から制御室への射線を遮る）
b.box(220, 0, 4, 232, 7, 40, 'machine', 'S03', 'S03:mill');
b.box(232, 3, 8, 236, 6, 36, 'machineDark', 'S03', 'S03:millSide');
// S03: 搬送台
b.box(180, 0, 60, 216, 1.2, 64, 'steel', 'S03', 'S03:conveyor1');
b.box(180, 0, 76, 216, 1.2, 80, 'steel', 'S03', 'S03:conveyor2');
// 昇降ダクト D1（S03 → S04、隔壁 B-01）
const D1 = b.duct({ id: 'D1', sectorId: 'S03', x0: 294, x1: 302, z0: 64, z1: 76, bottomY: 0, topY: 8, entrySide: 'w', entryA0: 66, entryA1: 74, exitSide: 'e', exitA0: 66, exitA1: 74, exitIsRoomWall: true });

// S04: 入口足場（+8）と坑底の壊れた昇降機
b.box(303, 7, 60, 315, 8, 80, 'catwalk', 'S04', 'S04:ledge');
b.box(303, -14, 60, 305, 7, 62, 'steelDark', 'S04', 'S04:ledgePost1');
b.box(303, -14, 78, 305, 7, 80, 'steelDark', 'S04', 'S04:ledgePost2');
b.box(318, -14, 52, 330, -10, 58, 'rust', 'S04', 'S04:brokenLift');
b.box(303, -14, 92, 311, -8, 100, 'machineDark', 'S04', 'S04:winch');

// S05: コンベア（中央、低い）
b.box(200, -14, 114, 300, -12.8, 118, 'steel', 'S05', 'S05:conveyor');
b.box(230, -14, 104, 238, -8, 110, 'machine', 'S05', 'S05:motor1');
b.box(270, -14, 122, 278, -8, 128, 'machine', 'S05', 'S05:motor2');

// S16: 遮蔽柱
for (let x = 140; x <= 260; x += 24) b.box(x, 0, 94, x + 2, 8, 96, 'concrete', 'S16', `S16:pillar${x}`);

// S17: 配管（壁沿い、低い）
b.box(44, -14, 82, 296, -12, 84, 'pipeRust', 'S17', 'S17:pipeRun');

// S06: 制御室 T-05（西側、開口は南向き z=164 x 40〜70）
b.box(40, -14, 136, 71, 6, 137, 'steelDark', 'S06', 'S06:ctrlN');
b.box(70, -14, 137, 71, 6, 164, 'steelDark', 'S06', 'S06:ctrlE');
// S06: 発電機群（東側）
b.box(150, -14, 110, 170, -6, 130, 'machine', 'S06', 'S06:gen1');
b.box(150, -14, 150, 170, -6, 170, 'machine', 'S06', 'S06:gen2');
b.box(100, -14, 196, 140, -10, 200, 'pipeRust', 'S06', 'S06:pipeS');

// S07: 冷却塔（西側）と制御室 T-07（南東、開口は北向き z=176 x 294〜302）
b.box(196, -14, 140, 208, 2, 152, 'machineDark', 'S07', 'S07:tower1');
b.box(196, -14, 180, 208, 2, 192, 'machineDark', 'S07', 'S07:tower2');
b.box(280, -14, 176, 281, 6, 201, 'steelDark', 'S07', 'S07:ctrlW');
b.box(280, -14, 176, 294, 6, 177, 'steelDark', 'S07', 'S07:ctrlN');
b.box(214, -14, 196, 276, -12, 200, 'pipe', 'S07', 'S07:pipeS');
// 昇降ダクト D2（S07 → S08、隔壁 B-03）
const D2 = b.duct({ id: 'D2', sectorId: 'S07', x0: 294, x1: 302, z0: 138, z1: 150, bottomY: -14, topY: -4, entrySide: 'w', entryA0: 140, entryA1: 148, exitSide: 'e', exitA0: 140, exitA1: 148, exitIsRoomWall: true });

// S08: 3 段のファン室（中間スラブ 2 枚）と昇降ダクト D3, D4
b.box(302, 5, 131, 334, 6, 213, 'grate', 'S08', 'S08:slab1');
b.box(302, 13, 131, 334, 14, 213, 'grate', 'S08', 'S08:slab2');
b.box(310, -4, 190, 326, -2, 206, 'machineDark', 'S08', 'S08:fanBase');
const D3 = b.duct({ id: 'D3', sectorId: 'S08', x0: 325, x1: 333, z0: 156, z1: 168, bottomY: -4, topY: 6, entrySide: 'n', entryA0: 326, entryA1: 332, exitSide: 's', exitA0: 326, exitA1: 332 });
const D4 = b.duct({ id: 'D4', sectorId: 'S08', x0: 303, x1: 311, z0: 184, z1: 196, bottomY: 6, topY: 14, entrySide: 'n', entryA0: 304, entryA1: 310, exitSide: 's', exitA0: 304, exitA1: 310 });

// S09: 配管（天井付近の太い配管と床の低い配管）
b.box(196, 22, 216, 328, 24, 218, 'pipeRust', 'S09', 'S09:pipeTop1');
b.box(196, 22, 248, 328, 24, 250, 'pipeRust', 'S09', 'S09:pipeTop2');
b.box(240, 14, 216, 244, 18, 236, 'pipe', 'S09', 'S09:pipeDown1');
b.box(280, 14, 230, 284, 18, 250, 'pipe', 'S09', 'S09:pipeDown2');

// S10: 上層デッキ（+14）、制御室 T-09（デッキ下南東、開口は北向き z=280 x 180〜189）、組立ライン
b.box(130, 13, 213, 189, 14, 313, 'catwalk', 'S10', 'S10:deck');
b.box(130, 14, 213, 131, 15, 313, 'steel', 'S10', 'S10:deckRail');
b.box(160, 0, 280, 161, 13, 313, 'steelDark', 'S10', 'S10:ctrlW');
b.box(160, 0, 280, 180, 13, 281, 'steelDark', 'S10', 'S10:ctrlN');
b.box(70, 0, 240, 80, 5, 250, 'machine', 'S10', 'S10:robot1');
b.box(70, 0, 270, 80, 5, 280, 'machine', 'S10', 'S10:robot2');
b.box(90, 0, 300, 150, 1.2, 304, 'steel', 'S10', 'S10:line');
b.box(140, 0, 220, 152, 6, 228, 'machineDark', 'S10', 'S10:press');
// 昇降ダクト D5（S10 → S11、隔壁 B-04）
const D5 = b.duct({ id: 'D5', sectorId: 'S10', x0: 60, x1: 68, z0: 218, z1: 230, bottomY: 0, topY: 10, entrySide: 'e', entryA0: 220, entryA1: 228, exitSide: 'w', exitA0: 220, exitA1: 228, exitIsRoomWall: true });

// S11: 検査デッキ（+10、南端崩落）と地上階の検査台
b.box(0, 9, 213, 59, 10, 313, 'catwalk', 'S11', 'S11:deck');
b.carve(aabb(8, 9, 290, 32, 10, 312));
b.box(6, 9, 288, 8, 11, 312, 'rust', 'S11', 'S11:deckRubble1');
b.box(32, 9, 288, 34, 11, 312, 'rust', 'S11', 'S11:deckRubble2');
b.box(10, 0, 292, 14, 2, 296, 'rust', 'S11', 'S11:rubble');
b.box(40, 0, 230, 50, 3, 250, 'machineDark', 'S11', 'S11:bench');

// S18: 遮蔽柱
for (let z = 262; z <= 370; z += 24) b.box(-18, 0, z, -16, 8, z + 2, 'concrete', 'S18', `S18:pillar${z}`);

// S12: 制御室 T-12（南西、開口は北向き z=386 x 20〜30）とプレス機
b.box(30, 0, 386, 31, 26, 414, 'steelDark', 'S12', 'S12:ctrlE');
b.box(0, 0, 386, 20, 26, 387, 'steelDark', 'S12', 'S12:ctrlN');
b.box(40, 0, 330, 52, 8, 342, 'machine', 'S12', 'S12:press1');
b.box(90, 0, 330, 102, 8, 342, 'machine', 'S12', 'S12:press2');
b.box(60, 0, 396, 100, 1.5, 400, 'steel', 'S12', 'S12:table');
// 昇降ダクト D7（S12 → S13、隔壁 B-05）
const D7 = b.duct({ id: 'D7', sectorId: 'S12', x0: 122, x1: 130, z0: 396, z1: 408, bottomY: 0, topY: 10, entrySide: 'w', entryA0: 398, entryA1: 406, exitSide: 'e', exitA0: 398, exitA1: 406, exitIsRoomWall: true });

// S13: 搬入バルコニー（+10）、制御室 T-14（北東、開口は南向き z=336 x 237〜250）、コンテナ
b.box(131, 9, 390, 151, 10, 414, 'catwalk', 'S13', 'S13:balcony');
b.box(151, 9, 390, 152, 11, 414, 'steel', 'S13', 'S13:balconyRail');
b.box(236, 0, 314, 237, 24, 336, 'steelDark', 'S13', 'S13:ctrlW');
b.box(250, 0, 336, 261, 24, 337, 'steelDark', 'S13', 'S13:ctrlS');
b.box(152, 0, 320, 164, 8, 332, 'container', 'S13', 'S13:cont1');
b.box(180, 0, 400, 200, 8, 412, 'container', 'S13', 'S13:cont2');
b.box(210, 0, 396, 222, 4, 408, 'container', 'S13', 'S13:cont3');
b.box(200, 0, 340, 212, 8, 352, 'crate', 'S13', 'S13:cont4');
// 昇降ダクト D6（S13 → S14、隔壁 B-06）
const D6 = b.duct({ id: 'D6', sectorId: 'S13', x0: 253, x1: 261, z0: 380, z1: 392, bottomY: 0, topY: 8, entrySide: 'w', entryA0: 382, entryA1: 390, exitSide: 'e', exitA0: 382, exitA1: 390, exitIsRoomWall: true });

// S02: 木箱・コンテナ（中央 x 70〜150, z 20〜80 は空ける）
b.box(50, 0, 4, 58, 3, 12, 'crate', 'S02', 'S02:crate1');
b.box(64, 0, 2, 76, 5, 10, 'container', 'S02', 'S02:cont1');
b.box(100, 0, 2, 112, 5, 10, 'container', 'S02', 'S02:cont2');
b.box(130, 0, 2, 138, 3, 8, 'crate', 'S02', 'S02:crate2');
b.box(60, 0, 82, 72, 5, 88, 'container', 'S02', 'S02:cont3');
b.box(120, 0, 82, 132, 5, 88, 'container', 'S02', 'S02:cont4');
b.box(160, 0, 40, 168, 3, 48, 'crate', 'S02', 'S02:crate3');
b.box(46, 0, 66, 54, 3, 74, 'crate', 'S02', 'S02:crate4');

// S14: 柱
b.box(270, 8, 376, 272, 20, 378, 'concrete', 'S14', 'S14:pillar1');
b.box(270, 8, 406, 272, 20, 408, 'concrete', 'S14', 'S14:pillar2');

// ---------------------------------------------------------------------------
// 梁・警告灯・標識（衝突あり）
// ---------------------------------------------------------------------------
const girders = (id: string, r: RoomDef, step: number) => {
  const y = r.floorY + r.height - 1;
  for (let x = r.x0 + step; x < r.x1 - 2; x += step) b.box(x, y - 1, r.z0, x + 1, y, r.z1, 'steelDark', id, `${id}:girder${x}`);
};
girders('S02', R.S02, 26);
girders('S03', R.S03, 26);
girders('S06', R.S06, 30);
girders('S10', R.S10, 26);
girders('S12', R.S12, 26);
girders('S13', R.S13, 26);
girders('S07', R.S07, 28);

// 制御砲台の標識（controlSign）: 制御室の壁面上部
b.box(275.8, 8, 6, 276, 10, 10, 'controlSign', 'S03', 'S03:sign'); // 制御室西壁の外面（開口の脇）
b.box(71, -6, 158, 71.2, -4, 162, 'controlSign', 'S06', 'S06:sign'); // 制御室東壁の外面（開口の脇）
b.box(288, -6, 175.8, 292, -4, 176, 'controlSign', 'S07', 'S07:sign'); // 制御室北壁の外面
b.box(174, 8, 279.8, 178, 10, 280, 'controlSign', 'S10', 'S10:sign'); // 制御室北壁の外面（デッキ下）
b.box(14, 8, 385.8, 18, 10, 386, 'controlSign', 'S12', 'S12:sign'); // 制御室北壁の外面
b.box(252, 8, 337, 256, 10, 337.2, 'controlSign', 'S13', 'S13:sign'); // 制御室南壁の外面
// 脱出標識（最終ゲートの上）
b.box(301.8, 16.5, 388, 302, 18, 392, 'exitSign', 'S14', 'S14:exitSign');

// ---------------------------------------------------------------------------
// 装飾（衝突なし）: 警告灯、矢印、区画名、配管シリンダー
// ---------------------------------------------------------------------------
const lampsAlong = (id: string, r: RoomDef, count: number, emissive: number) => {
  const y = r.floorY + Math.min(r.height - 1, 6);
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    b.lamp([r.x0 + (r.x1 - r.x0) * t, y, r.z0 + 0.6], emissive, id);
    b.lamp([r.x0 + (r.x1 - r.x0) * t, y, r.z1 - 0.6], emissive, id);
  }
};
for (const id of ROOM_ORDER) {
  const r = R[id];
  lampsAlong(id, r, Math.max(3, Math.min(8, Math.round((r.x1 - r.x0) / 30))), 0xffb347);
}

// 隔壁付近の矢印（次の目標方向）
b.arrow([290, 1, 70], -Math.PI / 2, 'S03');
b.arrow([180, -13, 184], -Math.PI / 2, 'S06');
b.arrow([290, -13, 144], -Math.PI / 2, 'S07');
b.arrow([72, 1, 224], Math.PI / 2, 'S10');
b.arrow([118, 1, 402], -Math.PI / 2, 'S12');
b.arrow([249, 1, 386], -Math.PI / 2, 'S13');
b.arrow([296, 9, 390], -Math.PI / 2, 'S14');

// 区画名ラベル（入口付近）
for (const id of ROOM_ORDER) {
  const r = R[id];
  b.label([(r.x0 + r.x1) / 2, r.floorY + Math.min(r.height - 1.5, 8), r.z0 + 1], r.name, id);
}

// ---------------------------------------------------------------------------
// 大型配管（衝突あり）: 通行空間や射線に入る大きさの配管は装飾ではなくソリッドにする（見た目＝衝突）。
// 衝突なしの装飾は薄い警告灯・矢印・区画名だけ。
// ---------------------------------------------------------------------------
b.box(80, 1.7, 194.2, 120, 3.3, 195.8, 'pipeRust', 'S06', 'S06:pipeHigh'); // 動力棟 天井下の横配管
b.box(61.4, 25.9, 232, 62.6, 27.1, 312, 'pipe', 'S10', 'S10:pipeHigh'); // 組立ライン 西壁上部の縦通し配管（ダクト D5 の上）
b.box(195, 23, 232, 325, 25, 234, 'pipeRust', 'S09', 'S09:pipeMain'); // 配管区画 天井の主配管（区画内に収める）
b.box(50, -8.1, 89.4, 290, -6.9, 90.6, 'pipeRust', 'S17', 'S17:pipeHigh'); // 地下保守通路 天井下の配管
b.box(248.8, -14, 148.8, 251.2, 4, 151.2, 'pipe', 'S07', 'S07:column'); // 冷却設備 中央の立ち上がり配管（柱として遮蔽になる）
b.box(150, 19.2, 379.2, 250, 20.8, 380.8, 'pipeRust', 'S13', 'S13:pipeHigh'); // 出荷倉庫 天井下の横配管

// ソリッド同士の重なりを解消（共有壁・ダクト壁・梁など）。衝突形状は変わらない
b.resolveOverlaps();

// ---------------------------------------------------------------------------
// 区画定義
// ---------------------------------------------------------------------------
const sectors: SectorDef[] = ROOM_ORDER.map((id) => {
  const r = R[id];
  return {
    id,
    name: r.name,
    kind: r.kind,
    bounds: [grow(aabb(r.x0, r.floorY, r.z0, r.x1, r.floorY + r.height, r.z1), 1)],
    description: r.description,
  };
});

// ---------------------------------------------------------------------------
// 隔壁・ゲート
// ---------------------------------------------------------------------------
const barriers: BarrierDef[] = [
  { id: 'B-01', box: D1.exit, controlTurretId: 't02', fromSectorId: 'S03', toSectorId: 'S04', label: '隔壁 B-01（圧延棟→搬送縦坑）' },
  { id: 'B-02', box: B2_BOX, controlTurretId: 't05', fromSectorId: 'S06', toSectorId: 'S07', label: '隔壁 B-02（動力棟→冷却設備）' },
  { id: 'B-03', box: D2.exit, controlTurretId: 't07', fromSectorId: 'S07', toSectorId: 'S08', label: '隔壁 B-03（冷却設備→排気縦坑）' },
  { id: 'B-04', box: D5.exit, controlTurretId: 't09', fromSectorId: 'S10', toSectorId: 'S11', label: '隔壁 B-04（組立ライン→検査棟）' },
  { id: 'B-05', box: D7.exit, controlTurretId: 't12', fromSectorId: 'S12', toSectorId: 'S13', label: '隔壁 B-05（主製造ホール→出荷倉庫）' },
  { id: 'B-06', box: D6.exit, controlTurretId: 't14', fromSectorId: 'S13', toSectorId: 'S14', label: '隔壁 B-06（出荷倉庫→搬出ゲート）' },
];

// ---------------------------------------------------------------------------
// 敵（警備 30 / 砲台 15、うち制御砲台 6）
// ---------------------------------------------------------------------------
const guard = (id: string, sectorId: string, position: Vec3, yaw = 0, patrol?: Vec3[]): EnemyDef => {
  const e: EnemyDef = { id, kind: 'guard', position, yaw, sectorId, isGateControl: false };
  if (patrol) e.patrol = patrol;
  return e;
};
const turret = (id: string, sectorId: string, position: Vec3, yaw = 0, controlsBarrierId?: string): EnemyDef => {
  const e: EnemyDef = { id, kind: 'turret', position, yaw, sectorId, isGateControl: controlsBarrierId !== undefined };
  if (controlsBarrierId !== undefined) e.controlsBarrierId = controlsBarrierId;
  return e;
};

const enemies: EnemyDef[] = [
  // S02 資材ヤード（交差射線 #1）
  guard('g01', 'S02', [70, 0, 20], Math.PI / 2, [[70, 0, 20], [90, 0, 30]]),
  guard('g02', 'S02', [100, 0, 70], 0, [[100, 0, 70], [120, 0, 60]]),
  guard('g03', 'S02', [140, 0, 40], Math.PI / 2),
  turret('t01', 'S02', [120, 0, 14], Math.PI),
  // S16 南側搬送路
  guard('g04', 'S16', [200, 0, 95], Math.PI / 2),
  // S03 圧延棟（交差射線 #2、制御砲台 T-02）
  guard('g05', 'S03', [190, 0, 50], -Math.PI / 2),
  guard('g06', 'S03', [244, 0, 70], 0),
  guard('g07', 'S03', [260, 0, 46], Math.PI / 2),
  turret('t02', 'S03', [290, 0, 14], Math.PI / 2, 'B-01'),
  turret('t03', 'S03', [246, 0, 84], 0),
  // S04 搬送縦坑
  guard('g08', 'S04', [318, -14, 70], 0),
  // S05 地下搬送区画
  guard('g09', 'S05', [300, -14, 108], Math.PI / 2),
  guard('g10', 'S05', [240, -14, 124], Math.PI / 2),
  turret('t04', 'S05', [212, -14, 126], -Math.PI / 2),
  // S17 地下保守通路
  guard('g11', 'S17', [150, -14, 92], Math.PI / 2),
  // S06 動力棟（交差射線 #3、制御砲台 T-05）
  guard('g12', 'S06', [100, -14, 120], -Math.PI / 2),
  guard('g13', 'S06', [130, -14, 176], -Math.PI / 2),
  guard('g14', 'S06', [84, -14, 188], -Math.PI / 2),
  turret('t05', 'S06', [54, -14, 148], Math.PI, 'B-02'),
  turret('t06', 'S06', [178, -14, 140], Math.PI / 2),
  // S07 冷却設備（制御砲台 T-07）
  guard('g15', 'S07', [224, -14, 150], -Math.PI / 2),
  guard('g16', 'S07', [250, -14, 188], -Math.PI / 2),
  turret('t07', 'S07', [292, -14, 192], 0, 'B-03'),
  // S08 排気縦坑
  guard('g17', 'S08', [318, -4, 150], Math.PI),
  turret('t08', 'S08', [318, 6, 176], 0),
  // S09 保守用配管区画
  guard('g18', 'S09', [300, 14, 236], Math.PI / 2),
  guard('g19', 'S09', [230, 14, 240], Math.PI / 2),
  // S10 組立ライン（交差射線 #4、制御砲台 T-09）
  guard('g20', 'S10', [100, 0, 240], 0),
  guard('g21', 'S10', [110, 0, 290], 0),
  guard('g22', 'S10', [150, 0, 256], -Math.PI / 2),
  turret('t09', 'S10', [181, 0, 302], 0, 'B-04'),
  turret('t10', 'S10', [86, 0, 260], -Math.PI / 2),
  // S11 検査棟
  guard('g23', 'S11', [20, 0, 240], Math.PI),
  guard('g24', 'S11', [40, 0, 270], Math.PI),
  turret('t11', 'S11', [30, 10, 240], Math.PI),
  // S12 主製造ホール（交差射線 #5、制御砲台 T-12）
  guard('g25', 'S12', [60, 0, 350], Math.PI),
  guard('g26', 'S12', [100, 0, 370], Math.PI),
  guard('g27', 'S12', [50, 0, 390], Math.PI / 2),
  turret('t12', 'S12', [10, 0, 402], 0, 'B-05'),
  turret('t13', 'S12', [112, 0, 350], -Math.PI / 2),
  // S18 外周搬送路
  guard('g28', 'S18', [-8, 0, 320], 0),
  // S13 出荷倉庫（交差射線 #6、制御砲台 T-14）
  guard('g29', 'S13', [170, 0, 350], Math.PI / 2),
  guard('g30', 'S13', [200, 0, 380], -Math.PI / 2),
  turret('t14', 'S13', [246, 0, 324], Math.PI, 'B-06'),
  turret('t15', 'S13', [160, 0, 360], Math.PI / 2),
];

// ---------------------------------------------------------------------------
// 正規経路・飛行必須箇所・分岐・環状
// ---------------------------------------------------------------------------
const route: RouteWaypoint[] = [
  { position: [8, 0, 40], sectorId: 'S01', note: '開始' },
  { position: [30, 0, 62], sectorId: 'S01', note: '遮蔽壁を回る' },
  { position: [40.5, 0, 50], sectorId: 'S01', note: '搬入口→資材ヤード' },
  { position: [110, 0, 40], sectorId: 'S02', note: 'ヤード中央' },
  { position: [171.5, 0, 12], sectorId: 'S02', note: '資材ヤード→圧延棟（北扉）' },
  { position: [216, 0, 50], sectorId: 'S03', note: '圧延機の南を回る' },
  { position: [270, 0, 20], sectorId: 'S03', note: '制御室 T-02 の射撃位置' },
  { position: [298, 0, 70], sectorId: 'S03', note: 'ダクト D1 底' },
  { position: [302.5, 8, 70], sectorId: 'S03', note: '隔壁 B-01' },
  { position: [309, 8, 70], sectorId: 'S04', note: '入口足場' },
  { position: [320, -14, 100.5], sectorId: 'S04', note: '坑底→地下搬送区画' },
  { position: [260, -14, 112], sectorId: 'S05', note: 'コンベア沿いに西へ' },
  { position: [189.5, -14, 112], sectorId: 'S05', note: '地下搬送区画→動力棟' },
  { position: [60, -14, 172], sectorId: 'S06', note: '制御室 T-05 の射撃位置' },
  { position: [189.5, -14, 184], sectorId: 'S06', note: '隔壁 B-02' },
  { position: [296, -14, 180], sectorId: 'S07', note: '制御室 T-07 の射撃位置' },
  { position: [298, -14, 144], sectorId: 'S07', note: 'ダクト D2 底' },
  { position: [302.5, -4, 144], sectorId: 'S07', note: '隔壁 B-03' },
  { position: [329, -4, 154], sectorId: 'S08', note: 'ダクト D3 底' },
  { position: [329, 6, 170], sectorId: 'S08', note: '第 2 ファン室' },
  { position: [307, 6, 182], sectorId: 'S08', note: 'ダクト D4 底' },
  { position: [307, 14, 198], sectorId: 'S08', note: '第 3 ファン室' },
  { position: [316, 14, 212.5], sectorId: 'S08', note: '排気縦坑→配管区画' },
  { position: [189.5, 14, 224], sectorId: 'S09', note: '配管区画→組立ライン（デッキ）' },
  { position: [128, 0, 260], sectorId: 'S10', note: 'デッキから下層へ降下' },
  { position: [184, 0, 276], sectorId: 'S10', note: '制御室 T-09 の射撃位置' },
  { position: [70, 0, 224], sectorId: 'S10', note: 'ダクト D5 底' },
  { position: [59.5, 10, 224], sectorId: 'S10', note: '隔壁 B-04' },
  { position: [30, 10, 260], sectorId: 'S11', note: '検査デッキ' },
  { position: [20, 0, 300], sectorId: 'S11', note: '崩落部から地上階へ' },
  { position: [24, 0, 313.5], sectorId: 'S11', note: '検査棟→主製造ホール' },
  { position: [24, 0, 384], sectorId: 'S12', note: '制御室 T-12 の射撃位置（開口の内側。TPS カメラからも射線が通る）' },
  { position: [118, 0, 402], sectorId: 'S12', note: 'ダクト D7 底' },
  { position: [130.5, 10, 402], sectorId: 'S12', note: '隔壁 B-05' },
  { position: [140, 10, 402], sectorId: 'S13', note: '搬入バルコニー' },
  { position: [244, 0, 340], sectorId: 'S13', note: '制御室 T-14 の射撃位置' },
  { position: [250, 0, 386], sectorId: 'S13', note: 'ダクト D6 底' },
  { position: [261.5, 8, 386], sectorId: 'S13', note: '隔壁 B-06' },
  { position: [282, 8, 390], sectorId: 'S14', note: '搬出ゲート前' },
  { position: [302.5, 8, 390], sectorId: 'S14', note: '最終ゲート' },
  { position: [332, 8, 392], sectorId: 'S15', note: '脱出領域' },
];

const flightPoints: FlightPointDef[] = [
  { id: 'F1', sectorId: 'S03', from: [298, 0, 70], to: [302.5, 8, 70], heightDiff: 8, note: 'ダクト D1: 圧延棟床 0 → 搬送縦坑入口足場 +8' },
  { id: 'F2', sectorId: 'S07', from: [298, -14, 144], to: [302.5, -4, 144], heightDiff: 10, note: 'ダクト D2: 冷却設備床 −14 → 排気縦坑第 1 ファン室 −4' },
  { id: 'F3', sectorId: 'S08', from: [329, -4, 162], to: [329, 6, 169.5], heightDiff: 10, note: 'ダクト D3: 第 1 ファン室 −4 → 第 2 ファン室 +6' },
  { id: 'F4', sectorId: 'S08', from: [307, 6, 190], to: [307, 14, 197.5], heightDiff: 8, note: 'ダクト D4: 第 2 ファン室 +6 → 第 3 ファン室 +14' },
  { id: 'F5', sectorId: 'S10', from: [64, 0, 224], to: [59.5, 10, 224], heightDiff: 10, note: 'ダクト D5: 組立ライン床 0 → 検査デッキ +10' },
  { id: 'F6', sectorId: 'S12', from: [126, 0, 402], to: [130.5, 10, 402], heightDiff: 10, note: 'ダクト D7: 主製造ホール床 0 → 出荷倉庫バルコニー +10' },
  { id: 'F7', sectorId: 'S13', from: [257, 0, 386], to: [261.5, 8, 386], heightDiff: 8, note: 'ダクト D6: 出荷倉庫床 0 → 搬出ゲート +8' },
];

const branches: BranchDef[] = [
  {
    id: 'BR1',
    splitSectorId: 'S02',
    mergeSectorId: 'S03',
    routes: [
      { sectorIds: ['S02', 'S03'], description: '北扉を直進。短いが資材ヤードと圧延棟の 4〜5 体から同時に射線を取られる' },
      { sectorIds: ['S02', 'S16', 'S03'], description: '南側搬送路を経由。約 120 m 長いが柱の遮蔽があり、敵は警備 1 体' },
    ],
  },
  {
    id: 'BR2',
    splitSectorId: 'S05',
    mergeSectorId: 'S06',
    routes: [
      { sectorIds: ['S05', 'S06'], description: '西扉から動力棟へ直進。発電機側の砲台 t06 と警備 3 体の射線に入る' },
      { sectorIds: ['S05', 'S17', 'S06'], description: '地下保守通路を迂回。天井が低く配管の遮蔽があるが警備 1 体が待ち伏せる' },
    ],
  },
  {
    id: 'BR3',
    splitSectorId: 'S11',
    mergeSectorId: 'S12',
    routes: [
      { sectorIds: ['S11', 'S12'], description: '南扉から主製造ホールへ。プレス機の間で砲台 t13 と警備 3 体に晒される' },
      { sectorIds: ['S11', 'S18', 'S12'], description: '外周搬送路を回る。柱の遮蔽つきで西扉から制御室の側面へ出られる' },
    ],
  },
];

const loops: LoopDef[] = [
  { id: 'LP1', sectorIds: ['S02', 'S03', 'S16'], description: '資材ヤード→圧延棟→南側搬送路→資材ヤードの環状経路' },
  { id: 'LP2', sectorIds: ['S05', 'S06', 'S17'], description: '地下搬送区画→動力棟→地下保守通路→地下搬送区画の環状経路' },
  { id: 'LP3', sectorIds: ['S11', 'S12', 'S18'], description: '検査棟→主製造ホール→外周搬送路→検査棟の環状経路' },
];

/**
 * 点光源（8 個、ARCHITECTURE §3.10 の予算）。6 つのアリーナと動力・排気の 2 室に置く。
 * 基礎照明は描画側の Hemisphere + Directional（影なしで全区画に届く）と発光する警告灯・標識が担う。
 * 搬出ゲート S14 は隣の S13 の光（90 m）と発光する脱出標識で照らす。
 */
const lights: LightDef[] = [
  { position: [106, 18, 45], color: 0xffd9a0, intensity: 2.0, distance: 140, sectorId: 'S02' },
  { position: [237, 16, 45], color: 0xffc080, intensity: 2.0, distance: 140, sectorId: 'S03' },
  { position: [114, 2, 150], color: 0x9fd0ff, intensity: 2.0, distance: 150, sectorId: 'S06' },
  { position: [246, 2, 166], color: 0x9fd0ff, intensity: 1.6, distance: 120, sectorId: 'S07' },
  { position: [318, 20, 172], color: 0xffe0b0, intensity: 1.5, distance: 90, sectorId: 'S08' },
  { position: [124, 26, 263], color: 0xffd9a0, intensity: 2.0, distance: 150, sectorId: 'S10' },
  { position: [65, 22, 364], color: 0xffd9a0, intensity: 2.0, distance: 150, sectorId: 'S12' },
  { position: [196, 20, 364], color: 0xffd9a0, intensity: 2.0, distance: 150, sectorId: 'S13' },
];

const objectiveHints: Record<string, string> = {
  S01: '遮蔽壁を回り、東の扉から資材ヤードへ進め',
  S02: '圧延棟へ進み、制御砲台 T-02 を探せ（北扉または南側搬送路）',
  S16: '南側搬送路を東へ進み、圧延棟へ入れ',
  S03: '制御砲台 T-02 を破壊して隔壁 B-01 を開け。東端のダクト D1 を飛行で登れ',
  S04: '坑底へ降り、南の扉から地下搬送区画へ進め',
  S05: '西の動力棟へ進み、制御砲台 T-05 を探せ（西扉または地下保守通路）',
  S17: '地下保守通路を西へ進み、動力棟の北扉へ出ろ',
  S06: '制御砲台 T-05 を破壊して隔壁 B-02 を開け。東扉から冷却設備へ',
  S07: '制御砲台 T-07 を破壊して隔壁 B-03 を開け。北東のダクト D2 を飛行で登れ',
  S08: 'ダクト D3・D4 を飛行で登り、南の扉から保守用配管区画へ',
  S09: '西へ進み、組立ラインの上層デッキへ入れ',
  S10: 'デッキから降り、制御砲台 T-09 を破壊して隔壁 B-04 を開け。北西のダクト D5 を飛行で登れ',
  S11: '検査デッキを南へ進み、崩落部から地上階へ降りて主製造ホールへ（外周搬送路も可）',
  S18: '外周搬送路を南へ進み、主製造ホールの西扉へ出ろ',
  S12: '制御砲台 T-12 を破壊して隔壁 B-05 を開け。東端のダクト D7 を飛行で登れ',
  S13: '制御砲台 T-14 を破壊して隔壁 B-06 を開け。東端のダクト D6 を飛行で登れ',
  S14: '最終ゲートを抜けて搬出ヤードの脱出領域へ入れ',
  S15: '脱出領域へ進め',
};

export const STAGE_DATA: StageData = {
  id: 'koala-heavy-industries-plant3',
  name: '廃工場 コアラ重工 第3工場',
  start: { position: [8, 0, 40], yaw: Math.PI, sectorId: 'S01' },
  exitZone: aabb(322, 8, 372, 342, 20, 412),
  killY: PLAYER.fallKillY,
  sectors,
  solids: b.solids,
  decor: b.decor,
  lights,
  barriers,
  gate: { id: 'GATE', box: GATE_BOX, label: '最終搬出ゲート' },
  enemies,
  route,
  flightPoints,
  branches,
  loops,
  arenaSectorIds: ['S02', 'S03', 'S06', 'S10', 'S12', 'S13'],
  crossfireSectors: [
    { sectorId: 'S02', enemyIds: ['g01', 'g02', 'g03', 't01'] },
    { sectorId: 'S03', enemyIds: ['g05', 'g06', 'g07', 't03'] },
    { sectorId: 'S06', enemyIds: ['g12', 'g13', 'g14', 't06'] },
    { sectorId: 'S10', enemyIds: ['g20', 'g21', 'g22', 't10'] },
    { sectorId: 'S12', enemyIds: ['g25', 'g26', 'g27', 't13'] },
    { sectorId: 'S13', enemyIds: ['g29', 'g30', 't14', 't15'] },
  ],
  objectiveHints,
  navFloorLevels: [-14, -4, 0, 6, 8, 10, 14],
};

/** 設計記録・検証用: 部屋の内側範囲 */
export const STAGE_ROOMS: Readonly<Record<string, Readonly<RoomDef>>> = R;
