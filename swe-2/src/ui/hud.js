// HUD: DOM overlay synced from the game snapshot each frame.

import { PARAMS } from '../core/params.js';

const W = PARAMS.weapons;

export class Hud {
  constructor(root) {
    this.el = {};
    for (const id of [
      'hpFill', 'hpText', 'enFill', 'enText', 'ammo', 'wpnMg', 'wpnBeam', 'wpnMs',
      'lockCircle', 'lockLabel', 'reticle', 'objText', 'sectorName', 'msgLine',
      'hitDir', 'vignette', 'markers', 'fcsState', 'qbFlash', 'denyLine',
      'ammoMg', 'ammoMs', 'enWarn',
    ]) this.el[id] = document.getElementById(id);
    this.root = root;
    this.msg = []; this.msgTtl = 0;
    this.markerDivs = [];
    this.dirDivs = [];
    for (let i = 0; i < 8; i++) {
      const d = document.createElement('div');
      d.className = 'hitdir-tick';
      this.el.hitDir.appendChild(d);
      this.dirDivs.push(d);
    }
  }

  setMessage(text, color = '#ffd27a') {
    this.msg.push({ text, color });
    if (this.msg.length > 3) this.msg.shift();
    this.msgTtl = 3.2;
    this._renderMsg();
  }
  _renderMsg() {
    this.el.msgLine.innerHTML = this.msg.map(m => `<div style="color:${m.color}">${m.text}</div>`).join('');
  }

  update(game, view, camYaw, dt) {
    const s = game.getSnapshot();
    const p = s.player;
    const st = s.effectiveStats;

    // bars
    this.el.hpFill.style.width = Math.max(0, p.hp / 1000 * 100) + '%';
    this.el.hpText.textContent = Math.ceil(p.hp);
    this.el.enFill.style.width = Math.max(0, p.en / st.maxEn * 100) + '%';
    this.el.enText.textContent = Math.floor(p.en);
    this.el.enWarn.style.display = p.en < PARAMS.player.qbCost ? 'inline' : 'none';

    // weapons
    this.el.ammoMg.textContent = p.ammo.machinegun;
    this.el.ammoMs.textContent = p.ammo.missile;
    for (const [id, key] of [['wpnMg', 'machinegun'], ['wpnBeam', 'beam'], ['wpnMs', 'missile']]) {
      this.el[id].classList.toggle('active', p.weapon === key);
    }

    // FCS
    const lk = s.lock;
    const c = this.el.lockCircle;
    if (!game.fcsUnlocked) {
      c.style.display = 'none';
      this.el.fcsState.textContent = 'FCS OFFLINE';
      this.el.fcsState.style.color = '#666';
    } else if (lk.state === 'none') {
      c.style.display = 'block';
      const d = lk.radiusCssPx * 2;
      c.style.width = c.style.height = d + 'px';
      c.className = 'lock-circle idle';
      this.el.fcsState.textContent = 'FCS READY';
      this.el.fcsState.style.color = '#8fc';
    } else {
      c.style.display = 'block';
      const d = lk.radiusCssPx * 2;
      c.style.width = c.style.height = d + 'px';
      const pct = Math.round(lk.progress * 100);
      c.className = 'lock-circle ' + (lk.state === 'locked' ? 'locked' : 'acquiring');
      c.style.background = `conic-gradient(${lk.state === 'locked' ? '#ff5040' : '#ffd040'} ${pct}%, transparent ${pct}%)`;
      this.el.fcsState.textContent = lk.state === 'locked' ? 'LOCKED' : `ACQ ${pct}%`;
      this.el.fcsState.style.color = lk.state === 'locked' ? '#ff5040' : '#ffd040';
    }
    this.el.reticle.className = 'reticle' + (lk.state === 'locked' ? ' locked' : '');

    // enemy markers (projected)
    const mroot = this.el.markers;
    while (this.markerDivs.length < s.enemies.length) {
      const d = document.createElement('div');
      d.className = 'emarker'; mroot.appendChild(d); this.markerDivs.push(d);
    }
    let mi = 0;
    for (const en of s.enemies) {
      const d = this.markerDivs[mi++];
      if (!en.alive || !en.hasLineOfSight) { d.style.display = 'none'; continue; }
      const pr = view.project([en.position[0], en.position[1] + 1.4, en.position[2]]);
      if (!pr || pr.behind || pr.x < 0 || pr.x > view.widthPx || pr.y < 0 || pr.y > view.heightPx) {
        d.style.display = 'none'; continue;
      }
      d.style.display = 'block';
      d.style.left = pr.x + 'px'; d.style.top = pr.y + 'px';
      d.className = 'emarker' + (en.id === lk.targetId ? ' target' : '');
    }
    for (; mi < this.markerDivs.length; mi++) this.markerDivs[mi].style.display = 'none';

    // objective
    const ob = s.objective;
    this.el.objText.innerHTML =
      `CONTROL ${ob.controlsDestroyed}/6` +
      (s.objective.gateOpen ? ' — <span class="gate">GATE OPEN: ESCAPE</span>' : '');
    this.el.sectorName.textContent = (game.stage.sectors.find(x => x.id === s.stage.currentSectorId) || {}).name || '';

    // movement mode chip
    const mm = p.movement.horizontalMode;
    this.el.qbFlash.textContent = mm === 'quickboost' ? 'QUICKBOOST' : mm === 'glide' ? 'GLIDE' : '';
    this.el.qbFlash.className = 'qb-chip ' + mm;

    // damage direction ticks
    for (let i = 0; i < this.dirDivs.length; i++) {
      const h = game.hitNotices[i];
      const d = this.dirDivs[i];
      if (!h) { d.style.opacity = 0; continue; }
      const ang = Math.atan2(h.dir[0], h.dir[2]) - camYaw;
      d.style.opacity = Math.max(0, 1 - (game.now - h.at) / 0.8);
      d.style.transform = `rotate(${ang}rad) translateY(-86px)`;
    }

    // deny line
    this.el.denyLine.textContent = game.now < game.denyUntil ? game.denyMsg : '';
    // low HP vignette
    this.el.vignette.style.opacity = p.hp < 300 ? String(0.55 - p.hp / 300 * 0.3) : '0';

    if (this.msgTtl > 0) { this.msgTtl -= dt; if (this.msgTtl <= 0) { this.msg = []; this._renderMsg(); } }
  }
}
