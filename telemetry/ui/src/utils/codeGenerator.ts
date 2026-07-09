/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/** Union type of all available node types in the builder. */
export type NodeType =
  | 'action'
  | 'input'
  | 'result'
  | 'llm_call'
  | 'api_call'
  | 'code'
  | 'streaming'
  | 'loop'
  | 'router';

/** Visual metadata (label, color, border, description) for each node type. */
export const NODE_TYPE_META: Record<
  NodeType,
  { label: string; color: string; borderColor: string; description: string }
> = {
  action: {
    label: 'Action',
    color: 'bg-white',
    borderColor: 'border-gray-300',
    description: 'Generic action with reads/writes'
  },
  input: {
    label: 'Input',
    color: 'bg-green-50',
    borderColor: 'border-green-400',
    description: 'Receives external data into state'
  },
  result: {
    label: 'Result',
    color: 'bg-blue-50',
    borderColor: 'border-blue-400',
    description: 'Extracts output from state'
  },
  llm_call: {
    label: 'LLM Call',
    color: 'bg-purple-50',
    borderColor: 'border-purple-400',
    description: 'Call an LLM with prompt/response'
  },
  api_call: {
    label: 'API Call',
    color: 'bg-orange-50',
    borderColor: 'border-orange-400',
    description: 'HTTP request to external API'
  },
  code: {
    label: 'Code',
    color: 'bg-gray-50',
    borderColor: 'border-gray-500',
    description: 'Custom Python code block'
  },
  streaming: {
    label: 'Streaming',
    color: 'bg-cyan-50',
    borderColor: 'border-cyan-400',
    description: 'Yields results progressively'
  },
  loop: {
    label: 'Loop',
    color: 'bg-amber-50',
    borderColor: 'border-amber-400',
    description: 'Iterate over items in state'
  },
  router: {
    label: 'Router',
    color: 'bg-rose-50',
    borderColor: 'border-rose-400',
    description: 'Branch based on conditions'
  }
};

/** Represents a single node in the builder graph tree. Supports compound nodes (loop, router) via nextAction, firstLoopAction, and branches fields. */
export type BuilderNode = {
  id: string;
  name: string;
  nodeType: NodeType;
  reads: string[];
  writes: string[];
  inputs: string[];
  position: { x: number; y: number };
  codeBody?: string;
  llmProvider?: string;
  llmModel?: string;
  apiUrl?: string;
  apiMethod?: string;
  // Tree structure
  nextAction?: BuilderNode;
  firstLoopAction?: BuilderNode;
  branches?: BuilderBranch[];
  // Loop config
  loopVariable?: string;
  itemVariable?: string;
};

/** A single branch within a router node, with a name, condition, and optional child action chain. */
export type BuilderBranch = {
  name: string;
  condition: string;
  firstAction?: BuilderNode;
};

/** A transition edge between two nodes, used for code generation. */
export type BuilderEdge = {
  id: string;
  source: string;
  target: string;
  condition: string;
};

/** Sanitize a string for use as a Python identifier. */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&') || 'unnamed';
}

/** Escape a string for safe embedding in a Python string literal. */
function escapePyString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function quotePy(value: string): string {
  return `"${escapePyString(value)}"`;
}

function indentLines(lines: string[], spaces = 4): string[] {
  const prefix = ' '.repeat(spaces);
  return lines.map((line) => (line.length > 0 ? `${prefix}${line}` : ''));
}

function formatPythonList(values: string[]): string {
  return `[${values.map((value) => quotePy(value)).join(', ')}]`;
}

function getImportedStateKeys(nodes: BuilderNode[]): string[] {
  const extraKeys = nodes.flatMap((node) => {
    if (node.nodeType === 'loop' && node.loopVariable) {
      return [`${node.loopVariable}_index`];
    }
    return [];
  });

  return [...new Set(nodes.flatMap((n) => [...n.reads, ...n.writes]).concat(extraKeys))];
}

function getInputParams(node: BuilderNode): string[] {
  return node.inputs.map((input) => `${sanitizeName(input)}: str`);
}

function normalizeCondition(condition: string, sourceNode?: BuilderNode): string {
  if (!condition || condition === 'default') {
    return 'default';
  }

  if (condition.startsWith('when(') || condition.startsWith('expr(')) {
    return condition;
  }

  if (sourceNode?.nodeType === 'router' && sourceNode.writes[0]) {
    return `when(${sanitizeName(sourceNode.writes[0])}=${quotePy(condition)})`;
  }

  return `expr(${quotePy(condition)})`;
}

function getLlmImportsAndDeps(nodes: BuilderNode[]): { imports: string[]; deps: string[] } {
  const providers = new Set(nodes.filter((node) => node.nodeType === 'llm_call').map((node) => node.llmProvider || 'openai'));
  const imports: string[] = [];
  const deps: string[] = [];

  if (providers.has('openai') || providers.has('local')) {
    imports.push('from openai import OpenAI');
    deps.push('openai');
  }
  if (providers.has('anthropic')) {
    imports.push('from anthropic import Anthropic');
    deps.push('anthropic');
  }
  if (providers.has('google')) {
    imports.push('import google.generativeai as genai');
    deps.push('google-generativeai');
  }

  return { imports, deps };
}

function getApiImportsAndDeps(nodes: BuilderNode[]): { imports: string[]; deps: string[] } {
  if (!nodes.some((node) => node.nodeType === 'api_call')) {
    return { imports: [], deps: [] };
  }

  return { imports: ['import httpx'], deps: ['httpx'] };
}

const generateActionCode = (node: BuilderNode): string[] => {
  const lines: string[] = [];
  const safeName = sanitizeName(node.name);
  const readsStr = formatPythonList(node.reads);
  const writesStr = formatPythonList(node.writes);
  const inputParams = getInputParams(node);
  const signatureParams = ['state: State', ...inputParams];
  const promptKey = node.reads[0] || 'prompt';
  const responseKey = sanitizeName(node.writes[0] || 'response');

  switch (node.nodeType) {
    case 'input': {
      lines.push(`@action(reads=[], writes=${writesStr})`);
      lines.push(`def ${safeName}(${signatureParams.join(', ')}) -> State:`);
      if (node.writes.length > 0) {
        const updates = node.writes
          .map((writeKey, index) => `${sanitizeName(writeKey)}=${sanitizeName(node.inputs[index] || writeKey)}`)
          .join(', ');
        lines.push(`    return state.update(${updates})`);
      } else {
        lines.push('    return state');
      }
      break;
    }
    case 'result': {
      const resultKey = sanitizeName(node.writes[0] || 'result');
      lines.push(`@action(reads=${readsStr}, writes=${formatPythonList([resultKey])})`);
      lines.push(`def ${safeName}(state: State) -> State:`);
      lines.push(
        `    extracted_result = {key: state.get(key) for key in ${readsStr}}`
      );
      lines.push(`    return state.update(${resultKey}=extracted_result)`);
      break;
    }
    case 'llm_call': {
      const provider = node.llmProvider || 'openai';
      const model = node.llmModel || (provider === 'anthropic'
        ? 'claude-3-5-sonnet-latest'
        : provider === 'google'
          ? 'gemini-1.5-pro'
          : 'gpt-4o-mini');

      lines.push(`@action(reads=${readsStr}, writes=${writesStr})`);
      lines.push(`def ${safeName}(state: State) -> State:`);
      lines.push(`    prompt = str(state.get(${quotePy(promptKey)}, ""))`);
      if (provider === 'anthropic') {
        lines.push('    client = Anthropic()');
        lines.push('    response = client.messages.create(');
        lines.push(`        model=${quotePy(model)},`);
        lines.push('        max_tokens=1024,');
        lines.push('        messages=[{"role": "user", "content": prompt}],');
        lines.push('    )');
        lines.push(
          '    response_text = "".join(block.text for block in response.content if getattr(block, "type", None) == "text")'
        );
      } else if (provider === 'google') {
        lines.push('    model = genai.GenerativeModel(model_name=' + quotePy(model) + ')');
        lines.push('    response = model.generate_content(prompt)');
        lines.push('    response_text = getattr(response, "text", "") or ""');
      } else if (provider === 'local') {
        lines.push('    client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")');
        lines.push('    response = client.chat.completions.create(');
        lines.push(`        model=${quotePy(model)},`);
        lines.push('        messages=[{"role": "user", "content": prompt}],');
        lines.push('    )');
        lines.push('    response_text = response.choices[0].message.content or ""');
      } else {
        lines.push('    client = OpenAI()');
        lines.push('    response = client.chat.completions.create(');
        lines.push(`        model=${quotePy(model)},`);
        lines.push('        messages=[{"role": "user", "content": prompt}],');
        lines.push('    )');
        lines.push('    response_text = response.choices[0].message.content or ""');
      }
      lines.push(`    return state.update(${responseKey}=response_text)`);
      break;
    }
    case 'api_call': {
      const method = (node.apiMethod || 'GET').toUpperCase();
      const url = node.apiUrl || 'https://api.example.com';
      const statusKey = sanitizeName(node.writes[1] || `${responseKey}_status`);

      lines.push(`@action(reads=${readsStr}, writes=${formatPythonList([responseKey, statusKey])})`);
      lines.push(`def ${safeName}(state: State) -> State:`);
      lines.push(`    request_data = {key: state.get(key) for key in ${readsStr}}`);
      lines.push(
        `    response = httpx.request(${quotePy(method)}, ${quotePy(url)}, ${
          method === 'GET' ? 'params=request_data' : 'json=request_data'
        }, timeout=30.0)`
      );
      lines.push('    response.raise_for_status()');
      lines.push('    try:');
      lines.push(`        payload = response.json()`);
      lines.push('    except ValueError:');
      lines.push('        payload = response.text');
      lines.push(`    return state.update(${responseKey}=payload, ${statusKey}=response.status_code)`);
      break;
    }
    case 'streaming': {
      lines.push(`@streaming_action(reads=${readsStr}, writes=${writesStr})`);
      lines.push(`def ${safeName}(state: State) -> Generator:`);
      lines.push(`    source_text = str(state.get(${quotePy(promptKey)}, "")) or ${quotePy(`Streaming output from ${node.name}`)}`);
      lines.push('    chunks = source_text.split() or ["stream"]');
      lines.push('    buffer = []');
      lines.push('    for chunk in chunks:');
      lines.push('        chunk_text = f"{chunk} "');
      lines.push('        buffer.append(chunk_text)');
      lines.push(`        yield {${quotePy(responseKey)}: "".join(buffer).strip()}, None`);
      lines.push(`    final_output = "".join(buffer).strip()`);
      lines.push(`    yield {${quotePy(responseKey)}: final_output}, state.update(${responseKey}=final_output)`);
      break;
    }
    case 'code': {
      lines.push(`@action(reads=${readsStr}, writes=${writesStr})`);
      lines.push(`def ${safeName}(${signatureParams.join(', ')}) -> State:`);
      if (node.codeBody && node.codeBody.trim().length > 0) {
        const bodyLines = node.codeBody.split('\n');
        lines.push(...indentLines(bodyLines));
        if (!bodyLines.some((line) => line.trim().startsWith('return '))) {
          lines.push('    return state');
        }
      } else if (node.writes.length > 0) {
        const updateExpr = node.writes
          .map((writeKey, index) =>
            `${sanitizeName(writeKey)}=${index === 0 ? quotePy(`${node.name}_result`) : 'None'}`
          )
          .join(', ');
        lines.push(`    return state.update(${updateExpr})`);
      } else {
        lines.push('    return state');
      }
      break;
    }
    case 'loop': {
      const loopVariable = node.loopVariable || node.reads[0] || 'items';
      const itemVariable = sanitizeName(node.itemVariable || node.writes[0] || 'current_item');
      const indexKey = sanitizeName(`${loopVariable}_index`);
      const loopIndexKey = sanitizeName(node.writes[1] || 'loop_index');

      lines.push(`@action(reads=${formatPythonList([...new Set([...node.reads, loopVariable, indexKey])])}, writes=${formatPythonList([itemVariable, loopIndexKey, indexKey])})`);
      lines.push(`def ${safeName}(state: State) -> State:`);
      lines.push(`    items = state.get(${quotePy(loopVariable)}, []) or []`);
      lines.push(`    current_index = (state.get(${quotePy(indexKey)}, -1) or -1) + 1`);
      lines.push('    if current_index >= len(items):');
      lines.push(`        return state.update(${indexKey}=current_index, ${loopIndexKey}=current_index)`);
      lines.push(`    current_item = items[current_index]`);
      lines.push(
        `    return state.update(${itemVariable}=current_item, ${loopIndexKey}=current_index, ${indexKey}=current_index)`
      );
      break;
    }
    case 'router': {
      const routeKey = sanitizeName(node.writes[0] || 'route');
      const routeSourceKey = node.reads[0] || routeKey;
      const conditionalBranches = node.branches?.filter((branch) => branch.condition !== 'default') || [];
      const defaultBranch =
        node.branches?.find((branch) => branch.condition === 'default') || node.branches?.[0];

      lines.push(`@action(reads=${readsStr}, writes=${formatPythonList([routeKey])})`);
      lines.push(`def ${safeName}(state: State) -> State:`);
      lines.push(`    route_hint = str(state.get(${quotePy(routeSourceKey)}, "")).lower()`);
      lines.push(`    selected_route = ${quotePy(defaultBranch?.condition === 'default' ? defaultBranch.name : conditionalBranches[0]?.condition || 'default')}`);

      conditionalBranches.forEach((branch) => {
        lines.push(`    if ${quotePy(branch.name.toLowerCase())} in route_hint:`);
        lines.push(`        selected_route = ${quotePy(branch.condition)}`);
      });

      if (conditionalBranches.length === 0 && defaultBranch) {
        lines.push(`    selected_route = ${quotePy(defaultBranch.name)}`);
      }

      lines.push(`    return state.update(${routeKey}=selected_route)`);
      break;
    }
    default: {
      lines.push(`@action(reads=${readsStr}, writes=${writesStr})`);
      lines.push(`def ${safeName}(${signatureParams.join(', ')}) -> State:`);
      if (node.writes.length > 0) {
        const updates = node.writes.map((writeKey) => `${sanitizeName(writeKey)}=${quotePy(`${node.name}:${writeKey}`)}`).join(', ');
        lines.push(`    return state.update(${updates})`);
      } else {
        lines.push('    return state');
      }
    }
  }

  return lines;
};

function buildTransitionLines(
  nodes: BuilderNode[],
  edges: BuilderEdge[],
  indentLevel: number
): string[] {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const pad = ' '.repeat(indentLevel);

  return edges.map((edge, index) => {
    const sourceNode = byName.get(edge.source);
    const condition = normalizeCondition(edge.condition, sourceNode);
    const suffix = index < edges.length - 1 ? ',' : '';
    return `${pad}("${edge.source}", "${edge.target}", ${condition})${suffix}`;
  });
}

/** Generate a single Python file from builder nodes and edges. */
export const generatePythonCode = (
  nodes: BuilderNode[],
  edges: BuilderEdge[],
  entrypoint: string
): string => {
  const lines: string[] = [];
  const hasStreaming = nodes.some((n) => n.nodeType === 'streaming');
  const hasTransitions = edges.length > 0;
  const llm = getLlmImportsAndDeps(nodes);
  const api = getApiImportsAndDeps(nodes);

  lines.push('from typing import Any' + (hasStreaming ? ', Generator' : ''));
  lines.push('from burr.core import ApplicationBuilder, State' + (hasTransitions ? ', default' : ''));
  lines.push(`from burr.core.action import action${hasStreaming ? ', streaming_action' : ''}`);

  const transitionHelpers = new Set<string>();
  edges.forEach((edge) => {
    const condition = normalizeCondition(edge.condition, nodes.find((node) => node.name === edge.source));
    if (condition.startsWith('when(')) transitionHelpers.add('when');
    if (condition.startsWith('expr(')) transitionHelpers.add('expr');
  });
  if (transitionHelpers.size > 0) {
    lines.push(`from burr.core import ${Array.from(transitionHelpers).sort().join(', ')}`);
  }
  llm.imports.forEach((statement) => lines.push(statement));
  api.imports.forEach((statement) => lines.push(statement));
  lines.push('');
  lines.push('');

  for (const node of nodes) {
    lines.push(...generateActionCode(node));
    lines.push('');
    lines.push('');
  }

  lines.push('app = (');
  lines.push('    ApplicationBuilder()');
  lines.push(`    .with_actions(${nodes.map((n) => `${n.name}=${sanitizeName(n.name)}`).join(', ')})`);

  if (edges.length > 0) {
    lines.push('    .with_transitions(');
    lines.push(...buildTransitionLines(nodes, edges, 8));
    lines.push('    )');
  }

  lines.push(`    .with_entrypoint("${entrypoint}")`);

  const stateKeys = getImportedStateKeys(nodes);
  if (stateKeys.length > 0) {
    lines.push(`    .with_state(${stateKeys.map((key) => `${sanitizeName(key)}=None`).join(', ')})`);
  }

  lines.push('    .with_tracker(project="my_app")');
  lines.push('    .build()');
  lines.push(')');
  lines.push('');

  return lines.join('\n');
};

/** A generated project file with name, language, and content. */
export type ProjectFile = {
  name: string;
  language: string;
  content: string;
};

/** Generate a multi-file Python project (actions.py, app.py, run.py, requirements.txt). */
export const generateProjectFiles = (
  nodes: BuilderNode[],
  edges: BuilderEdge[],
  entrypoint: string
): ProjectFile[] => {
  const hasStreaming = nodes.some((n) => n.nodeType === 'streaming');
  const hasTransitions = edges.length > 0;
  const llm = getLlmImportsAndDeps(nodes);
  const api = getApiImportsAndDeps(nodes);

  const actionsLines: string[] = [];
  actionsLines.push('from typing import Any' + (hasStreaming ? ', Generator' : ''));
  actionsLines.push('from burr.core import State');
  actionsLines.push(`from burr.core.action import action${hasStreaming ? ', streaming_action' : ''}`);
  llm.imports.forEach((statement) => actionsLines.push(statement));
  api.imports.forEach((statement) => actionsLines.push(statement));
  actionsLines.push('');
  actionsLines.push('');
  for (const node of nodes) {
    actionsLines.push(...generateActionCode(node));
    actionsLines.push('');
    actionsLines.push('');
  }

  const appLines: string[] = [];
  appLines.push(`from burr.core import ApplicationBuilder${hasTransitions ? ', default' : ''}`);
  const transitionHelpers = new Set<string>();
  edges.forEach((edge) => {
    const condition = normalizeCondition(edge.condition, nodes.find((node) => node.name === edge.source));
    if (condition.startsWith('when(')) transitionHelpers.add('when');
    if (condition.startsWith('expr(')) transitionHelpers.add('expr');
  });
  if (transitionHelpers.size > 0) {
    appLines.push(`from burr.core import ${Array.from(transitionHelpers).sort().join(', ')}`);
  }
  appLines.push(`from actions import ${nodes.map((n) => sanitizeName(n.name)).join(', ')}`);
  appLines.push('');
  appLines.push('');
  appLines.push('def build_app():');
  appLines.push('    app = (');
  appLines.push('        ApplicationBuilder()');
  appLines.push(
    `        .with_actions(${nodes.map((n) => `${n.name}=${sanitizeName(n.name)}`).join(', ')})`
  );
  if (edges.length > 0) {
    appLines.push('        .with_transitions(');
    appLines.push(...buildTransitionLines(nodes, edges, 12));
    appLines.push('        )');
  }
  appLines.push(`        .with_entrypoint("${entrypoint}")`);
  const stateKeys = getImportedStateKeys(nodes);
  if (stateKeys.length > 0) {
    appLines.push(`        .with_state(${stateKeys.map((key) => `${sanitizeName(key)}=None`).join(', ')})`);
  }
  appLines.push('        .with_tracker(project="my_app")');
  appLines.push('        .build()');
  appLines.push('    )');
  appLines.push('    return app');
  appLines.push('');

  const resultLikeNode = nodes.find((node) => node.nodeType === 'result');
  const haltAfterNode = resultLikeNode?.name || nodes[nodes.length - 1]?.name || entrypoint;
  const runLines = [
    'from app import build_app',
    '',
    '',
    'if __name__ == "__main__":',
    '    app = build_app()',
    `    app.run(halt_after=["${haltAfterNode}"])`,
    '    print("Done! Check the Burr UI for tracking.")',
    ''
  ];

  const deps = ['apache-burr[tracking]', ...llm.deps, ...api.deps];
  const reqContent = [...new Set(deps)].join('\n') + '\n';

  return [
    { name: 'actions.py', language: 'python', content: actionsLines.join('\n') },
    { name: 'app.py', language: 'python', content: appLines.join('\n') },
    { name: 'run.py', language: 'python', content: runLines.join('\n') },
    { name: 'requirements.txt', language: 'plaintext', content: reqContent }
  ];
};
