/**
 * PRD 解析（确定性，无 LLM）——把结构化 PRD 变成可合成需求。
 *
 * PRD 是与源码并列的真相源（「文档会过期」说的是**手工维护的 API 文档**；
 * PRD 是需求的原始出处，与源码互为对账）。解析器只认三种**结构化形态**，
 * 认不出的如实上报 skipped（不臆造）：
 *
 *  1. 字段约束表：`| 字段 | 类型 | 约束 |` + 段内 `接口: POST /orders`
 *     → 约束文本 → value_json（与原则同构）→ 边界用例
 *  2. UI 流协议（行协议，人类可读可写）：
 *       - 打开 /login        - 填写 input[name=u] = alice   - 点击 button[type=submit]
 *       - 应看到 欢迎回来     - 等待 .dashboard              - 按键 Enter        - 截图
 *     → 一个 UI 族用例（步骤树）
 *  3. 用户故事 / 验收标准（`作为…我希望…`、`- [ ]`）：识别为需求但**不可执行**，
 *     上报 skipped—— prose → 步骤 是 Agent 层的活，确定性解析器不装懂。
 */

export interface PrdFieldConstraint {
  section: string;
  field: string;
  type: string;
  /** 与原则同构的机读约束（可直接喂 boundaryValues）。 */
  valueJson: Record<string, unknown>;
  line: number;
  api: { method: string; path: string } | null;
}

export interface PrdUiFlow {
  section: string;
  title: string;
  steps: { kind: string; config: Record<string, unknown> }[];
  file: string;
  line: number;
}

export interface PrdSkip {
  line: number;
  text: string;
  reason: string;
}

export interface PrdParseResult {
  file: string;
  fields: PrdFieldConstraint[];
  uiFlows: PrdUiFlow[];
  stories: { title: string; line: number }[];
  skipped: PrdSkip[];
}

/* ─────────────── 约束文本 → value_json（与原则机读形态一致） ─────────────── */

export function parseConstraints(constraintText: string, typeText: string): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  const text = constraintText.trim();
  const t = typeText.trim().toLowerCase();

  // 类型
  if (/^(整数|整型|int|integer)$/.test(t) || /整数|int/i.test(text) === true && t === '') v['type'] = 'number';
  if (/^(数字|数值|float|decimal|number)$/.test(t)) v['type'] = 'number';
  if (/^(字符串|文本|string|text)$/.test(t)) v['type'] = 'string';
  if (/^(布尔|bool|boolean)$/.test(t)) v['type'] = 'boolean';
  if (/^枚举$/.test(t)) v['type'] = 'enum';
  if (v['type'] === undefined && (v_has(text, '整数') || v_has(text, 'int'))) v['type'] = 'number';

  // 区间式「0 ≤ x ≤ 50000」
  const range = /(-?\d+(?:\.\d+)?)\s*[≤<=]+\s*\S+\s*[≤<=]+\s*(-?\d+(?:\.\d+)?)/.exec(text);
  if (range !== null) {
    v['type'] = v['type'] ?? 'number';
    v['min'] = Number(range[1]);
    v['max'] = Number(range[2]);
  }

  // 上界 / 下界
  if (v['max'] === undefined) {
    const max = /(?:≤|<=|不超过|至多|最多|上限|最大(?:值)?)\s*(-?\d+(?:\.\d+)?)/.exec(text);
    if (max !== null) {
      v['type'] = v['type'] ?? 'number';
      v['max'] = Number(max[1]);
    }
  }
  if (v['min'] === undefined) {
    const min = /(?:≥|>=|不低于|至少|不少于|下限|最小(?:值)?)\s*(-?\d+(?:\.\d+)?)/.exec(text);
    if (min !== null) {
      v['type'] = v['type'] ?? 'number';
      v['min'] = Number(min[1]);
    }
  }

  // 长度（区别于数值区间）
  if (v_has(text, '长度')) {
    const lenRange = /长度\s*(\d+)\s*[-~—至]\s*(\d+)/.exec(text);
    const lenMax = /长度\s*(?:≤|<=|不超过|至多)?\s*(\d+)/.exec(text);
    const lenMin = /长度\s*(?:≥|>=|不低于|至少|不少于)?\s*(\d+)\s*[-~—]/.exec(text);
    v['type'] = 'string';
    if (lenRange !== null) {
      v['minLength'] = Number(lenRange[1]);
      v['maxLength'] = Number(lenRange[2]);
    } else {
      if (lenMax !== null) v['maxLength'] = Number(lenMax[1]);
      if (lenMin !== null) v['minLength'] = Number(lenMin[1]);
    }
  }

  // 枚举：取值/枚举 + 分隔符
  if (v['type'] === 'enum' || v_has(text, '枚举') || v_has(text, '取值')) {
    const enumPart = /(?:枚举|取值)[:：]?\s*(.+)/.exec(text);
    if (enumPart !== null) {
      const values = enumPart[1]!.split(/[、|/，,]/).map((s) => s.trim().replace(/^["'`]|["'`]$/g, '')).filter((s) => s.length > 0);
      if (values.length > 0) {
        v['type'] = 'enum';
        v['enum'] = values;
      }
    }
  }

  // 语义格式（约束列与类型列都参与：类型列写「手机号」等同于约束声明）
  if (v_has(text, '邮箱') || /email/i.test(text) || /^(邮箱|email)$/i.test(t)) v['email'] = true;
  if (v_has(text, '手机号') || /^(手机号|phone)$/i.test(t)) {
    v['type'] = 'string';
    v['pattern'] = '/^1[3-9]\\d{9}$/';
  }
  if (v_has(text, '唯一')) v['unique'] = true;
  if (v_has(text, '可选') || v_has(text, '可空')) v['optional'] = true;

  return v;
}

function v_has(text: string, needle: string): boolean {
  return text.includes(needle);
}

/* ─────────────── markdown 解析 ─────────────── */

const UI_LINE_PATTERNS: { re: RegExp; build: (m: RegExpExecArray) => { kind: string; config: Record<string, unknown> } | null }[] = [
  { re: /^(?:打开|goto|open|访问)\s+(\S+)/, build: (m) => ({ kind: 'ui_navigate', config: { url: m[1] } }) },
  { re: /^(?:填写|fill|输入)\s+(\S+)\s*=\s*(.+)$/, build: (m) => ({ kind: 'ui_fill', config: { selector: m[1], text: unquote(m[2]!) } }) },
  { re: /^(?:点击|click)\s+(\S+)/, build: (m) => ({ kind: 'ui_click', config: { selector: m[1] } }) },
  { re: /^(?:按键|press)\s+(\S+)/, build: (m) => ({ kind: 'ui_press', config: { key: m[1] } }) },
  { re: /^(?:等待出现|等待|wait(?:_for)?)\s+(\S+)/, build: (m) => ({ kind: 'ui_wait_for', config: { selector: m[1] } }) },
  { re: /^(?:应看到|应显示|see|expect[_ ]?text)\s+(.+)$/, build: (m) => ({ kind: 'ui_see', config: { contains: unquote(m[1]!) } }) },
  { re: /^(?:截图|screenshot)\s*(\S+)?$/, build: (m) => ({ kind: 'ui_screenshot', config: m[1] === undefined ? {} : { name: m[1] } }) },
];

function unquote(s: string): string {
  return s.trim().replace(/^["'`]|["'`]$/g, '');
}

export function parsePrdMarkdown(text: string, file: string): PrdParseResult {
  const lines = text.split('\n');
  const result: PrdParseResult = { file, fields: [], uiFlows: [], stories: [], skipped: [] };

  let section = '';
  let sectionApi: { method: string; path: string } | null = null;
  let currentUiFlow: PrdUiFlow | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;
    const line = raw.trim();

    // 标题 → 新 section（结束当前 UI 流）
    const heading = /^(#{2,4})\s+(.+)$/.exec(line);
    if (heading !== null) {
      currentUiFlow = null;
      section = heading[2]!.trim();
      continue;
    }

    // 段内接口声明：接口: POST /orders
    const api = /^(?:接口|API|端点)\s*[:：]\s*`?([A-Za-z]+)\s+(\S+?)`?\s*$/.exec(line);
    if (api !== null) {
      sectionApi = { method: api[1]!.toUpperCase(), path: api[2]! };
      continue;
    }

    // 字段表：| 字段 | 类型 | 约束 |
    if (line.startsWith('|')) {
      const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
      const isHeader = cells.some((c) => /^(字段|Field)$/i.test(c));
      const isSeparator = cells.every((c) => /^:?-{2,}:?$/.test(c));
      if (isHeader || isSeparator || cells.length < 3) continue;
      const [name, type, constraints] = cells as [string, string, string];
      if (name === undefined || type === undefined || constraints === undefined) continue;
      if (sectionApi === null) {
        result.skipped.push({ line: lineNo, text: line, reason: `字段「${name}」缺段内接口声明（接口: METHOD /path），无法落为可执行用例` });
        continue;
      }
      result.fields.push({
        section,
        field: name,
        type,
        valueJson: parseConstraints(constraints, type),
        line: lineNo,
        api: sectionApi,
      });
      continue;
    }

    // UI 流协议行
    if (/^[-+*]\s+/.test(line)) {
      const content = line.replace(/^[-+*]\s+/, '').trim();
      let matched = false;
      for (const pattern of UI_LINE_PATTERNS) {
        const m = pattern.re.exec(content);
        if (m === null) continue;
        const step = pattern.build(m);
        if (step === null) continue;
        if (currentUiFlow === null) {
          currentUiFlow = { section, title: section || '未命名 UI 流', steps: [], file, line: lineNo };
          result.uiFlows.push(currentUiFlow);
        }
        currentUiFlow.steps.push(step.config === undefined ? step : step);
        matched = true;
        break;
      }
      if (matched) continue;

      // 非结构化验收项 / 用户故事 → 识别但不可执行
      if (/^(?:作为|As a\b)/i.test(content)) {
        result.stories.push({ title: content, line: lineNo });
        result.skipped.push({ line: lineNo, text: content, reason: '用户故事（prose）：确定性解析器不装懂，需 Agent 合成或人工编写' });
        continue;
      }
      if (content.length > 0) {
        result.skipped.push({ line: lineNo, text: content, reason: '非结构化验收项：不匹配 UI 流协议，需 Agent 合成或人工编写' });
      }
      continue;
    }
  }
  return result;
}
