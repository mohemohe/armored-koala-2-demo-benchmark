import { Vector3 } from 'three';
import { FCS, GENERATORS, LEGS, WEAPONS, PHYSICS } from './config.js';

const koalaMark = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="10" cy="18" r="8"/><circle cx="38" cy="18" r="8"/><path d="M12 19C12 8 36 8 36 19V30C36 41 12 41 12 30Z"/><path class="mark-nose" d="M20 23C20 18 28 18 28 23V29C28 34 20 34 20 29Z"/><path d="M17 23h.1M31 23h.1" stroke-width="3" stroke-linecap="round"/></svg>`;
const arrow = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h15M13 5l7 7-7 7"/></svg>`;
const format = (v, digits = 0) => Number.isFinite(v) ? v.toFixed(digits) : '—';
const clock = (seconds = 0) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const asVector = (value) => Array.isArray(value) ? new Vector3(...value) : value;
const shortNames = {
  fcs: { wide: '広範囲', medium: '中範囲', narrow: '狭範囲' },
  generator: { capacity: '大容量', balanced: '均衡', recovery: '高回復' },
  legs: { biped: '2脚', quadruped: '4脚' },
};
const descriptions = {
  fcs: { wide: '広い捕捉領域。動く敵を捉えやすく、ロックはゆっくり。', medium: '捕捉領域とロック速度のバランスに優れた標準仕様。', narrow: '狭い捕捉領域。正確な視点操作で、素早くロック。' },
  generator: { capacity: '大きなEN容量で連続飛行に対応。回復はゆっくり。', balanced: '最大ENと回復速度を両立。扱いやすい標準仕様。', recovery: '短い休止で素早く回復。連続使用できるENは少なめ。' },
  legs: { biped: '標準速度・回復率。機動力を活かした軽快な戦闘に。', quadruped: 'ロック速度1.5倍。水平速度80%、EN回復率75%。' },
};

function controlGuide() {
  return `<div class="guide-grid">
    <div class="guide-row"><span class="key-group"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><div><b>移動</b><small>カメラを基準に前後左右へ</small></div></div>
    <div class="guide-row"><kbd class="wide-key">MOUSE</kbd><div><b>視点・照準 / 左クリックで射撃</b><small>長押しで連続射撃</small></div></div>
    <div class="guide-row"><kbd>Q</kbd><div><b>クイックブースト <em>${PHYSICS.quickboostCost} EN</em></b><small>1回押すと単発噴射 → 慣性 → 自動グライド</small></div></div>
    <div class="guide-row"><kbd class="wide-key">SHIFT</kbd><div><b>グライド切り替え <em>0 EN</em></b><small>キーを離しても継続。EN 0でも使用可能</small></div></div>
    <div class="guide-row"><kbd class="wide-key">L CTRL</kbd><div><b>ブレーキ</b><small>グライドを解除して減速。Shiftでの解除も可能</small></div></div>
    <div class="guide-row"><kbd class="wide-key">SPACE</kbd><div><b>ジャンプ / 長押しで飛行</b><small>${PHYSICS.flightHoldSeconds.toFixed(2)}秒以上で上昇推進 · 飛行 ${PHYSICS.flightCostPerSecond} EN/秒</small></div></div>
    <div class="guide-row"><span class="key-group"><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd></span><div><b>武器切り替え</b><small>マシンガン / ビーム / ハンドミサイル</small></div></div>
    <div class="guide-row"><kbd class="wide-key">ESC</kbd><div><b>一時停止</b><small>操作説明を表示 / マウスを解放</small></div></div>
  </div><div class="fcs-guide"><span class="mini-cross">⌖</span><div><b>狙うのは、対象そのもの。</b><p>敵をFCSの円内に保つと自動でロック。偏差と重力を自動補正します。中央照準を補正マーカーへ手動で合わせる必要はありません。ミサイルはロック完了後に発射できます。</p></div></div><p class="guide-note">地上でEN使用から${PHYSICS.regenDelaySeconds}秒後に回復開始。接地中のグライドは回復を妨げません。QB・飛行・ビームは同じENを使用します。</p>`;
}

function selector(key, number, title, subtitle, options) {
  return `<section class="part-selector"><div class="part-heading"><span class="part-number">${number}</span><div><h3>${title}</h3><span>${subtitle}</span></div><span class="part-active-dot"></span></div><div class="part-options ${options.length === 2 ? 'two-options' : ''}" role="group" aria-label="${title}">${options.map((option) => `<button type="button" data-part="${key}" data-value="${option}" aria-pressed="false"><span>${shortNames[key][option]}</span><small>${option.toUpperCase()}</small></button>`).join('')}</div><p class="part-description" data-description="${key}"></p><div class="part-spec" data-spec="${key}"></div></section>`;
}

export function createUI(root, callbacks) {
  root.classList.add('ak2-ui');
  root.innerHTML = `<main class="garage-screen" data-screen="garage">
    <header class="garage-header"><div class="brand"><div class="brand-mark">${koalaMark}</div><div><b>K-LA INDUSTRIES</b><span>ADVANCED COMBAT SYSTEMS</span></div></div><div class="header-center"><span class="online-dot"></span> SYSTEM ONLINE <i>/</i> HANGAR 04</div><button class="text-button help-button" data-action="help"><span>操作ガイド</span><span class="help-icon">?</span></button></header>
    <div class="garage-body"><section class="mission-brief"><div class="eyebrow"><span class="tiny-line"></span> TACTICAL MECH ACTION <span class="demo-badge">DEMO</span></div><h1>ARMORED<br>KOALA <span>2</span><span class="title-period">.</span></h1><p class="hero-tagline">その装甲に、野性を。</p><div class="mission-rule"><span>01 / OPERATION</span><span>CLASSIFIED</span></div><h2>ESCAPE THE<br>FOUNDRY<span>↗</span></h2><p class="mission-description">沈黙した工場。目覚める防衛機構。<br>6基の制御砲台を破壊し、<br>最終搬出ゲートから脱出せよ。</p><div class="mission-facts"><div><b>45</b><span>HOSTILES</span></div><div><b>06</b><span>CONTROL UNITS</span></div><div><b>3</b><span>WEAPONS</span></div></div><div class="mission-tip"><span>↳</span> 速く動け。エネルギーを使いこなせ。</div></section>
    <section class="mech-caption" aria-label="機体プレビュー"><div class="mech-topline"><span class="caption-cross">+</span><span>EXPERIMENTAL FRAME</span></div><div class="mech-model-id">AK–02 <span>KOALA</span></div><div class="mech-bottomline"><span class="online-dot"></span> <span data-model-label>BIPED CONFIGURATION</span><i>01 / 18</i></div></section>
    <aside class="assembly-panel"><div class="assembly-heading"><div><span class="eyebrow">BUILD YOUR MACHINE</span><h2>ASSEMBLY<span>機体構成</span></h2></div><span class="assembly-icon">⚙</span></div>
    ${selector('fcs', '01', 'FCS', 'FLIGHT CONTROL SYSTEM', ['wide', 'medium', 'narrow'])}
    ${selector('generator', '02', 'GENERATOR', 'ENERGY MANAGEMENT', ['capacity', 'balanced', 'recovery'])}
    ${selector('legs', '03', 'LEGS', 'LOCOMOTION SYSTEM', ['biped', 'quadruped'])}
    <div class="effective-stats"><div class="stats-heading"><span>FRAME PERFORMANCE</span><span>実効性能</span></div><div class="stats-grid"><div><span>最大EN</span><strong data-stat="maxEn">120</strong><small>EN</small></div><div><span>EN回復率</span><strong data-stat="regenPerSecond">15</strong><small>/ SEC</small></div><div><span>ロック時間</span><strong data-stat="lockSeconds">0.80</strong><small>SEC</small></div><div><span>グライド速度</span><strong data-stat="glideSpeed">22</strong><small>M / S</small></div></div><div class="speed-specs" data-speed-specs></div></div></aside></div>
    <footer class="garage-footer"><div class="footer-status"><span class="online-dot"></span><div><b>ALL SYSTEMS READY</b><span>機体構成を選択して出撃</span></div></div><div class="footer-hint"><kbd>W A S D</kbd><span>移動</span><kbd>Q</kbd><span>QB</span><kbd>SHIFT</kbd><span>GLIDE</span><kbd>SPACE</kbd><span>飛行</span></div><button class="deploy-button" data-action="deploy"><span><small>MISSION 01 / 廃工場からの脱出</small><b>DEPLOY<span>出撃する</span></b></span>${arrow}</button></footer>
    <div class="garage-watermark" aria-hidden="true">AK2 // TEST UNIT</div>
  </main>
  <main class="hud-screen" data-screen="hud" hidden>
    <div class="hud-top"><section class="hud-mission"><span class="eyebrow">OPERATION / THE FOUNDRY</span><h2 data-hud="sector">搬入口</h2><p data-hud="objective">制御砲台を破壊し、隔壁を開放</p><div class="control-progress" data-hud="controlDots"></div><small data-hud="barriers">隔壁制御 0 / 6</small></section><div class="hud-compass"><span>W</span><i></i><b data-hud="heading">000</b><i></i><span>E</span><small>HEADING</small></div><section class="hud-mission-time"><span class="eyebrow">MISSION TIME</span><strong data-hud="timer">00:00</strong><small><kbd>ESC</kbd> PAUSE / 操作説明</small></section></div>
    <div class="fcs-circle" data-hud="fcs"><span class="fcs-notch fcs-notch-top"></span><span class="fcs-notch fcs-notch-bottom"></span><span class="fcs-notch fcs-notch-left"></span><span class="fcs-notch fcs-notch-right"></span><div class="fcs-state"><b data-hud="lockState">SEARCHING</b><div class="lock-progress"><i data-hud="lockProgress"></i></div><span data-hud="lockDetail">AUTO TARGET ACQUISITION</span></div></div><div class="center-reticle"><i></i><i></i><i></i><i></i><b></b></div>
    <div class="target-marker" data-hud="target" hidden><span></span><span></span><span></span><span></span><b data-hud="targetLabel"></b><small data-hud="targetHP"></small></div><div class="aim-marker" data-hud="aim" hidden><span></span><b data-hud="aimLabel">AUTO CORRECTION</b></div><div class="objective-markers" data-hud="objectives"></div><div class="damage-indicator" data-hud="damage" hidden><span>▲</span><b>HIT</b></div>
    <section class="hud-weapon"><div class="hud-section-label"><span>ARMAMENT</span><span data-hud="weaponNumber">01</span></div><h2 data-hud="weaponName">MACHINE GUN</h2><p data-hud="weaponJapanese">マシンガン</p><div class="ammo-count"><strong data-hud="ammo">300</strong><span data-hud="ammoUnit">ROUNDS</span></div><div class="weapon-slots"><span data-weapon="machinegun"><kbd>1</kbd> MG</span><span data-weapon="beam"><kbd>2</kbd> BEAM</span><span data-weapon="missile"><kbd>3</kbd> MSL</span></div><small data-hud="weaponHint">12 DMG · 0.10 SEC</small></section>
    <section class="hud-energy"><div class="hud-section-label"><span>ENERGY</span><span>EN</span></div><div class="en-count"><strong data-hud="en">120</strong><span>/ <b data-hud="maxEn">120</b></span></div><div class="energy-bar"><i data-hud="enBar"></i><span></span></div><small data-hud="regen">GROUND REGEN</small><div class="qb-readiness"><span><kbd>Q</kbd> QUICK BOOST</span><b data-hud="qb">READY</b></div><div class="qb-cost">SINGLE BURST / ${PHYSICS.quickboostCost} EN</div></section>
    <div class="hud-feedback" data-hud="feedback" hidden></div><div class="hud-bottom"><section class="hud-motion"><div><span data-hud="mode">WALK</span><b data-hud="speed">0.0</b><small>M/S</small></div><p><span data-hud="vertical">GROUNDED</span><span data-hud="altitude">ALT 0.0 M</span></p><small><kbd>SHIFT</kbd> GLIDE 0 EN <i>·</i> <kbd>L CTRL</kbd> BRAKE</small></section><section class="hud-health"><div><span>ARMOR POINTS</span><b><strong data-hud="hp">1000</strong><small>/ 1000</small></b></div><div class="hp-bar"><i data-hud="hpBar"></i><span></span></div><small data-hud="hpState">STRUCTURAL INTEGRITY NOMINAL</small></section><section class="hud-telemetry"><span data-hud="fps">60 FPS</span><span data-hud="hostiles">45 HOSTILES REMAINING</span><span>AK–02 / TELEMETRY ONLINE</span></section></div>
  </main>
  <div class="modal-backdrop" data-screen="modal" hidden><section class="state-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><span class="eyebrow" data-modal="eyebrow">SYSTEM / STANDBY</span><button class="modal-close" data-action="close-help" aria-label="操作説明を閉じる">×</button></div><div class="state-modal-layout"><div class="modal-intro"><span class="modal-code" data-modal="code">II</span><h2 id="modal-title" data-modal="title">PAUSED</h2><p data-modal="description">戦闘を一時停止しています。</p><div class="result-stats" data-modal="stats"></div><div class="modal-error" data-modal="error" hidden></div><div class="modal-actions" data-modal="actions"></div><span class="modal-unit-id">AK–02 / PILOT INTERFACE</span></div><div class="modal-guide"><div class="guide-title"><span>操縦マニュアル</span><small>PILOT HANDBOOK / REV. 02</small></div>${controlGuide()}</div></div></section></div>`;

  const screens = Object.fromEntries([...root.querySelectorAll('[data-screen]')].map((el) => [el.dataset.screen, el]));
  const hud = Object.fromEntries([...root.querySelectorAll('[data-hud]')].map((el) => [el.dataset.hud, el]));
  const modal = Object.fromEntries([...root.querySelectorAll('[data-modal]')].map((el) => [el.dataset.modal, el]));
  let state = 'garage';
  let helpOpen = false;
  let width = window.innerWidth, height = window.innerHeight;
  let lastData = {};
  const text = (el, value) => { if (el.textContent !== String(value)) el.textContent = value; };
  const click = (event) => {
    const part = event.target.closest('[data-part]');
    if (part && state === 'garage' && !helpOpen) callbacks.setLoadout(part.dataset.part, part.dataset.value);
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'help') { helpOpen = true; drawModal('help', {}); }
    else if (action === 'close-help') { helpOpen = false; screens.modal.hidden = true; }
    else if (callbacks[action]) callbacks[action]();
  };
  root.addEventListener('click', click);

  function renderGarage(loadout, stats) {
    root.querySelectorAll('[data-part]').forEach((button) => {
      const selected = button.dataset.value === loadout[button.dataset.part];
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    for (const key of ['fcs', 'generator', 'legs']) text(root.querySelector(`[data-description="${key}"]`), descriptions[key][loadout[key]]);
    const fcs = FCS[loadout.fcs], gen = GENERATORS[loadout.generator], legs = LEGS[loadout.legs];
    const radius = fcs.radius ?? fcs.radiusFraction;
    text(root.querySelector('[data-spec="fcs"]'), `捕捉半径 ${format(radius * 100)}% D  /  基本ロック ${format(fcs.lockSeconds, 2)} SEC`);
    text(root.querySelector('[data-spec="generator"]'), `${gen.maxEn} EN  /  基本回復 ${gen.regenPerSecond} EN/SEC`);
    text(root.querySelector('[data-spec="legs"]'), `速度 ×${format(legs.speedMultiplier ?? stats.horizontalSpeedMultiplier, 2)}  /  ロック速度 ×${format(legs.lockSpeedMultiplier, 2)}`);
    const values = { ...stats, glideSpeed: PHYSICS.glideSpeed * stats.horizontalSpeedMultiplier };
    root.querySelectorAll('[data-stat]').forEach((el) => text(el, format(values[el.dataset.stat], el.dataset.stat === 'lockSeconds' ? 2 : el.dataset.stat === 'regenPerSecond' && values.regenPerSecond % 1 ? 2 : el.dataset.stat === 'glideSpeed' && values.glideSpeed % 1 ? 1 : 0)));
    text(root.querySelector('[data-speed-specs]'), `歩行 ${format(PHYSICS.walkSpeed * stats.horizontalSpeedMultiplier, 1)}  /  空中 ${format(PHYSICS.airSpeed * stats.horizontalSpeedMultiplier, 1)}  /  QB ${format(PHYSICS.quickboostSpeed * stats.horizontalSpeedMultiplier, 0)} M/S`);
    text(root.querySelector('[data-model-label]'), loadout.legs === 'biped' ? 'BIPED CONFIGURATION' : 'QUADRUPED CONFIGURATION');
    const configuration = ['wide', 'medium', 'narrow'].indexOf(loadout.fcs) * 6 + ['capacity', 'balanced', 'recovery'].indexOf(loadout.generator) * 2 + (loadout.legs === 'biped' ? 1 : 2);
    text(root.querySelector('.mech-bottomline i'), `${String(configuration).padStart(2, '0')} / 18`);
  }

  function marker(element, position, project, padding = 52) {
    if (!position || !project) { element.hidden = true; return; }
    const point = project(asVector(position));
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) { element.hidden = true; return; }
    const x = clamp(point.x, padding, width - padding), y = clamp(point.y, padding + 30, height - padding - 60);
    element.hidden = false;
    element.style.transform = `translate(${x}px, ${y}px)`;
    element.classList.toggle('offscreen', !point.visible || x !== point.x || y !== point.y);
    element.style.setProperty('--edge-angle', `${Math.atan2(y - height / 2, x - width / 2)}rad`);
  }

  function renderHUD(data) {
    lastData = data;
    const { player, stats, lock, fireControl, enemies = [], objective = {}, project, time = 0 } = data;
    if (!player || !stats) return;
    width = data.width || width; height = data.height || height;
    text(hud.sector, data.sector?.name || data.sector || '工場連絡路');
    text(hud.objective, objective.gateOpen ? '最終搬出ゲート開放 — 脱出領域へ向かえ' : '制御砲台を破壊し、隔壁を開放');
    const openBarriers = (objective.openBarrierIds || []).map((id) => id.replace('barrier-', 'B')).join(' / ');
    text(hud.barriers, objective.gateOpen ? '全隔壁開放 / EXTRACTION AVAILABLE' : `隔壁制御 ${objective.controlsDestroyed || 0} / 6${openBarriers ? ` · OPEN ${openBarriers}` : ' · 全隔壁閉鎖'}`);
    const count = objective.controlsDestroyed || 0;
    if (hud.controlDots.dataset.count !== String(count)) {
      const controlUnits = enemies.filter((enemy) => enemy.isGateControl).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      hud.controlDots.innerHTML = Array.from({ length: 6 }, (_, i) => `<i class="${controlUnits[i] && !controlUnits[i].alive ? 'complete' : ''}" title="${controlUnits[i]?.id || `control-${i + 1}`}">${controlUnits[i] && !controlUnits[i].alive ? '✓' : String(i + 1).padStart(2, '0')}</i>`).join('');
      hud.controlDots.dataset.count = count;
    }
    text(hud.timer, clock(data.elapsed));
    text(hud.heading, String(Math.round((((data.cameraYaw || 0) * 180 / Math.PI) % 360 + 360) % 360)).padStart(3, '0'));
    const fcsRadius = lock?.radiusCssPx || 0;
    hud.fcs.style.width = `${fcsRadius * 2}px`; hud.fcs.style.height = `${fcsRadius * 2}px`;
    hud.fcs.classList.toggle('locked', lock?.state === 'locked');
    hud.fcs.classList.toggle('acquiring', lock?.state === 'acquiring');
    text(hud.lockState, lock?.state === 'locked' ? 'LOCKED / 捕捉完了' : lock?.state === 'acquiring' ? `ACQUIRING / ${Math.round(lock.progress * 100)}%` : 'SEARCHING / 対象未取得');
    hud.lockProgress.style.width = `${(lock?.progress || 0) * 100}%`;
    text(hud.lockDetail, lock?.state === 'locked' ? fireControl?.status === 'solved' ? 'FIRE CONTROL / 補正有効' : 'FIRE CONTROL / 補正解なし' : 'TARGET INSIDE FCS TO LOCK');
    const target = enemies.find((enemy) => enemy.id === lock?.targetId && enemy.alive);
    if (target) {
      marker(hud.target, target.position, project);
      hud.target.classList.toggle('locked', lock.state === 'locked');
      text(hud.targetLabel, `${target.isGateControl ? 'CONTROL / ' : ''}${target.id} · 現在位置`);
      text(hud.targetHP, `HP ${Math.max(0, Math.ceil(target.hp))} · ${lock.state === 'locked' ? 'LOCKED' : 'ACQUIRING'}`);
    } else hud.target.hidden = true;
    if (lock?.state === 'locked' && fireControl?.status !== 'inactive' && fireControl?.aimPoint) {
      marker(hud.aim, fireControl.aimPoint, project, 66);
      hud.aim.classList.toggle('no-solution', fireControl.status === 'no_solution');
      text(hud.aimLabel, fireControl.status === 'solved' ? 'AUTO / 補正照準' : '× 補正解なし');
    } else hud.aim.hidden = true;
    const weaponData = WEAPONS[player.weapon];
    const weaponIndex = ['machinegun', 'beam', 'missile'].indexOf(player.weapon);
    text(hud.weaponNumber, `0${weaponIndex + 1}`);
    text(hud.weaponName, ['MACHINE GUN', 'PULSE BEAM', 'HAND MISSILE'][weaponIndex]);
    text(hud.weaponJapanese, ['マシンガン', 'ビーム', 'ハンドミサイル'][weaponIndex]);
    text(hud.ammo, player.weapon === 'beam' ? '∞' : player.ammo[player.weapon]);
    text(hud.ammoUnit, player.weapon === 'beam' ? `弾数無制限 / ${WEAPONS.beam.cost} EN` : 'ROUNDS');
    text(hud.weaponHint, `${weaponData.damage} DMG · ${format(weaponData.interval, 2)} SEC${player.weapon === 'missile' ? ' · LOCK REQUIRED' : ''}`);
    root.querySelectorAll('[data-weapon]').forEach((el) => el.classList.toggle('active', el.dataset.weapon === player.weapon));
    text(hud.en, Math.ceil(player.en)); text(hud.maxEn, stats.maxEn);
    hud.enBar.style.width = `${clamp(player.en / stats.maxEn * 100, 0, 100)}%`;
    hud.enBar.parentElement.classList.toggle('low', player.en < PHYSICS.quickboostCost);
    const movement = player.movement || {};
    const regenWait = movement.lastEnSpentAtSeconds === null ? 0 : Math.max(0, (movement.lastEnSpentAtSeconds ?? -999) + PHYSICS.regenDelaySeconds - time);
    text(hud.regen, !player.grounded ? 'AIRBORNE / 空中では回復停止' : regenWait > 0 ? `回復待機 / ${format(regenWait, 2)} SEC` : player.en >= stats.maxEn ? 'CAPACITY FULL / 充填完了' : `EN RECOVERY / +${format(stats.regenPerSecond, stats.regenPerSecond % 1 ? 2 : 0)} / SEC`);
    const cooldown = movement.qbCooldownRemainingSeconds || 0;
    text(hud.qb, cooldown > 0 ? `${format(cooldown, 2)} SEC` : player.en >= PHYSICS.quickboostCost ? 'READY / 使用可能' : 'LOW EN / EN不足');
    hud.qb.classList.toggle('ready', cooldown <= 0 && player.en >= PHYSICS.quickboostCost);
    const mode = { walk: 'WALK', glide: 'GLIDE / 0 EN', quickboost: 'QUICK BOOST' }[movement.horizontalMode] || 'WALK';
    text(hud.mode, mode);
    text(hud.speed, format(Math.hypot(player.velocity.x, player.velocity.z), 1));
    text(hud.vertical, { grounded: 'GROUNDED / 接地', rising: 'RISING / 上昇', flying: `FLYING / ${PHYSICS.flightCostPerSecond} EN/SEC`, falling: 'FALLING / 落下' }[movement.verticalMode] || 'GROUNDED');
    text(hud.altitude, `ALT ${format(player.position.y, 1)} M`);
    text(hud.hp, Math.max(0, Math.ceil(player.hp)));
    hud.hpBar.style.width = `${clamp(player.hp / PHYSICS.maxHp * 100, 0, 100)}%`;
    hud.hpBar.parentElement.classList.toggle('low', player.hp < 300);
    text(hud.hpState, player.hp < 300 ? 'WARNING / 装甲損傷甚大' : 'STRUCTURAL INTEGRITY NOMINAL');
    text(hud.fps, `${Math.round(data.fps || 0)} FPS`);
    text(hud.hostiles, `${enemies.filter((enemy) => enemy.alive).length} HOSTILES REMAINING`);
    hud.feedback.hidden = !data.feedback;
    if (data.feedback) text(hud.feedback, data.feedback);
    const hitAge = time - (player.lastHitAt ?? -999);
    hud.damage.hidden = !(hitAge >= 0 && hitAge < 0.75 && player.lastHitDirection);
    if (!hud.damage.hidden) {
      const direction = asVector(player.lastHitDirection);
      const angle = Math.atan2(direction.x, direction.z) - (data.cameraYaw || 0);
      hud.damage.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
      hud.damage.style.opacity = String(1 - hitAge / 0.75);
    }
    // Control markers represent actual surviving objectives, never fabricated route points.
    const controls = enemies.filter((enemy) => enemy.alive && enemy.isGateControl).sort((a, b) => asVector(a.position).distanceToSquared(player.position) - asVector(b.position).distanceToSquared(player.position)).slice(0, 2);
    const markerElements = [...hud.objectives.children];
    for (let i = 0; i < controls.length; i++) {
      const enemy = controls[i];
      let element = markerElements[i];
      if (!element) { element = document.createElement('div'); element.className = 'control-marker'; element.innerHTML = '<span>◇</span><b></b><small></small>'; hud.objectives.appendChild(element); }
      marker(element, enemy.position, project, 85);
      text(element.querySelector('b'), `制御砲台 ${enemy.id}`);
      text(element.querySelector('small'), `${Math.round(asVector(enemy.position).distanceTo(player.position))} M`);
    }
    for (let i = controls.length; i < markerElements.length; i++) markerElements[i].remove();
  }

  function drawModal(kind, data) {
    screens.modal.hidden = false;
    screens.modal.classList.toggle('help-modal', kind === 'help');
    root.querySelector('.modal-close').hidden = kind !== 'help';
    const success = kind === 'cleared', failed = kind === 'failed', help = kind === 'help';
    text(modal.eyebrow, help ? 'FIELD MANUAL / AK–02' : success ? 'OPERATION / COMPLETE' : failed ? 'SIGNAL / LOST' : 'SYSTEM / STANDBY');
    text(modal.code, help ? '01' : success ? '✓' : failed ? '×' : 'II');
    text(modal.title, help ? 'PILOT\nHANDBOOK' : success ? 'MISSION\nCOMPLETE' : failed ? 'MISSION\nFAILED' : 'PAUSED');
    text(modal.description, help ? '装甲の重さを、推進力に変えろ。' : success ? '搬出ゲートを突破。工場からの脱出に成功しました。' : failed ? '機体の信号を喪失しました。同じ構成で再出撃できます。' : 'シミュレーションを停止しています。\n再開するとマウスで視点を操作できます。');
    const error = data.pointerLockError || data.error || (kind === 'paused' ? data.reason || data.message : '');
    modal.error.hidden = !error;
    text(modal.error, typeof error === 'string' ? error : 'マウスの操作権限を取得できませんでした。「再開」をクリックして再試行してください。');
    const details = { ...lastData, ...data };
    modal.stats.innerHTML = help ? '<div><span>OBJECTIVE</span><b>6基の制御砲台を破壊 → 最終ゲートから脱出</b></div><div><span>LOADOUT</span><b>全3武器を携行。出撃後の機体構成は固定</b></div>' : `<div><span>MISSION TIME</span><b>${clock(details.elapsed || details.elapsedSeconds || 0)}</b></div><div><span>CONTROL UNITS</span><b>${details.objective?.controlsDestroyed || 0} / 6</b></div><div><span>ARMOR POINTS</span><b>${Math.max(0, Math.ceil(details.player?.hp || 0))} / 1000</b></div>`;
    modal.actions.innerHTML = help ? `<button class="primary-button" data-action="close-help">了解 / BACK TO HANGAR ${arrow}</button>` : kind === 'paused' ? `<button class="primary-button" data-action="resume">再開 / RESUME ${arrow}</button><button class="secondary-button" data-action="retry">同じ構成で再出撃</button><button class="text-button" data-action="garage">← 格納庫へ戻る</button>` : `<button class="primary-button" data-action="retry">再出撃 / RETRY ${arrow}</button><button class="secondary-button" data-action="garage">格納庫へ戻る</button>`;
  }

  function showState(nextState, data = {}) {
    state = nextState;
    root.dataset.state = state;
    helpOpen = false;
    screens.garage.hidden = state !== 'garage';
    screens.hud.hidden = state === 'garage';
    screens.modal.hidden = state === 'garage' || state === 'playing';
    if (!screens.modal.hidden) {
      if (lastData.stats && data.player) renderHUD({ ...lastData, ...data, time: data.elapsed ?? lastData.time });
      drawModal(state, data);
    }
  }
  showState('garage');
  return { renderGarage, renderHUD, showState, resize(w, h) { width = w; height = h; }, dispose() { root.removeEventListener('click', click); root.innerHTML = ''; root.classList.remove('ak2-ui'); } };
}
