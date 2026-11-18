/**
 * 操作説明（src/ui/controlsText.ts）の内容確認。DOM を使わないので node 環境で実行できる。
 * §8 の必須文言と、§6/§7 の数値（params.ts 由来）が含まれていることを確認する。
 */
import { describe, expect, it } from 'vitest';
import { FCS, PLAYER, WEAPONS } from '../src/params';
import { CONTROLS_SECTIONS, FCS_AUTO_CORRECTION_TEXT, QB_SUMMARY_TEXT } from '../src/ui/controlsText';

const allText = CONTROLS_SECTIONS.map((s) => `${s.title}\n${s.lines.join('\n')}`).join('\n');

describe('CONTROLS_SECTIONS', () => {
  it('has the required shape', () => {
    expect(CONTROLS_SECTIONS.length).toBeGreaterThanOrEqual(4);
    for (const sec of CONTROLS_SECTIONS) {
      expect(typeof sec.title).toBe('string');
      expect(sec.title.length).toBeGreaterThan(0);
      expect(sec.lines.length).toBeGreaterThan(0);
      for (const line of sec.lines) expect(line.length).toBeGreaterThan(0);
    }
  });

  it('contains the §8 FCS auto-correction wording', () => {
    expect(allText).toContain(FCS_AUTO_CORRECTION_TEXT);
    expect(allText).toContain('対象をFCS円内に保てばロックが自動で進み');
    expect(allText).toContain('中央の照準を補正マーカーへ手動で合わせる必要はありません');
    expect(allText).toContain('ビームは現在位置へ即時命中');
    expect(allText).toContain('ミサイルはロック完了時のみ発射可能');
  });

  it('states QB single press / 36 EN / auto glide / glide 0 EN / stop with Ctrl or Shift', () => {
    expect(allText).toContain(QB_SUMMARY_TEXT);
    expect(allText).toContain(`${PLAYER.qb.cost} EN`);
    expect(allText).toContain('自動でグライド');
    expect(allText).toContain('EN 消費は 0');
    expect(allText).toContain('左Ctrl');
    expect(allText).toContain('Shift');
  });

  it('carries the §7.1 numbers from params.ts', () => {
    expect(allText).toContain(`${PLAYER.walkSpeed} m/s`);
    expect(allText).toContain(`${PLAYER.jumpSpeed} m/s`);
    expect(allText).toContain(`${PLAYER.glideGroundSpeed} m/s`);
    expect(allText).toContain(`${PLAYER.airSpeed} m/s`);
    expect(allText).toContain(`${PLAYER.flightRiseSpeed} m/s`);
    expect(allText).toContain(`${PLAYER.flightEnPerSecond} EN/秒`);
    expect(allText).toContain(`${PLAYER.flightHoldSeconds.toFixed(2)}秒`);
    expect(allText).toContain(`${PLAYER.qb.speed} m/s`);
    expect(allText).toContain(`${PLAYER.qb.impulseSeconds.toFixed(2)} 秒`);
    expect(allText).toContain(`1射 ${WEAPONS.beam.enCost} EN`);
    expect(allText).toContain(`総弾数 ${WEAPONS.machinegun.ammo}`);
    expect(allText).toContain(`総弾数 ${WEAPONS.missile.ammo}`);
    expect(allText).toContain(`${FCS.range} m`);
    expect(allText).toContain('Esc');
    expect(allText).toContain('1 / 2 / 3');
  });

  it('explains enemy telegraph and hit direction', () => {
    expect(allText).toContain('予告');
    expect(allText).toContain('被弾方向');
  });
});
