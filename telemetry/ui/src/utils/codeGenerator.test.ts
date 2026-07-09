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

import { BuilderEdge, BuilderNode, generateProjectFiles, generatePythonCode } from './codeGenerator';

describe('codeGenerator', () => {
  const nodes: BuilderNode[] = [
    {
      id: 'input',
      name: 'prompt_input',
      nodeType: 'input',
      reads: [],
      writes: ['prompt'],
      inputs: ['prompt'],
      position: { x: 0, y: 0 }
    },
    {
      id: 'router',
      name: 'choose_route',
      nodeType: 'router',
      reads: ['status'],
      writes: ['route'],
      inputs: [],
      position: { x: 0, y: 0 },
      branches: [
        { name: 'Branch 1', condition: 'branch_1' },
        { name: 'Branch 2', condition: 'default' }
      ]
    },
    {
      id: 'llm',
      name: 'ask_llm',
      nodeType: 'llm_call',
      reads: ['prompt'],
      writes: ['response'],
      inputs: [],
      position: { x: 0, y: 0 },
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini'
    },
    {
      id: 'api',
      name: 'fetch_profile',
      nodeType: 'api_call',
      reads: ['response'],
      writes: ['api_response', 'api_status'],
      inputs: [],
      position: { x: 0, y: 0 },
      apiMethod: 'POST',
      apiUrl: 'https://api.example.com/users'
    },
    {
      id: 'stream',
      name: 'stream_answer',
      nodeType: 'streaming',
      reads: ['prompt'],
      writes: ['stream_output'],
      inputs: [],
      position: { x: 0, y: 0 }
    },
    {
      id: 'loop',
      name: 'loop_items',
      nodeType: 'loop',
      reads: ['items'],
      writes: ['current_item', 'loop_index', 'items_index'],
      inputs: [],
      position: { x: 0, y: 0 },
      loopVariable: 'items',
      itemVariable: 'current_item'
    },
    {
      id: 'code',
      name: 'custom_code',
      nodeType: 'code',
      reads: ['api_response'],
      writes: ['transformed'],
      inputs: [],
      position: { x: 0, y: 0 },
      codeBody: 'return state.update(transformed=state.get("api_response"))'
    },
    {
      id: 'result',
      name: 'final_result',
      nodeType: 'result',
      reads: ['transformed'],
      writes: ['result'],
      inputs: [],
      position: { x: 0, y: 0 }
    }
  ];

  const edges: BuilderEdge[] = [
    { id: 'e1', source: 'prompt_input', target: 'choose_route', condition: 'default' },
    { id: 'e2', source: 'choose_route', target: 'ask_llm', condition: 'branch_1' },
    { id: 'e3', source: 'choose_route', target: 'fetch_profile', condition: 'default' },
    { id: 'e4', source: 'ask_llm', target: 'stream_answer', condition: 'default' },
    { id: 'e5', source: 'stream_answer', target: 'loop_items', condition: 'default' },
    { id: 'e6', source: 'loop_items', target: 'custom_code', condition: 'expr("items_index < len(items)")' },
    { id: 'e7', source: 'custom_code', target: 'final_result', condition: 'default' }
  ];

  it('generates concrete implementations for specialized node types', () => {
    const python = generatePythonCode(nodes, edges, 'prompt_input');

    expect(python).toContain('from openai import OpenAI');
    expect(python).toContain('import httpx');
    expect(python).toContain('from burr.core import ApplicationBuilder, State, default');
    expect(python).toContain('from burr.core import expr, when');
    expect(python).toContain('client = OpenAI()');
    expect(python).toContain('client.chat.completions.create(');
    expect(python).toContain('httpx.request("POST", "https://api.example.com/users", json=request_data, timeout=30.0)');
    expect(python).toContain('chunks = source_text.split() or ["stream"]');
    expect(python).toContain('current_index = (state.get("items_index", -1) or -1) + 1');
    expect(python).toContain('return state.update(route=selected_route)');
    expect(python).toContain('("choose_route", "ask_llm", when(route="branch_1"))');
    expect(python).not.toContain('# TODO: call');
    expect(python).not.toContain('generate_chunks(state)');
    expect(python).not.toContain('return state.update(response=None)');
  });

  it('generates project files with matching runtime dependencies', () => {
    const files = generateProjectFiles(nodes, edges, 'prompt_input');
    const requirements = files.find((file) => file.name === 'requirements.txt')?.content || '';
    const run = files.find((file) => file.name === 'run.py')?.content || '';

    expect(requirements).toContain('apache-burr[tracking]');
    expect(requirements).toContain('openai');
    expect(requirements).toContain('httpx');
    expect(run).toContain('app.run(halt_after=["final_result"])');
  });
});
