/**
 * AK2 stage definition — one continuous decommissioned factory.
 *
 * Layout notes (world units = metres, Y is up):
 *   tier 0  : y = 0      ground floor of the plant
 *   tier 12 : y = 12     mezzanine / catwalk level
 *   tier 24 : y = 24     high gantry level
 *   vertical transfer shafts connect the tiers (12 m steps -> flight required)
 *
 * The mandatory route is a chain of 25 zones joined by 24 doors, interrupted
 * by six barrier doors that are opened by destroying six dedicated control
 * turrets.  Four side branches create genuine alternatives (and rings) so
 * the facility never degenerates into a single corridor.
 */

export type ZoneKind =
  | 'dock'
  | 'yard'
  | 'mill'
  | 'assembly'
  | 'inspection'
  | 'gantry'
  | 'plant'
  | 'conveyor'
  | 'cooling'
  | 'piping'
  | 'hall'
  | 'shipping'
  | 'gate'
  | 'escape'
  | 'shaft'
  | 'corridor';

export interface ZoneLevel {
  /** floor height of the level */
  y: number;
  /** clear height of the level */
  h: number;
}

export interface Zone {
  id: string;
  name: string;
  kind: ZoneKind;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  levels: ZoneLevel[];
  /** shaft only: centre of the opening the player flies through */
  hole?: [number, number];
  /** shaft only: size of the opening */
  holeSize?: number;
}

export interface Link {
  a: string;
  b: string;
  /** optional: id of the barrier that seals this door */
  barrier?: string;
  /** optional: the final evacuation gate */
  finalGate?: boolean;
}

export interface BarrierSpec {
  id: string;
  /** control turret that opens it */
  controlEnemyId: string;
  label: string;
}

export interface EnemySpawn {
  id: string;
  kind: 'guard' | 'turret';
  zone: string;
  /** level index inside the zone */
  level?: number;
  x: number;
  z: number;
  /** facing in radians (0 = +Z) */
  yaw?: number;
  control?: boolean;
}

export const TIER = { ground: 0, mid: 12, high: 24 };

export const ZONES: Zone[] = [
  // ---------------- tier 0 ----------------
  { id: 'intake', name: 'Intake Dock', kind: 'dock', x0: 40, x1: 190, z0: 600, z1: 800, levels: [{ y: 0, h: 12 }] },
  { id: 'yard', name: 'Material Yard', kind: 'yard', x0: 190, x1: 380, z0: 610, z1: 810, levels: [{ y: 0, h: 12 }] },
  { id: 'mill', name: 'Rolling Mill', kind: 'mill', x0: 380, x1: 520, z0: 610, z1: 790, levels: [{ y: 0, h: 12 }] },
  { id: 'sluice_a', name: 'Drain Link A', kind: 'corridor', x0: 250, x1: 330, z0: 490, z1: 610, levels: [{ y: 0, h: 9 }] },
  { id: 'sluice_b', name: 'Drain Link B', kind: 'corridor', x0: 250, x1: 420, z0: 430, z1: 490, levels: [{ y: 0, h: 9 }] },
  { id: 'sluice_c', name: 'Drain Link C', kind: 'corridor', x0: 420, x1: 480, z0: 430, z1: 610, levels: [{ y: 0, h: 9 }] },
  { id: 'spur_d', name: 'Service Spur D', kind: 'corridor', x0: 100, x1: 190, z0: 490, z1: 600, levels: [{ y: 0, h: 9 }] },
  { id: 'spur_e', name: 'Service Spur E', kind: 'corridor', x0: 100, x1: 250, z0: 430, z1: 490, levels: [{ y: 0, h: 9 }] },

  // ---------------- tier 12 ----------------
  { id: 'assembly', name: 'Assembly Line', kind: 'assembly', x0: 580, x1: 750, z0: 590, z1: 790, levels: [{ y: 12, h: 12 }] },
  { id: 'inspect', name: 'Inspection Bay', kind: 'inspection', x0: 750, x1: 880, z0: 610, z1: 780, levels: [{ y: 12, h: 12 }] },
  { id: 'conveyor', name: 'Conveyor Section', kind: 'conveyor', x0: 760, x1: 990, z0: 470, z1: 590, levels: [{ y: 12, h: 12 }] },
  { id: 'piping', name: 'Maintenance Piping', kind: 'piping', x0: 140, x1: 370, z0: 470, z1: 590, levels: [{ y: 12, h: 12 }] },
  { id: 'shipping', name: 'Shipping Warehouse', kind: 'shipping', x0: 540, x1: 720, z0: 280, z1: 400, levels: [{ y: 12, h: 12 }] },
  { id: 'dock2', name: 'Second Loading Dock', kind: 'dock', x0: 840, x1: 960, z0: 280, z1: 400, levels: [{ y: 12, h: 12 }] },
  { id: 'duct_s', name: 'Underfloor Duct S', kind: 'corridor', x0: 620, x1: 680, z0: 790, z1: 830, levels: [{ y: 12, h: 9 }] },
  { id: 'duct_x2', name: 'Underfloor Duct X', kind: 'corridor', x0: 620, x1: 880, z0: 830, z1: 870, levels: [{ y: 12, h: 9 }] },
  { id: 'duct_n2', name: 'Underfloor Duct N', kind: 'corridor', x0: 820, x1: 880, z0: 780, z1: 830, levels: [{ y: 12, h: 9 }] },

  // ---------------- tier 24 ----------------
  { id: 'gantry', name: 'Main Gantry', kind: 'gantry', x0: 940, x1: 1090, z0: 600, z1: 790, levels: [{ y: 24, h: 12 }] },
  { id: 'plant', name: 'Power House', kind: 'plant', x0: 1060, x1: 1200, z0: 460, z1: 600, levels: [{ y: 24, h: 12 }] },
  { id: 'cooling', name: 'Cooling Plant', kind: 'cooling', x0: 430, x1: 700, z0: 500, z1: 660, levels: [{ y: 24, h: 12 }] },
  { id: 'mainhall', name: 'Main Manufacturing Hall', kind: 'hall', x0: 140, x1: 480, z0: 200, z1: 480, levels: [{ y: 24, h: 24 }] },
  { id: 'exitgate', name: 'Evacuation Gate Front', kind: 'gate', x0: 1020, x1: 1200, z0: 260, z1: 420, levels: [{ y: 24, h: 12 }] },
  { id: 'escape', name: 'Evacuation Zone', kind: 'escape', x0: 1200, x1: 1620, z0: 160, z1: 440, levels: [{ y: 24, h: 12 }] },
  { id: 'spur_k', name: 'North Link K', kind: 'corridor', x0: 1000, x1: 1060, z0: 560, z1: 600, levels: [{ y: 24, h: 9 }] },

  // ---------------- vertical transfer shafts ----------------
  { id: 'towerA', name: 'Transfer Shaft A', kind: 'shaft', x0: 520, x1: 580, z0: 620, z1: 780, levels: [{ y: 0, h: 12 }, { y: 12, h: 12 }], hole: [550, 700], holeSize: 18 },
  { id: 'towerB', name: 'Transfer Shaft B', kind: 'shaft', x0: 880, x1: 940, z0: 620, z1: 780, levels: [{ y: 12, h: 12 }, { y: 24, h: 12 }], hole: [910, 700], holeSize: 18 },
  { id: 'towerC', name: 'Transfer Shaft C', kind: 'shaft', x0: 990, x1: 1060, z0: 460, z1: 560, levels: [{ y: 12, h: 12 }, { y: 24, h: 12 }], hole: [1025, 510], holeSize: 18 },
  { id: 'towerD', name: 'Transfer Shaft D', kind: 'shaft', x0: 700, x1: 760, z0: 480, z1: 580, levels: [{ y: 12, h: 12 }, { y: 24, h: 12 }], hole: [730, 530], holeSize: 18 },
  { id: 'towerE', name: 'Transfer Shaft E', kind: 'shaft', x0: 370, x1: 430, z0: 480, z1: 590, levels: [{ y: 12, h: 12 }, { y: 24, h: 12 }], hole: [400, 535], holeSize: 18 },
  { id: 'towerF', name: 'Transfer Shaft F', kind: 'shaft', x0: 80, x1: 140, z0: 450, z1: 580, levels: [{ y: 12, h: 12 }, { y: 24, h: 12 }], hole: [110, 515], holeSize: 18 },
  { id: 'towerG', name: 'Transfer Shaft G', kind: 'shaft', x0: 480, x1: 540, z0: 290, z1: 390, levels: [{ y: 12, h: 12 }, { y: 24, h: 12 }], hole: [510, 340], holeSize: 18 },
  { id: 'towerH', name: 'Transfer Shaft H', kind: 'shaft', x0: 720, x1: 780, z0: 290, z1: 390, levels: [{ y: 12, h: 12 }, { y: 24, h: 12 }], hole: [750, 340], holeSize: 18 },
  { id: 'towerI', name: 'Transfer Shaft I', kind: 'shaft', x0: 780, x1: 840, z0: 290, z1: 390, levels: [{ y: 12, h: 12 }, { y: 24, h: 12 }], hole: [810, 340], holeSize: 18 },
  { id: 'towerJ', name: 'Transfer Shaft J', kind: 'shaft', x0: 960, x1: 1020, z0: 290, z1: 390, levels: [{ y: 12, h: 12 }, { y: 24, h: 12 }], hole: [990, 340], holeSize: 18 }
];

export const LINKS: Link[] = [
  // ---- mandatory chain ----
  { a: 'intake', b: 'yard' },
  { a: 'yard', b: 'mill' },
  { a: 'mill', b: 'towerA' },
  { a: 'towerA', b: 'assembly', barrier: 'BR1' },
  { a: 'assembly', b: 'inspect' },
  { a: 'inspect', b: 'towerB' },
  { a: 'towerB', b: 'gantry', barrier: 'BR2' },
  { a: 'gantry', b: 'plant' },
  { a: 'plant', b: 'towerC' },
  { a: 'towerC', b: 'conveyor', barrier: 'BR3' },
  { a: 'conveyor', b: 'towerD' },
  { a: 'towerD', b: 'cooling' },
  { a: 'cooling', b: 'towerE' },
  { a: 'towerE', b: 'piping' },
  { a: 'piping', b: 'towerF' },
  { a: 'towerF', b: 'mainhall' },
  { a: 'mainhall', b: 'towerG', barrier: 'BR4' },
  { a: 'towerG', b: 'shipping' },
  { a: 'shipping', b: 'towerH', barrier: 'BR5' },
  { a: 'towerH', b: 'towerI' },
  { a: 'towerI', b: 'dock2' },
  { a: 'dock2', b: 'towerJ' },
  { a: 'towerJ', b: 'exitgate', barrier: 'BR6' },
  { a: 'exitgate', b: 'escape', finalGate: true },
  // ---- branch 1 : sluice ring (yard <-> mill) ----
  { a: 'yard', b: 'sluice_a' },
  { a: 'sluice_a', b: 'sluice_b' },
  { a: 'sluice_b', b: 'sluice_c' },
  { a: 'sluice_c', b: 'mill' },
  // ---- branch 2 : service loop back to the intake ----
  { a: 'intake', b: 'spur_d' },
  { a: 'spur_d', b: 'spur_e' },
  { a: 'spur_e', b: 'sluice_b' },
  // ---- branch 3 : under-floor duct (assembly <-> inspection) ----
  { a: 'assembly', b: 'duct_s' },
  { a: 'duct_s', b: 'duct_x2' },
  { a: 'duct_x2', b: 'duct_n2' },
  { a: 'duct_n2', b: 'inspect' },
  // ---- branch 4 : north link (gantry <-> plant) ----
  { a: 'gantry', b: 'spur_k' },
  { a: 'spur_k', b: 'plant' }
];

export const BARRIERS: BarrierSpec[] = [
  { id: 'BR1', controlEnemyId: 'E-TUR-01', label: 'Barrier 1 (Assembly Line entrance)' },
  { id: 'BR2', controlEnemyId: 'E-TUR-03', label: 'Barrier 2 (Gantry entrance)' },
  { id: 'BR3', controlEnemyId: 'E-TUR-06', label: 'Barrier 3 (Conveyor entrance)' },
  { id: 'BR4', controlEnemyId: 'E-TUR-09', label: 'Barrier 4 (Main Hall exit)' },
  { id: 'BR5', controlEnemyId: 'E-TUR-07', label: 'Barrier 5 (Shipping exit)' },
  { id: 'BR6', controlEnemyId: 'E-TUR-08', label: 'Barrier 6 (Evacuation gate entrance)' }
];

/** 30 security robots + 15 fixed turrets = 45 hostiles. */
export const ENEMY_SPAWNS: EnemySpawn[] = [
  // --- tier 0 ---
  { id: 'E-GRD-01', kind: 'guard', zone: 'yard', x: 235, z: 650, yaw: 0.4 },
  { id: 'E-GRD-02', kind: 'guard', zone: 'yard', x: 330, z: 665, yaw: 2.6 },
  { id: 'E-GRD-03', kind: 'guard', zone: 'yard', x: 250, z: 760, yaw: 1.2 },
  { id: 'E-GRD-04', kind: 'guard', zone: 'yard', x: 335, z: 765, yaw: 3.4 },
  { id: 'E-TUR-15', kind: 'turret', zone: 'yard', x: 285, z: 705 },
  { id: 'E-TUR-01', kind: 'turret', zone: 'mill', x: 450, z: 700, control: true },
  { id: 'E-GRD-05', kind: 'guard', zone: 'mill', x: 415, z: 650, yaw: 0.9 },
  { id: 'E-GRD-06', kind: 'guard', zone: 'mill', x: 485, z: 750, yaw: 3.0 },
  { id: 'E-GRD-07', kind: 'guard', zone: 'sluice_c', x: 450, z: 520, yaw: 1.6 },

  // --- tier 12 ---
  { id: 'E-GRD-08', kind: 'guard', zone: 'assembly', x: 615, z: 630, yaw: 0.3 },
  { id: 'E-GRD-09', kind: 'guard', zone: 'assembly', x: 710, z: 640, yaw: 2.4 },
  { id: 'E-GRD-10', kind: 'guard', zone: 'assembly', x: 630, z: 750, yaw: 1.1 },
  { id: 'E-GRD-11', kind: 'guard', zone: 'assembly', x: 705, z: 755, yaw: 3.3 },
  { id: 'E-TUR-02', kind: 'turret', zone: 'assembly', x: 665, z: 695 },
  { id: 'E-TUR-03', kind: 'turret', zone: 'inspect', x: 815, z: 700, control: true },
  { id: 'E-GRD-12', kind: 'guard', zone: 'inspect', x: 790, z: 650, yaw: 0.7 },
  { id: 'E-TUR-04', kind: 'turret', zone: 'conveyor', x: 870, z: 530 },
  { id: 'E-GRD-14', kind: 'guard', zone: 'conveyor', x: 805, z: 505, yaw: 0.2 },
  { id: 'E-GRD-15', kind: 'guard', zone: 'conveyor', x: 905, z: 515, yaw: 1.9 },
  { id: 'E-GRD-16', kind: 'guard', zone: 'conveyor', x: 850, z: 565, yaw: 2.7 },
  { id: 'E-TUR-05', kind: 'turret', zone: 'piping', x: 300, z: 530 },
  { id: 'E-GRD-17', kind: 'guard', zone: 'piping', x: 190, z: 510, yaw: 0.5 },
  { id: 'E-GRD-18', kind: 'guard', zone: 'piping', x: 215, z: 560, yaw: 2.2 },
  { id: 'E-TUR-06', kind: 'turret', zone: 'towerC', level: 1, x: 1045, z: 540, control: true },
  { id: 'E-TUR-07', kind: 'turret', zone: 'shipping', x: 630, z: 340, control: true },
  { id: 'E-GRD-19', kind: 'guard', zone: 'shipping', x: 580, z: 315, yaw: 0.6 },
  { id: 'E-GRD-20', kind: 'guard', zone: 'shipping', x: 675, z: 370, yaw: 2.5 },
  { id: 'E-TUR-08', kind: 'turret', zone: 'dock2', x: 900, z: 340, control: true },
  { id: 'E-GRD-21', kind: 'guard', zone: 'dock2', x: 870, z: 315, yaw: 0.8 },
  { id: 'E-GRD-22', kind: 'guard', zone: 'dock2', x: 930, z: 370, yaw: 3.1 },

  // --- tier 24 ---
  { id: 'E-TUR-09', kind: 'turret', zone: 'mainhall', x: 300, z: 330, control: true },
  { id: 'E-TUR-10', kind: 'turret', zone: 'mainhall', x: 420, z: 250 },
  { id: 'E-GRD-23', kind: 'guard', zone: 'mainhall', x: 210, z: 250, yaw: 0.9 },
  { id: 'E-GRD-24', kind: 'guard', zone: 'mainhall', x: 380, z: 420, yaw: 2.8 },
  { id: 'E-GRD-25', kind: 'guard', zone: 'mainhall', x: 250, z: 430, yaw: 1.4 },
  { id: 'E-TUR-11', kind: 'turret', zone: 'cooling', x: 565, z: 580 },
  { id: 'E-GRD-26', kind: 'guard', zone: 'cooling', x: 480, z: 540, yaw: 0.3 },
  { id: 'E-GRD-27', kind: 'guard', zone: 'cooling', x: 650, z: 615, yaw: 2.1 },
  { id: 'E-GRD-28', kind: 'guard', zone: 'cooling', x: 505, z: 625, yaw: 3.4 },
  { id: 'E-TUR-12', kind: 'turret', zone: 'gantry', x: 1015, z: 700 },
  { id: 'E-GRD-29', kind: 'guard', zone: 'gantry', x: 975, z: 645, yaw: 0.6 },
  { id: 'E-TUR-13', kind: 'turret', zone: 'plant', x: 1130, z: 530 },
  { id: 'E-GRD-30', kind: 'guard', zone: 'plant', x: 1095, z: 480, yaw: 1.7 },
  { id: 'E-TUR-14', kind: 'turret', zone: 'exitgate', x: 1110, z: 340 },
  { id: 'E-GRD-31', kind: 'guard', zone: 'exitgate', x: 1060, z: 300, yaw: 2.3 }
];

export const PLAYER_START = { zone: 'intake', x: 70, z: 705, yaw: 0.0 };

/** Reaching this point inside the evacuation zone ends the sortie. */
export const CLEAR_POINT = { zone: 'escape', x: 1580, z: 300 };

export const ZONE_BY_ID = new Map(ZONES.map((z) => [z.id, z]));

/** Every zone a control turret belongs to (for the objective HUD). */
export const CONTROL_TURRET_IDS = new Set(ENEMY_SPAWNS.filter((e) => e.control).map((e) => e.id));
