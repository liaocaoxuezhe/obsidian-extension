# 安装错误码排障 / Install error codes

初始化失败时，Analogy 会显示一个错误码和一行技术信息（只包含错误码与白名单线索，不含路径、网址或笔记内容）。先按下表处理；仍无法解决时，在设置的“诊断”里复制诊断信息发给我们。

When setup fails, Analogy shows an error code and one technical line (codes and allowlisted evidence only — no paths, URLs or note content). Use the table below first; if it does not help, copy the diagnostics from Settings → Diagnostics and send them to us.

## 推理引擎与运行时 / Inference engine and runtime

| 错误码 / Code | 含义 | 处理 | Meaning & fix |
|---|---|---|---|
| `EMBEDDING_NATIVE_LOAD_FAILED` | 推理引擎（ONNX Runtime）无法加载，常见于 Windows 缺少 VC++ 运行库或文件被杀软隔离 | 升级到包含 Windows 运行时 `node22-v2` 的版本（自带 VC++ 运行库）；旧版本请安装 [VC++ 运行库 x64](https://aka.ms/vs/17/release/vc_redist.x64.exe)；在 Defender / 360 / 火绒中放行 Analogy 数据目录后重试 | ONNX Runtime could not load. Update to a release with the Windows `node22-v2` runtime (bundles the VC++ runtime), or install the [VC++ Redistributable x64](https://aka.ms/vs/17/release/vc_redist.x64.exe); allow the Analogy data folder in your security software, then retry |
| `RUNTIME_EXECUTION_BLOCKED` | 系统或安全软件阻止托管运行时启动 | 在安全软件中放行 `%LOCALAPPDATA%\Analogy`（macOS：`~/Library/Application Support/Analogy`）后重试 | The OS or security software blocked the runtime. Allow the Analogy data folder, then retry |
| `RUNTIME_SMOKE_TEST_FAILED` | 运行时未通过就绪检查 | 点击“重新下载”；仍失败请检查杀软隔离记录 | Readiness check failed. Redownload; check quarantine logs if it repeats |
| `EMBEDDING_RUNTIME_INVALID` | 运行时缺失或校验不通过（文件被改动、损坏） | 点击“重新下载”，插件会重新校验安装 | Runtime missing or failed verification. Redownload |
| `RUNTIME_EXTRACT_FAILED` | 无法解压或移动安装包（磁盘、权限、同步软件占用） | 关闭占用数据目录的同步/备份软件，确认磁盘空间后重试 | Could not unpack or move the archive. Pause sync/backup tools on the data folder, check disk space, retry |
| `UNSUPPORTED_PLATFORM` | 当前系统或芯片不受支持（例如 Intel Mac） | 目前支持 Apple Silicon Mac 与 Windows x64 | Unsupported OS or CPU; Apple Silicon Macs and Windows x64 are supported |

## 下载 / Downloads

| 错误码 / Code | 含义 | 处理 | Meaning & fix |
|---|---|---|---|
| `DOWNLOAD_NETWORK_ERROR` | 下载因网络中断 | 重试即可断点续传；需要代理时开启系统代理（插件会跟随系统代理 / PAC）；无网络时使用“离线安装” | Network error. Retry to resume; enable the system proxy if needed; use Offline install without network |
| `DOWNLOAD_SIZE_MISMATCH` / `DOWNLOAD_HASH_MISMATCH` | 下载内容与已验证的发行包不一致（网络劫持、镜像异常、文件损坏） | 点击“重新下载”；不要手动替换文件 | Downloaded bytes do not match the pinned release. Redownload; never replace files by hand |
| `DOWNLOAD_CANCELLED` | 下载已取消 | 重新开始初始化 | Cancelled; start setup again |
| `INSUFFICIENT_DISK_SPACE` | 磁盘空间不足 | 运行时约 60–120 MB，模型 25–330 MB，请预留足够空间 | Not enough disk space (runtime ~60–120 MB, model 25–330 MB) |
| `LOCAL_DATA_ROOT_UNAVAILABLE` | 无法访问设备数据目录 | 检查数据目录权限；中文用户名、带空格路径均受支持 | Cannot access the data folder; check permissions |

## 模型 / Model

| 错误码 / Code | 含义 | 处理 | Meaning & fix |
|---|---|---|---|
| `EMBEDDING_MODEL_NETWORK_FAILED` | 模型下载失败 | 检查网络或代理，或在设置中更换模型下载源；已下载的文件会保留 | Model download failed. Check network/proxy or change the model host; finished files are kept |
| `EMBEDDING_MODEL_DOWNLOAD_FAILED` | 模型下载未完成 | 重试；或用“导入模型文件夹”离线导入 | Download incomplete. Retry or import a model folder offline |
| `EMBEDDING_MODEL_CACHE_CORRUPT` | 缓存的模型文件校验失败 | 点击“重新下载” | Cached model failed verification. Redownload |
| `EMBEDDING_MODEL_OOM` | 加载模型时内存不足 | 关闭其他程序，或换用更小的模型（例如 BGE-small）；8 GB 以下内存不建议 200M+ 模型 | Out of memory. Close apps or switch to a smaller model |
| `EMBEDDING_MODEL_WARMUP_FAILED` | 模型无法在本机准备好 | 重试；反复出现请发送诊断信息 | Model could not be prepared. Retry; send diagnostics if it repeats |
| `EMBEDDING_WORKER_CRASHED` | 本地嵌入进程意外退出 | 重试；反复出现请发送诊断信息 | Embedding process exited. Retry; send diagnostics if it repeats |

## 索引与数据 / Index and data

| 错误码 / Code | 含义 | 处理 | Meaning & fix |
|---|---|---|---|
| `VECTOR_STORE_FAILED` | 本地向量数据库无法启动 | 重试；现有数据不会被改动 | Vector database could not start. Retry; data is unchanged |
| `QUICK_INDEX_FAILED` | 首个索引未完成 | 重试，已完成的笔记不会重复计算 | First index incomplete. Retry |
| `LEGACY_INDEX_MIGRATION_FAILED` / `LEGACY_MIGRATION_UNAVAILABLE` | 旧索引无法迁移（原始数据未改动） | 选择“重建索引” | Old index could not be migrated (original data untouched). Choose rebuild |
| `ONBOARDING_STATE_CORRUPT` | 初始化状态文件损坏 | 重试，插件会重新检测环境 | Saved setup state unreadable. Retry |

## Windows 说明 / Windows notes

- Windows 运行时 `node22-v2` 起自带 VC++ 运行库，干净系统无需额外安装。已装旧版（`node22-v1`）的用户会看到“升级推理引擎”步骤，下载量以页面显示为准。
- 安全软件：Windows Defender 默认实时防护下可正常使用；若 360、火绒等拦截，请把 `%LOCALAPPDATA%\Analogy` 加入信任区。
- 仓库位于 OneDrive 同步目录也可使用；Analogy 的设备数据始终保存在仓库外。

- From Windows runtime `node22-v2` on, the VC++ runtime is bundled. Users of `node22-v1` see an "Upgrade the inference engine" step showing the exact download size.
- Defender real-time protection works out of the box; add `%LOCALAPPDATA%\Analogy` to the trusted list of other security tools if they interfere.
- Vaults inside OneDrive work; Analogy's device data always lives outside the vault.
