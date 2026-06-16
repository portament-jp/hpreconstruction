# 流線の途切れ補修: 文字や他の線に隠れて欠けたギャップを検出し、橋渡し線を描画する
# 出力:
#   logo-flow-warm-bridge.png  橋渡し部分のみ（ヒーローで ink の下に敷く）
#   logo-flow-warm-full.png    warm + 橋渡し焼き込み（stray装飾用）
#   logo-flow-cool-full.png    cool + 橋渡し焼き込み（ヒーロー/stray共用。coolはinkの下なので静止時も不可視）
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

BASE = 'portament-hp/assets'

ink_img = Image.open(f'{BASE}/logo-ink-full.png')
W, H = ink_img.size
ink = np.array(ink_img)[:, :, 3] > 20

def dilate(mask, size):
    return np.array(Image.fromarray((mask * 255).astype('uint8')).filter(ImageFilter.MaxFilter(size))) > 0

ink_d = dilate(ink, 9)

warm_arr = np.array(Image.open(f'{BASE}/logo-flow-warm.png'))
cool_arr = np.array(Image.open(f'{BASE}/logo-flow-cool.png'))
warm_m = warm_arr[:, :, 3] > 25
cool_m = cool_arr[:, :, 3] > 25

def cluster(points, link=4):
    """8近傍系の簡易クラスタリング（貪欲BFS）"""
    pts = points.astype(np.int32)
    n = len(pts)
    used = np.zeros(n, bool)
    clusters = []
    for i in range(n):
        if used[i]:
            continue
        stack = [i]
        used[i] = True
        member = [i]
        while stack:
            cur = stack.pop()
            d = np.abs(pts - pts[cur]).max(1)
            near = np.where(~used & (d <= link))[0]
            for j in near:
                used[j] = True
                stack.append(j)
                member.append(j)
        clusters.append(pts[member])
    return clusters

def avg_color(arr, mask, cy, cx, r=12):
    y0, y1 = max(0, cy - r), min(H, cy + r)
    x0, x1 = max(0, cx - r), min(W, cx + r)
    sub = arr[y0:y1, x0:x1]
    m = mask[y0:y1, x0:x1]
    if m.sum() == 0:
        return (120, 120, 120)
    px = sub[m][:, :3]
    return tuple(px.mean(0).astype(int))

def local_width(mask, cy, cx, r=9):
    """端点近傍の線の太さを近似（近傍線画素数 / 直径）"""
    y0, y1 = max(0, cy - r), min(H, cy + r)
    x0, x1 = max(0, cx - r), min(W, cx + r)
    cnt = mask[y0:y1, x0:x1].sum()
    return max(3, min(14, int(round(cnt / (2 * r)))))

def line_dir(line_mask, cy, cx, r=16):
    """端点から線が伸びている方向の単位ベクトル（線の重心方向）"""
    y0, y1 = max(0, cy - r), min(H, cy + r)
    x0, x1 = max(0, cx - r), min(W, cx + r)
    sub = line_mask[y0:y1, x0:x1]
    ys, xs = np.where(sub)
    if len(ys) == 0:
        return None
    vy = ys.mean() + y0 - cy
    vx = xs.mean() + x0 - cx
    n = (vy * vy + vx * vx) ** 0.5
    if n < 1e-6:
        return None
    return (vy / n, vx / n)

def repair(line_mask, line_arr, other_mask, name):
    # 障害物 = 文字 + もう一方の線（の膨張）。ギャップはこの中にある
    obstacle = ink_d | dilate(other_mask, 7)
    # 線端: 線を少し膨張させて障害物に食い込んだ画素（線の切れ目のすぐ先）
    line_d = dilate(line_mask, 5)
    contact = line_d & obstacle & ~line_mask
    ys, xs = np.where(contact)
    pts = np.stack([ys, xs], 1)
    cls = cluster(pts)
    cents = []
    for c in cls:
        if len(c) < 3:
            continue
        cy, cx = c.mean(0).astype(int)
        d_ = line_dir(line_mask, cy, cx)
        if d_ is None:
            continue
        cents.append((cy, cx, d_))
    print(f'{name}: endpoints = {len(cents)}')

    # ペアリング: 距離<150、中点が障害物内、かつ「線の延長方向」が橋方向と整合
    pairs = []
    cand = []
    for i in range(len(cents)):
        for j in range(i + 1, len(cents)):
            dy = cents[j][0] - cents[i][0]
            dx = cents[j][1] - cents[i][1]
            d = (dy * dy + dx * dx) ** 0.5
            if d < 10 or d > 150:
                continue
            my, mx_ = (cents[i][0] + cents[j][0]) // 2, (cents[i][1] + cents[j][1]) // 2
            if not obstacle[my, mx_]:
                continue
            by, bx = dy / d, dx / d  # i→j 方向
            di, dj = cents[i][2], cents[j][2]
            # 橋方向 ≈ -di（iの線と反対側へ抜ける）、逆向き ≈ -dj
            cos_i = (-di[0]) * by + (-di[1]) * bx
            cos_j = (-dj[0]) * (-by) + (-dj[1]) * (-bx)
            if cos_i < 0.45 or cos_j < 0.45:
                continue
            score = d - 40 * (cos_i + cos_j)  # 近くて方向が合うものを優先
            cand.append((score, d, i, j))
    cand.sort()
    used = set()
    for score, d, i, j in cand:
        if i in used or j in used:
            continue
        used.add(i)
        used.add(j)
        pairs.append((cents[i], cents[j]))
    print(f'{name}: bridges = {len(pairs)}')

    # 橋渡しを3次ベジェで描画（両端の線方向に沿って滑らかに、色はグラデ補間）
    bridge = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    dr = ImageDraw.Draw(bridge)
    for (y1_, x1_, d1), (y2_, x2_, d2) in pairs:
        c1 = avg_color(line_arr, line_mask, y1_, x1_)
        c2 = avg_color(line_arr, line_mask, y2_, x2_)
        w1 = local_width(line_mask, y1_, x1_)
        w2 = local_width(line_mask, y2_, x2_)
        wd = max(3, min(w1, w2, 9))
        dist = ((y2_ - y1_) ** 2 + (x2_ - x1_) ** 2) ** 0.5
        k = dist / 3
        # 制御点 = 端点から「線の延長方向」(-dir) へ
        p0 = (x1_, y1_)
        p1 = (x1_ - d1[1] * k, y1_ - d1[0] * k)
        p2 = (x2_ - d2[1] * k, y2_ - d2[0] * k)
        p3 = (x2_, y2_)
        steps = 22
        prev = p0
        for s in range(1, steps + 1):
            t = s / steps
            mt = 1 - t
            bx_ = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
            by_ = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
            col = tuple(int(c1[q] + (c2[q] - c1[q]) * t) for q in range(3)) + (255,)
            dr.line([prev, (bx_, by_)], fill=col, width=wd)
            r_ = wd // 2
            dr.ellipse([bx_ - r_, by_ - r_, bx_ + r_, by_ + r_], fill=col)
            prev = (bx_, by_)
    # わずかにぼかしてAAをなじませる
    bridge = bridge.filter(ImageFilter.GaussianBlur(0.6))
    return bridge

warm_bridge = repair(warm_m, warm_arr, cool_m, 'warm')
cool_bridge = repair(cool_m, cool_arr, warm_m, 'cool')

warm_bridge.save(f'{BASE}/logo-flow-warm-bridge.png')

warm_full = Image.open(f'{BASE}/logo-flow-warm.png').copy()
warm_full.alpha_composite(warm_bridge)
warm_full.save(f'{BASE}/logo-flow-warm-full.png')

cool_full = Image.open(f'{BASE}/logo-flow-cool.png').copy()
cool_full.alpha_composite(cool_bridge)
cool_full.save(f'{BASE}/logo-flow-cool-full.png')

# 検証: 補修後の線だけを白背景で合成
chk = Image.new('RGBA', (W, H), (255, 255, 255, 255))
chk.alpha_composite(cool_full)
chk.alpha_composite(warm_full)
chk.convert('RGB').save(f'{BASE}/_lines-fixed-check.png')
print('done')
