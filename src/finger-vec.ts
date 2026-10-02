// 教学用的 FingerVec 模型,算法对照 calcit-lang/finger-vec.rs(src/lib.rs、src/tree.rs)。
//
//     front buffer | relaxed B-tree of chunks | back buffer
//
// 与 Rust 实现一致的部分:
// - 树:叶子 1..=cap 个元素,分支 1..=cap 个孩子,所有叶子同深度,分支保存累计大小 ends
// - join / merge_seam / join_leaves / pack:concat 沿接缝合并或重新分配节点
// - push:缓冲区满了,整块变成叶子,用 Tree::concat 并入树
// - drop:缓冲区为空时,用 tree.split 从树的一端取出一个叶子当缓冲区
// - 不超过 cap 个元素的向量整个放在 back 里
// - concat 时一侧不超过 cap 个元素,就逐个 push 进另一侧
// - split / concat 之后,树高超过 max_height(len) 就按叶子重建
//
// 暂时简化的部分(后续再细化):
// - 缓冲区一律整体复制。Rust 里缓冲区是共享块的切片 data[start..end],
//   drop 只移动 start/end,新旧版本共用同一个块;这里每次 drop 都会生成新块
// - cap 同时代替 CHUNK 和 BRANCH(Rust 里都是 32);max_height 里的 /4 在 cap 很小时做了下限保护
//
// 所有操作不可变,未改动的节点保持同一个 id,可视化靠 id 判断复用。
// 和 Rust 一样,叶子由缓冲区整块转来(into_chunk / Buf::from_arc)时共用同一份数据,这里共用同一个 id。

export type Id = number;

let idCounter = 0;
const nid = (): Id => ++idCounter;

export interface Buf<T> {
  kind: "buf";
  id: Id;
  items: readonly T[];
}
export interface Leaf<T> {
  kind: "leaf";
  id: Id;
  items: readonly T[];
}
export interface Branch<T> {
  kind: "branch";
  id: Id;
  height: number;
  children: readonly TNode<T>[];
  /** 累计大小:sizes[j] = children[0..=j] 的元素总数(Rust 里叫 ends) */
  sizes: readonly number[];
}
export type TNode<T> = Leaf<T> | Branch<T>;

export interface FV<T> {
  cap: number;
  front: Buf<T>;
  tree: TNode<T> | null;
  back: Buf<T>;
}

// ---------------------------------------------------------------- trace

let curNotes: string[] | null = null;
let curPath: Id[] | null = null;

const note = (s: string) => {
  curNotes?.push(s);
};

/** 执行 f 时不记录说明,用于逐个 push 这类会刷屏的循环 */
function quiet<R>(f: () => R): R {
  const prev = curNotes;
  curNotes = null;
  try {
    return f();
  } finally {
    curNotes = prev;
  }
}

export interface Traced<R> {
  result: R;
  notes: string[];
  /** get 经过的节点 id */
  path: Id[];
}

export function traced<R>(f: () => R): Traced<R> {
  const prevNotes = curNotes;
  const prevPath = curPath;
  const notes: string[] = [];
  const path: Id[] = [];
  curNotes = notes;
  curPath = path;
  try {
    const result = f();
    return { result, notes, path };
  } finally {
    curNotes = prevNotes;
    curPath = prevPath;
  }
}

// ---------------------------------------------------------------- basics

const sizeOf = <T>(n: TNode<T>): number => (n.kind === "leaf" ? n.items.length : n.sizes[n.sizes.length - 1]);
export const heightOf = <T>(n: TNode<T>): number => (n.kind === "leaf" ? 0 : n.height);

const mkBuf = <T>(items: readonly T[]): Buf<T> => ({ kind: "buf", id: nid(), items });
const emptyBuf = <T>(): Buf<T> => mkBuf<T>([]);
const mkLeaf = <T>(items: readonly T[]): Leaf<T> => ({ kind: "leaf", id: nid(), items });
const mkBranch = <T>(children: readonly TNode<T>[]): Branch<T> => {
  const sizes: number[] = [];
  let acc = 0;
  for (const c of children) {
    acc += sizeOf(c);
    sizes.push(acc);
  }
  return { kind: "branch", id: nid(), height: heightOf(children[0]) + 1, children, sizes };
};

/** Buf::into_chunk:缓冲区整块变成叶子,数据共用 */
const leafFromBuf = <T>(b: Buf<T>): Leaf<T> => ({ kind: "leaf", id: b.id, items: b.items });
/** Buf::from_arc:叶子整块变成缓冲区,数据共用 */
const bufFromLeaf = <T>(l: Leaf<T>): Buf<T> => ({ kind: "buf", id: l.id, items: l.items });

/** 缓冲区变空时换成空缓冲区(Rust 里是 Buf::empty()) */
const bufOf = <T>(items: readonly T[]): Buf<T> => (items.length === 0 ? emptyBuf<T>() : mkBuf(items));

export function empty<T>(cap: number): FV<T> {
  return { cap, front: emptyBuf<T>(), tree: null, back: emptyBuf<T>() };
}

const treeLen = <T>(v: FV<T>): number => (v.tree ? sizeOf(v.tree) : 0);

export function len<T>(v: FV<T>): number {
  return v.front.items.length + treeLen(v) + v.back.items.length;
}

export function collectLeaves<T>(n: TNode<T> | null, out: Leaf<T>[] = []): Leaf<T>[] {
  if (!n) return out;
  if (n.kind === "leaf") out.push(n);
  else for (const c of n.children) collectLeaves(c, out);
  return out;
}

export function toArray<T>(v: FV<T>): T[] {
  const out: T[] = [...v.front.items];
  for (const l of collectLeaves(v.tree)) out.push(...l.items);
  out.push(...v.back.items);
  return out;
}

/** 一个向量里所有节点(含非空缓冲区)的 id。空缓冲区在 Rust 里没有数据,不算节点 */
export function collectIds<T>(v: FV<T>): Set<Id> {
  const ids = new Set<Id>();
  if (v.front.items.length > 0) ids.add(v.front.id);
  if (v.back.items.length > 0) ids.add(v.back.id);
  const walk = (n: TNode<T>) => {
    ids.add(n.id);
    if (n.kind === "branch") n.children.forEach(walk);
  };
  if (v.tree) walk(v.tree);
  return ids;
}

// ---------------------------------------------------------------- tree.rs

/** Tree::normalize_root:折叠只有一个孩子的根 */
const normalizeRoot = <T>(n: TNode<T> | null): TNode<T> | null => {
  let cur = n;
  while (cur && cur.kind === "branch" && cur.children.length === 1) cur = cur.children[0];
  return cur;
};

/** 把 count 个东西均匀分成 ceil(count / cap) 组,返回每组大小(chunk_values / build_from_chunks 的分法) */
function evenGroups(count: number, cap: number): number[] {
  const groups = Math.ceil(count / cap);
  const base = Math.floor(count / groups);
  const extra = count % groups;
  return Array.from({ length: groups }, (_, g) => base + (g < extra ? 1 : 0));
}

/** chunk_values:切成尽量均匀、每块不超过 cap 的叶子 */
function chunkValues<T>(xs: readonly T[], cap: number): Leaf<T>[] {
  if (xs.length === 0) return [];
  const out: Leaf<T>[] = [];
  let i = 0;
  for (const size of evenGroups(xs.length, cap)) {
    out.push(mkLeaf(xs.slice(i, i + size)));
    i += size;
  }
  return out;
}

/** build_from_chunks:自底向上,每层均匀分组建分支 */
function buildFromChunks<T>(leaves: readonly TNode<T>[], cap: number): TNode<T> | null {
  if (leaves.length === 0) return null;
  let level: TNode<T>[] = [...leaves];
  while (level.length > 1) {
    const next: TNode<T>[] = [];
    let i = 0;
    for (const size of evenGroups(level.length, cap)) {
      next.push(mkBranch(level.slice(i, i + size)));
      i += size;
    }
    level = next;
  }
  return level[0];
}

/** Tree::split:拆成 [0, idx) 和 [idx, len),两边都可能为空 */
function treeSplit<T>(n: TNode<T>, idx: number): [TNode<T> | null, TNode<T> | null] {
  if (idx <= 0) return [null, n];
  if (idx >= sizeOf(n)) return [n, null];
  if (n.kind === "leaf") return [mkLeaf(n.items.slice(0, idx)), mkLeaf(n.items.slice(idx))];
  let i = 0;
  while (n.sizes[i] <= idx) i++;
  const offset = i > 0 ? n.sizes[i - 1] : 0;
  const [cl, cr] = treeSplit(n.children[i], idx - offset);
  const left = [...n.children.slice(0, i), ...(cl ? [cl] : [])];
  const right = [...(cr ? [cr] : []), ...n.children.slice(i + 1)];
  return [left.length ? mkBranch(left) : null, right.length ? mkBranch(right) : null];
}

/** Tree::concat:join 之后,一个部分就折叠根,两个部分就加一层 */
function treeConcat<T>(a: TNode<T>, b: TNode<T>, cap: number): TNode<T> {
  const parts = join(a, b, cap);
  if (parts.length === 1) return normalizeRoot(parts[0])!;
  note("接缝处拆成了两个节点,在上面新加一层根,树高 +1");
  return mkBranch(parts);
}

/** join:返回高度为 max(ha, hb) 的一棵或两棵树 */
function join<T>(a: TNode<T>, b: TNode<T>, cap: number): TNode<T>[] {
  const ha = heightOf(a);
  const hb = heightOf(b);
  if (ha > hb) {
    const ab = a as Branch<T>;
    const last = ab.children.length - 1;
    const mid = join(ab.children[last], b, cap);
    const children = ab.children.slice(0, last);
    const seam = children.length;
    children.push(...mid);
    mergeSeam(children, Math.max(seam - 1, 0), seam + mid.length, cap);
    return pack(children, cap);
  }
  if (ha < hb) {
    const bb = b as Branch<T>;
    const mid = join(a, bb.children[0], cap);
    const children = [...mid, ...bb.children.slice(1)];
    mergeSeam(children, 0, mid.length + 1, cap);
    return pack(children, cap);
  }
  if (a.kind === "leaf" && b.kind === "leaf") return joinLeaves(a, b, cap);
  const ab = a as Branch<T>;
  const bb = b as Branch<T>;
  const la = ab.children.length - 1;
  const mid = join(ab.children[la], bb.children[0], cap);
  const children = ab.children.slice(0, la);
  const seam = children.length;
  children.push(...mid, ...bb.children.slice(1));
  mergeSeam(children, Math.max(seam - 1, 0), seam + mid.length + 1, cap);
  return pack(children, cap);
}

/** join_leaves:放得下就合并;有一边不到半满就均分;否则两个叶子原样复用 */
function joinLeaves<T>(x: Leaf<T>, y: Leaf<T>, cap: number): Leaf<T>[] {
  const total = x.items.length + y.items.length;
  if (total <= cap) {
    note(`接缝两侧的叶子共 ${total} 个元素,放得进一个块:合并成新叶子`);
    return [mkLeaf([...x.items, ...y.items])];
  }
  const half = Math.floor(cap / 2);
  if (x.items.length < half || y.items.length < half) {
    const left = Math.floor(total / 2);
    const all = [...x.items, ...y.items];
    note(`接缝两侧的叶子(${x.items.length} + ${y.items.length})有一个不到半满:重新均分成 ${left} + ${total - left}`);
    return [mkLeaf(all.slice(0, left)), mkLeaf(all.slice(left))];
  }
  return [x, y];
}

/** merge_seam:children[from..to] 里相邻节点放得下就合并,避免接缝处堆积小节点 */
function mergeSeam<T>(children: TNode<T>[], from: number, to: number, cap: number): void {
  let i = from;
  let end = Math.min(to, children.length);
  while (i + 1 < end) {
    const x = children[i];
    const y = children[i + 1];
    let merged: TNode<T> | null = null;
    if (x.kind === "leaf" && y.kind === "leaf" && x.items.length + y.items.length <= cap) {
      merged = mkLeaf([...x.items, ...y.items]);
      note(`merge_seam:相邻叶子 ${x.items.length} + ${y.items.length} 个元素合并成一个`);
    } else if (x.kind === "branch" && y.kind === "branch" && x.children.length + y.children.length <= cap) {
      merged = mkBranch([...x.children, ...y.children]);
      note(`merge_seam:相邻分支 ${x.children.length} + ${y.children.length} 个孩子合并成一个`);
    }
    if (merged) {
      children[i] = merged;
      children.splice(i + 1, 1);
      end -= 1;
    } else {
      i += 1;
    }
  }
}

/** pack:不超过 cap 个孩子包成一个分支,否则从中间拆成两个 */
function pack<T>(children: TNode<T>[], cap: number): TNode<T>[] {
  if (children.length <= cap) return [mkBranch(children)];
  const cut = Math.floor(children.length / 2);
  note(`pack:${children.length} 个孩子超过 cap,从中间拆成 ${cut} + ${children.length - cut} 两个分支`);
  return [mkBranch(children.slice(0, cut)), mkBranch(children.slice(cut))];
}

const leftmostLeaf = <T>(t: TNode<T>): Leaf<T> => (t.kind === "leaf" ? t : leftmostLeaf(t.children[0]));
const rightmostLeaf = <T>(t: TNode<T>): Leaf<T> =>
  t.kind === "leaf" ? t : rightmostLeaf(t.children[t.children.length - 1]);

// ---------------------------------------------------------------- lib.rs

/**
 * max_height:len 个元素允许的树高 —— 按节点只有四分之一满算出的高度,再加一层余量。
 * Rust 里是 CHUNK/4 = BRANCH/4 = 8;cap 很小时 /4 会变成 0 或 1,这里给了下限。
 */
export function maxHeight(n: number, cap: number): number {
  const perChunk = Math.max(1, Math.floor(cap / 4));
  const perBranch = Math.max(2, Math.floor(cap / 4));
  let chunks = Math.max(1, Math.ceil(n / perChunk));
  let h = 0;
  while (chunks > 1) {
    chunks = Math.ceil(chunks / perBranch);
    h += 1;
  }
  return h + 1;
}

/** rebalanced:树比 max_height 高就把所有元素重新切块建树 */
function rebalanced<T>(v: FV<T>): FV<T> {
  if (!v.tree) return v;
  const n = len(v);
  const limit = maxHeight(n, v.cap);
  if (heightOf(v.tree) <= limit) return v;
  const items: T[] = [];
  for (const l of collectLeaves(v.tree)) items.push(...l.items);
  note(`树高 ${heightOf(v.tree)} 超过 max_height(${n}) = ${limit}:把树里的元素重新切块建树`);
  return { ...v, tree: buildFromChunks(chunkValues(items, v.cap), v.cap) };
}

/** From<Vec<T>>:不超过 cap 个元素放进 back;否则全部切块建树,两端缓冲区为空 */
export function fromArray<T>(items: readonly T[], cap: number): FV<T> {
  if (items.length <= cap) return { cap, front: emptyBuf<T>(), tree: null, back: bufOf(items) };
  return { cap, front: emptyBuf<T>(), tree: buildFromChunks(chunkValues(items, cap), cap), back: emptyBuf<T>() };
}

/** from_slice_buf:split 在缓冲区里切出来的那一半 */
const fromSliceBuf = <T>(items: readonly T[], cap: number): FV<T> => fromArray(items, cap);

// ---------------------------------------------------------------- get / assoc

function locate<T>(v: FV<T>, i: number): { where: "front" | "tree" | "back"; k: number } {
  const fl = v.front.items.length;
  const ts = treeLen(v);
  if (i < fl) return { where: "front", k: i };
  if (i < fl + ts) return { where: "tree", k: i - fl };
  return { where: "back", k: i - fl - ts };
}

function checkIndex<T>(v: FV<T>, i: number) {
  if (!Number.isInteger(i) || i < 0 || i >= len(v)) throw new RangeError(`下标 ${i} 越界,长度 ${len(v)}`);
}

function getTree<T>(n: TNode<T>, i: number): T {
  curPath?.push(n.id);
  if (n.kind === "leaf") return n.items[i];
  let j = 0;
  while (n.sizes[j] <= i) j++;
  const off = j > 0 ? n.sizes[j - 1] : 0;
  return getTree(n.children[j], i - off);
}

export function get<T>(v: FV<T>, i: number): T {
  checkIndex(v, i);
  const { where, k } = locate(v, i);
  if (where === "front") {
    curPath?.push(v.front.id);
    note(`下标 ${i} 落在 front 缓冲区,直接取第 ${k} 个`);
    return v.front.items[k];
  }
  if (where === "back") {
    curPath?.push(v.back.id);
    note(`下标 ${i} 先减去 front 和树的长度,落在 back 缓冲区第 ${k} 个`);
    return v.back.items[k];
  }
  note(`下标 ${i} 落在树里:先减去 front 长度 ${v.front.items.length},得到树内下标 ${k}`);
  note("每层用累计大小 ends 找到第一个大于下标的孩子(partition_point),减去它之前的累计值再往下走");
  return getTree(v.tree!, k);
}

function assocTree<T>(n: TNode<T>, i: number, x: T): TNode<T> {
  if (n.kind === "leaf") {
    const items = n.items.slice();
    items[i] = x;
    return mkLeaf(items);
  }
  let j = 0;
  while (n.sizes[j] <= i) j++;
  const off = j > 0 ? n.sizes[j - 1] : 0;
  const children = n.children.slice();
  children[j] = assocTree(n.children[j], i - off, x);
  return { kind: "branch", id: nid(), height: n.height, children, sizes: n.sizes };
}

export function assoc<T>(v: FV<T>, i: number, x: T): FV<T> {
  checkIndex(v, i);
  const { where, k } = locate(v, i);
  if (where === "front") {
    note("下标在 front:复制 front 后改一个元素,树和 back 整体复用");
    const items = v.front.items.slice();
    items[k] = x;
    return { ...v, front: mkBuf(items) };
  }
  if (where === "back") {
    note("下标在 back:复制 back 后改一个元素,front 和树整体复用");
    const items = v.back.items.slice();
    items[k] = x;
    return { ...v, back: mkBuf(items) };
  }
  note("下标在树里:沿根到叶子的路径复制节点(path copy),ends 不变,路径之外的子树全部复用");
  return { ...v, tree: assocTree(v.tree!, k, x) };
}

// ---------------------------------------------------------------- push / drop

/** push_back_mut */
export function pushRight<T>(v: FV<T>, x: T): FV<T> {
  const cap = v.cap;
  let { tree, back } = v;
  if (back.items.length >= cap) {
    const leaf = leafFromBuf(back);
    note(`back 已满(${cap}/${cap}):整块变成叶子,用 Tree::concat(树, 叶子) 并入树的右侧`);
    tree = tree ? treeConcat(tree, leaf, cap) : leaf;
    back = emptyBuf<T>();
  } else {
    note(`back 未满(${back.items.length}/${cap}):复制 back 并追加,front 和树整体复用`);
  }
  return { cap, front: v.front, tree, back: mkBuf([...back.items, x]) };
}

/** push_front_mut */
export function pushLeft<T>(v: FV<T>, x: T): FV<T> {
  const cap = v.cap;
  let { front, tree } = v;
  if (front.items.length >= cap) {
    const leaf = leafFromBuf(front);
    note(`front 已满(${cap}/${cap}):整块变成叶子,用 Tree::concat(叶子, 树) 并入树的左侧`);
    tree = tree ? treeConcat(leaf, tree, cap) : leaf;
    front = emptyBuf<T>();
  }
  // 小向量整个放在 back 里,保持一个块
  if (front.items.length === 0 && !tree && v.back.items.length < cap) {
    note(`向量只有 back(${v.back.items.length}/${cap}):小向量整体留在 back,在 back 前面插入`);
    return { cap, front, tree, back: mkBuf([x, ...v.back.items]) };
  }
  if (front.items.length > 0) note(`front 未满(${front.items.length}/${cap}):复制 front 并在前面插入,树和 back 整体复用`);
  else note("front 为空:新建只含这个元素的 front");
  return { cap, front: mkBuf([x, ...front.items]), tree, back: v.back };
}

/** pop_front_mut。Rust 的 drop_left 对空向量是空操作,这里报错方便在界面上提示 */
export function dropLeft<T>(v: FV<T>): FV<T> {
  if (len(v) === 0) throw new RangeError("空向量不能 dropLeft");
  let { front, tree, back } = v;
  if (front.items.length === 0) {
    if (tree) {
      const k = leftmostLeaf(tree).items.length;
      const [head, rest] = treeSplit(tree, k);
      note(`front 为空:tree.split(${k}) 取出最左侧的叶子,整块变成 front(数据共用),再去掉第一个元素`);
      tree = normalizeRoot(rest);
      front = bufFromLeaf(normalizeRoot(head) as Leaf<T>);
    } else {
      note("front 和树都为空:第一个元素在 back,复制 back 并去掉它");
      return { ...v, back: bufOf(back.items.slice(1)) };
    }
  } else {
    note("front 非空:去掉 front 的第一个元素,树和 back 整体复用");
  }
  return { cap: v.cap, front: bufOf(front.items.slice(1)), tree, back };
}

/** pop_back_mut */
export function dropRight<T>(v: FV<T>): FV<T> {
  if (len(v) === 0) throw new RangeError("空向量不能 dropRight");
  let { front, tree, back } = v;
  if (back.items.length === 0) {
    if (tree) {
      const n = sizeOf(tree);
      const k = rightmostLeaf(tree).items.length;
      const [rest, tail] = treeSplit(tree, n - k);
      note(`back 为空:tree.split(${n - k}) 取出最右侧的叶子,整块变成 back(数据共用),再去掉最后一个元素`);
      tree = normalizeRoot(rest);
      back = bufFromLeaf(normalizeRoot(tail) as Leaf<T>);
    } else {
      note("back 和树都为空:最后一个元素在 front,复制 front 并去掉它");
      return { ...v, front: bufOf(front.items.slice(0, -1)) };
    }
  } else {
    note("back 非空:去掉 back 的最后一个元素,front 和树整体复用");
  }
  return { cap: v.cap, front, tree, back: bufOf(back.items.slice(0, -1)) };
}

// ---------------------------------------------------------------- concat / split

/** concat_with */
export function concat<T>(a: FV<T>, b: FV<T>): FV<T> {
  if (a.cap !== b.cap) throw new Error("两个向量的 cap 不同");
  const cap = a.cap;
  if (len(b) === 0) {
    note("右边为空,直接返回左边");
    return a;
  }
  if (len(a) === 0) {
    note("左边为空,直接返回右边");
    return b;
  }
  if (len(b) <= cap) {
    note(`右边只有 ${len(b)} 个元素(不超过 cap):逐个 pushRight 进左边,back 满了就整块并入树`);
    return quiet(() => toArray(b).reduce((acc, x) => pushRight(acc, x), a));
  }
  if (len(a) <= cap) {
    note(`左边只有 ${len(a)} 个元素(不超过 cap):倒序逐个 pushLeft 进右边,front 满了就整块并入树`);
    return quiet(() => toArray(a).reduceRight((acc, x) => pushLeft(acc, x), b));
  }
  note("左树 = a.tree + a.back,右树 = b.front + b.tree;a.front 和 b.back 原样保留为两端缓冲区");
  let left = a.tree;
  if (a.back.items.length > 0) {
    const leaf = leafFromBuf(a.back);
    left = left ? treeConcat(left, leaf, cap) : leaf;
  }
  let right = b.tree;
  if (b.front.items.length > 0) {
    const leaf = leafFromBuf(b.front);
    right = right ? treeConcat(leaf, right, cap) : leaf;
  }
  note("Tree::concat:较高的树沿脊柱下降到同一高度,只处理接缝两侧的节点");
  const tree = left && right ? treeConcat(left, right, cap) : (left ?? right);
  return rebalanced({ cap, front: a.front, tree, back: b.back });
}

/** split:[0, idx) 和 [idx, len) */
export function split<T>(v: FV<T>, idx: number): [FV<T>, FV<T>] {
  const n = len(v);
  if (!Number.isInteger(idx) || idx < 0 || idx > n) throw new RangeError(`切点 ${idx} 越界,长度 ${n}`);
  const cap = v.cap;
  if (idx === 0) {
    note("切点 0:左边为空,右边就是原向量");
    return [empty<T>(cap), v];
  }
  if (idx === n) {
    note("切点在末尾:左边就是原向量,右边为空");
    return [v, empty<T>(cap)];
  }
  const f = v.front.items.length;
  if (idx <= f) {
    note(`切点 ${idx} 落在 front 缓冲区:左边是 front 的前 ${idx} 个(放进 back),右边复用树和 back`);
    const left = fromSliceBuf(v.front.items.slice(0, idx), cap);
    const right: FV<T> = { ...v, front: bufOf(v.front.items.slice(idx)) };
    return [left, right];
  }
  const t = treeLen(v);
  if (idx <= f + t) {
    const k = idx - f;
    note(`切点 ${idx} 落在树里(树内位置 ${k}):沿根到切点的路径把每层节点拆成左右两半,路径之外的子树不动`);
    note("左边 = front + 左半树(back 为空),右边 = 右半树 + back(front 为空),两边各自折叠单孩子的根");
    const [tl, tr] = treeSplit(v.tree!, k);
    const left: FV<T> = { cap, front: v.front, tree: normalizeRoot(tl), back: emptyBuf<T>() };
    const right: FV<T> = { cap, front: emptyBuf<T>(), tree: normalizeRoot(tr), back: v.back };
    return [rebalanced(left), rebalanced(right)];
  }
  const k = idx - f - t;
  note(`切点 ${idx} 落在 back 缓冲区:左边复用 front 和树,右边是 back 的后 ${v.back.items.length - k} 个`);
  const left: FV<T> = { ...v, back: bufOf(v.back.items.slice(0, k)) };
  const right = fromSliceBuf(v.back.items.slice(k), cap);
  return [left, right];
}

/** insert_at:pos 在 0..=len */
export function insertAt<T>(v: FV<T>, pos: number, x: T): FV<T> {
  const n = len(v);
  if (!Number.isInteger(pos) || pos < 0 || pos > n) throw new RangeError(`插入位置 ${pos} 越界,长度 ${n}`);
  if (pos === 0) {
    note("插入位置在开头:等同于 pushLeft");
    return pushLeft(v, x);
  }
  if (pos === n) {
    note("插入位置在末尾:等同于 pushRight");
    return pushRight(v, x);
  }
  note(`insert = split(${pos}) → 左半 pushRight → concat`);
  const [l, r] = split(v, pos);
  return concat(pushRight(l, x), r);
}

/** dissoc */
export function dissoc<T>(v: FV<T>, i: number): FV<T> {
  checkIndex(v, i);
  const n = len(v);
  if (i === 0) {
    note("删除第一个:等同于 dropLeft");
    return dropLeft(v);
  }
  if (i === n - 1) {
    note("删除最后一个:等同于 dropRight");
    return dropRight(v);
  }
  note(`dissoc = split(${i}) → 右半 dropLeft → concat`);
  const [l, r] = split(v, i);
  return concat(l, dropLeft(r));
}

// ---------------------------------------------------------------- invariants

/** check_structure + Tree::check,出错抛异常。测试里每一步都会调用。 */
export function checkInvariants<T>(v: FV<T>): void {
  const fail = (m: string): never => {
    throw new Error(`invariant: ${m}`);
  };
  if (v.cap < 2) fail("cap < 2");
  if (v.front.items.length > v.cap) fail("front 超过 cap");
  if (v.back.items.length > v.cap) fail("back 超过 cap");
  const walk = (n: TNode<T>): number => {
    if (n.kind === "leaf") {
      if (n.items.length === 0 || n.items.length > v.cap) fail(`叶子大小 ${n.items.length} 不在 1..cap`);
      return n.items.length;
    }
    if (n.children.length < 1 || n.children.length > v.cap) fail(`分支孩子数 ${n.children.length} 不在 1..cap`);
    let acc = 0;
    n.children.forEach((c, j) => {
      if (heightOf(c) + 1 !== n.height) fail("叶子不在同一深度");
      acc += walk(c);
      if (n.sizes[j] !== acc) fail("累计大小不对");
    });
    return acc;
  };
  if (v.tree) {
    walk(v.tree);
    // Rust 的高度上界假设节点至少四分之一满(cap/4 >= 2)。cap 很小时这个假设不成立:
    // drop 不会触发重建,连续 drop 后树可以比上界高,所以只在 cap >= 8 时检查。
    const limit = maxHeight(len(v), v.cap);
    if (v.cap >= 8 && heightOf(v.tree) > limit) fail(`树高 ${heightOf(v.tree)} 超过 max_height ${limit}`);
  }
}
