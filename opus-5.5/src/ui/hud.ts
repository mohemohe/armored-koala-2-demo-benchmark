// HUD（HTML/CSS）。表示はすべて実際のゲーム状態から毎フレーム生成する。
import { PLAYER, WEAPONS, WEAPON_ORDER, type WeaponId } from '../config';
import { project } from '../sim/camera';
import type { SimEvent } from '../sim/enemies';
import type { Game } from '../sim/game';
import { ESCAPE_ZONE, PORTALS, SECTORS } from '../stage/layout';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface DmgArc {
  el: HTMLDivElement;
  worldAngle: number;
  life: number;
}

export class Hud {
  root = $('hud');
  private fcs = $('fcs-circle');
  private fcsLabel = $('fcs-label');
  private lock = $('lock-marker');
  private lockRing = document.getElementById('lock-ring') as unknown as SVGCircleElement;
  private lockText = $('lock-text');
  private markers = $('markers');
  private dmgLayer = $('dmg-layer');
  private toast = $('toast');
  private vignette = $('vignette');
  private weaponsEl = $('weapons');
  private weaponMsg = $('weapon-msg');
  private enText = $('en-text');
  private enBar = $('en-bar');
  private enState = $('en-state');
  private enWarn = $('en-warn');
  private hpText = $('hp-text');
  private hpBar = $('hp-bar');
  private moveH = $('move-h');
  private moveV = $('move-v');
  private moveGlide = $('move-glide');
  private qbState = $('qb-state');
  private qbBar = $('qb-bar');
  private sectorEl = $('sector');
  private objectiveEl = $('objective');
  private controlsEl = $('controls');
  private barriersEl = $('barriers');
  private timeEl = $('elapsed');
  private dmgArcs: DmgArc[] = [];
  private markerPool: HTMLDivElement[] = [];
  private toastTimer = 0;
  private vignetteT = 0;
  private cache = new Map<HTMLElement, string>();
  private lastSector: string | null = null;
  /** 開口ごとの脱出領域までの経路コスト（開口グラフ上の最短距離） */
  private portalCost = new Map<string, number>();
  private portalCenter = new Map<string, [number, number, number]>();

  constructor() {
    this.buildNav();
    this.weaponsEl.innerHTML = WEAPON_ORDER.map(
      (w) => `<div class="wrow" id="w-${w}"><span class="wkey">${WEAPONS[w].key}</span><span class="wname">${WEAPONS[w].name}</span><span class="wammo" id="w-${w}-ammo"></span><div class="wcd"><div id="w-${w}-cd"></div></div></div>`,
    ).join('');
  }

  /** 開口グラフで各開口から脱出領域までの最短距離を求める（進行方向表示用） */
  private buildNav() {
    const c = (b: { min: number[]; max: number[] }): [number, number, number] => [
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2,
    ];
    for (const p of PORTALS) this.portalCenter.set(p.id, c(p.box));
    const goal = c(ESCAPE_ZONE);
    const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const cost = new Map<string, number>();
    for (const p of PORTALS) cost.set(p.id, Infinity);
    for (const p of PORTALS) if (p.a === 'S19' || p.b === 'S19') cost.set(p.id, d(this.portalCenter.get(p.id)!, goal));
    const done = new Set<string>();
    for (;;) {
      let u: string | null = null;
      for (const [id, v] of cost) if (!done.has(id) && v < Infinity && (u === null || v < cost.get(u)!)) u = id;
      if (u === null) break;
      done.add(u);
      const pu = PORTALS.find((p) => p.id === u)!;
      for (const q of PORTALS) {
        if (done.has(q.id)) continue;
        const share = [pu.a, pu.b].some((sid) => sid === q.a || sid === q.b);
        if (!share) continue;
        const nv = cost.get(u)! + d(this.portalCenter.get(u)!, this.portalCenter.get(q.id)!);
        if (nv < cost.get(q.id)!) cost.set(q.id, nv);
      }
    }
    this.portalCost = cost;
  }

  /** 現在の区画から脱出へ向かう次の出口（または脱出領域） */
  private nextNav(game: Game): { pos: [number, number, number]; label: string } | null {
    const sid = game.currentSectorId;
    if (!sid) return null;
    const p = game.player.pos;
    if (sid === 'S19') {
      const z = ESCAPE_ZONE;
      return { pos: [(z.min[0] + z.max[0]) / 2, z.min[1] + 1, (z.min[2] + z.max[2]) / 2], label: '脱出領域' };
    }
    let best: string | null = null;
    let bestV = Infinity;
    for (const q of PORTALS) {
      if (q.a !== sid && q.b !== sid) continue;
      const pc = this.portalCenter.get(q.id)!;
      const v = Math.hypot(pc[0] - p[0], pc[1] - p[1], pc[2] - p[2]) + this.portalCost.get(q.id)!;
      if (v < bestV) {
        bestV = v;
        best = q.id;
      }
    }
    if (!best) return null;
    const q = PORTALS.find((x) => x.id === best)!;
    const dest = SECTORS.find((x) => x.id === (q.a === sid ? q.b : q.a))!;
    const pc = this.portalCenter.get(best)!;
    return { pos: [pc[0], q.box.min[1] + 1, pc[2]], label: `→ ${dest.id} ${dest.name}${q.barrierId ? `（${q.barrierId === 'GATE' ? '最終ゲート' : q.barrierId}）` : ''}` };
  }

  reset() {
    this.lastSector = null;
    for (const a of this.dmgArcs) a.el.remove();
    this.dmgArcs = [];
    this.toastTimer = 0;
    this.toast.classList.remove('show');
    this.vignetteT = 0;
    this.cache.clear();
  }

  private text(el: HTMLElement, s: string) {
    if (this.cache.get(el) !== s) {
      el.textContent = s;
      this.cache.set(el, s);
    }
  }
  private html(el: HTMLElement, s: string) {
    if (this.cache.get(el) !== s) {
      el.innerHTML = s;
      this.cache.set(el, s);
    }
  }

  showToast(msg: string, kind: 'info' | 'warn' | 'good' = 'info') {
    this.toast.textContent = msg;
    this.toast.className = `show ${kind}`;
    this.toastTimer = 3.2;
  }

  handleEvents(events: SimEvent[], game: Game) {
    for (const ev of events) {
      if (ev.type === 'playerHit') {
        // 被弾方向（攻撃元の方向＝弾の進行方向の逆）をyaw角で保持し、表示時にカメラ向きで回転
        const ang = Math.atan2(ev.dir[0], ev.dir[2]);
        const el = document.createElement('div');
        el.className = 'dmg-arc';
        this.dmgLayer.appendChild(el);
        this.dmgArcs.push({ el, worldAngle: ang, life: 1.4 });
        this.vignetteT = 0.35;
      } else if (ev.type === 'barrierOpened') {
        const b = game.barriers.find((x) => x.id === ev.id);
        this.showToast(`制御砲台破壊 — ${b?.label ?? ev.id} 開放（${game.controlsDestroyed}/6）`, 'good');
      } else if (ev.type === 'gateOpened') {
        this.showToast('制御砲台6/6 — 最終搬出ゲート開放！ 脱出路へ向かえ', 'good');
      }
    }
  }

  private marker(i: number): HTMLDivElement {
    while (this.markerPool.length <= i) {
      const d = document.createElement('div');
      d.className = 'mk';
      this.markers.appendChild(d);
      this.markerPool.push(d);
    }
    return this.markerPool[i];
  }

  update(game: Game, frameDt: number, firing: boolean) {
    const p = game.player;
    const now = game.elapsedSeconds;
    const W = game.viewport.w,
      H = game.viewport.h;
    const cam = game.cam;
    const stats = game.stats;

    // ---- FCS（実際の判定円と同じ半径）
    const R = game.lockRadiusPx();
    this.fcs.style.width = this.fcs.style.height = `${(R * 2).toFixed(1)}px`;
    this.fcs.style.left = `${(W / 2 - R).toFixed(1)}px`;
    this.fcs.style.top = `${(H / 2 - R).toFixed(1)}px`;
    const ls = game.fcs.state;
    this.fcs.dataset.state = ls;
    const prog = game.fcs.progress;
    this.fcsLabel.style.top = `${(H / 2 + R + 6).toFixed(0)}px`;
    this.text(
      this.fcsLabel,
      ls === 'none' ? 'FCS ─ 未捕捉' : ls === 'acquiring' ? `FCS ▷ 捕捉中 ${game.fcs.targetId} ${(prog * 100).toFixed(0)}%` : `FCS ◆ LOCK ${game.fcs.targetId}`,
    );
    this.fcsLabel.dataset.state = ls;
    if (game.fcs.targetId) {
      const e = game.enemies.byId(game.fcs.targetId);
      if (e) {
        const pr = project(cam, e.center(), W, H);
        this.lock.style.display = 'block';
        this.lock.style.left = `${pr.sx.toFixed(1)}px`;
        this.lock.style.top = `${pr.sy.toFixed(1)}px`;
        this.lock.dataset.state = ls;
        const C = 2 * Math.PI * 26;
        this.lockRing.setAttribute('stroke-dasharray', `${(C * prog).toFixed(1)} ${C.toFixed(1)}`);
        this.text(this.lockText, ls === 'locked' ? 'LOCK' : `${(prog * 100).toFixed(0)}%`);
      }
    } else this.lock.style.display = 'none';

    // ---- マーカー（次の目標・制御砲台・射撃予告）
    let mi = 0;
    const put = (x: number, y: number, cls: string, label: string) => {
      const d = this.marker(mi++);
      d.style.display = 'block';
      d.className = `mk ${cls}`;
      d.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      if (d.dataset.label !== label) {
        d.innerHTML = `<i></i><span>${label}</span>`;
        d.dataset.label = label;
      }
    };
    const edgePoint = (pr: { sx: number; sy: number; inFront: boolean }) => {
      let dx = pr.sx - W / 2,
        dy = pr.sy - H / 2;
      if (!pr.inFront) {
        dx = -dx;
        dy = -dy;
      }
      const m = Math.max(Math.abs(dx) / (W / 2 - 200), Math.abs(dy) / (H / 2 - 90), 1e-6);
      return { x: W / 2 + dx / Math.max(m, 1), y: H / 2 + dy / Math.max(m, 1), off: !pr.inFront || m > 1 };
    };
    const obj = this.objective(game);
    // 次の目標：制御砲台
    for (const e of game.enemies.enemies) {
      if (!e.alive || !e.def.isGateControl) continue;
      const c = e.center();
      const d = Math.hypot(c[0] - p.pos[0], c[1] - p.pos[1], c[2] - p.pos[2]);
      const isNext = obj.targetId === e.id;
      if (!isNext && e.def.sectorId !== game.currentSectorId) continue;
      const pr = project(cam, [c[0], c[1] + 3.2, c[2]], W, H);
      const ep = edgePoint(pr);
      put(ep.x, ep.y, `ctrl ${isNext ? 'next' : ''} ${ep.off ? 'off' : ''}`, `CTRL ${e.id}→${e.def.barrierId} ${d.toFixed(0)}m`);
    }
    // 進行方向（現在の区画から脱出へ向かう次の出口）
    const nav = this.nextNav(game);
    if (nav) {
      const pr = project(cam, nav.pos, W, H);
      const ep = edgePoint(pr);
      const d = Math.hypot(nav.pos[0] - p.pos[0], nav.pos[1] - p.pos[1], nav.pos[2] - p.pos[2]);
      const up = nav.pos[1] - 1 - p.pos[1];
      put(ep.x, ep.y, `nav ${ep.off ? 'off' : ''}`, `NAV ${nav.label} ${d.toFixed(0)}m${up > 3 ? ` ▲${up.toFixed(0)}m 飛行` : ''}`);
    }
    // 射撃予告（画面外は縁に矢印）
    for (const e of game.enemies.enemies) {
      if (!e.alive) continue;
      if (e.telegraphStart === null && e.burstLeft <= 0) continue;
      const c = e.center();
      const pr = project(cam, c, W, H);
      const ep = edgePoint(pr);
      put(ep.x, ep.y, `threat ${e.kind} ${ep.off ? 'off' : ''}`, e.telegraphStart !== null ? `! ${e.id}` : `▼ ${e.id}`);
    }
    for (let i = mi; i < this.markerPool.length; i++) this.markerPool[i].style.display = 'none';

    // ---- 被弾方向
    for (let i = this.dmgArcs.length - 1; i >= 0; i--) {
      const a = this.dmgArcs[i];
      a.life -= frameDt;
      if (a.life <= 0) {
        a.el.remove();
        this.dmgArcs.splice(i, 1);
        continue;
      }
      const rel = a.worldAngle - game.yaw; // 0 = 正面
      a.el.style.transform = `translate(-50%, -50%) rotate(${(-rel * 180) / Math.PI}deg)`;
      a.el.style.opacity = `${Math.min(1, a.life / 0.6)}`;
    }
    this.vignetteT = Math.max(0, this.vignetteT - frameDt);
    this.vignette.style.opacity = `${(this.vignetteT / 0.35) * 0.7}`;

    // ---- 武器（左）
    for (const w of WEAPON_ORDER) {
      const row = $(`w-${w}`);
      row.classList.toggle('active', game.weapons.current === w);
      const ammoEl = $(`w-${w}-ammo`);
      let ammo = '';
      if (w === 'machinegun') ammo = `${game.weapons.ammo.machinegun} / 300`;
      else if (w === 'beam') ammo = '∞ 弾数無制限 ・ 1射 8 EN';
      else ammo = `${game.weapons.ammo.missile} / 12 ・ LOCK必須`;
      this.text(ammoEl, ammo);
      const cd = Math.max(0, game.weapons.nextFireAt[w] - now) / WEAPONS[w].interval;
      $(`w-${w}-cd`).style.width = `${((1 - Math.min(1, cd)) * 100).toFixed(0)}%`;
      row.classList.toggle('empty', (w === 'machinegun' && game.weapons.ammo.machinegun <= 0) || (w === 'missile' && game.weapons.ammo.missile <= 0));
    }
    const cur: WeaponId = game.weapons.current;
    const den = game.weapons.lastDenied;
    let msg = '';
    let cls = '';
    if (den && now - den.at < 0.9) {
      msg = den.reason === 'noLock' ? '✖ 未ロック — ミサイル発射拒否' : den.reason === 'noAmmo' ? '✖ 弾切れ' : '✖ EN不足 — ビーム発射不可';
      cls = 'bad';
    } else if (cur === 'missile') {
      if (game.weapons.ammo.missile <= 0) [msg, cls] = ['✖ 弾切れ', 'bad'];
      else if (ls === 'locked') [msg, cls] = ['◆ LOCK完了 — 発射可能', 'good'];
      else [msg, cls] = [ls === 'acquiring' ? '▷ ロック中 — 発射不可' : '─ 未ロック — 発射不可', 'warn'];
    } else if (cur === 'beam') {
      [msg, cls] = p.en < 8 ? ['✖ EN不足（8 EN 必要）', 'bad'] : ['1射 8 EN 消費', ''];
    } else {
      [msg, cls] = game.weapons.ammo.machinegun <= 0 ? ['✖ 弾切れ', 'bad'] : ls === 'locked' ? ['◆ FCS射撃管制：偏差・弾道補正', 'good'] : ['照準方向へ射撃（LOCKで自動補正）', ''];
    }
    this.text(this.weaponMsg, msg);
    this.weaponMsg.className = cls;
    void firing;

    // ---- EN（右）
    this.text(this.enText, `${p.en.toFixed(1)} / ${stats.maxEn}`);
    this.enBar.style.width = `${((p.en / stats.maxEn) * 100).toFixed(1)}%`;
    this.enBar.className = p.en < 8 ? 'crit' : p.en < PLAYER.qbEnCost ? 'low' : '';
    $('en-mark-qb').style.left = `${((PLAYER.qbEnCost / stats.maxEn) * 100).toFixed(1)}%`;
    $('en-mark-beam').style.left = `${((8 / stats.maxEn) * 100).toFixed(1)}%`;
    let enState: string;
    if (!p.grounded) enState = '空中：回復なし';
    else if (p.en >= stats.maxEn) enState = '満タン';
    else if (p.lastEnSpentAt !== null && now < p.lastEnSpentAt + PLAYER.enRegenDelay) enState = `回復待機 ${(p.lastEnSpentAt + PLAYER.enRegenDelay - now).toFixed(2)}s`;
    else enState = `回復中 +${stats.regenPerSecond.toFixed(2)}/s`;
    this.text(this.enState, enState);
    const short = p.lastEnShortAt !== null && now - p.lastEnShortAt < 0.9;
    this.enWarn.style.visibility = short ? 'visible' : 'hidden';

    // 移動
    const hm = p.horizontalMode;
    this.text(this.moveH, hm === 'quickboost' ? 'QB噴射' : hm === 'glide' ? 'グライド (0 EN)' : 'ホバー歩行');
    this.moveH.dataset.mode = hm;
    const vm = p.verticalMode;
    this.text(this.moveV, vm === 'grounded' ? '接地' : vm === 'rising' ? '上昇' : vm === 'flying' ? '飛行 (20 EN/s)' : '落下');
    this.text(this.moveGlide, p.glideEnabled ? 'GLIDE ON' : 'GLIDE OFF');
    this.moveGlide.dataset.on = String(p.glideEnabled);
    const cdq = p.qbCooldownRemaining(now);
    let qb: string;
    let qbCls: string;
    if (cdq > 0) {
      qb = `QB 再使用まで ${cdq.toFixed(2)}s`;
      qbCls = 'cd';
    } else if (p.en < PLAYER.qbEnCost) {
      qb = `QB 不可：EN不足（36必要）`;
      qbCls = 'bad';
    } else {
      qb = 'QB READY ［Q］ 36 EN';
      qbCls = 'ok';
    }
    this.text(this.qbState, qb);
    this.qbState.className = qbCls;
    this.qbBar.style.width = `${((1 - cdq / PLAYER.qbCooldownSeconds) * 100).toFixed(0)}%`;

    // ---- HP（下）
    const hp = Math.max(0, p.hp);
    this.text(this.hpText, `HP ${hp.toFixed(0)} / ${PLAYER.maxHp}`);
    this.hpBar.style.width = `${((hp / PLAYER.maxHp) * 100).toFixed(1)}%`;
    this.hpBar.className = hp < 300 ? 'crit' : hp < 550 ? 'low' : '';

    // ---- 上部：区画・目標・隔壁
    const sec = SECTORS.find((s) => s.id === game.currentSectorId);
    this.text(this.sectorEl, sec ? `${sec.id} ${sec.name} ［${sec.spaceType}］  探索 ${game.visited.length}/${SECTORS.length}` : '---');
    if (game.currentSectorId !== this.lastSector && this.lastSector !== null && sec) this.showToast(`${sec.id} ${sec.name} に進入`, 'info');
    this.lastSector = game.currentSectorId;
    this.text(this.objectiveEl, obj.text);
    this.text(this.controlsEl, `制御砲台 ${game.controlsDestroyed}/6`);
    this.html(
      this.barriersEl,
      game.barriers
        .map((b) => `<span class="chip ${b.open ? 'open' : 'closed'}">${b.id === 'GATE' ? 'GATE' : b.id} ${b.open ? '開' : '閉'}</span>`)
        .join('') + (game.gateOpen ? '<span class="chip escape">脱出可能</span>' : ''),
    );
    const t = Math.floor(now);
    this.text(this.timeEl, `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);

    // トースト
    if (this.toastTimer > 0) {
      this.toastTimer -= frameDt;
      if (this.toastTimer <= 0) this.toast.classList.remove('show');
    }
  }

  objective(game: Game): { text: string; targetId: string | null } {
    for (const b of game.barriers) {
      if (b.id === 'GATE') continue;
      if (!b.open) {
        const e = game.enemies.byId(b.controlId!);
        return { text: `目標：制御砲台 ${b.controlId}（${e?.def.sectorId}）を破壊し ${b.label} を開放`, targetId: b.controlId };
      }
    }
    if (!game.gateOpen) return { text: '目標：残りの制御砲台を破壊', targetId: null };
    return { text: '目標：最終搬出ゲートを抜けて脱出領域（S19）へ', targetId: null };
  }
}
