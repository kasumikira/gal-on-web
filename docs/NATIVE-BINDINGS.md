# Native 绑定开发规范

本文描述当前 API 和开发约定。架构见 [VM-DESIGN.md](VM-DESIGN.md)，构建见 [原生项目说明](../native/kirikiri/README.md)。绑定入口为 `web/engine-js/common/native.js`，值与调用桥接为 `web/engine-js/wasm-vm.js`。

## 显式注册

初始化通过 `vm.registerGlobal(name, value)` 注册全局值或带装饰器的 Native 类。原版 TJS 内建类由 C++ 创建。注册完成后即可由脚本使用，不再批量重新导出全局对象。

插件入口接收 `registerGlobal(name, value)`、`registerMembers(target, members)` 和已有宿主服务。新增类使用前者；向已有对象扩展方法使用后者。已注册 Native 类也可使用 `Class.defineMember(name, member)`。修改普通 JS 对象或 `Class.members` 本身不会更新已注册的 TJS 成员。

向原版 Array/Dictionary 等脚本对象追加函数时，绑定层保留 TJS 调用提供的接收者，不将函数永久绑定到类对象。普通 JS 服务的方法仍绑定其宿主对象。插件上下文的 `readScript`、`callScript` 可访问包括普通 JS 全局服务在内的脚本成员，查询和调用经 VM API 完成；脚本追加或覆盖的成员不能从原始 JS 对象字段推断。对象结果仍遵循 retain/dispose 契约。

`Plugins.link()` 等待插件注册完成才标记加载成功。插件只注册自身负责的接口；未实现插件报告缺失，不注入其它插件的空接口。业务实现仍留在 JS，注册和参数转换交给绑定层。

## 1. 业务类和装饰器

业务使用普通 JS 类，不继承绑定基类。辅助方法和内部字段不加装饰器。

```js
import {
  nativeClass, nativeMethod, nativeProperty, nativeEvent,
} from '#krkr/native';

@nativeClass('Counter')
class Counter {
  constructor(initial = 0) { this.value = initial; }

  @nativeProperty get count() { return this.value; }
  @nativeProperty set count(value) { this.value = value; }

  @nativeMethod async increment() {
    this.value++;
    await this.onChanged(this.value);
  }

  @nativeEvent onChanged(value) {}
}
```

| 装饰器 | 用途与规则 |
| --- | --- |
| `@nativeClass('TJSName')` | 注册脚本类名；JS 类名可以不同 |
| `@nativeMethod` | 暴露方法；JS 内部直接调用执行 JS 实现，不查找脚本覆盖 |
| `@nativeProperty` | 分别标在 getter、setter 上；仅有一侧就保持只读或只写 |
| `@nativeEvent` | 暴露可覆盖事件；JS 状态中的同名方法经 TJS 查找和调用，必须等待或返回其 Promise |
| `@nativeConstructor` | 标记接收脚本构造参数的初始化方法，支持 async；普通 JS 构造器先以无参数方式创建基础状态 |
| `@nativeMembers({...})` | 挂载动态成员表；函数为方法，NativeProperty 为属性，其余为常量或关联类；固定接口优先逐个装饰 |

`@nativeMethod`、`@nativeProperty` 支持 `static`，用于原版静态成员，不能为了方便改变原版实例/静态语义。静态方法和静态属性访问器的 `this` 是声明它们的 JS 类；实例方法和实例属性访问器的 `this` 是 JS native 状态。

插件在类已导出后追加接口时，使用 `Class.defineMember(name, methodOrProperty)` 或 `Class.defineProperty(name, getter, setter)`，同步注册到原版类；直接修改 `Class.members` 仅用于导出前组装声明。

类级入口使用 `Class.defineMember(name, fn, { static: true })`；函数的 `this` 是 JS 类。程序化属性使用 `Class.defineProperty(name, getter, setter, options)`：getter 接收 `owner`，setter 接收 `(owner, value)`，默认 owner 为实例 native 状态；`options.static` 为 true 时 owner 为 JS 类。这与装饰器访问器通过 `this` 访问状态的语法不同。静态声明保存在 JS 类描述符中，导出前后均可追加，不记录脚本引擎内部引用关系。

`NCB_ATTACH_FUNCTION` 仅说明向某个 dispatch 注册函数，不足以判定实例/静态语义。须核对函数是否使用 `objthis` 以及脚本调用方式：例如 `setDefaultAheads` 不依赖实例，`getSample` 则读取接收者的音频数据。

无 `@nativeConstructor` 时，普通 JS 构造器接收脚本构造参数。有该装饰器时，普通构造器只建立基础字段，异步初始化放入被装饰的方法：

```js
constructor() { this.ready = false; }

@nativeConstructor
async initialize(path) {
  this.image = await loadImage(path);
  this.ready = true;
}
```

不要给纯 JS 平台通知使用脚本事件名。例如尺寸变化的宿主通知使用 `onSizeChanged`，脚本事件使用 `onResize`。绑定层会接管 `@nativeEvent` 的同名方法；不得将它当作普通平台回调覆盖。

## 2. JS 状态与脚本对象

`this` 上的普通字段是 JS 状态。`Class.of(object)`（与 `Class.state(object)` 等价）通过 API 取得指定 native 类的状态；跨类访问明确写所属类。`Class.instances.values()` 通过 API 枚举 native 实例状态，不另建实例索引。

| 函数 | 使用方式 |
| --- | --- |
| `script(object)` | 取得脚本访问影子；不延长引用期限 |
| `nativeOwner(state)` | 通过 API 取得对应脚本 owner；不等于 retain |
| `readScript(object, name, options)` | await 属性读取；`ignoreProperty` 请求原始成员，`optional` 仅容许该成员缺失 |
| `readScriptTyped(object, name, options)` | await 成员读取，返回 `{ type, value, text }`；保留原版 int/real 分类，`ignoreProperty` 请求原始成员 |
| `writeScript(object, name, value)` | await 脚本赋值，包括 setter 执行 |
| `callScript(object, name, args, options)` | await 成员调用；默认接收者为 object，`receiver` 显式指定，`ignoreMissing` 仅用于契约允许缺失的事件 |
| `invalidateScriptValue(object)` | await 原版对象失效及 native 终结；用于原版明确要求 invalidate 的清理路径，不代替 dispose |
| `evalScript(expression, context, name = '(eval)')` | await 原版表达式求值；context 指定脚本上下文，name 为错误来源名称；结果遵循脚本调用的引用交接规则 |
| `constructNative(context, klass, ...args)` | await 构造 VM 对象；context 提供所属 VM |
| `nativeDictionary(context, entries)` | 创建原版 Dictionary；entries 为键值对 |
| `nativeArray(context, values)` | 创建原版 Array |
| `nativeGlobals(context)` | 取得运行时全局接口集合 |

```js
const caption = await readScript(target, 'caption');
await writeScript(target, 'caption', caption);
await callScript(target, 'onClick', [x, y]);
// 代理写法同样需要等待：
await script(target).onClick(x, y);
```

脚本属性可能执行 getter，不能将代理当作普通 JS 数据对象使用。赋值用 `writeScript`，让调用方能等待 setter。Array/Dictionary 的同步视图是绑定 API，不是本地数据副本；原始成员访问也不等于正常属性访问，不用它绕过 getter 或异步契约。

Array 影子的 `.length` 通过原版 `TJSGetArrayElementCount` 查询实际元素数，不执行可覆盖的 `count` getter。需要脚本可见的 `count` 属性语义时，仍使用 `await readScript(array, 'count')`。

Native 参数需要原版类型转换时，使用 `#krkr/values` 的 `string`、`number`、`integer`、`truth`。不要对脚本影子使用 JS `String(value)` 或模板插值来实现 TJS 字符串转换：JS 会尝试调用代理的 `toString/valueOf`，既不符合原版 Variant 转换，也可能启动未等待的脚本调用。

普通 JS 对象、数组、Map、函数和浏览器资源由 V8 管理；TJS 对象使用统一影子，元数据只有 API 端点与不透明句柄。业务不访问 `_tjs_*`、WASM 内存或内部句柄，不缓存脚本对象的上下文、引用关系或有效性。类型、状态和实例查询走已有 API。新增底层操作集中到绑定层。

### 保留成员的 TJS 类型

序列化等需要区分 `int 1` 与 `real 1` 的接口使用 `readScriptTyped`，不要从 JS `typeof` 或是否有小数反推。`type` 与 `#krkr/values` 导出的 `TJSValueType` 比较：`VOID`、`OBJECT`、`STRING`、`OCTET`、`INTEGER`、`REAL`。这是一项 API 查询结果，不是脚本对象的本地状态副本。

`value` 与普通读取结果一致：安全整数为 number，大整数为 bigint，实数为 number，Octet 为独立字节副本，对象为不透明影子，空对象为 null。函数同属 `OBJECT`，不可只靠 JS `typeof value === 'object'` 判断。`text` 仅对 INTEGER/REAL 提供原版 Variant 的字符串转换结果，避免序列化大整数时经 JS Number 丢失精度；它不是完整结构化序列化结果。

```js
import { readScriptTyped, retainScriptValue, disposeScriptValue } from '#krkr/native';
import { TJSValueType } from '#krkr/values';

async function formatNumber(object, name) {
  const held = retainScriptValue(object);
  try {
    const item = await readScriptTyped(held, name, { ignoreProperty: true });
    try {
      if (item.type === TJSValueType.INTEGER) return `int ${item.text}`;
      if (item.type === TJSValueType.REAL) return `real ${item.text}`;
      throw new Error('Expected a TJS numeric member');
    } finally { await disposeScriptValue(item.value); }
  } finally { await disposeScriptValue(held); }
}
```

调用后按契约释放 `item.value`；对原始值调用 dispose 是无操作，不能 dispose 外层普通 JS 结果记录来代替释放其中的影子。普通读取会执行 getter 并传播缺失成员错误；`ignoreProperty: true` 沿用原始读取 API，跳过 getter，缺失成员返回 VOID。跨后续异步使用时仍遵循原有引用契约。

此能力复用现有 WASM 成员读取、类型查询及值转换 API，没有新增 C++ 导出或修改原版类/闭包的接收者规则。

## 3. 借用与延长

**保存一个 JS 代理，不会延长 C++ 中对应值的期限。** 闭包、数组、Map 和普通字段都一样。

### 自动参数借用

TJS 调用 JS 时，参数在该 JS 函数的同步执行阶段自动借用。函数同步返回（包括 async 函数返回 Promise）时自动借用结束。首次异步等待后还要使用的对象，必须提前 retain，并改用 retain 返回的新影子。

```js
import { retainScriptValue, disposeScriptValue } from '#krkr/native';

@nativeMethod
async refresh(target) {
  const held = retainScriptValue(target);
  try {
    await prepare();
    await callScript(held, 'refresh');
  } finally {
    await disposeScriptValue(held);
  }
}
```

retain 保存独立的原版 Variant，不延长原参数的借用，也不复制脚本对象。每次 retain 都要有对应的 dispose；不要释放调用方拥有的原参数。普通 JS 值不需要这套机制。

### 显式借用块

运行时接口提供 `vm.withBorrow(value, callback)`：

```js
await vm.withBorrow(value, borrowed => {
  inspectSynchronously(borrowed);
});
```

callback 必须同步返回，不能为 async，不能返回 Promise，也不能启动未等待的脚本调用。外层 await 等待借用结束时可能执行的终结过程，不让块内引用自动跨 await。业务模块优先使用自动参数借用和 `retainScriptValue`，不为调用此接口自行获取底层 VM。

### 延长、结果和常驻

- 有限异步任务：`retainScriptValue` 加 `try/finally`，finally 中 await `disposeScriptValue`。
- Promise 写法：`.finally(() => disposeScriptValue(held))`；不要写 `.then(disposeScriptValue(held))`，它会立即释放。
- JS 字段长期持有：保存 retain 返回值，替换时释放旧值，在所属 native 实例清理路径释放最后一个值。
- 原版脚本成员关系：通过原版成员赋值保存，由 TJS 自己持有，不在 JS 再镜像引用图。
- `vm.pin(value)`：仅用于明确贯穿 runtime 的少量对象；runtime 关闭时释放，没有 unpin。pin 不阻止脚本 invalidate，其派生结果也不自动常驻。
- 对象结果：异步调用、新建容器、原始成员读取可能产生需要释放的独立影子；按对应 API 的返回契约使用或转交，使用结束后 await dispose。JS 原始值无须释放。
- 返回影子：必须在来源引用有效时交给绑定层编码。禁止在 finally 中 dispose 某个影子后再把该影子作为异步返回结果交给绑定层。可以返回普通 JS 结果，或明确转交独立引用并由接收方释放。

`dispose` 结束引用持有，不等于原版 `invalidate`。失效是否发生、何时终结交给原版 TJS2；不能用其中一个替代另一个。终结可能执行脚本，因此释放也必须等待。

## 4. 执行边界与调度约定

当前采用开发约定，没有执行凭据、自动收拢子调用或覆盖全部 WASM 入口的执行锁。现有队列不能替调用者补上遗漏的 await。

同一个 VM 允许严格嵌套：脚本 A 调宿主，宿主调用脚本 B，B 完成后宿主返回，A 才继续。B 挂起时仍须保持该顺序。独立事件不能在这期间直接进入 VM。

必须遵守：

1. 所有可能执行脚本的操作必须 await，或直接返回该 Promise，让上层等待。包括事件、属性 getter/setter、构造、失效和可能触发终结的释放。
2. 同一个 VM 的脚本操作顺序执行，不用 `Promise.all`、`Promise.allSettled` 或未等待的 async forEach 并行调用。纯资源 IO 可以并行，回调 VM 的阶段保持串行。
3. 浏览器输入、Timer、音频完成、尺寸变化等独立事件，通过运行时已有 `enqueueEvent` 投递。队列 callback 返回完整工作的 Promise；在队列外 `.catch(report)` 只负责上报。
4. 当前宿主调用需要立即执行的脚本回调直接 await，不放到等待当前事件结束的队列后再 await，否则会自等待死锁。应投递还是立即调用，以原版事件语义为准。
5. 排队事件若使用临时影子，投递前 retain，事件完成或取消后 dispose。排队本身不延长借用。
6. 不在其他位置另建 VM 队列。`vm.enqueue` 和业务事件队列是不同的 Promise 链，不能认为它们自动相互排斥。启动及诊断等直接入口应确保已有调用结束，启动完成后再交付事件。
7. 错误必须传给上层或现有报告入口；不能用空 catch、默认返回值或重试掩盖错误。允许缺失的回调只处理明确的成员缺失。

```js
// 当前宿主调用中的直接嵌套：把完成传递给外层。
@nativeMethod
async update() {
  await this.onChanged();
}

// 独立事件：先投递，完整返回事件处理 Promise。
function onBrowserResize() {
  enqueueEvent(() => state.onResize()).catch(report);
}
```

禁止的路径是：启动脚本 B 后未等待就让外层 A 恢复；或者 A 挂起时独立事件直接启动 C。即使在同一 JS 线程，也会交错恢复，破坏原版执行栈/寄存器池的顺序。`retain` 只解决对象存活，不能解决执行交错。

目前 `host_call` 使用 `EM_ASYNC_JS`，同步宿主结果也经过 Promise 路径；不要根据函数是否声明 async 判断是否能挂起。JSPI 支持挂起不代表 TJS VM 支持独立调用交错执行。绑定层现有借用清理与异步结果的顺序仍需专项核对，不能以本规范代替实现验证。

## 5. 清理与验证

原版失效路径负责触发 JS native 资源清理。停止事件源、取消订阅、断开音频节点，并释放实例持有的延长引用；不要依赖 V8 GC 触发 TJS 终结。关闭时停止新入口，完成在途操作，再执行原版关闭和宿主根释放；活动回调不能等待包含自身的关闭完成。

修改前对照 `third_party/kirikiroid2/` 的可达调用路径。未实现接口明确报错；第三方库的引入先与用户商议。验证复用现有工具，不为普通重构另建脚手架：

```powershell
pnpm build:vm # 仅 C++ / WASM 改动需要
pnpm build:js
node tools/dev/vm-check.mjs
node tools/dev/error-check.mjs
```

图像、Motion、转场或输入改动再运行相应已有检查，并实际打开游戏检查画面和交互。没有 JS error 不等于渲染正确；定向检查和标题成功不代表整款游戏通过。

## 运行时关闭失败与 GC

运行时整体 dispose 可能因游戏脚本的引用环或 finalize 依赖报错。绑定层仍会在 finally 中解除全局原始值转换入口、清空宿主回调表，并断开 WASM 实例引用，使整块线性内存可由 V8 回收。错误继续交给调用方；关闭完成或失败后都不再使用旧 VM 及其影子。正常运行中的 retain/dispose 与原版 invalidate 语义不变，不以 JS GC 代替逐对象的引用释放。详见 [引用环与运行时回收](VM-DESIGN.md#引用环与运行时回收)。
