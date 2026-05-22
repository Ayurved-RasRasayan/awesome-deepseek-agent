#!/usr/bin/env node

import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { createReadStream, createWriteStream, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
import readline from 'readline';

dotenv.config();

const execAsync = promisify(exec);

// ======================== CONFIGURATION ========================
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.MODEL || 'deepseek-v4-pro';
const REASONING_EFFORT = process.env.REASONING_EFFORT || 'max'; // 'high' or 'max'
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS) || 8192;
const CONTEXT_WINDOW = 1000000;

if (!DEEPSEEK_API_KEY) {
  console.error('❌ DEEPSEEK_API_KEY environment variable not set.');
  console.error('Get your key from https://platform.deepseek.com/api_keys');
  process.exit(1);
}

// ======================== TOOL DEFINITIONS ========================
const tools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to CWD).' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file (overwrites if exists).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          content: { type: 'string', description: 'Content to write.' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command and return its stdout/stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run.' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories in a given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (defaults to current directory).' }
        },
        required: []
      }
    }
  }
];

// ======================== TOOL IMPLEMENTATIONS ========================
async function readFile(path) {
  try {
    const resolved = resolve(path);
    const content = readFileSync(resolved, 'utf-8');
    return `Content of ${resolved}:\n${content}`;
  } catch (err) {
    return `Error reading file: ${err.message}`;
  }
}

async function writeFile(path, content) {
  try {
    const resolved = resolve(path);
    const dir = dirname(resolved);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolved, content, 'utf-8');
    return `Successfully wrote ${content.length} characters to ${resolved}`;
  } catch (err) {
    return `Error writing file: ${err.message}`;
  }
}

async function runCommand(command) {
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
    let output = '';
    if (stdout) output += `STDOUT:\n${stdout}`;
    if (stderr) output += `\nSTDERR:\n${stderr}`;
    if (!output) output = '(no output)';
    return output;
  } catch (err) {
    return `Command failed (exit ${err.code}): ${err.message}\n${err.stderr || ''}`;
  }
}

async function listDirectory(path = '.') {
  try {
    const resolved = resolve(path);
    const items = readdirSync(resolved, { withFileTypes: true });
    const output = items.map(item => {
      const type = item.isDirectory() ? '📁' : '📄';
      return `${type} ${item.name}`;
    }).join('\n');
    return `Contents of ${resolved}:\n${output || '(empty)'}`;
  } catch (err) {
    return `Error listing directory: ${err.message}`;
  }
}

async function callTool(name, args) {
  switch (name) {
    case 'read_file': return await readFile(args.path);
    case 'write_file': return await writeFile(args.path, args.content);
    case 'run_command': return await runCommand(args.command);
    case 'list_directory': return await listDirectory(args.path);
    default: return `Unknown tool: ${name}`;
  }
}

// ======================== DEEPSEEK API WRAPPER ========================
async function callDeepSeek(messages, toolsEnabled = true) {
  const requestBody = {
    model: MODEL,
    messages: messages,
    max_tokens: MAX_TOKENS,
    temperature: 0.7,
    stream: false
  };

  if (REASONING_EFFORT && (MODEL.includes('deepseek-v4-pro') || MODEL.includes('deepseek-v4'))) {
    requestBody.reasoning_effort = REASONING_EFFORT;
  }

  if (toolsEnabled) {
    requestBody.tools = tools;
    requestBody.tool_choice = 'auto';
  }

  const response = await fetch(`${DEEPSEEK_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0].message;
}

// ======================== TERMINAL UI ========================
function createPrompt() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `\x1b[36m>>>\x1b[0m `
  });
  return rl;
}

async function main() {
  console.clear();
  console.log(`\x1b[1;34m╔════════════════════════════════════════════════════╗\x1b[0m`);
  console.log(`\x1b[1;34m║   🤖 DeepSeek Terminal AI Agent                     ║\x1b[0m`);
  console.log(`\x1b[1;34m║   Model: ${MODEL.padEnd(36)}\x1b[0m`);
  console.log(`\x1b[1;34m║   Reasoning: ${REASONING_EFFORT.padEnd(32)}\x1b[0m`);
  console.log(`\x1b[1;34m║   Context: 1M tokens                               ║\x1b[0m`);
  console.log(`\x1b[1;34m╚════════════════════════════════════════════════════╝\x1b[0m`);
  console.log(`\x1b[90mType \x1b[33m/help\x1b[90m for commands, \x1b[33mCtrl+C\x1b[90m to exit.\x1b[0m\n`);

  const conversation = [
    { role: 'system', content: `You are a powerful terminal AI agent with the following capabilities:
- Read and write files (read_file, write_file)
- Execute shell commands (run_command)
- List directory contents (list_directory)

You have a 1M token context window and can reason deeply (${REASONING_EFFORT} effort).
Always think step-by-step. When you need to perform an action, call the appropriate tool.
After each tool call, you will receive the result. Continue until the user's request is fully satisfied.
Be concise but thorough. Use the tools efficiently.` }
  ];

  const rl = createPrompt();
  rl.prompt();

  rl.on('line', async (input) => {
    const trimmed = input.trim();
    if (trimmed === '') {
      rl.prompt();
      return;
    }

    // Handle special commands
    if (trimmed === '/exit' || trimmed === '/quit') {
      console.log('\n👋 Goodbye!');
      rl.close();
      process.exit(0);
    } else if (trimmed === '/help') {
      console.log(`
\x1b[1;33mAvailable commands:\x1b[0m
  /help      - Show this help
  /exit      - Quit the agent
  /clear     - Clear conversation history (start fresh)
  /model     - Show current model
  /reasoning - Show current reasoning effort

\x1b[1;33mBuilt-in tools:\x1b[0m
  - read_file <path>       (tool, not manual)
  - write_file <path>      (the agent will call them)
  - run_command <command>
  - list_directory [path]

Just describe what you want, and the agent will use tools automatically.
      `);
      rl.prompt();
      return;
    } else if (trimmed === '/clear') {
      conversation.length = 1; // keep only system message
      console.log('🧹 Conversation cleared.');
      rl.prompt();
      return;
    } else if (trimmed === '/model') {
      console.log(`Current model: ${MODEL}`);
      rl.prompt();
      return;
    } else if (trimmed === '/reasoning') {
      console.log(`Reasoning effort: ${REASONING_EFFORT}`);
      rl.prompt();
      return;
    }

    // Add user message
    conversation.push({ role: 'user', content: trimmed });
    process.stdout.write('\x1b[90mAgent is thinking...\x1b[0m\n');

    let loopCount = 0;
    const maxLoops = 10;

    while (loopCount < maxLoops) {
      loopCount++;
      try {
        const assistantMsg = await callDeepSeek(conversation, true);
        conversation.push(assistantMsg);

        // Check for tool calls
        if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
          console.log(`\x1b[90m🔧 Executing ${assistantMsg.tool_calls.length} tool(s)...\x1b[0m`);
          for (const toolCall of assistantMsg.tool_calls) {
            const funcName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);
            console.log(`  ⚙️  ${funcName}(${JSON.stringify(args)})`);
            const result = await callTool(funcName, args);
            conversation.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result
            });
          }
          // Continue loop to let model process tool results
          continue;
        }

        // No tool calls – final answer
        const content = assistantMsg.content || '(no textual response)';
        console.log(`\n\x1b[32m${content}\x1b[0m\n`);
        break;

      } catch (err) {
        console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
        conversation.push({ role: 'assistant', content: `I encountered an error: ${err.message}` });
        break;
      }
    }

    if (loopCount >= maxLoops) {
      console.log(`\x1b[33m⚠️  Stopped after ${maxLoops} tool call rounds. Please refine your request.\x1b[0m`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n👋 Exiting...');
  process.exit(0);
});

main().catch(console.error);
