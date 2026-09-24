/** 新建文档模板库（P0-8）：骨架存于前端，后续可迁到工作区模板目录 */
export interface MdTemplate {
  id: string;
  name: string;
  content: string;
}

export const TEMPLATES: MdTemplate[] = [
  {
    id: 'blank',
    name: '空白文档',
    content: '',
  },
  {
    id: 'note',
    name: '笔记模板',
    content: `# 标题

> 日期：${new Date().toLocaleDateString('zh-CN')}

## 背景

## 内容

## 结论
`,
  },
  {
    id: 'bid',
    name: '方案骨架',
    content: `# XX 项目建设方案

## 一、项目概述

### 1.1 项目背景

### 1.2 建设目标

## 二、需求分析

### 2.1 现状与痛点

### 2.2 功能需求

## 三、总体设计

### 3.1 总体架构

### 3.2 技术选型

## 四、实施计划

| 阶段 | 内容 | 交付物 | 周期 |
|---|---|---|---|
| 一 | 需求调研 | 调研报告 | 2 周 |
| 二 | 设计开发 | 系统原型 | 4 周 |
| 三 | 部署上线 | 验收报告 | 2 周 |

## 五、售后服务

- 质保期：
- 响应时效：
`,
  },
];
