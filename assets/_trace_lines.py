# 流線PNG（補修済み）から中心線パス（点列+色+太さ）をトレースし、
# canvas 3D アニメ用の JS データ（concepts/line-paths.js）を出力する
import numpy as np
from PIL import Image, ImageDraw
import json

BASE = 'portament-hp/assets'
OUT = 'portament-hp/concepts/line-paths.js'

def trace_image(path, name):
    im = Image.open(path)
    W, H = im.size
    arr = np.array(im)
    mask = arr[:, :, 3] > 25

    # --- 連結成分ラベリング（BFS, 8近傍を粗く: 3px リンク） ---
    ys, xs = np.where(mask)
    pix = set(zip(ys.tolist(), xs.tolist()))
    comps = []
    seen = set()
    for p in zip(ys.tolist(), xs.tolist()):
        if p in seen:
            continue
        stack = [p]
        seen.add(p)
        comp = []
        while stack:
            cy, cx = stack.pop()
            comp.append((cy, cx))
            for dy in (-2, -1, 0, 1, 2):
                for dx in (-2, -1, 0, 1, 2):
                    q = (cy + dy, cx + dx)
                    if q in pix and q not in seen:
                        seen.add(q)
                        stack.append(q)
        comps.append(comp)
    comps = [c for c in comps if len(c) >= 120]
    comps.sort(key=len, reverse=True)
    print(f'{name}: components = {[len(c) for c in comps]}')

    raw_lines = []
    for comp in comps:
        carr = np.array(comp)
        remaining = np.ones(len(carr), bool)

        # 成分内を消費し尽くすまで複数回トレース（途中開始の取り残しも断片として回収）
        while remaining.sum() >= 60:
            idx = np.where(remaining)[0]
            # 開始点: 残存画素のうち「近傍重心からのオフセット最大」= 端っぽい点
            sub = carr[idx]
            best_i, best_off = idx[0], -1.0
            step = max(1, len(idx) // 300)
            for k in range(0, len(idx), step):
                cy, cx = carr[idx[k]]
                d = np.abs(sub - [cy, cx]).max(1)
                near = sub[d <= 12]
                off = np.hypot(near[:, 0].mean() - cy, near[:, 1].mean() - cx)
                if off > best_off:
                    best_off, best_i = off, idx[k]

            pts = []
            cur = carr[best_i].astype(float)
            dirv = None
            for _ in range(30000):
                cy, cx = cur
                icy, icx = int(cy), int(cx)
                ry0, ry1 = max(0, icy - 6), min(H, icy + 7)
                rx0, rx1 = max(0, icx - 6), min(W, icx + 7)
                subp = arr[ry0:ry1, rx0:rx1]
                m = mask[ry0:ry1, rx0:rx1]
                wd = 3.0
                if m.sum() > 0:
                    col = subp[m][:, :3].mean(0).astype(int)
                    wd = max(2.0, min(14.0, m.sum() / 13.0))
                    pts.append((round(cx, 1), round(cy, 1), round(wd, 1), int(col[0]), int(col[1]), int(col[2])))

                # 消費（半径は控えめに: ヘアピンの先を食い荒らさない）
                eat = min(6.0, wd / 2 + 1.5)
                d2 = (carr[:, 0] - cy) ** 2 + (carr[:, 1] - cx) ** 2
                remaining &= d2 > eat * eat
                if not remaining.any():
                    break

                # 次点: 最近傍の未消費画素（後戻りのみ禁止 cos>-0.5）
                dists = np.where(remaining, d2, 1e18)
                if dirv is not None:
                    vy = carr[:, 0] - cy
                    vx = carr[:, 1] - cx
                    dn = np.sqrt(d2) + 1e-6
                    cosv = (vy * dirv[0] + vx * dirv[1]) / dn
                    cand = np.where(remaining & (cosv > -0.5), d2, 1e18)
                    if cand.min() < 22 * 22:
                        dists = cand
                ni = int(dists.argmin())
                if dists[ni] > 26 * 26:
                    break  # 次が遠い＝この線分は終端（残りは次回トレース）
                nxt = carr[ni].astype(float)
                vy, vx = nxt[0] - cy, nxt[1] - cx
                n = (vy * vy + vx * vx) ** 0.5
                if n > 0:
                    nd = (vy / n, vx / n)
                    dirv = nd if dirv is None else (dirv[0] * .45 + nd[0] * .55, dirv[1] * .45 + nd[1] * .55)
                cur = nxt

            if len(pts) >= 8:
                raw_lines.append(pts)

    lines = []
    for pts in raw_lines:

        # --- 等間隔リサンプル（5px）+ 平滑化 ---
        res = [pts[0]]
        acc = 0.0
        for i in range(1, len(pts)):
            d = ((pts[i][0] - pts[i-1][0]) ** 2 + (pts[i][1] - pts[i-1][1]) ** 2) ** 0.5
            acc += d
            if acc >= 5:
                res.append(pts[i])
                acc = 0
        sm = []
        for i in range(len(res)):
            lo, hi = max(0, i - 2), min(len(res), i + 3)
            seg = res[lo:hi]
            # 太さは広い窓(13)で強平滑化 + クリップ → 「滲んだような太さムラ」を除去
            lo2, hi2 = max(0, i - 6), min(len(res), i + 7)
            seg2 = res[lo2:hi2]
            w_s = sum(s[2] for s in seg2) / len(seg2)
            sm.append([
                round(sum(s[0] for s in seg) / len(seg), 1),
                round(sum(s[1] for s in seg) / len(seg), 1),
                round(min(8.0, max(2.4, w_s)), 1),
                int(sum(s[3] for s in seg) / len(seg)),
                int(sum(s[4] for s in seg) / len(seg)),
                int(sum(s[5] for s in seg) / len(seg)),
            ])
        lines.append(sm)
        print(f'{name}: traced line pts = {len(sm)}')

    # --- 断片連結: 線Aの端と線Bの端が近ければ1本につなぐ ---
    def endpts(l):
        return (l[0][0], l[0][1]), (l[-1][0], l[-1][1])
    merged = True
    while merged and len(lines) > 1:
        merged = False
        for i in range(len(lines)):
            for j in range(len(lines)):
                if i == j:
                    continue
                (asx, asy), (aex, aey) = endpts(lines[i])
                (bsx, bsy), (bex, bey) = endpts(lines[j])
                # i の末尾 ↔ j の先頭 / 末尾
                d_es = ((aex - bsx) ** 2 + (aey - bsy) ** 2) ** 0.5
                d_ee = ((aex - bex) ** 2 + (aey - bey) ** 2) ** 0.5
                if d_es < 80:
                    lines[i] = lines[i] + lines[j]
                elif d_ee < 80:
                    lines[i] = lines[i] + lines[j][::-1]
                else:
                    continue
                del lines[j]
                merged = True
                break
            if merged:
                break
    print(f'{name}: merged into {len(lines)} line(s), pts = {[len(l) for l in lines]}')
    return lines, (W, H)

warm_lines, size = trace_image(f'{BASE}/logo-flow-warm-full.png', 'warm')
cool_lines, _ = trace_image(f'{BASE}/logo-flow-cool-full.png', 'cool')

data = {'w': size[0], 'h': size[1], 'warm': warm_lines, 'cool': cool_lines}
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('// 自動生成: _trace_lines.py — ロゴ流線の中心線パス（x,y,太さ,r,g,b）\n')
    f.write('const LINE_PATHS = ' + json.dumps(data, separators=(',', ':')) + ';\n')
print('saved', OUT)

# --- 検証: トレース結果を polyline で再描画して目視比較 ---
chk = Image.new('RGB', size, (255, 255, 255))
dr = ImageDraw.Draw(chk)
for group in (cool_lines, warm_lines):
    for line in group:
        for i in range(1, len(line)):
            x1, y1, w1, r1, g1, b1 = line[i-1]
            x2, y2, w2, r2, g2, b2 = line[i]
            dr.line([(x1, y1), (x2, y2)], fill=(r1, g1, b1), width=int(max(2, w1)))
chk.save(f'{BASE}/_trace-check.png')
print('check image saved')
