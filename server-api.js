#!/usr/bin/env node

import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve, dirname } from 'path';
import crypto from 'crypto';

dotenv.config();

// ========== Configuration ==========
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = process.env.MODEL || 'deepseek-v4-pro';
const REASONING_EFFORT = process.env.REASONING_EFFORT || 'max';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS) || 8192;
const PORT = process.env.PORT || 3000;
const API_SECRET_KEY = process.env.API_SECRET_KEY;

if (!DEEPSEEK_API_KEY) {
  console.error('❌ DEEPSEEK_API_KEY environment variable not set.');
  process.exit(1);
}

const execAsync = promisify(exec);

// ========== In-memory session store ==========
const sessions = new Map();

// ========== Tool definitions ==========
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

// ========== DeepSeek API wrapper ==========
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

// ========== Agent turn ==========
async function runAgentTurn(sessionId, userMessage) {
  let session = sessions.get(sessionId);
  if (!session) {
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

  session.messages.push({ role: 'user', content: userMessage });

  let loopCount = 0;
  const maxLoops = 10;

  while (loopCount < maxLoops) {
    loopCount++;
    try {
      const assistantMsg = await callDeepSeek(session.messages, true);
      session.messages.push(assistantMsg);

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
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
        continue;
      }

      return {
        finalAnswer: assistantMsg.content || '(no response)',
        conversationHistory: session.messages
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

// ========== Express app ==========
const app = express();
app.use(express.json({ limit: '10mb' }));

// Auth middleware (unchanged)
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

// ========== Chat HTML (injected with API_SECRET_KEY from environment) ==========
const chatHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DeepSeek APK Builder</title>
    <style>
        body {
            background: #0a0a0a;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
        }
        .chat-window {
            width: 900px;
            max-width: 100%;
            height: 80vh;
            background: #1e1e1e;
            border-radius: 16px;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            box-shadow: 0 8px 30px rgba(0,0,0,0.5);
            border: 1px solid #333;
        }
        .chat-header {
            background: #2d2d2d;
            padding: 15px 20px;
            border-bottom: 1px solid #444;
            font-weight: bold;
            color: #10a37f;
            font-size: 1.1em;
        }
        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            background: #121212;
        }
        .message {
            max-width: 80%;
            padding: 10px 16px;
            border-radius: 18px;
            line-height: 1.4;
            font-size: 14px;
            word-wrap: break-word;
            white-space: pre-wrap;
        }
        .user-message {
            background: #10a37f;
            color: white;
            align-self: flex-end;
            border-bottom-right-radius: 4px;
        }
        .agent-message {
            background: #2d2d2d;
            color: #e0e0e0;
            align-self: flex-start;
            border-bottom-left-radius: 4px;
            font-family: monospace;
        }
        .input-area {
            padding: 15px;
            background: #1e1e1e;
            border-top: 1px solid #333;
            display: flex;
            gap: 10px;
        }
        textarea {
            flex: 1;
            background: #2d2d2d;
            border: 1px solid #444;
            border-radius: 24px;
            padding: 12px 18px;
            color: white;
            font-family: inherit;
            resize: none;
            outline: none;
            font-size: 14px;
        }
        button {
            background: #10a37f;
            border: none;
            border-radius: 24px;
            padding: 0 24px;
            color: white;
            font-weight: bold;
            cursor: pointer;
            transition: background 0.2s;
        }
        button:hover {
            background: #0e8b6c;
        }
        .status {
            padding: 8px 15px;
            background: #0a0a0a;
            border-top: 1px solid #333;
            font-size: 12px;
            color: #888;
        }
    </style>
</head>
<body>
    <div class="chat-window">
        <div class="chat-header">
            🤖 DeepSeek APK Builder — v4 Pro (max reasoning)
        </div>
        <div class="messages" id="messages">
            <div class="message agent-message">✅ Agent ready. I can read/write files, run commands, and build Android projects.<br><br>Give me a task like:<br>📱 "Generate a full Android Kotlin project with a simple 'Hello World' app and compile an APK."</div>
        </div>
        <div class="input-area">
            <textarea id="userInput" placeholder="Ask me to build an APK..."></textarea>
            <button id="sendBtn">Send</button>
        </div>
        <div class="status" id="status">● Ready</div>
    </div>

    <script>
        const API_URL = window.location.origin + '/chat';
        // API secret automatically injected from server environment
        const API_SECRET = '${API_SECRET_KEY || ''}';
        let sessionId = localStorage.getItem('agentSessionId');
        if (!sessionId) {
            sessionId = crypto.randomUUID();
            localStorage.setItem('agentSessionId', sessionId);
        }
        
        const messagesDiv = document.getElementById('messages');
        const userInput = document.getElementById('userInput');
        const sendBtn = document.getElementById('sendBtn');
        const statusSpan = document.getElementById('status');
        
        function addMessage(text, isUser = false) {
            const msgDiv = document.createElement('div');
            msgDiv.className = \`message \${isUser ? 'user-message' : 'agent-message'}\`;
            msgDiv.textContent = text;
            messagesDiv.appendChild(msgDiv);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
        
        function setStatus(msg, isError = false) {
            statusSpan.innerHTML = isError ? \`⚠️ \${msg}\` : \`● \${msg}\`;
        }
        
        async function sendMessage() {
            const text = userInput.value.trim();
            if (!text) return;
            userInput.value = '';
            addMessage(text, true);
            setStatus('Agent is thinking...');
            
            const headers = { 'Content-Type': 'application/json' };
            if (API_SECRET) headers['Authorization'] = \`Bearer \${API_SECRET}\`;
            
            try {
                const response = await fetch(API_URL, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({ message: text, sessionId: sessionId })
                });
                if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
                const data = await response.json();
                if (data.error) throw new Error(data.error);
                addMessage(data.reply, false);
                setStatus('Ready');
            } catch (err) {
                console.error(err);
                addMessage(\`⚠️ Error: \${err.message}\`, false);
                setStatus('Error — check console', true);
            }
        }
        
        sendBtn.addEventListener('click', sendMessage);
        userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
        userInput.focus();
    </script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.send(chatHTML);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', model: MODEL, reasoning: REASONING_EFFORT });
});

// Chat endpoint
app.post('/chat', authMiddleware, async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required and must be a string' });
  }
  const effectiveSessionId = sessionId || crypto.randomUUID();
  try {
    const { finalAnswer, error } = await runAgentTurn(effectiveSessionId, message);
    res.json({ sessionId: effectiveSessionId, reply: finalAnswer, error: error || false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Clear session
app.delete('/session/:sessionId', authMiddleware, (req, res) => {
  const { sessionId } = req.params;
  if (sessions.delete(sessionId)) {
    res.json({ success: true, message: 'Session cleared' });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// List sessions
app.get('/sessions', authMiddleware, (req, res) => {
  const sessionList = Array.from(sessions.keys()).map(id => ({
    id,
    createdAt: sessions.get(id).createdAt,
    messageCount: sessions.get(id).messages.length
  }));
  res.json({ sessions: sessionList });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 DeepSeek Web Agent API running on port ${PORT}`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   Reasoning: ${REASONING_EFFORT}`);
  console.log(`   Auth: ${API_SECRET_KEY ? 'enabled' : 'disabled (warning!)'}`);
});
