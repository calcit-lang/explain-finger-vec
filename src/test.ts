// 随机操作序列对照普通数组:每一步检查内容、结构不变量,并且确认旧版本没有被改动(持久性)。
import {
  assoc,
  checkInvariants,
  concat,
  dissoc,
  dropLeft,
  dropRight,
  empty,
  fromArray,
  get,
  heightOf,
  insertAt,
  len,
  maxHeight,
  pushLeft,
  pushRight,
  split,
  toArray,
  type FV,
} from "./finger-vec.js";

let seed = 12345;
const rnd = (n: number) => {
  // xorshift,保证每次运行结果一致
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return Math.abs(seed) % n;
};

let counter = 0;
const eq = (a: readonly number[], b: readonly number[], msg: string) => {
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
    throw new Error(`${msg}\n  got      ${JSON.stringify(a)}\n  expected ${JSON.stringify(b)}`);
  }
};

function runOnce(cap: number, steps: number) {
  const versions: { v: FV<number>; arr: number[] }[] = [];
  let v: FV<number> = empty<number>(cap);
  let arr: number[] = [];
  versions.push({ v, arr });
  let maxHeight = 0;

  for (let s = 0; s < steps; s++) {
    const op = rnd(11);
    const n = arr.length;
    let label = "";
    // 偶尔回到旧版本继续操作,验证持久性
    if (rnd(12) === 0) {
      const old = versions[rnd(versions.length)];
      v = old.v;
      arr = old.arr;
    }
    const m = arr.length;
    switch (op) {
      case 0:
      case 1:
        label = "pushRight";
        v = pushRight(v, ++counter);
        arr = [...arr, counter];
        break;
      case 2:
        label = "pushLeft";
        v = pushLeft(v, ++counter);
        arr = [counter, ...arr];
        break;
      case 3:
        if (m > 0) {
          label = "dropLeft";
          v = dropLeft(v);
          arr = arr.slice(1);
        }
        break;
      case 4:
        if (m > 0) {
          label = "dropRight";
          v = dropRight(v);
          arr = arr.slice(0, -1);
        }
        break;
      case 5:
        if (m > 0) {
          const i = rnd(m);
          label = `assoc ${i}`;
          v = assoc(v, i, ++counter);
          arr = arr.slice();
          arr[i] = counter;
        }
        break;
      case 6: {
        const i = rnd(m + 1);
        label = `insertAt ${i}`;
        v = insertAt(v, i, ++counter);
        arr = [...arr.slice(0, i), counter, ...arr.slice(i)];
        break;
      }
      case 7:
        if (m > 0) {
          const i = rnd(m);
          label = `dissoc ${i}`;
          v = dissoc(v, i);
          arr = [...arr.slice(0, i), ...arr.slice(i + 1)];
        }
        break;
      case 8: {
        const i = rnd(m + 1);
        label = `split ${i}`;
        const [l, r] = split(v, i);
        checkInvariants(l);
        checkInvariants(r);
        eq(toArray(l), arr.slice(0, i), `split left ${label}`);
        eq(toArray(r), arr.slice(i), `split right ${label}`);
        // 随机留下哪一半
        if (rnd(2) === 0) {
          v = l;
          arr = arr.slice(0, i);
        } else {
          v = r;
          arr = arr.slice(i);
        }
        break;
      }
      case 9: {
        const k = rnd(cap * cap * 2 + 3);
        const other = Array.from({ length: k }, () => ++counter);
        label = `concat +${k}`;
        const ov = fromArray(other, cap);
        checkInvariants(ov);
        v = concat(v, ov);
        arr = [...arr, ...other];
        break;
      }
      default: {
        // 自己拼自己:验证结构共享不会互相污染
        label = "concat self";
        if (arr.length < 400) {
          v = concat(v, v);
          arr = [...arr, ...arr];
        }
      }
    }
    try {
      checkInvariants(v);
    } catch (e) {
      throw new Error(`step ${s}: ${label} (cap=${cap}, n=${n} → ${arr.length}): ${(e as Error).message}`);
    }
    eq(toArray(v), arr, `step ${s}: ${label} (cap=${cap}, n=${n})`);
    if (len(v) !== arr.length) throw new Error("len mismatch");
    for (let k = 0; k < 3 && arr.length > 0; k++) {
      const i = rnd(arr.length);
      if (get(v, i) !== arr[i]) throw new Error(`get(${i}) wrong after ${label}`);
    }
    if (v.tree) maxHeight = Math.max(maxHeight, heightOf(v.tree));
    versions.push({ v, arr });
  }

  // 所有历史版本必须仍然等于当时的数组
  versions.forEach(({ v: ov, arr: oa }, idx) => {
    eq(toArray(ov), oa, `version ${idx} was mutated (cap=${cap})`);
    checkInvariants(ov);
  });
  return maxHeight;
}

// 深度上界(对照 tests/shape.rs):循环 concat、中间插入、队列用法之后,树高不超过 max_height
function depthChecks(cap: number) {
  const within = (v: FV<number>, what: string) => {
    checkInvariants(v);
    const h = v.tree ? heightOf(v.tree) : 0;
    const limit = maxHeight(len(v), cap);
    if (h > limit) throw new Error(`${what} 之后高度 ${h} 超过 max_height ${limit} (cap=${cap})`);
    return h;
  };

  let right = empty<number>(cap);
  let left = empty<number>(cap);
  for (let i = 0; i < 300; i++) {
    right = concat(right, fromArray([i], cap));
    left = concat(fromArray([i], cap), left);
  }
  const h1 = Math.max(within(right, "右侧循环 concat"), within(left, "左侧循环 concat"));
  eq(toArray(right), Array.from({ length: 300 }, (_, i) => i), "concat loop right");

  let w = fromArray(Array.from({ length: 50 }, (_, i) => i), cap);
  for (let i = 0; i < 200; i++) w = insertAt(w, Math.floor(len(w) / 2), 1000 + i);
  const h2 = within(w, "中间插入");

  let q = empty<number>(cap);
  for (let i = 0; i < 400; i++) {
    q = pushRight(q, i);
    if (i % 2 === 1) q = dropLeft(q);
  }
  checkInvariants(q);
  eq(toArray(q), Array.from({ length: 200 }, (_, i) => 200 + i), "queue usage");
  return [h1, h2];
}

for (const cap of [2, 3, 4, 5, 8, 32]) {
  let hmax = 0;
  for (let round = 0; round < 40; round++) hmax = Math.max(hmax, runOnce(cap, 150));
  const [h1, h2] = depthChecks(cap);
  console.log(`cap=${cap}: ok  (随机最大高度 ${hmax}, concat 循环高度 ${h1}, 中间插入高度 ${h2})`);
}
console.log("all tests passed");
