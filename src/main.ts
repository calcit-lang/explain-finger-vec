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
import { draw, type NodeState } from "./layout.js";

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
  /** 参与操作但不是前一个版本的输入,例如 concat 的右操作数 */
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
/** get 经过的路径,只对当前版本有效 */
let viewPath = new Set<Id>();
let viewNotes: string[] = [];

const HINT = {
  push: "摊还 O(1):多数情况只复制一个缓冲区,缓冲区满时才改动树的一条脊柱",
  drop: "摊还 O(1):多数情况只复制一个缓冲区",
  get: "O(log_cap n):每层按累计大小选一个孩子",
  assoc: "O(log_cap n):复制根到叶子的一条路径,其余子树复用",
  concat: "O(log n):只沿两棵树的接缝处理,两棵树的其余部分整体复用",
  split: "O(log n):只沿切点路径拆分,其余子树整体复用",
  insert: "O(log n):split + pushRight + concat",
  dissoc: "O(log n):split + dropLeft + concat",
};

// ---------------------------------------------------------------- state

function setError(msg: string) {
  $("#error").textContent = msg;
}

function reset() {
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
  viewPath = new Set();
  viewNotes = [];
  setError("");
  render();
}

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
  viewPath = new Set();
  viewNotes = [];
}

function act(op: string) {
  const base = versions[sel].vec;
  switch (op) {
    case "pushRight": {
      const x = takeValue();
      commit(`pushRight(${x})`, HINT.push, (b) => ({ main: pushRight(b, x) }));
      break;
    }
    case "pushLeft": {
      const x = takeValue();
      commit(`pushLeft(${x})`, HINT.push, (b) => ({ main: pushLeft(b, x) }));
      break;
    }
    case "dropRight":
      commit("dropRight", HINT.drop, (b) => ({ main: dropRight(b) }));
      break;
    case "dropLeft":
      commit("dropLeft", HINT.drop, (b) => ({ main: dropLeft(b) }));
      break;
    case "pushRightN": {
      const n = takeCount();
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
      break;
    }
    case "get": {
      const i = takeIndex();
      const t = traced(() => get(base, i));
      viewPath = new Set(t.path);
      viewNotes = [...t.notes, `结果:get(${i}) = ${t.result}`];
      break;
    }
    case "assoc": {
      const i = takeIndex();
      const x = takeValue();
      commit(`assoc(${i}, ${x})`, HINT.assoc, (b) => ({ main: assoc(b, i, x) }));
      break;
    }
    case "insert": {
      const i = takeIndex();
      const x = takeValue();
      commit(`insert(${i}, ${x})`, HINT.insert, (b) => ({ main: insertAt(b, i, x) }));
      break;
    }
    case "dissoc": {
      const i = takeIndex();
      commit(`dissoc(${i})`, HINT.dissoc, (b) => ({ main: dissoc(b, i) }));
      break;
    }
    case "concat": {
      const n = takeCount();
      const other = fromArray(
        Array.from({ length: n }, () => counter++),
        cap,
      );
      commit(`concat(+${n} 个元素)`, HINT.concat, (b) => ({
        main: concat(b, other),
        inputs: [{ title: `被拼接的向量 b(${n} 个元素)`, vec: other }],
      }));
      break;
    }
    case "split": {
      const i = takeIndex();
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
      sel = versions.length - 2;
      viewPath = new Set();
      viewNotes = [];
      break;
    }
    default:
      throw new Error(`unknown op ${op}`);
  }
}

// ---------------------------------------------------------------- render

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

function makePanel(title: string, vec: Vec, role: Role, other: Set<Id>, hi: Set<Id>, maxWidth: number): HTMLElement {
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
  draw(canvas, vec, { state, highlight: hi, maxWidth });
  return section;
}

function render() {
  const cur = versions[sel];
  const panels = $("#panels");
  panels.replaceChildren();
  const maxWidth = Math.max(240, panels.clientWidth - 26);

  const sources: Extra[] = [];
  if (cur.parent >= 0) sources.push({ title: `操作前 · v${cur.parent}`, vec: versions[cur.parent].vec });
  sources.push(...cur.inputs);
  const results: Extra[] = [{ title: `v${sel} · ${cur.label}`, vec: cur.vec }, ...cur.outputs];

  if (sources.length === 0) {
    results.forEach((r, k) => {
      panels.append(makePanel(r.title, r.vec, "plain", new Set(), k === 0 ? viewPath : new Set(), maxWidth));
    });
  } else {
    const srcIds = idsOf(sources.map((s) => s.vec));
    const resIds = idsOf(results.map((r) => r.vec));
    sources.forEach((s) => panels.append(makePanel(s.title, s.vec, "source", resIds, new Set(), maxWidth)));
    results.forEach((r, k) => {
      panels.append(makePanel(r.title, r.vec, "result", srcIds, k === 0 ? viewPath : new Set(), maxWidth));
    });
  }

  // 说明
  const ex = $("#explain");
  ex.replaceChildren();
  const h2 = document.createElement("h2");
  h2.textContent = cur.label;
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = cur.hint;
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
  versions.forEach((v, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    if (i === sel) b.setAttribute("aria-current", "true");
    b.textContent = `v${i} ${v.label}`;
    if (v.parent >= 0) {
      const sub = document.createElement("span");
      sub.className = "parent";
      sub.textContent = `  ← v${v.parent}`;
      b.append(sub);
    }
    b.addEventListener("click", () => {
      sel = i;
      viewPath = new Set();
      viewNotes = [];
      setError("");
      render();
    });
    li.append(b);
    hist.append(li);
  });
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
    render();
  });
});
$("#reset").addEventListener("click", reset);
$("#cap").addEventListener("change", reset);

let resizeTimer = 0;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(render, 120);
});

reset();
