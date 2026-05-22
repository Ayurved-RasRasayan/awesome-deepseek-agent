# DeepSeek Web Agent API

A full-featured web API version of the DeepSeek terminal agent.  
Supports file read/write, shell command execution, directory listing, and multi-turn reasoning – all over HTTP.

## Features

- 🤖 DeepSeek V4 Pro/Flash with configurable reasoning effort
- 📂 Read, write, list files (on the server's filesystem)
- 💻 Execute shell commands (use with caution)
- 💾 Per‑session conversation memory (in‑memory, optional Redis)
- 🔐 Optional API key authentication
- 🚀 Ready to deploy on Render, Railway, or any Node.js host

## Deploy to Render

1. Click **New Web Service** on Render.
2. Connect your GitHub repository.
3. Set the following:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Add environment variables (see `.env.example`):
   - `DEEPSEEK_API_KEY` (required)
   - `API_SECRET_KEY` (strongly recommended)
5. Deploy.

## API Usage

### Send a message

```bash
curl -X POST https://your-app.onrender.com/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-secret-key" \
  -d '{"message": "Read the file package.json", "sessionId": "my-session-123"}'
