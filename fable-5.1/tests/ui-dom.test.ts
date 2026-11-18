/**
 * src/ui の DOM 出力を、依存追加なしの最小 DOM スタブで確認する（jsdom なし）。
 * レイアウトは検証できないが、ロック円の半径・文字列・状態クラス・ボタンのコールバック・伝播停止を確かめる。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LOADOUT, FCS, LEGS, OBJECTIVE, PLAYER, WEAPONS, computeEffectiveStats, lockRadiusCssPx } from '../src/params';
import { inferHorizontalSpeedMultiplier } from '../src/ui/hud';
import type { HudView, Loadout } from '../src/types';

// ---------------------------------------------------------------- 最小 DOM スタブ

type Listener = (ev: StubEvent) => void;

class StubEvent {
  stopped = false;
  prevented = false;
  constructor(readonly type: string) {}
  stopPropagation(): void {
    this.stopped = true;
  }
  preventDefault(): void {
    this.prevented = true;
  }
}

class ClassList {
  constructor(private readonly el: StubElement) {}
  private list(): string[] {
    return this.el.className.split(/\s+/).filter((s) => s.length > 0);
  }
  contains(n: string): boolean {
    return this.list().includes(n);
  }
  add(n: string): void {
    if (!this.contains(n)) this.el.className = [...this.list(), n].join(' ');
  }
  remove(n: string): void {
    this.el.className = this.list().filter((s) => s !== n).join(' ');
  }
  toggle(n: string, force?: boolean): boolean {
    const on = force ?? !this.contains(n);
    if (on) this.add(n);
    else this.remove(n);
    return on;
  }
}

class StubElement {
  className = '';
  readonly children: (StubElement | string)[] = [];
  parent: StubElement | null = null;
  readonly style: Record<string, string> = {};
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  readonly classList = new ClassList(this);
  type = '';
  scrollTop = 0;
  private text = '';

  constructor(readonly tagName: string, readonly namespaceURI: string | null = null) {}

  get textContent(): string {
    if (this.children.length === 0) return this.text;
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(s: string) {
    this.children.length = 0;
    this.text = s;
  }
  /** 直接の文字列だけ（子要素の文字は含まない） */
  ownText(): string {
    if (this.children.length === 0) return this.text;
    return this.children.filter((c): c is string => typeof c === 'string').join('');
  }
  set innerHTML(s: string) {
    if (s !== '') throw new Error('stub: innerHTML only supports clearing');
    this.children.length = 0;
    this.text = '';
  }
  appendChild<T extends StubElement>(c: T): T {
    this.children.push(c);
    c.parent = this;
    return c;
  }
  append(...nodes: (StubElement | string)[]): void {
    for (const n of nodes) {
      if (typeof n === 'string') this.children.push(n);
      else this.appendChild(n);
    }
  }
  setAttribute(k: string, v: string): void {
    if (k === 'class') this.className = v;
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    if (k === 'class') return this.className;
    return this.attrs.has(k) ? (this.attrs.get(k) as string) : null;
  }
  addEventListener(type: string, fn: Listener): void {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  scrollIntoView(): void {}

  /** テスト用: イベントをバブリングさせて配信 */
  dispatch(type: string): StubEvent {
    const ev = new StubEvent(type);
    let cur: StubElement | null = this;
    while (cur && !ev.stopped) {
      for (const fn of cur.listeners.get(type) ?? []) fn(ev);
      cur = cur.parent;
    }
    return ev;
  }
  /** テスト用: 条件に合う子孫を全て集める */
  find(pred: (e: StubElement) => boolean, out: StubElement[] = []): StubElement[] {
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      if (pred(c)) out.push(c);
      c.find(pred, out);
    }
    return out;
  }
  hasClass(n: string): boolean {
    return this.classList.contains(n);
  }
  /** display:none の祖先がなければ表示中 */
  isDisplayed(): boolean {
    let cur: StubElement | null = this;
    while (cur) {
      if (cur.style.display === 'none') return false;
      cur = cur.parent;
    }
    return true;
  }
}

const stubDocument = {
  createElement: (tag: string) => new StubElement(tag.toLowerCase()),
  createElementNS: (ns: string, tag: string) => new StubElement(tag, ns),
};

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = stubDocument;
});

// ---------------------------------------------------------------- HUD

function baseView(over: Partial<HudView> = {}): HudView {
  const st = computeEffectiveStats(DEFAULT_LOADOUT);
  const w = 1280;
  const h = 720;
  return {
    state: 'playing',
    viewportWidth: w,
    viewportHeight: h,
    elapsedSeconds: 65.25,
    hp: PLAYER.maxHp,
    maxHp: PLAYER.maxHp,
    en: 87.3,
    maxEn: st.maxEn,
    regenPerSecond: st.regenPerSecond,
    weapon: 'machinegun',
    ammo: { machinegun: WEAPONS.machinegun.ammo, missile: WEAPONS.missile.ammo },
    beamEnCost: WEAPONS.beam.enCost,
    lock: { state: 'none', targetId: null, progress: 0, radiusCssPx: lockRadiusCssPx('medium', w, h), lockSeconds: st.lockSeconds },
    targetMarker: null,
    aimMarker: null,
    fireControl: {
      status: 'inactive',
      weapon: 'machinegun',
      targetId: null,
      evaluatedAtSeconds: null,
      muzzlePosition: null,
      targetPosition: null,
      targetVelocity: null,
      launchDirection: null,
      predictedFlightSeconds: null,
      predictedInterceptPosition: null,
      aimPoint: null,
      residualMeters: null,
    },
    fireDenied: null,
    movement: {
      horizontalMode: 'walk',
      verticalMode: 'grounded',
      glideEnabled: false,
      qbReady: true,
      qbCooldownRemainingSeconds: 0,
      qbImpulseRemainingSeconds: 0,
      qbCost: PLAYER.qb.cost,
      horizontalSpeedMultiplier: inferHorizontalSpeedMultiplier({ maxEn: over.maxEn ?? st.maxEn, regenPerSecond: over.regenPerSecond ?? st.regenPerSecond }),
      speed: 0,
    },
    objective: {
      currentSectorId: 'S01',
      currentSectorName: '搬入口',
      nextObjective: '制御砲台 CT-1 を破壊',
      controlsDestroyed: 0,
      controlsRequired: OBJECTIVE.controlsRequired,
      openBarrierIds: [],
      recentBarrierLabel: null,
      gateOpen: false,
      enemiesAlive: OBJECTIVE.totalEnemies,
      enemiesTotal: OBJECTIVE.totalEnemies,
    },
    hitIndicators: [],
    telegraphMarkers: [],
    controlTurretMarkers: [],
    objectiveMarker: null,
    pointerLockError: null,
    ...over,
  };
}

/** 各要素が直接持つ文字列（textContent で設定した文字と文字列の子）を改行で連結する */
const allText = (root: StubElement): string =>
  root
    .find(() => true)
    .map((e) => e.ownText())
    .filter((s) => s.length > 0)
    .join('\n');

describe('Hud', () => {
  it('draws the lock circle with radius exactly view.lock.radiusCssPx and updates it on resize', async () => {
    const { Hud } = await import('../src/ui/hud');
    const container = new StubElement('div');
    const hud = new Hud(container as unknown as HTMLElement);
    const v = baseView();
    hud.update(v);
    const circles = container.find((e) => e.tagName === 'circle');
    expect(circles.length).toBe(3);
    for (const c of circles) expect(Number(c.getAttribute('r'))).toBe(v.lock.radiusCssPx);
    expect(v.lock.radiusCssPx).toBe(FCS.kinds.medium.radiusFactor * 720);
    const svg = container.find((e) => e.tagName === 'svg')[0];
    expect(Number(svg.getAttribute('width'))).toBe(2 * v.lock.radiusCssPx + 8);
    expect(svg.getAttribute('data-state')).toBe('none');

    // リサイズ: 1920×1080 → D=1080
    const v2 = baseView({ viewportWidth: 1920, viewportHeight: 1080, lock: { ...v.lock, radiusCssPx: lockRadiusCssPx('medium', 1920, 1080) } });
    hud.update(v2);
    for (const c of container.find((e) => e.tagName === 'circle')) expect(Number(c.getAttribute('r'))).toBe(0.2 * 1080);
  });

  it('shows weapon/ammo, EN, HP, movement, objective text from the view', async () => {
    const { Hud } = await import('../src/ui/hud');
    const container = new StubElement('div');
    const hud = new Hud(container as unknown as HTMLElement);
    hud.update(baseView());
    const t = allText(container);
    expect(t).toContain('残弾 300 / 300');
    expect(t).toContain('残弾 12 / 12');
    expect(t).toContain(`∞（弾数制限なし）／1射 ${WEAPONS.beam.enCost} EN`);
    expect(t).toContain('EN 87.3 / 120');
    expect(t).toContain('回復 15.00 EN/秒');
    expect(t).toContain('HP 1000 / 1000');
    expect(t).toContain('歩行');
    expect(t).toContain('接地');
    expect(t).toContain(`使用可 (${PLAYER.qb.cost} EN)`);
    expect(t).toContain('搬入口');
    expect(t).toContain('次の目標: 制御砲台 CT-1 を破壊');
    expect(t).toContain('制御砲台 0/6');
    expect(t).toContain('最終ゲート: 閉鎖');
    expect(t).toContain('開放済み隔壁: なし');
    expect(t).toContain('01:05.3');
    expect(t).toContain('FCS 未取得');
    // 選択中の武器行だけ active
    const rows = container.find((e) => e.hasClass('ak2-weapon-row'));
    expect(rows.length).toBe(3);
    expect(rows.filter((r) => r.hasClass('active')).length).toBe(1);
    expect(rows[0].hasClass('active')).toBe(true);
  });

  it('shows acquiring progress, locked state, markers, denial toast, HP warning and hit wedges', async () => {
    const { Hud } = await import('../src/ui/hud');
    const container = new StubElement('div');
    const hud = new Hud(container as unknown as HTMLElement);
    const base = baseView();
    hud.update(
      baseView({
        lock: { ...base.lock, state: 'acquiring', targetId: 'guard-07', progress: 0.45 },
        targetMarker: { x: 700, y: 400, onScreen: true, angle: 0 },
      }),
    );
    let t = allText(container);
    expect(t).toContain('LOCK 45%');
    expect(t).toContain('guard-07');
    const svg = container.find((e) => e.tagName === 'svg')[0];
    expect(svg.getAttribute('data-state')).toBe('acquiring');
    const prog = container.find((e) => e.className === 'ak2-lock-progress')[0];
    const circ = 2 * Math.PI * base.lock.radiusCssPx;
    expect(prog.getAttribute('stroke-dasharray')).toBe(`${(circ * 0.45).toFixed(2)} ${circ.toFixed(2)}`);
    const target = container.find((e) => e.hasClass('ak2-marker-target'))[0];
    expect(target.isDisplayed()).toBe(true);
    expect(target.style.transform).toBe('translate(700.0px, 400.0px)');
    expect(target.hasClass('offscreen')).toBe(false);

    // ロック完了 + 補正解あり + 画面外の補正マーカー（右上方向）
    hud.update(
      baseView({
        weapon: 'beam',
        en: 5,
        hp: 240,
        lock: { ...base.lock, state: 'locked', targetId: 'guard-07', progress: 1 },
        targetMarker: { x: 700, y: 400, onScreen: true, angle: 0 },
        aimMarker: { x: 2000, y: -50, onScreen: false, angle: -Math.PI / 4, status: 'solved' },
        fireControl: { ...base.fireControl, status: 'solved', targetId: 'guard-07', muzzlePosition: [0, 20, 0], targetPosition: [0, 20, 60] },
        fireDenied: { weapon: 'beam', reason: 'noEn', ageSeconds: 0.2 },
        hitIndicators: [{ angle: 0, ageSeconds: 0.1 }],
        telegraphMarkers: [{ x: 100, y: 100, onScreen: true, angle: 0 }],
        controlTurretMarkers: [{ x: 300, y: 300, onScreen: true, angle: 0, id: 'CT-2', alive: false }],
        objectiveMarker: { x: 0, y: 0, onScreen: false, angle: Math.PI, label: '隔壁 B2' },
        movement: { ...base.movement, horizontalMode: 'glide', verticalMode: 'falling', qbReady: false, qbCooldownRemainingSeconds: 0.6, speed: 40 },
      }),
    );
    t = allText(container);
    expect(t).toContain('LOCKED guard-07 60 m');
    expect(t).toContain('補正中');
    expect(svg.getAttribute('data-state')).toBe('locked');
    const aim = container.find((e) => e.hasClass('ak2-marker-aim'))[0];
    expect(aim.isDisplayed()).toBe(true);
    expect(aim.hasClass('offscreen')).toBe(true);
    // 右上 45° → 端の点は上端（余白 44px）: y = 44, x = 640 + (360-44) = 956
    expect(aim.style.transform).toBe('translate(956.0px, 44.0px)');
    expect(t).toContain('ビーム: EN不足');
    const toast = container.find((e) => e.hasClass('ak2-toast'))[0];
    expect(toast.hasClass('show')).toBe(true);
    expect(t).toContain('HP 240 / 1000');
    expect(t).toContain('HP 25% 未満');
    const hpPanel = container.find((e) => e.hasClass('ak2-hp'))[0];
    expect(hpPanel.hasClass('red')).toBe(true);
    expect(t).toContain('慣性減速中(グライド)');
    expect(t).toContain('落下');
    expect(t).toContain('冷却 0.6s');
    expect(t).toContain('40.0 m/s');
    expect(t).toContain('制御 CT-2 破壊済');
    const ctrl = container.find((e) => e.hasClass('ak2-marker-control'))[0];
    expect(ctrl.hasClass('dead')).toBe(true);
    expect(t).toContain('隔壁 B2');
    const paths = container.find((e) => e.tagName === 'path');
    expect(paths.length).toBe(1);
    expect(paths[0].getAttribute('opacity')).toBe('0.90');
    expect(paths[0].getAttribute('d')).toMatch(/^M .* A /);
    const vignette = container.find((e) => e.hasClass('ak2-hud-vignette'))[0];
    expect(Number(vignette.style.opacity)).toBeGreaterThan(0.5);
    // ビーム行の EN 不足表示
    const beamAmmo = container.find((e) => e.hasClass('ak2-weapon-ammo'))[1];
    expect(beamAmmo.hasClass('empty')).toBe(true);

    // 解なし → 「解なし」の文字、トーストは 1.5 秒で消える、被弾も消える
    hud.update(
      baseView({
        lock: { ...base.lock, state: 'locked', targetId: 'guard-07', progress: 1 },
        aimMarker: { x: 10, y: 10, onScreen: true, angle: 0, status: 'no_solution' },
        fireControl: { ...base.fireControl, status: 'no_solution', targetId: 'guard-07' },
        fireDenied: { weapon: 'missile', reason: 'noLock', ageSeconds: 1.6 },
        hitIndicators: [{ angle: 1, ageSeconds: 1.2 }],
      }),
    );
    t = allText(container);
    expect(t).toContain('解なし');
    expect(aim.hasClass('no-solution')).toBe(true);
    expect(toast.hasClass('show')).toBe(false);
    expect(paths[0].style.display).toBe('none');
    expect(vignette.style.opacity).toBe('0.00');
    expect(container.find((e) => e.hasClass('ak2-marker-target'))[0].isDisplayed()).toBe(false);

    // ミサイルのロック未完了の拒否文言
    hud.update(baseView({ fireDenied: { weapon: 'missile', reason: 'noLock', ageSeconds: 0 } }));
    expect(allText(container)).toContain('ミサイル: ロック未完了のため発射拒否');
    hud.update(baseView({ fireDenied: { weapon: 'machinegun', reason: 'noAmmo', ageSeconds: 0 } }));
    expect(allText(container)).toContain('マシンガン: 弾切れ');
  });

  it('setVisible hides the root', async () => {
    const { Hud } = await import('../src/ui/hud');
    const container = new StubElement('div');
    const hud = new Hud(container as unknown as HTMLElement);
    hud.setVisible(false);
    const root = container.find((e) => e.hasClass('ak2-hud'))[0];
    expect(root.style.display).toBe('none');
    hud.setVisible(true);
    expect(root.style.display).toBe('');
  });
});

// ---------------------------------------------------------------- 格納庫

describe('GarageUI', () => {
  it('defaults to medium/balanced/biped, updates effective stats, and reports loadout changes', async () => {
    const { GarageUI } = await import('../src/ui/garage');
    const container = new StubElement('div');
    const changes: Loadout[] = [];
    let launches = 0;
    const ui = new GarageUI(container as unknown as HTMLElement, {
      onLoadoutChange: (l) => changes.push(l),
      onLaunch: () => launches++,
    });
    const pressed = () => container.find((e) => e.hasClass('ak2-part-btn') && e.getAttribute('aria-pressed') === 'true').map((b) => `${b.dataset.part}:${b.dataset.kind}`);
    expect(pressed()).toEqual(['fcs:medium', 'generator:balanced', 'legs:biped']);
    let t = allText(container);
    expect(t).toContain('ARMORED KOALA 2 — 格納庫');
    expect(t).toContain('選択中: 中範囲FCS ／ 均衡ジェネレーター ／ 2脚');
    expect(t).toContain('120 EN');
    expect(t).toContain('15.00 EN/秒');
    expect(t).toContain('0.800 秒');
    expect(t).toContain('0.20D');
    expect(t).toContain('通常 10.0 ／ グライド 22.0 ／ 空中 16.0 ／ QB 80.0 m/s');
    // 長所短所と生の数値
    expect(t).toContain('長所: ロック円が最も広く');
    expect(t).toContain('短所: 最大EN90');
    expect(t).toContain('ロック円半径 0.30D ／ 基本ロック所要時間 1.20 秒');
    expect(t).toContain('最大EN 180 ／ 基本回復率 10 EN/秒');
    expect(t).toContain('水平移動速度 ×0.80 ／ EN回復率 ×0.75 ／ ロック速度 ×1.50');
    // 操作説明が含まれる
    expect(t).toContain('中央の照準を補正マーカーへ手動で合わせる必要はありません');
    expect(t).toContain('出撃');

    // 4脚を選択 → 仕様例: 最大EN120、回復 11.25、ロック 0.533
    const quad = container.find((e) => e.dataset.part === 'legs' && e.dataset.kind === 'quadruped')[0];
    const ev = quad.dispatch('click');
    expect(ev.stopped).toBe(true);
    expect(changes).toEqual([{ fcs: 'medium', generator: 'balanced', legs: 'quadruped' }]);
    expect(pressed()).toEqual(['fcs:medium', 'generator:balanced', 'legs:quadruped']);
    t = allText(container);
    expect(t).toContain('11.25 EN/秒');
    expect(t).toContain('0.533 秒');
    expect(t).toContain('通常 8.0 ／ グライド 17.6 ／ 空中 12.8 ／ QB 64.0 m/s');
    // 同じ部品の再クリックは通知しない
    quad.dispatch('click');
    expect(changes.length).toBe(1);

    // setLoadout はコールバックを呼ばない
    ui.setLoadout({ fcs: 'narrow', generator: 'recovery', legs: 'biped' });
    expect(changes.length).toBe(1);
    expect(pressed()).toEqual(['fcs:narrow', 'generator:recovery', 'legs:biped']);
    expect(allText(container)).toContain('0.400 秒');
    expect(allText(container)).toContain('90 EN');

    // 出撃 → onLaunch。ポインターロック失敗 → 再試行で再度 onLaunch
    const launch = container.find((e) => e.tagName === 'button' && e.textContent === '出撃')[0];
    expect(launch.type).toBe('button');
    expect(launch.dispatch('click').stopped).toBe(true);
    expect(launches).toBe(1);
    const errBox = container.find((e) => e.hasClass('ak2-plerror'))[0];
    expect(errBox.hasClass('show')).toBe(false);
    ui.setPointerLockError('NotAllowedError: denied');
    expect(errBox.hasClass('show')).toBe(true);
    expect(allText(container)).toContain('NotAllowedError: denied');
    const retry = container.find((e) => e.tagName === 'button' && e.textContent === '再試行')[0];
    retry.dispatch('click');
    expect(launches).toBe(2);
    ui.setPointerLockError(null);
    expect(errBox.hasClass('show')).toBe(false);

    // 非ボタン領域のクリックもゲームへ伝播しない
    const root = container.find((e) => e.hasClass('ak2-garage'))[0];
    expect(root.dispatch('mousedown').stopped).toBe(true);
    ui.setVisible(false);
    expect(root.style.display).toBe('none');
  });
});

// ---------------------------------------------------------------- オーバーレイ

describe('Overlays', () => {
  it('shows pause/result dialogs, wires buttons, and stops propagation', async () => {
    const { Overlays } = await import('../src/ui/overlays');
    const container = new StubElement('div');
    const calls: string[] = [];
    const ov = new Overlays(container as unknown as HTMLElement, {
      onResume: () => calls.push('resume'),
      onRetry: () => calls.push('retry'),
      onGarage: () => calls.push('garage'),
    });
    const root = container.find((e) => e.hasClass('ak2-overlays'))[0];
    const pause = container.find((e) => e.hasClass('ak2-pause'))[0];
    const result = container.find((e) => e.hasClass('ak2-result'))[0];
    const perr = pause.find((e) => e.hasClass('ak2-plerror'))[0];
    expect(root.hasClass('show')).toBe(false);

    ov.showPause(null);
    expect(root.hasClass('show')).toBe(true);
    expect(pause.hasClass('show')).toBe(true);
    expect(result.hasClass('show')).toBe(false);
    expect(perr.hasClass('show')).toBe(false);
    expect(allText(pause)).toContain('一時停止');
    expect(allText(pause)).toContain('中央の照準を補正マーカーへ手動で合わせる必要はありません');
    const btn = (label: string, within: StubElement) => within.find((e) => e.tagName === 'button' && e.textContent === label)[0];
    expect(btn('再開', pause).dispatch('click').stopped).toBe(true);
    btn('格納庫へ戻る', pause).dispatch('click');
    expect(calls).toEqual(['resume', 'garage']);

    ov.showPause('SecurityError: exited lock');
    expect(perr.hasClass('show')).toBe(true);
    expect(allText(perr)).toContain('SecurityError: exited lock');
    btn('再試行', perr).dispatch('click');
    expect(calls).toEqual(['resume', 'garage', 'resume']);

    ov.showResult('cleared', { elapsedSeconds: 734.2, controlsDestroyed: 6, enemiesDestroyed: 31, failReason: null });
    expect(pause.hasClass('show')).toBe(false);
    expect(result.hasClass('show')).toBe(true);
    let t = allText(result);
    expect(t).toContain('脱出成功');
    expect(t).toContain('12分 14.2秒');
    expect(t).toContain(`6 / ${OBJECTIVE.controlsRequired}`);
    expect(t).toContain(`31 / ${OBJECTIVE.totalEnemies}`);
    btn('再出撃（同じ構成）', result).dispatch('click');
    btn('格納庫へ戻る', result).dispatch('click');
    expect(calls.slice(-2)).toEqual(['retry', 'garage']);

    ov.showResult('failed', { elapsedSeconds: 95.6, controlsDestroyed: 2, enemiesDestroyed: 9, failReason: 'hp' });
    t = allText(result);
    expect(t).toContain('撃破された');
    expect(t).toContain('1分 35.6秒');
    ov.showResult('failed', { elapsedSeconds: 5, controlsDestroyed: 0, enemiesDestroyed: 0, failReason: 'fall' });
    expect(allText(result)).toContain('落下');

    // 背景クリックも伝播しない
    expect(root.dispatch('click').stopped).toBe(true);
    ov.hide();
    expect(root.hasClass('show')).toBe(false);
    expect(result.hasClass('show')).toBe(false);
  });
});

// ---------------------------------------------------------------- レビュー指摘の回帰試験

describe('review regressions', () => {
  it('clock strings roll over at the minute boundary (59.96 → 01:00.0 / 1分 0.0秒)', async () => {
    const { Hud } = await import('../src/ui/hud');
    const { formatElapsed } = await import('../src/ui/overlays');
    const container = new StubElement('div');
    const hud = new Hud(container as unknown as HTMLElement);
    hud.update(baseView({ elapsedSeconds: 59.96 }));
    let t = allText(container);
    expect(t).toContain('01:00.0');
    expect(t).not.toContain('60.0');
    hud.update(baseView({ elapsedSeconds: 119.97 }));
    t = allText(container);
    expect(t).toContain('02:00.0');
    hud.update(baseView({ elapsedSeconds: 65.25 }));
    expect(allText(container)).toContain('01:05.3');
    expect(formatElapsed(59.96)).toBe('1分 0.0秒');
    expect(formatElapsed(119.97)).toBe('2分 0.0秒');
    expect(formatElapsed(734.2)).toBe('12分 14.2秒');
    expect(formatElapsed(0)).toBe('0分 0.0秒');
  });

  it('glide inertia label uses the leg speed multiplier (quadruped steady 17.6 / 12.8 m/s)', async () => {
    const { Hud } = await import('../src/ui/hud');
    const container = new StubElement('div');
    const hud = new Hud(container as unknown as HTMLElement);
    const quad = computeEffectiveStats({ ...DEFAULT_LOADOUT, legs: 'quadruped' });
    const base = baseView({ maxEn: quad.maxEn, regenPerSecond: quad.regenPerSecond });
    const quadSteadyGround = PLAYER.glideGroundSpeed * LEGS.quadruped.speedMul;
    const quadSteadyAir = PLAYER.airSpeed * LEGS.quadruped.speedMul;
    expect(quadSteadyGround).toBeCloseTo(17.6, 9);
    // 4脚・地上・21 m/s: 定常 17.6 を超えているので慣性減速中
    hud.update(baseView({ ...base, movement: { ...base.movement, horizontalSpeedMultiplier: LEGS.quadruped.speedMul, horizontalMode: 'glide', verticalMode: 'grounded', speed: 21 } }));
    expect(allText(container)).toContain('慣性減速中(グライド)');
    // 4脚・地上・定常速度: グライド
    hud.update(baseView({ ...base, movement: { ...base.movement, horizontalSpeedMultiplier: LEGS.quadruped.speedMul, horizontalMode: 'glide', verticalMode: 'grounded', speed: quadSteadyGround } }));
    let t = allText(container);
    expect(t).toContain('グライド');
    expect(t).not.toContain('慣性減速中');
    // 4脚・空中・15 m/s: 定常 12.8 超 → 慣性減速中
    hud.update(baseView({ ...base, movement: { ...base.movement, horizontalSpeedMultiplier: LEGS.quadruped.speedMul, horizontalMode: 'glide', verticalMode: 'falling', speed: 15 } }));
    expect(allText(container)).toContain('慣性減速中(グライド)');
    hud.update(baseView({ ...base, movement: { ...base.movement, horizontalSpeedMultiplier: LEGS.quadruped.speedMul, horizontalMode: 'glide', verticalMode: 'flying', speed: quadSteadyAir } }));
    expect(allText(container)).not.toContain('慣性減速中');
    // 2脚（既定）・地上・22 m/s: 定常 → グライド。23.5 → 慣性減速中
    const bip = baseView();
    hud.update(baseView({ movement: { ...bip.movement, horizontalMode: 'glide', verticalMode: 'grounded', speed: PLAYER.glideGroundSpeed } }));
    expect(allText(container)).not.toContain('慣性減速中');
    hud.update(baseView({ movement: { ...bip.movement, horizontalMode: 'glide', verticalMode: 'grounded', speed: 23.5 } }));
    expect(allText(container)).toContain('慣性減速中(グライド)');
    // 全 3×2 構成で脚部倍率が一意に推定できる（最大EN と回復率の組）
    for (const generator of ['capacity', 'balanced', 'recovery'] as const) {
      for (const legs of ['biped', 'quadruped'] as const) {
        const st = computeEffectiveStats({ fcs: 'medium', generator, legs });
        const steady = PLAYER.glideGroundSpeed * LEGS[legs].speedMul;
        const v = baseView({ maxEn: st.maxEn, regenPerSecond: st.regenPerSecond });
        hud.update(baseView({ ...v, movement: { ...v.movement, horizontalMode: 'glide', verticalMode: 'grounded', speed: steady } }));
        expect(allText(container), `${generator}/${legs} steady`).not.toContain('慣性減速中');
        hud.update(baseView({ ...v, movement: { ...v.movement, horizontalMode: 'glide', verticalMode: 'grounded', speed: steady * 1.2 } }));
        expect(allText(container), `${generator}/${legs} decel`).toContain('慣性減速中(グライド)');
      }
    }
  });

  it('never writes NaN into the lock circle; keeps the last good radius', async () => {
    const { Hud } = await import('../src/ui/hud');
    const container = new StubElement('div');
    const hud = new Hud(container as unknown as HTMLElement);
    const noNaN = () => {
      for (const e of container.find(() => true)) {
        for (const [k, v] of e.attrs) expect(v, `attr ${k}`).not.toMatch(/NaN|Infinity/);
        for (const [k, v] of Object.entries(e.style)) expect(v, `style ${k}`).not.toMatch(/NaN|Infinity/);
      }
    };
    const v = baseView();
    // 最初のフレームから NaN → 0 として扱う
    hud.update(baseView({ lock: { ...v.lock, radiusCssPx: Number.NaN } }));
    noNaN();
    const circles = container.find((e) => e.tagName === 'circle');
    for (const c of circles) expect(c.getAttribute('r')).toBe('0');
    // 正常値 → NaN: 直前の半径を保持
    hud.update(v);
    for (const c of circles) expect(Number(c.getAttribute('r'))).toBe(v.lock.radiusCssPx);
    hud.update(baseView({ lock: { ...v.lock, radiusCssPx: Number.NaN } }));
    noNaN();
    for (const c of circles) expect(Number(c.getAttribute('r'))).toBe(v.lock.radiusCssPx);
    hud.update(baseView({ lock: { ...v.lock, radiusCssPx: Number.POSITIVE_INFINITY } }));
    noNaN();
    for (const c of circles) expect(Number(c.getAttribute('r'))).toBe(v.lock.radiusCssPx);
  });

  it('rounds HP to nearest but never shows 0 while alive', async () => {
    const { Hud } = await import('../src/ui/hud');
    const container = new StubElement('div');
    const hud = new Hud(container as unknown as HTMLElement);
    hud.update(baseView({ hp: 999.2 }));
    expect(allText(container)).toContain('HP 999 / 1000');
    hud.update(baseView({ hp: 999.6 }));
    expect(allText(container)).toContain('HP 1000 / 1000');
    hud.update(baseView({ hp: 0.3 }));
    expect(allText(container)).toContain('HP 1 / 1000');
    hud.update(baseView({ hp: 0 }));
    expect(allText(container)).toContain('HP 0 / 1000');
  });

  it('QB cooldown never displays 0.0 s while cooling and names EN shortage during cooldown', async () => {
    const { Hud } = await import('../src/ui/hud');
    const container = new StubElement('div');
    const hud = new Hud(container as unknown as HTMLElement);
    const b = baseView();
    hud.update(baseView({ movement: { ...b.movement, qbReady: false, qbCooldownRemainingSeconds: 0.03 } }));
    let t = allText(container);
    expect(t).toContain('冷却 0.1s');
    expect(t).not.toContain('冷却 0.0s');
    expect(t).not.toContain('EN不足');
    hud.update(baseView({ en: 5, movement: { ...b.movement, qbReady: false, qbCooldownRemainingSeconds: 0.6 } }));
    t = allText(container);
    expect(t).toContain('冷却 0.6s・EN不足');
    hud.update(baseView({ en: 5, movement: { ...b.movement, qbReady: false, qbCooldownRemainingSeconds: 0 } }));
    expect(allText(container)).toContain(`EN不足 (${PLAYER.qb.cost} EN 必要)`);
  });

  it('places the fire-denial toast inside the lock circle so it cannot cover the lock text', async () => {
    const { Hud } = await import('../src/ui/hud');
    const container = new StubElement('div');
    const hud = new Hud(container as unknown as HTMLElement);
    const center = container.find((e) => e.hasClass('ak2-hud-center'))[0];
    const toast = container.find((e) => e.hasClass('ak2-toast'))[0];
    expect(toast.parent).toBe(center);
    const TOAST_HEIGHT_PX = 34; // styles.css: 16px 文字 + 上下 6px + 枠
    for (const kind of ['narrow', 'medium', 'wide'] as const) {
      for (const [w, h] of [
        [1280, 720],
        [1920, 1080],
      ] as const) {
        const r = lockRadiusCssPx(kind, w, h);
        const v = baseView({ viewportWidth: w, viewportHeight: h, fireDenied: { weapon: 'missile', reason: 'noLock', ageSeconds: 0 } });
        hud.update(baseView({ ...v, lock: { ...v.lock, radiusCssPx: r } }));
        const top = Number.parseFloat(toast.style.top);
        expect(Number.isFinite(top)).toBe(true);
        // 照準点（±7px）より下、ロック文字（r + 10）より上
        expect(top).toBeGreaterThanOrEqual(36);
        expect(top + TOAST_HEIGHT_PX).toBeLessThan(r + 10);
        expect(toast.hasClass('show')).toBe(true);
      }
    }
  });
});

describe('Overlays result screen pointer-lock failure', () => {
  it('shows the explanation and a retry button on the result dialog when re-launch fails', async () => {
    const { Overlays } = await import('../src/ui/overlays');
    const container = new StubElement('div');
    const calls: string[] = [];
    const ov = new Overlays(container as unknown as HTMLElement, {
      onResume: () => calls.push('resume'),
      onRetry: () => calls.push('retry'),
      onGarage: () => calls.push('garage'),
    });
    const result = container.find((e) => e.hasClass('ak2-result'))[0];
    const summary = { elapsedSeconds: 95.6, controlsDestroyed: 2, enemiesDestroyed: 9, failReason: 'hp' as const };
    ov.showResult('failed', summary, null);
    const rerr = result.find((e) => e.hasClass('ak2-plerror'))[0];
    expect(rerr).toBeDefined();
    expect(rerr.hasClass('show')).toBe(false);
    expect(allText(result)).not.toContain('SecurityError');

    // main.ts: overlays.showResult(kind, resultSummary(), res.message)
    ov.showResult('failed', summary, 'SecurityError: exited lock');
    expect(rerr.hasClass('show')).toBe(true);
    const t = allText(result);
    expect(t).toContain('ポインターロックを取得できませんでした');
    expect(t).toContain('SecurityError: exited lock');
    expect(t).toContain('撃破された');
    const retry = rerr.find((e) => e.tagName === 'button' && e.textContent === '再試行')[0];
    expect(retry).toBeDefined();
    expect(retry.dispatch('click').stopped).toBe(true);
    expect(calls).toEqual(['retry']);

    // 2 引数の呼び出し（契約どおり）では非表示に戻る
    ov.showResult('cleared', { ...summary, failReason: null });
    expect(rerr.hasClass('show')).toBe(false);
    expect(allText(result)).not.toContain('SecurityError');
    // 一時停止画面の失敗表示とは独立
    ov.showPause('NotAllowedError');
    const pause = container.find((e) => e.hasClass('ak2-pause'))[0];
    expect(pause.find((e) => e.hasClass('ak2-plerror'))[0].hasClass('show')).toBe(true);
    expect(rerr.hasClass('show')).toBe(false);
  });
});
