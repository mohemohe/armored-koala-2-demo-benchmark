# AK2 アーキテクチャと各モジュールの契約

仕様書は `docs/SPEC.md`。数値は全て `src/params.ts`、型は全て `src/types.ts` から取る。
**`src/sim/**` は DOM/Three.js に依存しない**（vitest の node 環境で丸ごと実行する）。

## 1. 規約

- 1 ワールド単位 = 1 m。Y が上。時間は秒。`Vec3 = [x, y, z]` タプル（`src/sim/vec.ts` の関数で演算）。
- yaw=0 の前方は −Z（Three.js カメラ規約）。`forwardFromYaw(yaw) = [-sin, 0, -cos]`、`rightFromYaw(yaw) = [cos, 0, -sin]`。pitch>0 で上向き。
- プレイヤーの `pos` は**足元**位置。当たり判定 AABB の中心は `pos + PLAYER.hitCenterOffset`、半径 `PLAYER.halfExtents`。銃口は `pos + rotateY(PLAYER.muzzleOffset, yaw)`（ヨーのみで決まり、照準方向に依存しない）。
- 敵の `pos` も足元位置。当たり判定は**球**（`ENEMIES.<kind>.radius`、中心 `pos + centerOffset`）。移動衝突は AABB（`halfExtents`）。
- シミュレーションは `Game.advance(realDt)` が固定刻み（`SIM.maxStep = 1/120`）で回し、イベント時刻（QB噴射終了、EN回復開始、飛行EN枯渇、射撃時刻、敵の射撃時刻）で刻みを分割する。各モジュールは `nextEventTime(time)` で「次に状態が不連続に変わる時刻（≥ time）」を返す。
- 1 サブステップ `Game.stepOnce(h)` の順序（`src/sim/game.ts` 参照）:
  1. `processDueEvents()`（境界時刻 t で: プレイヤー射撃 `weapons.tryFire` → 敵射撃 `enemies.fireDue`）
  2. `enemies.beginStep()`（prev 位置を記録）→ `enemies.integrate(h)` → `player.integrate(h)` → `projectiles.integrate(h)`（prev→cur の掃引判定）
  3. `time += h` → `camera.follow` → `fcs.update(h)` → `fireSolution` 更新 → 区画更新 → 失敗判定（HP0/落下）→ クリア判定
- 乱数は `Rng`（mulberry32）。ゲーム進行に使う乱数は `game.rng` のみ。視覚効果は描画側で別インスタンス。
- **描画頻度非依存**: 30/60/120fps で同じ結果になるように、全ての運動・消費・タイマーは `h` に基づいて更新する。

## 2. モジュール一覧と所有者

| ファイル | 役割 | 状態 |
|---|---|---|
| `src/params.ts` | 全パラメーター | 完成 |
| `src/types.ts` | 共有型 | 完成 |
| `src/sim/vec.ts` `rng.ts` `camera.ts` `stage.ts` `game.ts` | ベクトル、乱数、カメラ、ステージ実行時、統括 | 完成（統括は各モジュール完成後に調整） |
| `src/sim/geom.ts` `collision.ts` | 幾何プリミティブ、衝突ワールド | 実装対象 A |
| `src/sim/ballistics.ts` | 偏差・重力補正の解法 | 実装対象 B |
| `src/sim/player.ts` | プレイヤー移動・EN | 実装対象 C |
| `src/sim/fcs.ts` `weapons.ts` `projectiles.ts` | ロック、射撃、弾体 | 実装対象 D |
| `src/sim/enemy.ts` `nav.ts` | 敵AI、経路探索 | 実装対象 E |
| `src/stage/stageData.ts` `src/stage/verify.ts` | ステージ定義、検証ツール | 実装対象 F |
| `src/render/*` | Three.js 描画（機体、敵、弾体、ステージ、効果） | 実装対象 G |
| `src/ui/*` | HUD、格納庫、一時停止・結果画面 | 実装対象 H |
| `src/input.ts` `src/main.ts` `src/bench.ts` `index.html` | 入力、起動、ベンチAPI | 統括者 |

## 3. 各モジュールの API（必ずこの通りに export する）

### 3.1 `src/sim/geom.ts`（A）

```ts
export function rayAABB(origin: Vec3, dir: Vec3, box: AABB, maxDist: number): { t: number; normal: Vec3 } | null; // dir は単位
export function raySphere(origin: Vec3, dir: Vec3, center: Vec3, radius: number, maxDist: number): number | null; // 最初の交点までの距離。原点が内部なら 0
export function segmentAABB(a: Vec3, b: Vec3, box: AABB): boolean;
/** 線分 a→b（半径 r の球の掃引）と、prev→cur へ動く半径 R の球との最初の接触割合 t∈[0,1]。相対運動で解く。開始時に重なっていれば 0 */
export function sweptSphereVsMovingSphere(a: Vec3, b: Vec3, r: number, prevCenter: Vec3, curCenter: Vec3, R: number): number | null;
/** 線分 a→b（半径 r）と、prev→cur へ動く AABB（半径 half）との最初の接触割合 t∈[0,1] */
export function sweptSphereVsMovingBox(a: Vec3, b: Vec3, r: number, prevCenter: Vec3, curCenter: Vec3, half: Vec3): { t: number; normal: Vec3 } | null;
export function expandAABB(box: AABB, r: number): AABB;
export function aabbOverlap(a: AABB, b: AABB): boolean;
```

### 3.2 `src/sim/collision.ts`（A）

```ts
export function createCollisionWorld(): CollisionWorld; // types.ts の CollisionWorld を完全実装
```
- 内部にブロードフェーズ（XZ 一様グリッド、セル 16m 程度）を持ち、数百〜千個の AABB でも高速に問い合わせできること。
- `moveBox` は Y→X→Z の順に各軸で掃引し、接触面で停止（接触面から 1e-4 m 手前）。開始時に既に重なっている AABB は「その軸では無視」して押し出さない（引っかかり防止）が、めり込み解消のため `boxOverlaps` を提供する。
- `sweepSphere` は各 AABB を r だけ拡張して線分交差（近似。角は丸めなくて良い）。
- `raycast` は最初の衝突（t 昇順）。`segmentBlocked` は真偽のみ（早期終了）。
- `bounds()` は全コライダーの包含 AABB（コライダーがなければ原点の 0 サイズ）。

### 3.3 `src/sim/ballistics.ts`（B）

```ts
export interface LeadSolution { t: number; direction: Vec3; residualMeters: number; }
/** §4.3 マシンガン: 最小の正の実数解 t∈(0, maxT]。r = p - m, v = 対象速度, g = [0,-18,0], s = 100 */
export function solveMachinegunLead(r: Vec3, v: Vec3, speed: number, gravity: Vec3, maxT: number): LeadSolution | null;
/** §4.4 ミサイル/敵弾: (v·v - s²)t² + 2(r·v)t + r·r = 0 の最小の正の解 t∈(0, maxT]。2次項 0 なら 1次式 */
export function solveLinearLead(r: Vec3, v: Vec3, speed: number, maxT: number): LeadSolution | null;
/** 4次方程式 c4 t^4 + c3 t^3 + c2 t^2 + c1 t + c0 = 0 の (0, maxT] 内の実根を昇順で返す（重根・端点を含む） */
export function quarticRootsInRange(c4: number, c3: number, c2: number, c1: number, c0: number, maxT: number): number[];
```
- `solveMachinegunLead`: w(t) = r + v t − 0.5 g t²、|w|² − s² t² = 0 の 4 次方程式を、導関数による区間分離＋二分法＋ニュートン磨きで解く。重根（接する根）と t=maxT 端点も扱う。`direction = normalize(w(t))`、`residualMeters = | |w(t)| − s t |`（採用時刻における弾体と等速予測対象中心の距離）。residual > 0.01 の解は返さない（null）。NaN/Infinity を返さない。r≈0 のときは null（銃口での重なりは衝突側で処理）。
- 参考値: A03（r=(0,0,100), v=0）→ t≈1.004108529, v0≈(0, 9.036976765, 99.590828147)。A05（v=(8,0,0)）→ t≈1.007391236, v0≈(8, 9.066521121, 99.266299391)。A13（r=(0,0,120), v=(6,3,4)）→ t≈1.266137996。
- `tests/ballistics.test.ts` で A01〜A13 の解の存在・残差・参考値一致（1e-6）・|v0|=100±0.001 を検証する。

### 3.4 `src/sim/player.ts`（C）

```ts
export class Player {
  constructor(loadout: Loadout);
  readonly loadout: Loadout; readonly stats: EffectiveStats;
  pos: Vec3; vel: Vec3; yaw: number; grounded: boolean; hp: number; en: number;
  weapon: Weapon; ammo: { machinegun: number; missile: number };
  horizontalMode: HorizontalMode; verticalMode: VerticalMode; glideEnabled: boolean;
  desiredDir: Vec2;               // 保存された水平移動方向（単位、なければ [0,0]）
  qbSuccessfulCount: number; qbLastStartedAt: number | null; qbImpulseRemaining: number;
  lastEnSpentAt: number | null;
  thrusting: boolean;             // 飛行推進中
  get alive(): boolean;           // hp > 0
  reset(spawnPos: Vec3, yaw: number): void; // HP/EN/弾/全モード/タイマー初期化
  applyEdgeInput(input: InputFrame, cameraYaw: number, time: number, events: SimEvent[]): void; // Q/Shift/Space のエッジ
  nextEventTime(time: number, input: InputFrame): number | null;
  integrate(h: number, time: number, input: InputFrame, cameraYaw: number, world: CollisionWorld, events: SimEvent[]): void;
  spendEn(amount: number, time: number): boolean; // 不足なら false（何も変えない）
  takeDamage(amount: number): void;
  qbCooldownRemaining(time: number): number;
  getMuzzlePosition(): Vec3; getHitCenter(): Vec3; getHitBox(): { center: Vec3; halfExtents: Vec3 };
}
```
仕様 §6, §7 を完全に実装する。要点:
- **QB**: `applyEdgeInput` で `input.qbPressed` かつ `!input.ctrlDown` かつ `en ≥ 36` かつ `(qbLastStartedAt === null || time − qbLastStartedAt ≥ 1.0)` のとき発動。方向は WASD（カメラ水平面へ変換・正規化）、無入力ならカメラ水平前方。水平速度を `80×legMul` に**設定**（加算しない）。垂直速度は変更しない。`en −= 36`、`lastEnSpentAt = time`、`qbImpulseRemaining = 0.15`、`horizontalMode = 'quickboost'`、`desiredDir = 方向`、`qbSuccessfulCount++`、`qbLastStartedAt = time`、events に `qbStart`。噴射中は水平速度を再設定しない（衝突で失った分を再付与しない）。噴射中は Shift/Ctrl を無視。
- **噴射終了**（`nextEventTime` で分割）: `glideEnabled = true`、`horizontalMode = 'glide'`、速度はそのまま。
- **グライド**: 目標速度 = `desiredDir × (grounded ? 22 : 16) × legMul`。WASD 入力があれば `desiredDir` を更新。変化量上限 = `(80 − 22)/0.6 × legMul`（地上）/ `(80 − 16)/0.6 × legMul`（空中）[m/s²]。`approachVector` で目標を越えない。位置は台形則（(v_old+v_new)/2 × h）で積分。
- **通常移動**: 目標 = 入力方向 × (grounded ? 10 : 16) × legMul。入力なし: 地上は 0 へ減速、空中は現在速度を保持（慣性）。加減速上限 `120 × legMul`。
- **Shift エッジ**（噴射中でなければ）: glide トグル。ON 時 `desiredDir` = 入力方向 or カメラ前方。OFF 時は walk モードへ（速度は即座に消さない）。
- **Ctrl 押下中**（噴射中でなければ）: `glideEnabled = false`、`horizontalMode = 'walk'`、目標速度 0（WASD より優先）。
- **ジャンプ**: 接地中の Space エッジで `vel.y = 10`（倍率なし）、events に `jump`。
- **飛行**: Space を 0.20 秒以上押し続けると（押下開始時刻から。空中で押し直した場合も 0.20 秒必要）飛行。飛行中 `vel.y = 8`、`20 EN/s` 消費。EN が途中で尽きる場合はその時刻で分割（`nextEventTime`）し、消費できない時間の上昇は行わない。Space を離す/EN 0 で重力運動へ（現在の vy を引き継ぐ）。
- **重力**: `vel.y −= 18 h`（飛行推進中は適用しない）。
- **衝突**: `world.moveBox(center, halfExtents, delta)` で移動。`hitNegY` で着地（`grounded = true`, `vel.y = 0`, events に `landed`、walk/glide モードは維持）。壁接触面に向かう速度成分を 0 に。接地判定は毎ステップ、下向きの微小プローブ（0.05m）で更新。
- **EN 回復**: 区間 [time, time+h] のうち `grounded` かつ この更新で消費なし かつ `time ≥ lastEnSpentAt + 0.75`（`nextEventTime` で分割）のとき `regen × h`。`en` は [0, maxEn] にクランプ。
- **EN 判定順**: 同一更新で QB 開始費 → ビーム（weapons が `spendEn` を呼ぶ）→ 飛行の連続消費。
- **verticalMode**: grounded / rising (vy>0, 非推進) / flying (推進中) / falling。
- **状態の保存**: `qbImpulseRemaining`, `lastEnSpentAt` などは一時停止で進まない（time ベース＋h ベースなので自然に満たす）。
- `tests/movement.test.ts` で §11 の表（単発入力、入力解放、移動量 42.6/34.08、グライド EN0、残量境界 35/36、同時操作、着地、飛行の EN 枯渇分割）を検証する。平坦な床は `createCollisionWorld()` に 1 枚の大きな AABB を追加して作る。

### 3.5 `src/sim/fcs.ts`（D）

```ts
export interface FcsContext { time: number; camera: SimCamera; muzzle: Vec3; targets: TargetInfo[]; world: CollisionWorld; }
export class Fcs {
  constructor(kind: FcsKind, lockSeconds: number);
  readonly kind: FcsKind; lockSeconds: number;
  state: LockState; targetId: string | null; progress: number; // 0..1
  reset(): void;
  radiusCssPx(camera: SimCamera): number; // lockRadiusCssPx(kind, camera.viewportWidth, camera.viewportHeight)
  /** 候補条件を再評価し、同じ対象が条件を満たし続けていれば progress += h/lockSeconds。h=0 で検証のみ */
  update(h: number, ctx: FcsContext): void;
  /** state==='locked' かつ対象が生存なら TargetInfo */
  lockedTarget(targets: TargetInfo[]): TargetInfo | null;
}
export function computeFireSolution(weapon: Weapon, muzzle: Vec3, target: TargetInfo | null, time: number): FireSolution;
```
- 候補: `alive`、銃口からの距離 ≤ 120、`camera.project(center).inFront`、画面中心からの距離 ≤ 半径、`!world.segmentBlocked(camera.position, center)`、`!world.segmentBlocked(muzzle, center)`。
- 未選択時: 中心に最も近い候補（同距離は ID 昇順）。選択中の対象が条件を満たす限り変更しない。失効したら即座に `state='none', progress=0, targetId=null`、次の対象は 0 から。
- `computeFireSolution`: target null → `inactive`（weapon 以外 null）。machinegun → `solveMachinegunLead`（maxT=2）: solved なら `launchDirection=d`、`predictedFlightSeconds=t`、`predictedInterceptPosition=p+vt`、`aimPoint=p+vt−0.5gt²`、`residualMeters`。解なし → `no_solution`（`launchDirection=normalize(p−m)`、`aimPoint=p`、t/命中点/残差 null）。beam → solved, direction=normalize(p−m), t=0, intercept=p, aim=p, residual=0。missile → `solveLinearLead`(45, maxT=4): solved なら direction=normalize(r+vt), aim=p+vt, intercept=p+vt; 解なし → `no_solution`、direction=normalize(p−m)、aim=p。

### 3.6 `src/sim/weapons.ts`（D）

```ts
export interface FireContext {
  time: number; player: Player; fcs: Fcs; camera: SimCamera; world: CollisionWorld; targets: TargetInfo[];
  projectiles: Projectiles; freeAimPoint: Vec3; events: SimEvent[];
  damageEnemy(id: string, amount: number, point: Vec3, weapon: Weapon): void;
  nextShotId(): number;
}
export class Weapons {
  nextFireAt: Record<Weapon, number>;
  lastDenial: { weapon: Weapon; reason: FireDenialReason; time: number } | null;
  reset(): void;
  /** トリガー押下中に次に発射を試みる時刻（≥ time）。押下していなければ null */
  nextFireTime(player: Player, input: InputFrame, time: number): number | null;
  /** time に発射を試みる。成立すれば ShotRecord（events にも push）。拒否なら null（lastDenial 更新、`fireDenied` イベントは 0.5 秒に 1 回まで） */
  tryFire(ctx: FireContext): ShotRecord | null;
}
```
- 発射前に `ctx.fcs.update(0, {...})` で対象を再検証し、`ctx.fcs.lockedTarget(ctx.targets)` と `computeFireSolution` で**その時刻の**解を得る。
- machinegun: 弾 0 なら拒否(noAmmo)。ロック完了＋solved → `v0 = 100·d`。ロック完了＋no_solution → 現在位置へ直接照準 d=normalize(p−m)、`solutionStatus='no_solution'`。未ロック → 自由射撃 d=normalize(freeAimPoint−m)、`inactive`。`projectiles.spawnMgBullet(m, v0, time)`、弾 −1、`nextFireAt = time + 0.1`。`accelerationAtFire=[0,−18,0]`。
- beam: `player.spendEn(8, time)` が false なら拒否(noEn)。方向はロック完了なら normalize(p−m)、未ロックなら自由射撃。`projectiles.fireBeam(m, d, world, targets)` → 命中した敵に `damageEnemy(id, 40, point, 'beam')`。events に `beamFire`。`initialVelocity=null`、`accelerationAtFire=[0,0,0]`。
- missile: ロック完了でなければ拒否(noLock)。弾 0 なら拒否(noAmmo)。方向は `computeFireSolution('missile')` の `launchDirection`（解なしでも現在位置方向で発射）。`projectiles.spawnMissile(m, d, targetId, time)`。`initialVelocity=45·d`、`predictedFlightSeconds` は初期方向の等速解（解なしなら null）。
- 拒否時は `nextFireAt` を更新しない。武器切り替えで `nextFireAt` はリセットしない。自機速度を弾に加算しない。

### 3.7 `src/sim/projectiles.ts`（D）

```ts
export interface ProjectileContext {
  time: number; world: CollisionWorld; targets: HittableSphere[];
  targetInfoById(id: string): TargetInfo | null;   // ミサイル誘導用（現在の中心・速度）
  player: HittableBox | null;                        // 死亡時 null
  damageEnemy(id: string, amount: number, point: Vec3, weapon: Weapon): void;
  damagePlayer(amount: number, point: Vec3, fromDirection: Vec3): void;
  events: SimEvent[];
}
export interface MgBullet { origin: Vec3; v0: Vec3; firedAt: number; pos: Vec3; }
export interface Missile { pos: Vec3; dir: Vec3; targetId: string; firedAt: number; lastObservedPos: Vec3 | null; lastObservedVel: Vec3 | null; lastObservedAt: number | null; targetLost: boolean; }
export interface EnemyBullet { pos: Vec3; dir: Vec3; speed: number; damage: number; firedAt: number; lifetime: number; ownerId: string; }
export class Projectiles {
  mgBullets: MgBullet[]; missiles: Missile[]; enemyBullets: EnemyBullet[];
  reset(): void;
  spawnMgBullet(origin: Vec3, initialVelocity: Vec3, time: number): void;
  spawnMissile(origin: Vec3, direction: Vec3, targetId: string, time: number): void;
  fireBeam(origin: Vec3, direction: Vec3, world: CollisionWorld, targets: TargetInfo[]): { hitEnemyId: string | null; point: Vec3; distance: number };
  spawnEnemyBullet(origin: Vec3, direction: Vec3, speed: number, damage: number, lifetime: number, ownerId: string, time: number): void;
  integrate(h: number, time: number, ctx: ProjectileContext): void;
  views(): ProjectileView[];
}
```
- MG 弾: 位置は年齢 a から解析的に `origin + v0 a + 0.5 g a²`。区間 [a, a+h]（寿命 2 秒で打ち切り）の線分について、`ctx.targets`（prev→cur の相対運動、`sweptSphereVsMovingSphere`）と `world.sweepSphere` を判定し、最も早い接触で処理。寿命終端まで検査してから削除。**発射後の誘導・位置補正なし**。
- ミサイル: 毎更新、対象が生存かつ `!world.segmentBlocked(pos, center)` なら観測更新し、`solveLinearLead(r, v, 45, 残り寿命)` の方向（解なしなら現在位置方向）へ、最大 `120°/s × h` だけ `rotateToward`。遮蔽中は最後の観測を等速外挿。対象破壊後は直進。速度 45 m/s 固定。衝突は掃引球。命中対象にのみ 180 ダメージ。寿命 4 秒で `missileExpired`。
- 敵弾: 直進。`ctx.player`（prev→cur の AABB、`sweptSphereVsMovingBox`）と `world.sweepSphere` を判定。プレイヤー命中で `damagePlayer(damage, point, dir)`。1 発 1 回。敵には当たらない。
- 全弾体は自機（発射者）に当たらない。

### 3.8 `src/sim/enemy.ts` / `src/sim/nav.ts`（E）

```ts
export interface EnemyContext {
  time: number; world: CollisionWorld;
  player: { center: Vec3; velocity: Vec3; alive: boolean; feet: Vec3; halfExtents: Vec3 };
  projectiles: Projectiles; events: SimEvent[];
}
export class Enemy {
  readonly id: string; readonly kind: EnemyKind; readonly def: EnemyDef;
  pos: Vec3; prevPos: Vec3; vel: Vec3; yaw: number; gunDirection: Vec3;
  hp: number; readonly maxHp: number; alive: boolean;
  alert: boolean; hasLineOfSight: boolean; shotsFired: number; lastShotAt: number | null;
  telegraphing: boolean; readonly radius: number;
  center(): Vec3; muzzle(): Vec3;
}
export class EnemyManager {
  readonly enemies: Enemy[];
  constructor(defs: EnemyDef[], world: CollisionWorld, nav: NavGrid | null, rng: Rng, sectorOf: (p: Vec3) => string | null);
  reset(): void;
  beginStep(): void;                         // prevPos = pos
  nextEventTime(time: number): number | null; // 次の予定射撃時刻（予告開始も可）
  fireDue(ctx: EnemyContext): void;           // time に到来した射撃を実行
  integrate(h: number, ctx: EnemyContext): void; // 索敵・記憶・移動・予告状態・target の等速移動
  damage(id: string, amount: number): { killed: boolean; enemy: Enemy } | null; // 死亡済み/不明は null
  byId(id: string): Enemy | undefined;
  targetInfos(): TargetInfo[];   // 全敵（alive フラグ付き）。velocity は (pos − prevPos)/h の実測値（target は def.velocity）
  targetInfo(id: string): TargetInfo | null;
  hittables(): HittableSphere[]; // 生存中のみ
  views(): EnemyView[];
  aliveCount(): number;
}
export class NavGrid {
  static build(world: CollisionWorld, opts: { cellSize: number; agentHalfExtents: Vec3; floorLevels?: number[] }): NavGrid;
  findPath(from: Vec3, to: Vec3): Vec3[] | null;        // 足元位置の経由点列（to に近い順不同でなく from→to）
  pathDistance(from: Vec3, to: Vec3, maxDistance: number): number | null;
  nearest(pos: Vec3): Vec3 | null;
}
```
仕様 §2.3 を完全に実装する。要点:
- 索敵: 距離（敵中心→プレイヤー中心）≤ 索敵距離 かつ `!world.segmentBlocked(muzzle, playerCenter)`。カメラ・プレイヤーの向き・先制攻撃に依存しない。
- 初回: 有効な射線を初めて得た時刻 t0 に `burstStartAt = t0 + firstShotDelay`（予告は `burstStartAt − telegraph` から）。バースト: `burstCount` 発を `burstInterval` 間隔、次のバースト開始は前の開始 + `burstPeriod`。
- 射線喪失時も `nextBurstAt` を保持。再露出時刻 te で `burstStartAt = max(nextBurstAt, te + telegraph)`。記憶 8 秒で失効（`alert=false`）。失効後に再発見したら初回扱い。
- 各発ごとに銃口からの射線を確認し、遮蔽なら**その発は撃たない**（スケジュールは進める）。
- 偏差: `solveLinearLead(r, playerVel, bulletSpeed, 1.2)`。解なしなら `t = min(|r|/speed, 1.2)`。狙点 = center + v t。ばらつき ≤ 0.5°（`rng`）。`projectiles.spawnEnemyBullet(muzzle, dir, speed, damage, lifetime, id, time)`、`shotsFired++`、`lastShotAt = time`、events に `enemyFire`。
- 警備ロボットの移動: 距離 > 55 → 8 m/s で接近（ナビ経路）。25〜55 → 6 m/s 側方移動（周期的に左右を変え、壁に当たれば反転）。< 15 → 8 m/s で後退。15〜25 → 停止または微調整。射線喪失後 0.5 秒以内に最後の確認位置へ移動（ナビ経路）。移動は `world.moveBox` で衝突。重力（床に接地）。敵同士の簡易分離（重なりを避ける押し戻し）。
- 共有: 認識時、ナビ経路距離 ≤ 60 m（`nav.pathDistance`、nav が null なら直線距離）の警備ロボットへ最後の確認位置を共有（`alert=true`、移動先設定。射線がなければ撃たない）。
- 固定砲台: 移動しない。砲塔（`gunDirection`）はプレイヤー方向へ向ける。
- `kind==='target'`: 毎更新 `pos += def.velocity × h`、攻撃も索敵もしない。`hp` は `ENEMIES.target.hp`。
- `tests/enemy.test.ts`: 初回 0.50/0.70 秒（±0.01）、バースト間隔と周期、偏差（移動プレイヤーに命中）、遮蔽後の時刻保持、画面外からの攻撃、**露出時の危険性試験**（警備2＋砲台1、35〜50 m、静止 HP1000 → 15 秒以内に HP ≤ 0。`Game` を使って実行）。

### 3.9 `src/stage/stageData.ts` / `src/stage/verify.ts`（F）

- `export const STAGE_DATA: StageData`（`src/types.ts` の形式）。ヘルパーで記述してよいが、最終的に純粋なデータとして評価できること。
- `verify.ts` は `export function verifyStage(data: StageData): StageReport` を提供し、`tests/stage.test.ts` から実行。ボクセル格子（2 m）＋ダイクストラで「自由飛行を許した下限」の最短経路を制御砲台の可視位置経由で計算し、1500 m 以上を確認する（詳細は SPEC §2.2）。区画数 ≥ 15、必須通過区画 ≥ 12、分岐 ≥ 3、環状 ≥ 2、飛行必須箇所 ≥ 6（各 6〜16 m、歩行・ジャンプのみでは不可、最小構成（EN90、12.8 m/s）で可）、3 層以上、60×50 m アリーナ ≥ 5、4 体交差射線区画 ≥ 5、6 種類以上の区画種別、敵 45（警備 30 / 砲台 15 / 制御 6、全て到達可能な床上、AABB と重ならない）、開始地点が敵から遮蔽、隔壁の衝突が見た目と一致、必須経路の全員が通過可能。

### 3.10 `src/render/*`（G）

```ts
// src/render/renderer.ts
export class GameRenderer {
  constructor(container: HTMLElement);
  readonly scene: THREE.Scene; readonly camera: THREE.PerspectiveCamera; readonly renderer: THREE.WebGLRenderer;
  setStage(data: StageData): void;            // ステージメッシュを構築（再出撃で作り直さない）
  setBarrierOpen(id: string, open: boolean): void; setGateOpen(open: boolean): void;
  setPlayerLoadout(legs: LegsKind): void;     // 2脚/4脚モデル切り替え
  setGarageMode(on: boolean): void;           // 格納庫: 機体を正面から映す固定カメラ・回転台
  update(frame: { dtReal: number; camera: SimCamera; player: PlayerView; enemies: EnemyView[]; projectiles: ProjectileView[]; missileTrails?: never; events: SimEvent[]; time: number }): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
```
- `src/render/mech.ts`: `createPlayerMech(legs): MechModel`（コアラ頭：球体の頭、左右の大きな丸い耳、黒い鼻、目、装甲板、関節、武器保持部の右腕、推進器）。`MechModel.update({ aimDirection, yaw, walkPhase, speed, boosting, thrusting, grounded })` で腕の向き（実際の射出方向）、脚の歩行アニメーション、推進器の発光。2 脚/4 脚で脚の本数が変わる。
- `src/render/enemyModels.ts`: 警備ロボット（脚付き、銃）、固定砲台（台座＋回転砲塔）、制御砲台は識別できる標識（発光リング・色）。予告中は砲口を明滅。
- `src/render/stageMeshes.ts`: `StageData.solids/decor/lights/barriers/gate` からメッシュ生成。マテリアルキー → `MeshStandardMaterial`。同一マテリアルの静的ボックスは `BufferGeometryUtils.mergeGeometries` で結合して描画負荷を抑える。隔壁・ゲートは個別メッシュ（開閉アニメーション）。警告灯・標識は emissive。
- `src/render/effects.ts`: MG 曳光（短い発光ボックス）、ビーム軌跡（0.12 秒のシリンダー）、ミサイル噴射、命中火花、被弾、撃破爆発、QB/飛行の噴射。全て寿命付きで確実に破棄（`dispose`）。
- 外部アセット禁止。ライトは少数（Hemisphere + Directional + 区画ごとの PointLight は最大 8 程度、それ以外は emissive）。

### 3.11 `src/ui/*`（H）

```ts
// src/ui/hud.ts
export class Hud { constructor(container: HTMLElement); update(view: HudView): void; setVisible(v: boolean): void; }
// src/ui/garage.ts
export class GarageUI {
  constructor(container: HTMLElement, callbacks: { onLoadoutChange(l: Loadout): void; onLaunch(): void });
  setLoadout(l: Loadout): void; setVisible(v: boolean): void; setPointerLockError(msg: string | null): void;
}
// src/ui/overlays.ts
export class Overlays {
  constructor(container: HTMLElement, callbacks: { onResume(): void; onRetry(): void; onGarage(): void });
  showPause(pointerLockError: string | null): void; showResult(kind: 'cleared' | 'failed', summary: ResultSummary): void; hide(): void;
}
export interface ResultSummary { elapsedSeconds: number; controlsDestroyed: number; enemiesDestroyed: number; failReason: 'hp' | 'fall' | null; }
// src/ui/controlsText.ts
export const CONTROLS_SECTIONS: { title: string; lines: string[] }[]; // 操作説明（§8 の必須文言を含む）
```
- HUD の要素: 中央ロック円（半径 `view.lock.radiusCssPx`、SVG/DIV。リサイズで更新）、照準点、対象マーカー（現在位置）、補正照準マーカー（形と文字で「補正中」「解なし」を区別、ミサイルでは初期偏差点）、左: 武器・残弾（ビームは「∞ / 1射 8 EN」）、右: EN 数値＋バー、下: HP 数値＋バー、移動モード（歩行/グライド/QB 噴射中/慣性減速、接地/上昇/飛行/落下）、QB 可否と残り時間、目標情報（区画名、次の目標、制御砲台 n/6、隔壁開放、脱出可能）、発射拒否メッセージ（ロック未完了/EN 不足/弾切れ）、被弾方向インジケーター、敵の予告マーカー、制御砲台マーカー、目標方向マーカー。
- 状態差は色だけでなく文字・形・進捗で表現。数値は `params.ts` 由来（`view` で渡される）。
- 格納庫: 部品選択（FCS 3、ジェネレーター 3、脚部 2）、各選択肢の長所短所（`PART_DESCRIPTIONS`）、実効値（`computeEffectiveStats`: 最大 EN、回復率、ロック所要時間、水平移動速度 = 10×倍率 など）、操作説明、出撃ボタン。3D プレビューは描画側（GarageUI は DOM のみ）。
- 一時停止: 再開ボタン（ポインターロック再取得）、操作説明、格納庫へ戻る、ポインターロック失敗の説明と再試行。
- 結果: クリア/失敗、経過時間、再出撃（同じ構成）、格納庫へ戻る。

## 4. テスト規約

- vitest（`npm test`）。`tests/*.test.ts`。ヘッドレスで `Game` を使う（`new Game({ stage, loadout, seed, viewport: {width:1280,height:720}, buildNav:false })`）。
- 射撃試験のステージは `tests/helpers/testStage.ts` に作る: 銃口が (0,20,0) になるようプレイヤーを配置（`pos = [0,20,0] − rotateY(PLAYER.muzzleOffset, yaw)`、yaw = π で前方 +Z）、足元に小さな床（4×4 m、上面 = pos.y）、標的は `kind:'target'` の EnemyDef（`position = center`、`velocity`）。カメラは毎フレーム `game.camera.lookAt(targetCenter)` で標的を中央に保つ。
- ヒット数は `game.drainEvents()` の `enemyHit` イベント（`enemyId` 一致）で数える。

## 5. 実装後の契約補足（統合時に確定した事項）

- **前方は −Z**: `PLAYER.muzzleOffset = [0.95, 2.05, -0.9]`、`ENEMIES.guard.muzzleOffset = [0.7, 1.7, -0.8]`（yaw=0 のとき機体前方 −Z 側に銃口がある）。描画側の砲身先端はこの点に一致させる。
- **§3.1/§3.2 衝突の境界規約**: 境界は閉集合として扱う（面に接する・角をかすめる・面上で終わる線分は遮蔽/命中とみなす）。隣接する 2 枚の壁の継ぎ目平面に沿う射線が壁を抜けないための保守的な規約。`raycast` の `maxDist` は 0 以上、非有限の入力は null/false。`sweepSphere` の `point` は接触時の球の中心。`moveBox` は既存の重なりを押し出さない（配置側が `boxOverlaps` で回避する）。`geom.ts` は追加で `slabIntersect` / `segmentAABBHit` / `SlabHit` を export する。`collision.ts` は `CONTACT_MARGIN = 1e-4`、`CELL_SIZE = 16` を持つ（実装上の定数であり仕様値ではない）。
- **§3.3 弾道**: `WEAPONS.machinegun.maxResidualMeters = 0.01`（§4.3 の残差基準）と `maxChordDeviationMeters = 0.01`（§4.5 の曲線近似のずれ）を `params.ts` に置き、`ballistics.ts` / `projectiles.ts` が参照する。`quarticRootsInRange` は |f| ≤ 1e-9·Σ|c_i|·t^i の極値・端点を接する根として返す。
- **§3.5 FCS**: 120 m と円の半径の境界は 1e-6（m / px）の許容付きで「以内」とする（§4.6 の A04/A13 がちょうど 120 m のため）。
- **§3.6 武器**: `fireDenied` イベントは武器か理由が直前と異なれば即時、同じ組み合わせの連続は 0.5 秒に 1 回。
- **§3.7 弾体**: `integrate` は撃破した敵の `HittableSphere.alive` を false にし、同一更新内の後続弾は通過させる。ミサイルの観測は `prevCenter`（時刻 `time` の中心）を `lastObservedAt = time` として記録する。発射直後の弾は `[max(time, firedAt), time+h]` の部分区間だけ進める。
- **§3.8 敵**: `NavGrid.findPathToward(from, to): { path, reached } | null`（到達不能時は最接近点までの経路）を追加。隔壁・ゲートのコライダーは `StageRuntime` が `'barrier:<id>'` / `'gate:<id>'` タグを付け、`NavGrid` はそのタグで静的通行可否から除外し、実際の開閉は線分判定で反映する。露出時の危険性試験は `tests/exposure.test.ts` と `tests/enemy.test.ts` の両方にある。
- **§3.10 描画**: `MechModel.update` は `weapon?`, `gliding?`, `alive?` も受け取る。再出撃時は `main.ts` が全隔壁・ゲートを `setBarrierOpen(id,false)` / `setGateOpen(false)` で閉じる。`LightDef.intensity` は 1〜2 を通常の照明とし、描画側で ×30（cd）に換算する。視覚効果のタイマーは sim 時間で進める（一時停止中は止まる）。
- **§3.11 UI**: `Overlays.showResult(kind, summary, pointerLockError?)`。`HudView.movement.horizontalSpeedMultiplier` を追加（main が `computeEffectiveStats` から渡す）。`overlays.ts` は `renderControlsSections`, `stopPointerPropagation`, `formatElapsed`, `splitMinutesTenths` を、`hud.ts` は `inferHorizontalSpeedMultiplier` を追加 export する。
- **§3.9 ステージ**: `verify.ts` は格子経路長（`gridPathMeters`）と紐張り後の推定（`shortestPathMeters`）の両方を報告する。`VERIFY_THRESHOLDS` と `STAGE_ROOMS` を追加 export する。
- **統合レビュー後の追加**: `Player.canQuickBoost(time, ctrlDown)`（HUD の QB 可否表示は applyEdgeInput と同じ条件を使う）、`InputManager.isHeld(code)`、`GameRenderer.resetRun()`（再出撃時に効果と歩行状態を破棄。`beginRun` が呼ぶ）、`Enemy.moveLos/moveLosLostAt/retreatBlockedUntil`（移動判断用の射線は喪失後 0.1 秒保持し、後退が壁で塞がれたら 0.6 秒側方移動へ切り替える。射撃判断は実射線のまま）、`main.ts` の `nextObjectiveText`（制御砲台破壊後は説明文の「。」以降を表示）。描画側の右腕は銃口を回転中心にし、上腕は肩（胴体固定）と肘を毎フレーム結ぶ。カメラ追従は `sweepSphere`（半径 `CAMERA.collisionMargin`）で壁から余裕を保ち、注視点から 1.6 m 以内に寄ったら自機を非表示にする。
- **開発用フック**: `src/main.ts` は `import.meta.env.DEV && ?devhook` のときだけ `window.__AK2_DEV`（`launchNoLock`, `resumeNoLock`, `pause`, `step`, `capture`）を公開する。本番ビルドには含まれない。
