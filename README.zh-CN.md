# OMP Pi Bridge

[English](README.md) | [简体中文](README.zh-CN.md)

一个面向 Oh My Pi（OMP）的扩展：从 Pi 配置读取供应商和模型，并将 OMP 的 Token 用量与会话记录写成 Pi 兼容的会话文件，供 CC Switch 原有的 Pi 扫描读取。

**本项目是 OMP 扩展，不是 Pi 扩展。** `package.json` 只声明 OMP 的 `omp.extensions`，不声明 `pi.extensions`。Pi 在这里是配置来源和会话文件格式。不要把扩展复制到 Pi 的 `~/.pi/agent/extensions`，否则它可能尝试镜像 Pi 自己的会话。参考 [OMP 扩展规范](https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-extensions.md) 和 [Pi 扩展规范](https://pi.dev/docs/latest/extensions)。

## 功能与数据边界

- OMP 启动时读取 Pi 的 `models.json`，在 OMP 运行时注册供应商、API 类型、端点、密钥引用和模型。
- 历史 OMP 会话只回填 Token 用量；历史提示词和回复内容不回填。
- 实时 OMP 对话会镜像完整消息、工具结果和 Token 用量。实时记录包含工具输入和输出。
- 插件不写 Pi 的 API 配置，也不读取或修改 CC Switch 的配置和数据库。
- Pi 没有配置供应商时，首次会话启动会询问是否同步。选项默认是“本次跳过同步”；拒绝、取消或没有交互界面时，本次 OMP 进程不会回填或写 Pi 会话。选择同步后，该决定只在当前 OMP 进程有效。

## 安装

### Windows 原生安装脚本

在 PowerShell 中进入项目目录后运行：

```powershell
.\install.ps1
```

脚本会把扩展复制到当前 OMP profile 的扩展目录，并在需要时把已存在的 Bun 可执行目录加入用户 `PATH`。脚本不会安装 OMP 或 Bun。安装后重新启动 OMP。

命名 profile 可显式指定：

```powershell
.\install.ps1 -Profile work
```

也可先设置当前 PowerShell 的 profile 环境变量：

```powershell
$env:OMP_PROFILE = 'work'
.\install.ps1
```

### OMP 插件管理器

也可以通过 OMP 插件管理器从 GitHub 安装：

```powershell
omp plugin install github:soatori/omp-pi-bridge
```

请选择一种安装方式，避免同时加载两份扩展。

## 配置

默认读取 `%USERPROFILE%\.pi\agent\models.json`。Pi 配置目录不同时，设置 `OMP_PI_CONFIG_DIR`：

```powershell
$env:OMP_PI_CONFIG_DIR = 'D:\Pi\agent'
```

`PI_CODING_AGENT_DIR` 用于 OMP 自己的 agent 目录，不用于指定 Pi 配置目录。

Pi 的 `settings.json` 中 `sessionDir` 或 `PI_CODING_AGENT_SESSION_DIR` 可以指定绝对会话目录。相对路径无法供 CC Switch 全局扫描，插件会跳过并提示。

## 卸载

通过原生脚本安装的扩展：

```powershell
.\uninstall.ps1
```

卸载命名 profile：

```powershell
.\uninstall.ps1 -Profile work
```

通过 OMP 插件管理器安装的扩展：

```powershell
omp plugin uninstall omp-pi-bridge
```

`uninstall.ps1` 只删除当前 profile 下的 `omp-pi-bridge` 扩展目录，保留 Pi 会话历史、OMP 同步状态、配置文件和共享 `PATH` 项。卸载后重新启动 OMP。

## 开发与验证

需要 Bun 和 Windows PowerShell：

```powershell
bun test test
bun run build-check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/install-profile.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/uninstall-profile.ps1
```

测试覆盖供应商同步、空配置确认、历史与实时会话转换、profile 路径、卸载保留边界和并发状态写入。

## 兼容性与行为

- 已在 OMP 18.10.3、CC Switch 4.0.7、Windows 上验证。
- OMP 分支在 Pi 镜像中按执行顺序展平；恢复工作请使用原 OMP 会话。
- 实时完整会话可能显示在 Pi 或 CC Switch 的会话列表中。
- 成本显示取决于 OMP 用量数据及 CC Switch 可用的模型定价。
