#!/usr/bin/env node

import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve, dirname, join } from 'path';
import crypto from 'crypto';

dotenv.config();

// ========== Configuration ==========
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = process.env.MODEL || 'deepseek-v4-pro';
const REASONING_EFFORT = process.env.REASONING_EFFORT || 'max';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS) || 8192;
const PORT = process.env.PORT || 3000;
const API_SECRET_KEY = process.env.API_SECRET_KEY; // optional: if not set, no auth

if (!DEEPSEEK_API_KEY) {
  console.error('❌ DEEPSEEK_API_KEY environment variable not set.');
  process.exit(1);
}

const execAsync = promisify(exec);

// ========== In-memory session store (for demo; use Redis for production) ==========
const sessions = new Map(); // sessionId -> { messages, createdAt }

// ========== Tool definitions (same as original) ==========
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

// ========== Tool implementations ==========
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
    const { stdout, stderr } = await execAsync(command, { timeout: 60000 });
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

// ========== DeepSeek API wrapper with tool calling ==========
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

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0].message;
}

// ========== Main agent loop (stateless for a given session) ==========
async function runAgentTurn(sessionId, userMessage) {
  // Get or create session
  let session = sessions.get(sessionId);
  if (!session) {
    // Initial system prompt
    const systemMessage = {
      role: 'system',
      content: `You are a powerful terminal AI agent with the following capabilities:
- Read and write files (read_file, write_file)
- Execute shell commands (run_command)
- List directory contents (list_directory)

You have a 1M token context window and can reason deeply (${REASONING_EFFORT} effort).
Always think step-by-step. When you need to perform an action, call the appropriate tool.
After each tool call, you will receive the result. Continue until the user's request is fully satisfied.
Be concise but thorough. Use the tools efficiently.`
    };
    session = {
      messages: [systemMessage],
      createdAt: Date.now()
    };
    sessions.set(sessionId, session);
  }

  // Add user message
  session.messages.push({ role: 'user', content: userMessage });

  let loopCount = 0;
  const maxLoops = 10;

  while (loopCount < maxLoops) {
    loopCount++;
    try {
      const assistantMsg = await callDeepSeek(session.messages, true);
      session.messages.push(assistantMsg);

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        // Execute tools
        for (const toolCall of assistantMsg.tool_calls) {
          const funcName = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments);
          const result = await callTool(funcName, args);
          session.messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result
          });
        }
        // Continue loop to let model process results
        continue;
      }

      // No tool calls – final answer
      return {
        finalAnswer: assistantMsg.content || '(no response)',
        conversationHistory: session.messages // optional, for debugging
      };
    } catch (err) {
      const errorMsg = `Error: ${err.message}`;
      session.messages.push({ role: 'assistant', content: errorMsg });
      return { finalAnswer: errorMsg, error: true };
    }
  }

  return {
    finalAnswer: `Stopped after ${maxLoops} tool call rounds. Please refine your request.`,
    error: false
  };
}

// ========== Express App ==========
const app = express();
app.use(express.json({ limit: '10mb' }));

// Simple auth middleware (if API_SECRET_KEY is set)
function authMiddleware(req, res, next) {
  if (!API_SECRET_KEY) return next();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== API_SECRET_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', model: MODEL, reasoning: REASONING_EFFORT });
});

// Chat endpoint
app.post('/chat', authMiddleware, async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required and must be a string' });
  }

  // Generate session ID if not provided
  const effectiveSessionId = sessionId || crypto.randomUUID();

  try {
    const { finalAnswer, error } = await runAgentTurn(effectiveSessionId, message);
    res.json({
      sessionId: effectiveSessionId,
      reply: finalAnswer,
      error: error || false
    });
  } catch (err) {
    console.error(`Error processing session ${effectiveSessionId}:`, err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Optional: clear session
app.delete('/session/:sessionId', authMiddleware, (req, res) => {
  const { sessionId } = req.params;
  if (sessions.delete(sessionId)) {
    res.json({ success: true, message: 'Session cleared' });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// List active sessions (admin only - protect with API key)
app.get('/sessions', authMiddleware, (req, res) => {
  const sessionList = Array.from(sessions.keys()).map(id => ({
    id,
    createdAt: sessions.get(id).createdAt,
    messageCount: sessions.get(id).messages.length
  }));
  res.json({ sessions: sessionList });
});

// ========== Start server ==========
app.listen(PORT, () => {
  console.log(`🚀 DeepSeek Web Agent API running on port ${PORT}`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   Reasoning: ${REASONING_EFFORT}`);
  console.log(`   Auth: ${API_SECRET_KEY ? 'enabled' : 'disabled (warning!)'}`);
});
