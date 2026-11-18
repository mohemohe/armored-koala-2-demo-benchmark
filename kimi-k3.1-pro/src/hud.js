import * as THREE from 'three';
import { WEAPONS, PLAYER } from './config.js';

export const INSTRUCTIONS_HTML = `
  <div class="controls-grid">
    <span><kbd>WASD</kbd></span><span>カメラ水平基準で移動</span><span><kbd>マウス</kbd></span><span>TPS視点・照準</span>
    <span><kbd>Space</kbd></span><span>短押しジャンプ／0.20秒長押しで飛行（20 EN/秒）</span>
    <span><kbd>Q</kbd></span><span>単発クイックブースト（36 EN）※押し直しで再発動</span>
    <span><kbd>Shift</kbd></span><span>グライドON/OFF（0 EN）※押し続ける必要なし</span>
    <span><kbd>左Ctrl</kbd></span><span>ブレーキ・グライド解除</span><span><kbd>左クリック</kbd></span><span>押している間射撃</span>
    <span><kbd>1 / 2 / 3</kbd></span><span>マシンガン／ビーム／ミサイル</span><span><kbd>Esc</kbd></span><span>一時停止</span>
  </div>
  <p class="instruction-note"><strong>FCS自動射撃管制：</strong>対象の現在位置を中央円内に保ち、ロック完了後に撃てば、武器ごとの偏差とマシンガンの重力落下を自動補正します。中央照準を補正マーカーへ手動で合わせる必要はありません。ミサイルはロック完了必須です。</p>
  <p class="instruction-note"><strong>QB後は自動グライド。</strong>Qを離しても噴射・慣性・移動は継続します。グライドはEN 0でも作動し、接地中のEN回復を妨げません。止まるには左Ctrl、またはShiftで解除してください。</p>`;

const _v = new THREE.Vector3();
function project(position, camera, canvas) {
  _v.copy(position).project(camera);
  const width = canvas.clientWidth, height = canvas.clientHeight;
  return { x: (_v.x * 0.5 + 0.5) * width, y: (-_v.y * 0.5 + 0.5) * height, behind: _v.z > 1 || _v.z < -1, width, height };
}
function place(element, p, margin = 28) {
  const x = Math.max(margin, Math.min(p.width - margin, p.x));
  const y = Math.max(margin, Math.min(p.height - margin, p.y));
  element.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  element.classList.toggle('edge', p.behind || p.x !== x || p.y !== y);
}

export class HUD {
  constructor(element, canvas) {
    this.element = element; this.canvas = canvas; this.damage = []; this.notice = null;
    element.innerHTML = `
      <div id="mission-panel" class="panel"><div id="sector-name">SECTOR</div><div id="objective-text"></div><div id="barrier-text"></div></div>
      <div id="weapon-panel" class="panel"><div class="panel-label">ARMAMENT</div><div id="weapon-name"></div><div id="ammo-text"></div><div id="weapon-cost"></div><div class="weapon-slots">1 MG　2 BM　3 MSL</div></div>
      <div id="en-panel" class="panel"><div class="panel-label">ENERGY</div><div id="en-text"></div><div class="meter"><i id="en-fill"></i></div><div id="en-regen"></div></div>
      <div id="hp-panel" class="panel"><div class="hp-line"><span>AP</span><span id="hp-text"></span></div><div class="meter hp"><i id="hp-fill"></i></div></div>
      <div id="move-panel" class="panel"><div id="move-mode"></div><div id="qb-state"></div><div id="speed-text"></div></div>
      <div id="fcs-ring"><div id="lock-progress"></div><div id="lock-label">FCS / 未捕捉</div></div>
      <div id="crosshair"><i></i><b></b></div>
      <div id="target-marker" class="world-marker hidden"><span></span><small></small></div>
      <div id="correction-marker" class="world-marker hidden"><span></span><small></small></div>
      <div id="objective-marker" class="world-marker"><span></span><small></small></div>
      <div id="notice" class="hidden"></div><div id="damage-indicators"></div><div id="telegraphs"></div>
      <div id="quick-help">Q: 単発QB 36EN　Shift: グライド 0EN　Ctrl: ブレーキ　1/2/3: 武器</div>`;
    this.q = Object.fromEntries([...element.querySelectorAll('[id]')].map(e => [e.id, e]));
    this.telegraphPool = [];
    for (let i = 0; i < 12; i++) { const d = document.createElement('div'); d.className = 'telegraph hidden'; d.textContent = '! 砲撃予告'; this.q.telegraphs.appendChild(d); this.telegraphPool.push(d); }
  }

  reset() { this.damage.length = 0; this.notice = null; this.q['damage-indicators'].innerHTML = ''; }
  setNotice(title, detail, now) { this.notice = { title, detail, until: now + 1.25 }; }
  addDamage(sourcePosition, game) {
    const dx = sourcePosition.x - game.player.position.x, dz = sourcePosition.z - game.player.position.z;
    const worldAngle = Math.atan2(dx, -dz);
    this.damage.push({ angle: worldAngle - game.yaw, until: game.elapsed + 0.85 });
  }

  update(game) {
    const p = game.player, now = game.elapsed;
    const sector = game.stage.sectorMap.get(game.currentSectorId);
    this.q['sector-name'].textContent = sector ? `${sector.id} / ${sector.name}` : '連絡路 / 移動中';
    const objective = game.currentObjective;
    this.q['objective-text'].textContent = `目標: ${objective.label}`;
    const open = game.stage.barriers.get(objective.barrierId)?.open;
    this.q['barrier-text'].textContent = `制御砲台 ${game.controlsDestroyed}/6　${game.objective.gateOpen ? '最終ゲート開放・脱出可能' : objective.barrierId ? `隔壁 ${objective.barrierId}: ${open ? '開放' : '閉鎖'}` : '隔壁制御を探索'}`;
    const weapon = p.weapon;
    this.q['weapon-name'].textContent = WEAPONS[weapon].name;
    this.q['ammo-text'].textContent = weapon === 'beam' ? '弾数 ∞' : `残弾 ${p.ammo[weapon]}`;
    this.q['weapon-cost'].textContent = weapon === 'beam' ? '1射 8 EN' : weapon === 'missile' ? 'ロック完了必須' : '100m/s / 重力弾道';
    this.q['en-text'].textContent = `${p.en.toFixed(1)} / ${p.maxEn} EN`;
    this.q['en-fill'].style.width = `${p.en / p.maxEn * 100}%`;
    this.q['en-regen'].textContent = `接地回復 ${p.stats.regenPerSecond} EN/s`;
    this.q['hp-text'].textContent = `${Math.ceil(p.hp)} / 1000`;
    this.q['hp-fill'].style.width = `${p.hp / 10}%`;
    this.q['move-mode'].textContent = `${p.horizontalMode.toUpperCase()} / ${p.verticalMode.toUpperCase()}${p.glideEnabled ? ' / GLIDE ON' : ''}`;
    const cd = p.qbCooldownRemaining(now);
    this.q['qb-state'].textContent = cd > 0 ? `QB 再使用まで ${cd.toFixed(2)}s` : p.en < 36 ? 'QB EN不足（36必要）' : 'QB READY / 36 EN';
    this.q['speed-text'].textContent = `水平 ${Math.hypot(p.velocity.x, p.velocity.z).toFixed(1)} m/s`;

    const radius = game.fcs.radiusCssPx;
    Object.assign(this.q['fcs-ring'].style, { width: `${radius * 2}px`, height: `${radius * 2}px` });
    this.q['lock-progress'].style.background = `conic-gradient(#75f1d0 ${game.fcs.progress * 360}deg, rgba(80,130,140,.18) 0deg)`;
    const lockName = game.fcs.state === 'locked' ? 'LOCK 完了' : game.fcs.state === 'acquiring' ? `捕捉中 ${(game.fcs.progress * 100).toFixed(0)}%` : '未捕捉';
    this.q['lock-label'].textContent = `FCS / ${lockName}${game.fcs.targetId ? ` ${game.fcs.targetId}` : ''}`;
    this.q['fcs-ring'].classList.toggle('locked', game.fcs.state === 'locked');

    const target = game.fcs.target(game.enemies);
    if (target && target.alive) {
      this.q['target-marker'].classList.remove('hidden');
      place(this.q['target-marker'], project(target.position, game.camera, this.canvas));
      this.q['target-marker'].querySelector('small').textContent = `${target.id} 現在位置`;
    } else this.q['target-marker'].classList.add('hidden');
    const fc = game.weapons.fireControl;
    if (fc.status !== 'inactive' && fc.aimPoint) {
      this.q['correction-marker'].classList.remove('hidden');
      place(this.q['correction-marker'], project(new THREE.Vector3(...fc.aimPoint), game.camera, this.canvas));
      this.q['correction-marker'].querySelector('small').textContent = fc.status === 'solved' ? `AUTO ${fc.weapon === 'machinegun' ? '偏差＋重力' : fc.weapon === 'missile' ? '偏差' : '現在位置'}` : '解なし / 直接照準';
      this.q['correction-marker'].classList.toggle('no-solution', fc.status === 'no_solution');
    } else this.q['correction-marker'].classList.add('hidden');

    if (objective.position) {
      const op = new THREE.Vector3(...objective.position); op.y += 4;
      place(this.q['objective-marker'], project(op, game.camera, this.canvas), 40);
      this.q['objective-marker'].querySelector('small').textContent = `◇ ${objective.id} ${p.position.distanceTo(op).toFixed(0)}m`;
      this.q['objective-marker'].classList.remove('hidden');
    } else this.q['objective-marker'].classList.add('hidden');

    if (this.notice && now <= this.notice.until) {
      this.q.notice.innerHTML = `<strong>${this.notice.title}</strong><small>${this.notice.detail}</small>`;
      this.q.notice.classList.remove('hidden');
    } else this.q.notice.classList.add('hidden');

    this.damage = this.damage.filter(d => d.until > now);
    this.q['damage-indicators'].innerHTML = this.damage.map(d => `<i style="transform:rotate(${d.angle}rad)"></i>`).join('');
    let ti = 0;
    for (const e of game.enemies) {
      if (ti >= this.telegraphPool.length) break;
      if (!e.alive || !e.model.flash.visible) continue;
      const marker = this.telegraphPool[ti++];
      marker.classList.remove('hidden');
      const pos = e.position.clone(); pos.y += 2.5;
      place(marker, project(pos, game.camera, this.canvas));
    }
    for (; ti < this.telegraphPool.length; ti++) this.telegraphPool[ti].classList.add('hidden');
  }
}
