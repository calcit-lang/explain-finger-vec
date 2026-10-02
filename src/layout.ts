// 把一个 FV 摆成图:最下面一行是序列本身(front | 叶子们 | back),树的分支一层层往上叠。
// 另外负责两个布局之间的过渡动画:节点按 id 配对,复用的滑动到新位置,新的淡入,被丢弃的淡出。
import { heightOf, type FV, type Id, type TNode } from "./finger-vec.js";

export type NodeState = "new" | "shared" | "dropped" | "neutral";

const CELL_W = 28;
const CELL_H = 28;
const INNER = 5;
const GAP = 12;
const SECTION_GAP = 34;
const LEVEL_H = 72;
const TOP = 18;
const MARGIN = 20;
const TAG_H = 26;

type Kind = "buf" | "leaf" | "branch";
type Tag = "front" | "back";

export interface Box {
  id: Id;
  kind: Kind;
  x: number;
  y: number;
  w: number;
  cells: string[];
  /** 只有缓冲区有:front / back */
  tag?: Tag;
}
export interface Edge {
  parent: Id;
  child: Id;
  /** child 是 parent 的第几个孩子 */
  index: number;
}
export interface Layout {
  boxes: Box[];
  edges: Edge[];
  width: number;
  height: number;
}

const boxW = (n: number) => Math.max(n, 1) * CELL_W + 2 * INNER;

export function layout(v: FV<number>): Layout {
  const boxes: Box[] = [];
  const edges: Edge[] = [];
  const H = v.tree ? heightOf(v.tree) : 0;
  const yOf = (h: number) => TOP + (H - h) * LEVEL_H;
  let cursor = MARGIN;

  const addBuf = (id: Id, items: readonly number[], tag: Tag) => {
    const w = boxW(items.length);
    boxes.push({ id, kind: "buf", x: cursor, y: yOf(0), w, cells: items.map(String), tag });
    cursor += w;
  };

  addBuf(v.front.id, v.front.items, "front");
  cursor += SECTION_GAP;

  // 返回节点中心 x
  const place = (n: TNode<number>): number => {
    if (n.kind === "leaf") {
      const w = boxW(n.items.length);
      const x = cursor;
      boxes.push({ id: n.id, kind: "leaf", x, y: yOf(0), w, cells: n.items.map(String) });
      cursor += w + GAP;
      return x + w / 2;
    }
    const centers = n.children.map(place);
    const w = boxW(n.children.length);
    const cx = (centers[0] + centers[centers.length - 1]) / 2;
    const x = cx - w / 2;
    boxes.push({ id: n.id, kind: "branch", x, y: yOf(n.height), w, cells: n.sizes.map(String) });
    n.children.forEach((c, j) => edges.push({ parent: n.id, child: c.id, index: j }));
    return cx;
  };

  if (v.tree) {
    place(v.tree);
    cursor -= GAP;
    cursor += SECTION_GAP;
  }
  addBuf(v.back.id, v.back.items, "back");

  return { boxes, edges, width: cursor + MARGIN, height: yOf(0) + CELL_H + TAG_H + 8 };
}

// ---------------------------------------------------------------- 配对

interface Pair {
  fb?: Box;
  tb?: Box;
}
interface EdgePair extends Edge {
  inFrom: boolean;
  inTo: boolean;
}
/** 两个布局配好对的结果,同一对布局画很多帧时只算一次 */
export interface Prepared {
  from: Layout;
  to: Layout;
  pairs: Pair[];
  edges: EdgePair[];
}

/**
 * 先按 id 配对;剩下的缓冲区再按角色(front / back)配对。
 * 这样 push 进缓冲区时,缓冲区原地长出一格,而不是旧的淡出、新的淡入。
 * 缓冲区整块变成叶子时 id 不变,会按 id 配上叶子,新缓冲区则淡入。
 */
export function prepare(from: Layout, to: Layout): Prepared {
  const fm = new Map(from.boxes.map((b) => [b.id, b]));
  const used = new Set<Id>();
  const pairs: Pair[] = [];
  const pendingTo: Box[] = [];
  for (const tb of to.boxes) {
    const fb = fm.get(tb.id);
    if (fb) {
      used.add(fb.id);
      pairs.push({ fb, tb });
    } else pendingTo.push(tb);
  }
  const roles = new Map<Tag, Box>();
  for (const fb of from.boxes) if (!used.has(fb.id) && fb.tag) roles.set(fb.tag, fb);
  for (const tb of pendingTo) {
    const fb = tb.tag ? roles.get(tb.tag) : undefined;
    if (fb && tb.tag) {
      roles.delete(tb.tag);
      used.add(fb.id);
      pairs.push({ fb, tb });
    } else pairs.push({ tb });
  }
  for (const fb of from.boxes) if (!used.has(fb.id)) pairs.push({ fb });

  const edges = new Map<string, EdgePair>();
  for (const e of from.edges) edges.set(`${e.parent}>${e.child}`, { ...e, inFrom: true, inTo: false });
  for (const e of to.edges) {
    const k = `${e.parent}>${e.child}`;
    const old = edges.get(k);
    if (old) old.inTo = true;
    else edges.set(k, { ...e, inFrom: false, inTo: true });
  }
  return { from, to, pairs, edges: [...edges.values()] };
}

// ---------------------------------------------------------------- 动画曲线

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
/** 在 [a, b] 这段时间里从 0 缓动到 1 */
const win = (t: number, a: number, b: number) => ease((t - a) / (b - a));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export interface DrawOpts {
  /** `to` 里节点的状态 */
  state: (id: Id) => NodeState;
  /** 要高亮的路径,按从根到叶的顺序 */
  path: readonly Id[];
  /** 已点亮的路径节点数,可以是小数;>= path.length 就是全部点亮 */
  reveal: number;
  /** 容器可用宽度;图比它宽时按比例缩小,最小 0.8(再小字就看不清了),再宽就横向滚动 */
  maxWidth: number;
}

interface Item {
  pair: Pair;
  x: number;
  y: number;
  w: number;
  alpha: number;
  scale: number;
  state: NodeState;
  kind: Kind;
  tag?: Tag;
  tagAlpha: number;
}

/**
 * 画 t 时刻的画面,t 从 0(旧布局)到 1(新布局)。
 * 时间分三段:0–0.35 旧节点淡出,0.2–0.8 复用的节点滑动,0.55–1 新节点淡入。
 */
export function drawScene(canvas: HTMLCanvasElement, P: Prepared, t: number, o: DrawOpts): void {
  const tOut = win(t, 0, 0.35);
  const tMove = win(t, 0.2, 0.8);
  const tIn = win(t, 0.55, 1);

  const W = lerp(P.from.width, P.to.width, tMove);
  const H = lerp(P.from.height, P.to.height, tMove);
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.max(0.8, Math.min(1, o.maxWidth / W));
  const cw = Math.ceil(W * scale * dpr);
  const ch = Math.ceil(H * scale * dpr);
  if (canvas.width !== cw) canvas.width = cw;
  if (canvas.height !== ch) canvas.height = ch;
  canvas.style.width = `${W * scale}px`;
  canvas.style.height = `${H * scale}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  ctx.clearRect(0, 0, W + 2, H + 2);

  const css = getComputedStyle(document.documentElement);
  const c = (name: string) => css.getPropertyValue(name).trim();
  const palette: Record<NodeState, { line: string; bg: string }> = {
    new: { line: c("--c-new"), bg: c("--c-new-bg") },
    shared: { line: c("--c-shared"), bg: c("--c-shared-bg") },
    dropped: { line: c("--c-dropped"), bg: c("--c-dropped-bg") },
    neutral: { line: c("--c-node"), bg: c("--c-node-bg") },
  };
  const text = c("--c-text");
  const muted = c("--c-muted");
  const pathColor = c("--c-path");
  const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

  const stateOf = (b: Box) => (b.cells.length === 0 ? "neutral" : o.state(b.id));

  // 每个节点此刻的位置和透明度
  const items: Item[] = P.pairs.map((pair) => {
    const { fb, tb } = pair;
    if (fb && tb) {
      return {
        pair,
        x: lerp(fb.x, tb.x, tMove),
        y: lerp(fb.y, tb.y, tMove),
        w: lerp(fb.w, tb.w, tMove),
        alpha: 1,
        scale: 1,
        state: stateOf(tb),
        kind: tMove < 0.5 ? fb.kind : tb.kind,
        tag: tb.tag ?? fb.tag,
        tagAlpha: tb.tag && fb.tag ? 1 : tb.tag ? tMove : 1 - tMove,
      };
    }
    if (tb) {
      return {
        pair,
        x: tb.x,
        y: tb.y + (1 - tIn) * 14,
        w: tb.w,
        alpha: tIn,
        scale: 0.8 + 0.2 * tIn,
        state: stateOf(tb),
        kind: tb.kind,
        tag: tb.tag,
        tagAlpha: tIn,
      };
    }
    const f = fb!;
    return {
      pair,
      x: f.x,
      y: f.y,
      w: f.w,
      alpha: 1 - tOut,
      scale: 1 - 0.15 * tOut,
      state: "dropped",
      kind: f.kind,
      tag: f.tag,
      tagAlpha: 1 - tOut,
    };
  });
  const byId = new Map<Id, Item>();
  items.forEach((it) => {
    if (it.pair.fb) byId.set(it.pair.fb.id, it);
    if (it.pair.tb) byId.set(it.pair.tb.id, it);
  });

  // 边:颜色跟随父节点,端点跟随两端节点此刻的位置
  ctx.lineWidth = 1.5;
  for (const e of P.edges) {
    const p = byId.get(e.parent);
    const ch = byId.get(e.child);
    if (!p || !ch) continue;
    const st = p.state;
    const edgeAlpha = e.inFrom && e.inTo ? 1 : e.inTo ? tIn : 1 - tOut;
    if (edgeAlpha <= 0.01) continue;
    const x1 = p.x + INNER + e.index * CELL_W + CELL_W / 2;
    const y1 = p.y + CELL_H;
    const x2 = ch.x + ch.w / 2;
    const y2 = ch.y;
    ctx.strokeStyle = st === "neutral" ? muted : palette[st].line;
    ctx.globalAlpha = edgeAlpha * (st === "shared" ? 0.55 : 0.9);
    ctx.setLineDash(st === "dropped" ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    const my = (y1 + y2) / 2;
    ctx.bezierCurveTo(x1, my, x2, my, x2, y2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  // 路径高亮:按顺序一个个点亮
  const lit = new Map<Item, number>();
  o.path.forEach((id, k) => {
    const it = byId.get(id);
    const a = clamp01(o.reveal - k);
    if (it && a > 0) lit.set(it, a);
  });

  const drawCells = (it: Item, cells: string[], kind: Kind, alpha: number) => {
    if (alpha <= 0.01) return;
    ctx.globalAlpha = it.alpha * alpha;
    const pal = palette[it.state];
    if (cells.length === 0) {
      ctx.fillStyle = muted;
      ctx.font = `13px ${mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("∅", it.x + it.w / 2, it.y + CELL_H / 2);
      return;
    }
    // 格子均分整个盒子的宽度,盒子变宽时格子跟着撑开
    const cellW = (it.w - 2 * INNER) / cells.length;
    cells.forEach((s, j) => {
      const cx = it.x + INNER + j * cellW;
      if (j > 0) {
        ctx.beginPath();
        ctx.moveTo(cx, it.y + 5);
        ctx.lineTo(cx, it.y + CELL_H - 5);
        ctx.lineWidth = 1;
        ctx.strokeStyle = pal.line;
        ctx.globalAlpha = it.alpha * alpha * 0.35;
        ctx.stroke();
        ctx.globalAlpha = it.alpha * alpha;
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (kind === "branch") {
        // 分支格子里写的是累计大小
        ctx.fillStyle = muted;
        ctx.font = `italic 12px ${mono}`;
      } else {
        ctx.fillStyle = text;
        ctx.font = `13px ${mono}`;
      }
      ctx.fillText(s, cx + cellW / 2, it.y + CELL_H / 2 + 0.5);
    });
  };

  for (const it of items) {
    if (it.alpha <= 0.01) continue;
    const pal = palette[it.state];
    ctx.save();
    // 以盒子中心为原点缩放
    const cx = it.x + it.w / 2;
    const cy = it.y + CELL_H / 2;
    ctx.translate(cx, cy);
    ctx.scale(it.scale, it.scale);
    ctx.translate(-cx, -cy);

    ctx.globalAlpha = it.alpha;
    ctx.beginPath();
    ctx.roundRect(it.x, it.y, it.w, CELL_H, 6);
    ctx.fillStyle = pal.bg;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = pal.line;
    ctx.setLineDash(it.kind === "buf" || it.state === "dropped" ? [5, 3] : []);
    ctx.stroke();
    ctx.setLineDash([]);

    const hl = lit.get(it);
    if (hl) {
      ctx.globalAlpha = it.alpha * hl;
      ctx.beginPath();
      ctx.roundRect(it.x - 3, it.y - 3, it.w + 6, CELL_H + 6, 8);
      ctx.lineWidth = 3;
      ctx.strokeStyle = pathColor;
      ctx.stroke();
    }

    const { fb, tb } = it.pair;
    if (fb && tb && fb.cells.join(",") !== tb.cells.join(",")) {
      // 内容变了(例如缓冲区追加了一个元素):旧内容淡出,新内容淡入
      drawCells(it, fb.cells, fb.kind, 1 - tMove);
      drawCells(it, tb.cells, tb.kind, tMove);
    } else {
      const b = tb ?? fb!;
      drawCells(it, b.cells, b.kind, 1);
    }

    if (it.tag && it.tagAlpha > 0.01) {
      ctx.globalAlpha = it.alpha * it.tagAlpha;
      ctx.fillStyle = muted;
      ctx.font = `12px ${mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(it.tag, it.x + it.w / 2, it.y + CELL_H + 7);
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
