# 🚀 发布前 checklist

发布前一次性过一遍这几件事,避免上线就翻车。

## ⚠️ 隐私 & 安全

- [ ] `git status` 干净 — 没有 uncommitted 的本地数据
- [ ] `git log --all -- data/resume.md config/profile.yaml personalinfo.md` 都没有 (确认没人 push 过这些)
- [ ] grep 仓库:`grep -r "shiki35279\|gmail" .` 应该没结果
- [ ] grep 仓库:`grep -r "sk-[a-zA-Z0-9]\{30,\}\|AT_[a-zA-Z0-9]\{30,\}" .` API key 模式没匹配
- [ ] 所有截图 / 视频 **打码**:
  - 真实公司名(防止侵权或惹麻烦)
  - API key / WxPusher token / UID
  - 手机号 / 邮箱 / 简历个人信息
  - Boss 账号信息(头像、扫码登录界面里的二维码)

## 🧪 功能 verification

跑一遍完整流程,确认没回归:

- [ ] 重新装扩展(`chrome://extensions/` 删了再加载)
- [ ] 画像 tab 填写 → 切搜索 → 切回画像 — **数据不丢**
- [ ] 显示 "上次保存 HH:MM:SS"
- [ ] 搜索 tab 关键词 + 城市 + per-query-cap → 显示预估上限
- [ ] 🚀 跑一轮 ≥2 个任务
  - [ ] 看到 "采集 [X/N] xxx @ yyy" substep
  - [ ] 看到 "任务间冷却 Xs (alarm 接力)"
  - [ ] 看到 "打分 X/N · xxx" + ETA
  - [ ] 看到 "✓ 打分完成: 成功 X / 失败 Y"
- [ ] popup 卡片视图能展开,**2.5s 自动刷新后展开状态保住**
- [ ] 切表格视图 — HR 颜色对(绿/灰/橘)
- [ ] 🖥 全屏 → 新 tab 打开 dashboard.html
  - [ ] 点表头能排序
  - [ ] 顶部搜索框能过滤
  - [ ] 📥 CSV 能下载,Excel 打开中文不乱码
- [ ] WxPusher 不填也能跑(只是不推送)
- [ ] WxPusher 填了能收到推送(S 级 + A 级两条)
- [ ] Chrome 杀掉再开,看是否检测到中断 run

## 📚 文档

- [ ] README.md 顶部 version badge 跟 manifest.json 一致(目前 6.2.1)
- [ ] README 没有引用已删除的字段(S/A 级关键词 / 硬拒关键词 等)
- [ ] docs/extension.md 同步到 v6.x(还要更新)
- [ ] docs/launch/screenshots.md / video-script.md / posts.md 全在
- [ ] LICENSE 是 MIT
- [ ] `.gitignore` 完整(检查 .env、profile.yaml、resume.md、data/*.json 都 ignored)

## 📸 素材

按 `docs/launch/screenshots.md` 优先级拍:

- [ ] 01 Hero shot — 全屏看板 满屏 S/A
- [ ] 02 画像 tab
- [ ] 03 搜索 tab
- [ ] 05 卡片展开
- [ ] 06 表格视图
- [ ] 07 全屏看板搜索排序
- [ ] 10 安装步骤

视频:

- [ ] 90 秒短版(小红书 / 即刻)
- [ ] (可选)3-5 分钟完整 demo(B 站)

## 🌐 上线渠道

- [ ] **GitHub Release**:`v6.2.1`,把改动写在 CHANGELOG,带 Hero shot 截图
- [ ] **小红书**:发主推贴(配 4-5 张截图)
- [ ] **即刻**:同时发**技术向**和**用户向**两版,看哪个数据好
- [ ] **V2EX**:技术向版本,放在 /go/share-creation 或 /go/career
- [ ] **微博**(可选):短版 + 截图
- [ ] **Twitter / X**(可选):英文版

## 📈 上线后

- [ ] 监控 GitHub Issues — 装机问题 / Bug
- [ ] 监控 Star 增长(用 [shields.io](https://shields.io/) 做 dynamic badge 可选)
- [ ] 评论区互动尽量 24h 内回
- [ ] 如果有 PR 提交,review + merge 速度尽量快
