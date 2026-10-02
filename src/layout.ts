// 把一个 FV 摆成图:最下面一行是序列本身(front | 叶子们 | back),树的分支一层层往上叠。
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

interface Box {
  id: Id;
  kind: "buf" | "leaf" | "branch";
  x: number;
  y: number;
  w: number;
  cells: string[];
  tag?: string;
}
interface Edge {
  parent: Id;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
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

  const addBuf = (id: Id, items: readonly number[], tag: string) => {
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
    const y = yOf(n.height);
    boxes.push({ id: n.id, kind: "branch", x, y, w, cells: n.sizes.map(String) });
    n.children.forEach((c, j) => {
      edges.push({
        parent: n.id,
        x1: x + INNER + j * CELL_W + CELL_W / 2,
        y1: y + CELL_H,
        x2: centers[j],
        y2: yOf(heightOf(c)),
      });
    });
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

export interface DrawOpts {
  state: (id: Id) => NodeState;
  highlight: Set<Id>;
  /** 容器可用宽度;图比它宽时按比例缩小,最小 0.8(再小字就看不清了),再宽就横向滚动 */
  maxWidth: number;
}

export function draw(canvas: HTMLCanvasElement, v: FV<number>, o: DrawOpts): void {
  const L = layout(v);
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.max(0.8, Math.min(1, o.maxWidth / L.width));
  canvas.style.width = `${L.width * scale}px`;
  canvas.style.height = `${L.height * scale}px`;
  canvas.width = Math.ceil(L.width * scale * dpr);
  canvas.height = Math.ceil(L.height * scale * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  ctx.clearRect(0, 0, L.width, L.height);

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

  // 边:颜色跟随父节点(新节点写入的指针画成新的)
  ctx.lineWidth = 1.5;
  for (const e of L.edges) {
    const st = o.state(e.parent);
    ctx.strokeStyle = st === "neutral" ? muted : palette[st].line;
    ctx.globalAlpha = st === "shared" ? 0.55 : 0.9;
    ctx.setLineDash(st === "dropped" ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(e.x1, e.y1);
    const my = (e.y1 + e.y2) / 2;
    ctx.bezierCurveTo(e.x1, my, e.x2, my, e.x2, e.y2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  for (const b of L.boxes) {
    // 空缓冲区没有数据,不参与新建 / 复用的标记
    const st = b.cells.length === 0 ? "neutral" : o.state(b.id);
    const pal = palette[st];
    const w = b.w;
    const h = CELL_H;
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, w, h, 6);
    ctx.fillStyle = pal.bg;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = pal.line;
    ctx.setLineDash(b.kind === "buf" || st === "dropped" ? [5, 3] : []);
    ctx.stroke();
    ctx.setLineDash([]);

    if (o.highlight.has(b.id)) {
      ctx.beginPath();
      ctx.roundRect(b.x - 3, b.y - 3, w + 6, h + 6, 8);
      ctx.lineWidth = 3;
      ctx.strokeStyle = pathColor;
      ctx.stroke();
    }

    if (b.cells.length === 0) {
      ctx.fillStyle = muted;
      ctx.font = `13px ${mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("∅", b.x + w / 2, b.y + h / 2);
    }
    b.cells.forEach((s, j) => {
      const cx = b.x + INNER + j * CELL_W;
      if (j > 0) {
        ctx.beginPath();
        ctx.moveTo(cx, b.y + 5);
        ctx.lineTo(cx, b.y + h - 5);
        ctx.lineWidth = 1;
        ctx.strokeStyle = pal.line;
        ctx.globalAlpha = 0.35;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (b.kind === "branch") {
        // 分支格子里写的是累计大小
        ctx.fillStyle = muted;
        ctx.font = `italic 12px ${mono}`;
      } else {
        ctx.fillStyle = text;
        ctx.font = `13px ${mono}`;
      }
      ctx.fillText(s, cx + CELL_W / 2, b.y + h / 2 + 0.5);
    });

    if (b.tag) {
      ctx.fillStyle = muted;
      ctx.font = `12px ${mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(b.tag, b.x + w / 2, b.y + h + 7);
    }
  }
}
