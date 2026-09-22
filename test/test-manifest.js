'use strict';
/**
 * manifest 完整性自检。
 *
 * 为什么需要它：`contributes` 全靠字符串互相引用（commands ⇄ menus ⇄
 * keybindings ⇄ views），而 `vsce package` 不校验这些引用 —— 一个改名后
 * 忘了同步的命令，打包不会报错，界面上就是永远不出现。
 *
 * 本文件既做真实自检，也**故意在临时目录里造一份坏 manifest 跑一遍**，
 * 要求检查器必须报错。一个从没失败过的守卫，只是一段注释。
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, includes, section, finish } = require('./lib');

function checkManifest(dir) {
  const problems = [];
  const pkgPath = path.join(dir, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    return [`package.json 无法解析：${err.message}`];
  }

  const contributes = pkg.contributes || {};
  const commands = (contributes.commands || []).map((c) => c.command);
  const commandSet = new Set(commands);

  if (!pkg.publisher) {
    problems.push('缺少 publisher（vsce 打包会直接失败）');
  }
  if (!pkg.engines || !pkg.engines.vscode) {
    problems.push('缺少 engines.vscode');
  }
  if (!pkg.main) {
    problems.push('缺少 main 入口');
  } else if (!fs.existsSync(path.join(dir, pkg.main))) {
    problems.push(`main 指向的文件不存在：${pkg.main}（先跑 npm run compile）`);
  }

  // 菜单引用的命令必须存在
  const menus = contributes.menus || {};
  for (const [menuId, entries] of Object.entries(menus)) {
    for (const entry of entries) {
      if (entry.command && !commandSet.has(entry.command)) {
        problems.push(`菜单 ${menuId} 引用了不存在的命令：${entry.command}`);
      }
    }
  }

  // 快捷键引用的命令必须存在
  for (const binding of contributes.keybindings || []) {
    if (binding.command && !commandSet.has(binding.command)) {
      problems.push(`快捷键引用了不存在的命令：${binding.command}`);
    }
  }

  // view/title 上的命令需要有 codicon 图标，否则工具栏上是个无意义占位符
  for (const entry of menus['view/title'] || []) {
    const cmd = (contributes.commands || []).find((c) => c.command === entry.command);
    if (cmd && !cmd.icon) {
      problems.push(`view/title 上的命令缺少 icon：${entry.command}`);
    }
  }

  // 视图容器与视图要互相匹配
  const containers = (contributes.viewsContainers && contributes.viewsContainers.activitybar) || [];
  const containerIds = new Set(containers.map((c) => c.id));
  for (const containerId of Object.keys(contributes.views || {})) {
    if (!containerIds.has(containerId)) {
      problems.push(`views 使用的容器 ${containerId} 未在 viewsContainers 里定义`);
    }
  }
  const viewIds = new Set();
  for (const list of Object.values(contributes.views || {})) {
    for (const v of list) {
      viewIds.add(v.id);
    }
  }

  // 活动栏图标文件必须真实存在
  for (const container of containers) {
    const iconPath = path.join(dir, container.icon || '');
    if (!container.icon) {
      problems.push(`活动栏容器 ${container.id} 缺少 icon`);
    } else if (!fs.existsSync(iconPath)) {
      problems.push(`活动栏图标文件不存在：${container.icon}`);
    }
  }

  // menus 里的 when 子句引用的视图必须真实存在
  for (const entries of Object.values(menus)) {
    for (const entry of entries) {
      const match = /view\s*==\s*([\w.]+)/.exec(entry.when || '');
      if (match && !viewIds.has(match[1])) {
        problems.push(`when 子句引用了不存在的视图：${match[1]}`);
      }
    }
  }

  // webview 视图声明的类型与代码里的 viewType 必须一致
  for (const list of Object.values(contributes.views || {})) {
    for (const v of list) {
      if (v.type === 'webview') {
        const extSource = path.join(dir, 'out', 'panel.js');
        if (fs.existsSync(extSource)) {
          const source = fs.readFileSync(extSource, 'utf8');
          if (!source.includes(v.id)) {
            problems.push(`视图 ${v.id} 在 out/panel.js 里找不到对应的 viewType 字符串`);
          }
        }
      }
    }
  }

  // engines.vscode 必须 >= @types/vscode（vsce 会拒绝不一致的组合）
  const typesVersion = (pkg.devDependencies || {})['@types/vscode'];
  if (typesVersion && pkg.engines && pkg.engines.vscode) {
    const major = pkg.engines.vscode.replace(/[^\d.]/g, '');
    const typesNum = Number(String(typesVersion).replace(/[^\d.]/g, ''));
    const engineNum = Number(major);
    if (Number.isFinite(typesNum) && Number.isFinite(engineNum) && typesNum > engineNum) {
      problems.push(`@types/vscode (${typesVersion}) 高于 engines.vscode (${pkg.engines.vscode})`);
    }
  }

  // 配置项必须在代码里被真正读过（防止写了个没人用的开关）
  const declared = Object.keys((contributes.configuration && contributes.configuration.properties) || {});
  const outFiles = fs.existsSync(path.join(dir, 'out'))
    ? fs.readdirSync(path.join(dir, 'out')).filter((f) => f.endsWith('.js'))
    : [];
  const bundle = outFiles.map((f) => fs.readFileSync(path.join(dir, 'out', f), 'utf8')).join('\n');
  for (const key of declared) {
    const short = key.split('.').pop();
    if (bundle && !bundle.includes(short)) {
      problems.push(`配置项 ${key} 声明了但代码里没读过`);
    }
  }

  return problems;
}

section('manifest 自检（真实工程）');
{
  const problems = checkManifest(path.join(__dirname, '..'));
  eq(problems, [], `contributes 引用一致，无悬空引用`);
  if (problems.length) {
    for (const p of problems) {
      console.error(`      - ${p}`);
    }
  }
}

section('反例：故意弄坏 manifest，检查器必须报错');
{
  const tmp = path.join(require('os').tmpdir(), `manifest-broken-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'out'), { recursive: true });
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  const broken = JSON.parse(JSON.stringify(real));
  // 坏点 1：菜单指向一个不存在的命令
  broken.contributes.menus['view/title'].push({ command: 'hermesPanel.doesNotExist', when: 'view == hermesPanel.chat' });
  // 坏点 2：把某个命令的图标摘掉（工具栏会变成无意义占位符）
  delete broken.contributes.commands.find((c) => c.command === 'hermesPanel.newSession').icon;
  // 坏点 3：视图容器图标路径写错
  broken.contributes.viewsContainers.activitybar[0].icon = 'media/not-there.svg';
  // 坏点 4：when 引用了一个不存在的视图
  broken.contributes.menus['view/title'].push({ command: 'hermesPanel.restart', when: 'view == hermesPanel.nope' });
  delete broken.publisher;

  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(broken, null, 2));
  fs.writeFileSync(path.join(tmp, 'out', 'panel.js'), '// 空壳');
  const problems = checkManifest(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });

  ok(problems.length >= 5, `坏 manifest 被抓出 ${problems.length} 个问题（要求 >= 5）`);
  includes(problems.join('\n'), 'hermesPanel.doesNotExist', '指出悬空命令');
  includes(problems.join('\n'), '缺少 icon', '指出缺图标的工具栏命令');
  includes(problems.join('\n'), 'media/not-there.svg', '指出不存在的图标文件');
  includes(problems.join('\n'), 'hermesPanel.nope', '指出 when 里的悬空视图');
  includes(problems.join('\n'), 'publisher', '指出缺 publisher');
}

section('webview 标记与脚本的 id 契约');
{
  // 这条是踩坑换来的：chat.js 新增了一个 getElementById 目标，而模板里没有那个元素，
  // 于是脚本一解引用就抛错，后面整条 op 流都没应用 —— 面板看起来"没反应"。
  const { buildHtml } = require('../out/htmlTemplate.js');
  const html = buildHtml({ cspSource: 'x', nonce: 'n', cssUri: 'a.css', jsUri: 'a.js' });
  const chatJs = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  const ids = [...chatJs.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  ok(ids.length > 5, `从 chat.js 提取到 ${ids.length} 个元素 id`);
  // usage-fill 是 chat.js 自己创建的，不在静态模板里
  const missing = ids.filter((id) => id !== 'usage-fill' && !html.includes(`id="${id}"`));
  eq(missing, [], 'chat.js 引用的每个元素 id 都存在于模板中');
}

finish();
