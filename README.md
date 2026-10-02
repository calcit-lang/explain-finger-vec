# explain-finger-vec

交互式可视化 [finger-vec](https://github.com/calcit-lang/finger-vec.ts) 的数据结构和操作规则,思路参考 [explain-ternary-tree](https://github.com/calcit-lang/explain-ternary-tree)。

Live demo <http://repo.calcit-lang.org/explain-finger-vec/>

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

### 动画

操作前后两个结构之间有过渡动画(节点按 id 配对):

- 被复用的节点滑动到新位置,树变高或变宽时整体平滑移动
- 旧版本里不再引用的节点淡出,新建的节点淡入
- 缓冲区原地变宽,新元素淡入,而不是整个换掉
- `get` 经过的路径从根到叶一个个点亮

速度滑块控制动画时长(0.25× 到 4×)。系统设置了"减少动态效果"时不播放动画。

### 自动播放

页面上方的工具栏可以选模式,点"播放"自动执行,"单步"只走一步,速度滑块同时控制动画和步与步之间的停顿。长度会在上下限之间来回(增长阶段 / 回缩阶段),所以能同时看到长高和降低。

| 模式 | 做什么 |
| --- | --- |
| 队列 | 右端 push、左端 drop |
| 向右追加 / 回缩 | 一直 pushRight 到上限,再一直 dropRight |
| 向左追加 / 回缩 | 一直 pushLeft 到上限,再一直 dropLeft |
| 双端随机 | 随机选左端或右端,增长时多推、回缩时多弹 |
| 中间插入 / 删除 | 总在正中间 insert 或 dissoc,每步都是 split + concat |
| 拼接 / 切分 | 增长时往左右两侧 concat 一小段,回缩时随机 split 留下一半 |
| 随机读写 | 先推到一定长度,再交替 get 和 assoc 随机下标 |
| 随机混合 | 所有操作随机混合 |

播放中可以手动点操作按钮,播放继续;点历史里的版本会暂停。

## 运行

```
npm install
npm run dev      # 开发
npm run build    # tsc 类型检查 + vite 构建
npm test         # 随机操作对照数组的测试
```

## 部署

`.github/workflows/upload.yaml` 参照 [respo-calcit-workflow](https://github.com/calcit-lang/respo-calcit-workflow):先跑类型检查和模型测试,再用 `VITE_BASE_URL=https://cos-sh.tiye.me/<repo>/` 构建,把 `dist` 上传到 COS;push 到 main 时 rsync 到 `tiye.me:/web-assets/repo/<repo>`,同仓库的 PR 上传到 `pr/` 前缀。需要 `COS_BUCKET`、`COS_SECRET_ID`、`COS_SECRET_KEY` 和 `rsync_private_key` 这几个 secrets。

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
