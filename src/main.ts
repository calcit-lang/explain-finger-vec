import {
  assoc,
  collectIds,
  collectLeaves,
  concat,
  dissoc,
  dropLeft,
  dropRight,
  fromArray,
  get,
  heightOf,
  insertAt,
  len,
  pushLeft,
  pushRight,
  split,
  traced,
  type FV,
  type Id,
} from "./finger-vec.js";
import { drawScene, layout, prepare, type NodeState, type Prepared } from "./layout.js";

type Vec = FV<number>;

interface Extra {
  title: string;
  vec: Vec;
}
interface Version {
  vec: Vec;
  /** 操作前的版本,-1 表示初始版本 */
  parent: number;
  label: string;
  hint: string;
  notes: string[];
  /** 参与操作但不是前一个版本的输入,例如 concat 的另一个操作数 */
  inputs: Extra[];
  /** 同一次操作的其他结果,例如 split 的另一半 */
  outputs: Extra[];
}
interface Out {
  main: Vec;
  notes?: string[];
  inputs?: Extra[];
  outputs?: Extra[];
}

const $ = <E extends HTMLElement>(sel: string): E => {
  const el = document.querySelector<E>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

let cap = 4;
let counter = 0;
let versions: Version[] = [];
let sel = 0;
/** get 经过的路径(从根到叶),只对当前版本有效 */
let viewPath: Id[] = [];
let viewNotes: string[] = [];
let viewTitle = "";
let viewHint = "";

const HINT = {
  push: "摊还 O(1):多数情况只改一个缓冲区,缓冲区满时才并入树",
  drop: "摊还 O(1):多数情况只改一个缓冲区",
  get: "O(log_cap n):每层按累计大小选一个孩子",
  assoc: "O(log_cap n):复制根到叶子的一条路径,其余子树复用",
  concat: "O(log n):只沿两棵树的接缝处理,两棵树的其余部分整体复用",
  split: "O(log n):只沿切点路径拆分,其余子树整体复用",
  insert: "O(log n):split + pushRight + concat",
  dissoc: "O(log n):split + dropLeft + concat",
};

// ---------------------------------------------------------------- 操作

interface Params {
  x?: number;
  i?: number;
  n?: number;
  /** split 之后留下哪一半作为当前版本 */
  keep?: "left" | "right";
}
/** morph:前后两个版本之间做过渡动画;reveal:不产生新版本,只逐个点亮 get 的路径 */
type Effect = "morph" | "reveal";

function setError(msg: string) {
  $("#error").textContent = msg;
}

function commit(label: string, hint: string, fn: (base: Vec) => Out) {
  const base = versions[sel];
  const t = traced(() => fn(base.vec));
  const out = t.result;
  versions.push({
    vec: out.main,
    parent: sel,
    label,
    hint,
    notes: [...(out.notes ?? []), ...t.notes],
    inputs: out.inputs ?? [],
    outputs: out.outputs ?? [],
  });
  sel = versions.length - 1;
  clearView();
}

function clearView() {
  viewPath = [];
  viewNotes = [];
  viewTitle = "";
  viewHint = "";
}

function newChunk(n: number): Vec {
  return fromArray(
    Array.from({ length: n }, () => counter++),
    cap,
  );
}

/** 执行一个操作。出错时抛异常,不会产生新版本。 */
function perform(op: string, p: Params): Effect {
  const base = versions[sel].vec;
  switch (op) {
    case "pushRight": {
      const x = p.x ?? counter++;
      commit(`pushRight(${x})`, HINT.push, (b) => ({ main: pushRight(b, x) }));
      return "morph";
    }
    case "pushLeft": {
      const x = p.x ?? counter++;
      commit(`pushLeft(${x})`, HINT.push, (b) => ({ main: pushLeft(b, x) }));
      return "morph";
    }
    case "dropRight":
      commit("dropRight", HINT.drop, (b) => ({ main: dropRight(b) }));
      return "morph";
    case "dropLeft":
      commit("dropLeft", HINT.drop, (b) => ({ main: dropLeft(b) }));
      return "morph";
    case "pushRightN": {
      const n = p.n ?? 1;
      commit(`pushRight × ${n}`, HINT.push, (b) => {
        let v = b;
        let last: string[] = [];
        for (let k = 0; k < n; k++) {
          const t = traced(() => pushRight(v, counter++));
          v = t.result;
          last = t.notes;
        }
        return { main: v, notes: [`连续 pushRight ${n} 次,下面是最后一次的过程`, ...last] };
      });
      return "morph";
    }
    case "get": {
      const i = p.i ?? 0;
      const t = traced(() => get(base, i));
      clearView();
      viewPath = t.path;
      viewTitle = `get(${i})`;
      viewHint = HINT.get;
      viewNotes = [...t.notes, `结果:get(${i}) = ${t.result}`];
      return "reveal";
    }
    case "assoc": {
      const i = p.i ?? 0;
      const x = p.x ?? counter++;
      commit(`assoc(${i}, ${x})`, HINT.assoc, (b) => ({ main: assoc(b, i, x) }));
      return "morph";
    }
    case "insert": {
      const i = p.i ?? 0;
      const x = p.x ?? counter++;
      commit(`insert(${i}, ${x})`, HINT.insert, (b) => ({ main: insertAt(b, i, x) }));
      return "morph";
    }
    case "dissoc": {
      const i = p.i ?? 0;
      commit(`dissoc(${i})`, HINT.dissoc, (b) => ({ main: dissoc(b, i) }));
      return "morph";
    }
    case "concat": {
      const n = p.n ?? 1;
      const other = newChunk(n);
      commit(`concat(右侧 +${n} 个元素)`, HINT.concat, (b) => ({
        main: concat(b, other),
        inputs: [{ title: `被拼接的向量 b(${n} 个元素)`, vec: other }],
      }));
      return "morph";
    }
    case "concatLeft": {
      const n = p.n ?? 1;
      const other = newChunk(n);
      commit(`concat(左侧 +${n} 个元素)`, HINT.concat, (b) => ({
        main: concat(other, b),
        inputs: [{ title: `拼在左边的向量 a(${n} 个元素)`, vec: other }],
      }));
      return "morph";
    }
    case "split": {
      const i = p.i ?? 0;
      const baseIdx = sel;
      const t = traced(() => split(base, i));
      const [L, R] = t.result;
      versions.push({
        vec: L,
        parent: baseIdx,
        label: `split(${i}) → 左半`,
        hint: HINT.split,
        notes: t.notes,
        inputs: [],
        outputs: [{ title: `split(${i}) 的右半`, vec: R }],
      });
      versions.push({
        vec: R,
        parent: baseIdx,
        label: `split(${i}) → 右半`,
        hint: HINT.split,
        notes: [...t.notes, "(同一次 split 的另一半,可以在历史里切换查看)"],
        inputs: [],
        outputs: [{ title: `split(${i}) 的左半`, vec: L }],
      });
      sel = p.keep === "right" ? versions.length - 1 : versions.length - 2;
      clearView();
      return "morph";
    }
    default:
      throw new Error(`unknown op ${op}`);
  }
}

function runOp(op: string, p: Params) {
  const effect = perform(op, p);
  render({ morph: effect === "morph", animate: true });
}

// ---- 手动操作:从输入框读参数

function takeValue(): number {
  const raw = $<HTMLInputElement>("#value").value.trim();
  if (raw === "") return counter++;
  const x = Number(raw);
  if (!Number.isFinite(x)) throw new Error("值必须是数字");
  return x;
}
function takeIndex(): number {
  const x = Number($<HTMLInputElement>("#index").value);
  if (!Number.isInteger(x)) throw new Error("下标必须是整数");
  return x;
}
function takeCount(): number {
  const x = Math.floor(Number($<HTMLInputElement>("#count").value));
  if (!Number.isFinite(x) || x < 1 || x > 100) throw new Error("个数必须在 1 到 100 之间");
  return x;
}

function act(op: string) {
  const p: Params = {};
  if (["pushRight", "pushLeft", "assoc", "insert"].includes(op)) p.x = takeValue();
  if (["get", "assoc", "insert", "dissoc", "split"].includes(op)) p.i = takeIndex();
  if (["pushRightN", "concat"].includes(op)) p.n = takeCount();
  runOp(op, p);
}

// ---------------------------------------------------------------- 重置

function reset() {
  setPlaying(false);
  cap = Number($<HTMLSelectElement>("#cap").value);
  const n = Math.max(0, Math.min(200, Math.floor(Number($<HTMLInputElement>("#init").value) || 0)));
  counter = 0;
  const items = Array.from({ length: n }, () => counter++);
  const vec = fromArray(items, cap);
  const leaves = collectLeaves(vec.tree).length;
  versions = [
    {
      vec,
      parent: -1,
      label: `初始:${n} 个元素,cap=${cap}`,
      hint: "From<Vec>:O(n)。不超过 cap 个元素整个放进 back;否则全部切块建树,两端缓冲区为空",
      notes:
        n <= cap
          ? [`${n} 个元素不超过 cap,整个放进 back 缓冲区,没有树`]
          : [
              `${n} 个元素均匀切成 ${leaves} 个块(chunk_values),每块不超过 ${cap} 个`,
              "自底向上每层均匀分组建分支(build_from_chunks),front 和 back 都为空",
              "之后的 push 先写缓冲区,缓冲区满了才整块并入树",
            ],
      inputs: [],
      outputs: [],
    },
  ];
  sel = 0;
  clearView();
  resetModeState();
  setError("");
  render();
}

// ---------------------------------------------------------------- 绘制与动画

interface Scene {
  canvas: HTMLCanvasElement;
  prep: Prepared;
  state: (id: Id) => NodeState;
  path: Id[];
  maxWidth: number;
}
let scenes: Scene[] = [];
let raf = 0;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const speed = () => Number($<HTMLInputElement>("#speed").value) || 1;
/** 一次操作的过渡动画时长 */
const animDuration = () => (reduceMotion.matches ? 0 : 1000 / speed());
/** 自动播放时,动画结束后停多久再做下一步 */
const pauseMs = () => (reduceMotion.matches ? 800 : 500) / speed();

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function startAnimation(animate: boolean) {
  cancelAnimationFrame(raf);
  const dur = animate ? animDuration() : 0;
  const t0 = performance.now();
  const frame = (now: number) => {
    const t = dur <= 0 ? 1 : clamp01((now - t0) / dur);
    for (const s of scenes) {
      drawScene(s.canvas, s.prep, t, { state: s.state, path: s.path, reveal: s.path.length * t, maxWidth: s.maxWidth });
    }
    if (t < 1) raf = requestAnimationFrame(frame);
  };
  frame(t0);
}

function idsOf(vs: Vec[]): Set<Id> {
  const s = new Set<Id>();
  for (const v of vs) for (const id of collectIds(v)) s.add(id);
  return s;
}

function statsText(v: Vec): string {
  const levels = v.tree ? heightOf(v.tree) + 1 : 0;
  return `长度 ${len(v)} · 树 ${levels} 层 · front ${v.front.items.length}/${cap} · back ${v.back.items.length}/${cap}`;
}

type Role = "plain" | "source" | "result";

function makePanel(
  title: string,
  vec: Vec,
  role: Role,
  other: Set<Id>,
  from: Vec | null,
  withPath: boolean,
  maxWidth: number,
): HTMLElement {
  const own = collectIds(vec);
  let extra = "";
  let state: (id: Id) => NodeState = () => "neutral";
  if (role === "result") {
    let nNew = 0;
    let nShared = 0;
    own.forEach((id) => (other.has(id) ? nShared++ : nNew++));
    extra = ` · 新建 ${nNew} 个节点 · 复用 ${nShared} 个`;
    state = (id) => (other.has(id) ? "shared" : "new");
  } else if (role === "source") {
    let kept = 0;
    let dropped = 0;
    own.forEach((id) => (other.has(id) ? kept++ : dropped++));
    extra = ` · 被复用 ${kept} 个 · 不再引用 ${dropped} 个`;
    state = (id) => (other.has(id) ? "shared" : "dropped");
  }

  const section = document.createElement("section");
  section.className = "panel";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  const p = document.createElement("p");
  p.className = "stats";
  p.textContent = statsText(vec) + extra;
  const wrap = document.createElement("div");
  wrap.className = "scroll";
  const canvas = document.createElement("canvas");
  wrap.append(canvas);
  section.append(h3, p, wrap);

  const toL = layout(vec);
  scenes.push({
    canvas,
    prep: prepare(from ? layout(from) : toL, toL),
    state,
    path: withPath ? [...viewPath] : [],
    maxWidth,
  });
  return section;
}

interface RenderOpts {
  /** 结果面板从操作前的版本过渡到新版本 */
  morph?: boolean;
  /** 播放动画(否则直接画最终状态) */
  animate?: boolean;
}

function render(opts: RenderOpts = {}) {
  const cur = versions[sel];
  const panels = $("#panels");
  const lefts = [...panels.querySelectorAll<HTMLElement>(".scroll")].map((e) => e.scrollLeft);
  panels.replaceChildren();
  scenes = [];
  const maxWidth = Math.max(240, panels.clientWidth - 26);
  const base = opts.morph && cur.parent >= 0 ? versions[cur.parent].vec : null;

  const sources: Extra[] = [];
  if (cur.parent >= 0) sources.push({ title: `操作前 · v${cur.parent}`, vec: versions[cur.parent].vec });
  sources.push(...cur.inputs);
  const results: Extra[] = [{ title: `v${sel} · ${cur.label}`, vec: cur.vec }, ...cur.outputs];

  if (sources.length === 0) {
    results.forEach((r, k) => {
      panels.append(makePanel(r.title, r.vec, "plain", new Set(), null, k === 0, maxWidth));
    });
  } else {
    const srcIds = idsOf(sources.map((s) => s.vec));
    const resIds = idsOf(results.map((r) => r.vec));
    sources.forEach((s) => panels.append(makePanel(s.title, s.vec, "source", resIds, null, false, maxWidth)));
    results.forEach((r, k) => {
      panels.append(makePanel(r.title, r.vec, "result", srcIds, base, k === 0, maxWidth));
    });
  }
  panels.querySelectorAll<HTMLElement>(".scroll").forEach((e, k) => {
    e.scrollLeft = lefts[k] ?? 0;
  });
  startAnimation(opts.animate ?? false);

  // 说明
  const ex = $("#explain");
  ex.replaceChildren();
  const h2 = document.createElement("h2");
  h2.textContent = viewNotes.length ? viewTitle : cur.label;
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = viewNotes.length ? viewHint : cur.hint;
  ex.append(h2, hint);
  const notes = viewNotes.length ? viewNotes : cur.notes;
  const ol = document.createElement("ol");
  for (const n of notes) {
    const li = document.createElement("li");
    li.textContent = n;
    ol.append(li);
  }
  ex.append(ol);

  // 历史
  const hist = $("#history");
  hist.replaceChildren();
  let curBtn: HTMLElement | null = null;
  versions.forEach((v, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    if (i === sel) {
      b.setAttribute("aria-current", "true");
      curBtn = b;
    }
    b.textContent = `v${i} ${v.label}`;
    if (v.parent >= 0) {
      const sub = document.createElement("span");
      sub.className = "parent";
      sub.textContent = `  ← v${v.parent}`;
      b.append(sub);
    }
    b.addEventListener("click", () => {
      setPlaying(false);
      sel = i;
      clearView();
      setError("");
      render();
    });
    li.append(b);
    hist.append(li);
  });
  // 只在历史列表内部滚动,不带动整个页面
  const btn = curBtn as HTMLElement | null;
  if (btn) {
    if (btn.offsetTop + btn.offsetHeight > hist.scrollTop + hist.clientHeight) {
      hist.scrollTop = btn.offsetTop + btn.offsetHeight - hist.clientHeight;
    } else if (btn.offsetTop < hist.scrollTop) {
      hist.scrollTop = btn.offsetTop;
    }
  }
  updateStatus();
}

// ---------------------------------------------------------------- 自动播放

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Phase = "grow" | "shrink";
let phase: Phase = "grow";
let tick = 0;
let steps = 0;
let rng = mulberry32(7);
const ri = (n: number) => Math.floor(rng() * n);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

const curLen = () => len(versions[sel].vec);
/** 增长到这个长度就开始回缩 */
const maxLen = () => Math.min(100, Math.max(24, cap * cap * 5));
/** 回缩到这个长度就重新增长 */
const minLen = () => Math.max(2, Math.min(cap, 6));

function updatePhase() {
  const n = curLen();
  if (phase === "grow" && n >= maxLen()) phase = "shrink";
  else if (phase === "shrink" && n <= minLen()) phase = "grow";
}

interface Mode {
  id: string;
  label: string;
  desc: string;
  /** 是否有 增长 / 回缩 两个阶段 */
  phased: boolean;
  step: () => void;
}

const MODES: Mode[] = [
  {
    id: "queue",
    label: "队列",
    desc: "右端 pushRight、左端 dropLeft。增长时三步里推两步弹一步,回缩时反过来。能看到右缓冲区满了并入树、左缓冲区空了从树里取回叶子。",
    phased: true,
    step() {
      const k = tick++ % 3;
      const push = phase === "grow" ? k !== 2 : k === 0;
      runOp(push ? "pushRight" : "dropLeft", {});
    },
  },
  {
    id: "append",
    label: "向右追加 / 回缩",
    desc: "一直 pushRight 到上限,再一直 dropRight 回到很短。能看到 back 缓冲区反复填满、并入树的右侧脊柱,树增高;回缩时树又降下来。",
    phased: true,
    step() {
      runOp(phase === "grow" ? "pushRight" : "dropRight", {});
    },
  },
  {
    id: "prepend",
    label: "向左追加 / 回缩",
    desc: "和上一个对称:pushLeft 到上限再 dropLeft。能看到 front 缓冲区并入树的左侧脊柱。",
    phased: true,
    step() {
      runOp(phase === "grow" ? "pushLeft" : "dropLeft", {});
    },
  },
  {
    id: "deque",
    label: "双端随机",
    desc: "每一步随机选左端或右端,增长阶段 75% 推入,回缩阶段 75% 弹出。两端缓冲区各自独立工作。",
    phased: true,
    step() {
      const push = rng() < (phase === "grow" ? 0.75 : 0.25);
      const left = rng() < 0.5;
      runOp(push ? (left ? "pushLeft" : "pushRight") : left ? "dropLeft" : "dropRight", {});
    },
  },
  {
    id: "middle",
    label: "中间插入 / 删除",
    desc: "总是在正中间 insert(增长)或 dissoc(回缩)。每一步都是 split + concat,能看到只有切点和接缝处的节点被新建,其余子树全部复用,树不会越插越深。",
    phased: true,
    step() {
      const n = curLen();
      const mid = Math.floor(n / 2) + ri(3) - 1;
      if (phase === "grow" || n < 3) runOp("insert", { i: clamp(mid, 1, Math.max(1, n - 1)), x: counter++ });
      else runOp("dissoc", { i: clamp(mid, 1, n - 2) });
    },
  },
  {
    id: "join",
    label: "拼接 / 切分",
    desc: "增长阶段交替往右、往左 concat 一小段;回缩阶段随机 split 并留下一半。能看到 join 沿接缝合并或重新均分节点,以及短输入退化成逐个 push。",
    phased: true,
    step() {
      const n = curLen();
      if (phase === "grow") {
        runOp(tick++ % 2 === 0 ? "concat" : "concatLeft", { n: 1 + ri(cap * 3) });
      } else {
        const i = clamp(Math.floor(n / 4) + ri(Math.max(1, Math.floor(n / 2))), 1, n - 1);
        runOp("split", { i, keep: rng() < 0.5 ? "left" : "right" });
      }
    },
  },
  {
    id: "readwrite",
    label: "随机读写",
    desc: "先把向量推到一定长度,然后交替 get 和 assoc 随机下标。get 会逐个点亮经过的节点;assoc 只复制根到叶子的一条路径,其余子树复用。",
    phased: false,
    step() {
      const n = curLen();
      if (n < Math.max(cap * cap, 16)) {
        runOp("pushRight", {});
        return;
      }
      const i = ri(n);
      if (tick++ % 2 === 0) runOp("get", { i });
      else runOp("assoc", { i, x: counter++ });
    },
  },
  {
    id: "random",
    label: "随机混合",
    desc: "把所有操作混在一起随机执行:push、drop、insert、dissoc、assoc、get、concat、split。长度仍然在上下限之间来回。",
    phased: true,
    step() {
      const n = curLen();
      const growOps = ["pushRight", "pushRight", "pushLeft", "insert", "concat", "assoc", "get", "dropLeft", "dissoc", "split"];
      const shrinkOps = ["dropLeft", "dropRight", "dropRight", "dissoc", "split", "pushRight", "assoc", "get", "insert"];
      const list = phase === "grow" ? growOps : shrinkOps;
      let op = list[ri(list.length)];
      if (n < 3 && !["pushRight", "pushLeft", "concat"].includes(op)) op = "pushRight";
      switch (op) {
        case "insert":
          runOp("insert", { i: ri(n + 1), x: counter++ });
          break;
        case "concat":
          runOp(ri(2) === 0 ? "concat" : "concatLeft", { n: 1 + ri(cap * 3) });
          break;
        case "assoc":
          runOp("assoc", { i: ri(n), x: counter++ });
          break;
        case "get":
        case "dissoc":
          runOp(op, { i: ri(n) });
          break;
        case "split": {
          if (phase === "grow") {
            // 增长阶段只从一端切掉一小段(最多四分之一),留下大的那一半
            const cut = 1 + ri(Math.max(1, Math.floor(n / 4)));
            if (rng() < 0.5) runOp("split", { i: clamp(cut, 1, n - 1), keep: "right" });
            else runOp("split", { i: clamp(n - cut, 1, n - 1), keep: "left" });
          } else {
            runOp("split", { i: 1 + ri(n - 1), keep: rng() < 0.5 ? "left" : "right" });
          }
          break;
        }
        default:
          runOp(op, {});
      }
    },
  },
];

let modeIdx = 0;
let playing = false;
let playToken = 0;

function resetModeState() {
  phase = "grow";
  tick = 0;
  steps = 0;
  rng = mulberry32(7);
}

function updateStatus() {
  const m = MODES[modeIdx];
  const parts = [`第 ${steps} 步`];
  if (m.phased) parts.push(phase === "grow" ? "增长阶段" : "回缩阶段");
  parts.push(`长度 ${curLen()}`);
  $("#modeStatus").textContent = parts.join(" · ");
}

function stepMode() {
  updatePhase();
  MODES[modeIdx].step();
  steps++;
  updateStatus();
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

async function loop(token: number) {
  while (playing && token === playToken) {
    try {
      stepMode();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPlaying(false);
      return;
    }
    await sleep(animDuration() + pauseMs());
  }
}

function setPlaying(on: boolean) {
  if (on === playing) return;
  playing = on;
  const btn = $<HTMLButtonElement>("#play");
  btn.textContent = on ? "⏸ 暂停" : "▶ 播放";
  btn.setAttribute("aria-pressed", String(on));
  if (on) {
    setError("");
    void loop(++playToken);
  } else {
    playToken++;
  }
}

function setMode(i: number) {
  modeIdx = i;
  resetModeState();
  $("#modeDesc").textContent = MODES[i].desc;
  updateStatus();
}

// ---------------------------------------------------------------- wiring

document.querySelectorAll<HTMLButtonElement>("button[data-op]").forEach((btn) => {
  btn.addEventListener("click", () => {
    try {
      act(btn.dataset.op!);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  });
});
$("#reset").addEventListener("click", reset);
$("#cap").addEventListener("change", reset);

const modeSel = $<HTMLSelectElement>("#mode");
MODES.forEach((m, i) => {
  const o = document.createElement("option");
  o.value = String(i);
  o.textContent = m.label;
  modeSel.append(o);
});
modeSel.addEventListener("change", () => setMode(Number(modeSel.value)));
$("#play").addEventListener("click", () => setPlaying(!playing));
$("#step").addEventListener("click", () => {
  setPlaying(false);
  try {
    stepMode();
    setError("");
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
});
const speedInput = $<HTMLInputElement>("#speed");
const syncSpeed = () => {
  $("#speedOut").textContent = `${speed()}×`;
};
speedInput.addEventListener("input", syncSpeed);
syncSpeed();

let resizeTimer = 0;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => render(), 120);
});

reset();
setMode(0);
