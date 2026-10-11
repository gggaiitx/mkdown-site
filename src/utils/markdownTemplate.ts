/**
 * 新建文档模板库（P0-8）：骨架存于前端，后续可迁到工作区模板目录。
 *
 * 双形态（2026-10-11）：每个模板同时提供 Markdown 骨架（content，md 引擎消费）
 * 与 HTML 骨架（contentHtml，mh/wangEditor 引擎消费）——补齐 Markhtml 内核下
 * "从模板新建"此前恒空白的能力缺口。两类骨架章节一一对应，正文全部留白。
 *
 * 日期经 getter 惰性求值：每次新建取当天日期，模块常驻不会跨天失效。
 *
 * ★ mh HTML 写法约束（wangEditor 5.1.23 解析边界）：
 * - 仅用 h1-h3 / p / blockquote>p / table>tbody>tr>th,td（均 wangEditor 原生节点）；
 * - 空段落统一 <p><br></p>、空单元格 <td><br></td>（wangEditor 自身序列化方言，可靠回读）；
 * - 不预置 ul/ol（空 li 会被 parser 过滤，骨架留待用户经工具条插入）。
 */
export interface MdTemplate {
  id: string;
  name: string;
  /** Markdown 骨架（md 引擎） */
  content: string;
  /** HTML 骨架（mh 引擎）；仅空白文档无（恒空白起步） */
  contentHtml?: string;
}

/** 当天日期（zh-CN 口径），getter 内调用保证跨天新鲜 */
function today(): string {
  return new Date().toLocaleDateString('zh-CN');
}

/** 骨架常量里的日期占位符：getter 求值时替换为当天日期 */
const DATE_PH = '{{DATE}}';

// ---------- 笔记模板：md 骨架 ----------

const NOTE_MD = `# 笔记标题

> 日期：${DATE_PH}
> 标签：

## 背景

## 要点

- 

## 详情

## 待办

- [ ] 

## 参考

- 
`;

// ---------- 笔记模板：mh 骨架（章节与 NOTE_MD 一一对应） ----------

const NOTE_HTML = `<h1>笔记标题</h1><blockquote><p>日期：${DATE_PH}</p><p>标签：</p></blockquote><h2>背景</h2><p><br></p><h2>要点</h2><p><br></p><h2>详情</h2><p><br></p><h2>待办</h2><p><br></p><h2>参考</h2><p><br></p>`;

// ---------- 方案骨架：md 骨架 ----------

const BID_MD = `# XX 项目建设方案

## 一、项目概述

### 1.1 项目背景

### 1.2 建设目标

### 1.3 建设依据

### 1.4 术语与缩略语

| 术语 | 说明 |
|---|---|
|  |  |

## 二、需求分析

### 2.1 现状与痛点

### 2.2 功能需求

### 2.3 非功能需求

## 三、总体设计

### 3.1 设计原则

### 3.2 总体架构

### 3.3 技术选型

| 层次 | 选型 | 说明 |
|---|---|---|
| 操作系统 |  |  |
| 数据库 |  |  |
| 中间件 |  |  |
| 应用架构 |  |  |

## 四、功能设计

| 序号 | 功能模块 | 功能描述 |
|---|---|---|
| 1 |  |  |
| 2 |  |  |
| 3 |  |  |

## 五、接口设计

| 序号 | 对接系统 | 接口名称 | 方向 | 方式 |
|---|---|---|---|---|
| 1 |  |  |  |  |

## 六、实施计划

| 阶段 | 内容 | 交付物 | 周期 |
|---|---|---|---|
| 一 | 需求调研 | 调研报告 | 2 周 |
| 二 | 设计开发 | 系统原型 | 4 周 |
| 三 | 部署上线 | 验收报告 | 2 周 |

## 七、培训方案

| 对象 | 内容 | 形式 | 课时 |
|---|---|---|---|
|  |  |  |  |

## 八、售后服务

- 质保期：
- 响应时效：
- 服务方式：
`;

// ---------- 方案骨架：mh 骨架（章节与 BID_MD 一一对应；空单元格 <td><br></td>） ----------

/** 单元格速记：th 行 / td 空行；非空内容原样保留（实施计划等预填行），空单元格落 <br> */
function trow(cells: string[], header = false): string {
  const tag = header ? 'th' : 'td';
  const inner = cells.map((c) => `<${tag}>${c || '<br>'}</${tag}>`).join('');
  return `<tr>${inner}</tr>`;
}

function table(head: string[], rows: string[][]): string {
  const body = rows.map((r) => trow(r)).join('');
  return `<table width="100%" style="border-collapse:collapse;"><tbody>${trow(head, true)}${body}</tbody></table>`;
}

const BID_HTML = `<h1>XX 项目建设方案</h1>
<h2>一、项目概述</h2><h3>1.1 项目背景</h3><p><br></p><h3>1.2 建设目标</h3><p><br></p><h3>1.3 建设依据</h3><p><br></p><h3>1.4 术语与缩略语</h3>${table(['术语', '说明'], [['', '']])}
<h2>二、需求分析</h2><h3>2.1 现状与痛点</h3><p><br></p><h3>2.2 功能需求</h3><p><br></p><h3>2.3 非功能需求</h3><p><br></p>
<h2>三、总体设计</h2><h3>3.1 设计原则</h3><p><br></p><h3>3.2 总体架构</h3><p><br></p><h3>3.3 技术选型</h3>${table(['层次', '选型', '说明'], [['操作系统', '', ''], ['数据库', '', ''], ['中间件', '', ''], ['应用架构', '', '']])}
<h2>四、功能设计</h2>${table(['序号', '功能模块', '功能描述'], [['1', '', ''], ['2', '', ''], ['3', '', '']])}
<h2>五、接口设计</h2>${table(['序号', '对接系统', '接口名称', '方向', '方式'], [['1', '', '', '', '']])}
<h2>六、实施计划</h2>${table(['阶段', '内容', '交付物', '周期'], [['一', '需求调研', '调研报告', '2 周'], ['二', '设计开发', '系统原型', '4 周'], ['三', '部署上线', '验收报告', '2 周']])}
<h2>七、培训方案</h2>${table(['对象', '内容', '形式', '课时'], [['', '', '', '']])}
<h2>八、售后服务</h2><ul><li>质保期：</li><li>响应时效：</li><li>服务方式：</li></ul>`;

export const TEMPLATES: MdTemplate[] = [
  {
    id: 'blank',
    name: '空白文档',
    content: '',
    // 无 contentHtml：mh 引擎下恒空白起步（Ctrl+N / 欢迎「新建文档」口径不变）
  },
  {
    id: 'note',
    name: '笔记模板',
    get content() {
      return NOTE_MD.replace(DATE_PH, today());
    },
    get contentHtml() {
      return NOTE_HTML.replace(DATE_PH, today());
    },
  },
  {
    id: 'bid',
    name: '方案骨架',
    get content() {
      return BID_MD;
    },
    get contentHtml() {
      return BID_HTML;
    },
  },
];
