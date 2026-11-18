import {stats,FCS,GENERATORS,LEGS,MOVEMENT} from './movement.js';
export const $=id=>document.getElementById(id);
const paths={
 fcs:'<circle cx="12" cy="12" r="7"/><path d="M12 1v6m0 10v6M1 12h6m10 0h6"/>',
 generator:'<path d="M8 2h8v3h3v16H5V5h3zM13 7l-4 6h5l-3 5"/>',
 legs:'<path d="M6 3h5v6l-3 5v6H3v-3l2-2v-5zm8 0h5v7l-2 5v4l3 1v2h-8v-8l3-5z"/>',
 rotate:'<path d="M4 10a9 6 0 1 1 0 6m-2-8 2 4 5-2"/><path d="m9 10 3-2 4 2v4l-4 2-3-2z"/>',
 launch:'<path d="m3 17 9-13 9 13-9-4zM7 21l5-4 5 4"/>',
 key:'<rect x="2" y="5" width="20" height="14" rx="1"/><path d="M5 9h2m2 0h2m2 0h2m2 0h2M5 12h2m2 0h2m2 0h2m2 0h2M7 16h10"/>'};
const svg=key=>'<svg viewBox="0 0 24 24" aria-hidden="true">'+paths[key]+'</svg>';
const groups={
 fcs:['FCS','FLIGHT CONTROL SYSTEM',{wide:['広範囲','広い取得範囲。ロック完了までの時間は長め。'],medium:['中範囲','取得範囲とロック時間のバランスに優れる。'],narrow:['狭範囲','狭い取得範囲で素早くロックする。']}],
 generator:['ジェネレーター','GENERATOR',{capacity:['大容量','EN容量に優れ、接地時の回復は緩やか。'],balanced:['均衡','EN容量と回復速度を両立する標準仕様。'],recovery:['高回復','容量を抑え、EN回復速度を高めた仕様。']}],
 legs:['脚部ユニット','LEG UNIT',{biped:['2脚','高い機動性と標準のロック速度を持つ。'],quadruped:['4脚','ロック速度1.5倍。移動速度と回復率が低下。']}]
};
const controls=[['W A S D','移動'],['MOUSE','視点'],['LMB','射撃'],['1 / 2 / 3','武器'],['SPACE','跳躍・飛行'],['SHIFT','グライド'],['Q','QB'],['CTRL','ブレーキ'],['ESC','停止']];
export function configure(loadout,onChange){
 document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=svg(el.dataset.icon));
 $('components').innerHTML=Object.entries(groups).map(([key,[title,eng,opts]])=>'<section class="component"><div class="component-head"><span class="icon">'+svg(key)+'</span><b>'+title+'</b><small>'+eng+'</small></div><div class="options" role="group" aria-label="'+title+'">'+Object.entries(opts).map(([k,[name,desc]])=>'<button data-part="'+key+'" data-value="'+k+'" title="'+desc+'">'+name+'</button>').join('')+'</div><p class="desc" id="desc-'+key+'"></p></section>').join('');
 document.querySelector('.controls').innerHTML=controls.map(([k,v])=>'<div class="control"><kbd>'+k+'</kbd>'+v+'</div>').join('');
 function refresh(){
  for(const key of Object.keys(groups))$('desc-'+key).textContent=groups[key][2][loadout[key]][1];
  document.querySelectorAll('[data-part]').forEach(b=>{let active=b.dataset.value===loadout[b.dataset.part];b.classList.toggle('selected',active);b.setAttribute('aria-pressed',active)});
  const s=stats(loadout);
  $('stats').innerHTML=[['最大EN',s.maxEn,'EN'],['EN回復',+s.regenPerSecond.toFixed(2),'/s'],['ロック時間',+s.lockSeconds.toFixed(3),'s'],['歩行速度',MOVEMENT.walk*s.horizontalSpeedMultiplier,'m/s']].map(([name,value,unit])=>'<div class="stat"><small>'+name+'</small><strong>'+value+'<sup>'+unit+'</sup></strong></div>').join('');
 }
 $('components').onclick=e=>{const b=e.target.closest('[data-part]');if(!b)return;loadout[b.dataset.part]=b.dataset.value;refresh();onChange(b.dataset.part)};
 refresh();
}
export function manual(){
 return '<dl>'+[
 ['W A S D','カメラ基準で移動。マウスで視点を旋回。'],['LMB','長押しで射撃。1・2・3で機関銃、ビーム、ミサイル。'],['SPACE','短押しでジャンプ。0.20秒以上の長押しで飛行（20 EN/秒）。'],['Q','単発QBで36 ENを消費。噴射後は無入力でも自動グライド。'],['SHIFT','グライドを切り替え。消費は0 EN。接地中は回復可能。'],['左 CTRL','慣性ブレーキ。Shiftでグライドを解除しても減速。'],['ESC','一時停止。再開にはボタンをクリック。']
 ].map(([a,b])=>'<dt><kbd>'+a+'</kbd></dt><dd>'+b+'</dd>').join('')+'</dl><p>敵を中央のFCS円内に保つと、機関銃の偏差と重力落下を自動補正します。補正マーカーに手動で照準を合わせる必要はありません。ミサイルはロック完了後に発射できます。</p><p>制御砲台6基を破壊し、搬出ゲートの先へ脱出してください。段差の手前でENを回復し、Space長押しで上昇できます。</p>';
}
export function dialog(label,title,body,buttons){
 $('overlay').hidden=false;$('dialog').innerHTML='<div class="eyebrow"><i></i>'+label+'</div><h2>'+title+'</h2>'+body+buttons.map(([txt],i)=>'<button class="'+(i?'secondary':'primary')+'" data-action="'+i+'">'+txt+'</button>').join('');
 $('dialog').querySelectorAll('[data-action]').forEach(b=>b.onclick=buttons[Number(b.dataset.action)][1]);
}
export function hideDialog(){$('overlay').hidden=true}
