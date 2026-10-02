# explain-finger-vec

交互式可视化 [finger-vec](https://github.com/calcit-lang/finger-vec.ts) 的数据结构和操作规则,思路参考 [explain-ternary-tree](https://github.com/calcit-lang/explain-ternary-tree)。

finger-vec 的布局:

```
front 缓冲区 | relaxed B-tree(块) | back 缓冲区
```

页面上点 `pushRight` / `dropLeft` / `get` / `assoc` / `insert` / `dissoc` / `split` / `concat`,会并排画出操作前后的结构:

- 橙色:本次新建的节点
- 蓝色:被复用的节点(新旧两个版本共享同一个对象)
- 红色虚线:只在旧版本里,新版本不再引用
- 绿色外框:`get` 经过的路径
- 虚线框是缓冲区;分支格子里的斜体数字是累计大小

每次操作下面有逐步说明,右侧是版本历史,可以在任意旧版本上继续操作,旧版本不会变。

## 运行

```
npm install
npm run dev      # 开发
npm run build    # tsc 类型检查 + vite 构建
npm test         # 随机操作对照数组的测试
```

## 实现说明

- 技术栈是 TypeScript + Canvas 2D,没有用 ternary-tree 那边的 Calcit/Phlox 实现,也没有用 WebGPU:图里最多几十个节点,Canvas 足够快。
- `src/finger-vec.ts` 的树算法对照 [finger-vec.rs](https://github.com/calcit-lang/finger-vec.rs) 的 `src/tree.rs` 和 `src/lib.rs`:`join` / `merge_seam` / `join_leaves` / `pack`、`Tree::split`、push 满了走 `Tree::concat`、drop 走 `tree.split`、小向量放在 back、`concat_with` 对短输入逐个 push、split / concat 之后按 `max_height` 重建。函数旁边的注释写了对应的 Rust 名字。
- 所有操作不可变,未改动的节点保持同一个 `id`,可视化靠 `id` 判断复用。缓冲区整块转成叶子(或反过来)时和 Rust 一样共用数据,所以共用 `id`。
- 目前的简化:
  - 缓冲区每次都整体复制。Rust 里缓冲区是共享块的切片 `data[start..end]`,drop 只移动 `start` / `end`。这部分后续再细化。
  - `cap` 同时代替 `CHUNK` 和 `BRANCH`(Rust 里都是 32,这里默认 4,方便看清)。`max_height` 里的 `/4` 在 cap 很小时给了下限;drop 不触发重建,所以 cap < 8 时随机操作后树高可能超过 `max_height`,测试只在 cap ≥ 8 时检查这一条。
  - 对空向量 `dropLeft` / `dropRight` 会报错(Rust 是空操作),方便在界面上提示。
- `src/test.ts` 用随机操作序列(含回到旧版本继续操作、自己拼自己)对照普通数组,每一步检查结构不变量,最后确认所有历史版本都没被改动;另外对照 `tests/shape.rs` 检查左右循环 concat、中间插入、队列用法之后的树高。
- `src/layout.ts` 负责布局(最下面一行是序列本身,分支一层层往上叠)和绘制。

## 文件

```
index.html
src/finger-vec.ts   数据结构与操作(带步骤说明)
src/layout.ts       布局与 Canvas 绘制
src/main.ts         界面逻辑、版本历史
src/style.css
src/test.ts
```

## License

MIT
