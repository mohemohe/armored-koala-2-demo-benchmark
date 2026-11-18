import { DEFAULT_SEED } from '../config';
import { parseSeed as parseSeedQuery } from '../sim/rng';

/**
 * URLクエリの seed (32bit符号なし整数, 10進) を読む。未指定・不正(非数字/範囲外/空)は DEFAULT_SEED。
 * 解釈そのものは sim/rng.ts の parseSeed (単一の実装)。ここは UI 側の入口で、次の2点だけを足す:
 *   - "seed=7" のように先頭の "?" が無い文字列も受け付ける
 *   - 不正なパーセントエンコード (decodeURIComponent の例外) を含め、どんな入力でも例外を投げない
 * 例: "?seed=123" -> 123, "?seed=4294967295" -> 4294967295, "?seed=4294967296" -> DEFAULT_SEED
 */
export function parseSeed(search: string): number {
  try {
    const q = typeof search === 'string' ? search : '';
    return parseSeedQuery(q.startsWith('?') ? q : `?${q}`, DEFAULT_SEED);
  } catch {
    return DEFAULT_SEED;
  }
}
