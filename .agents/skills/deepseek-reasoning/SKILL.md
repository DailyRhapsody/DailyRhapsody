---
name: deepseek-reasoning
description: 调用 DeepSeek API 处理复杂代码逻辑、算法优化或需要深度推理的问题。当遇到棘手的算法设计、复杂逻辑推演、或需要第二意见的深度技术问题时使用。
---

# DeepSeek Expert Subagent

In addition to Gemini, you have access to DeepSeek models to assist with complex code logic, algorithm optimisation, or deep reasoning tasks.

When you require DeepSeek's assistance, use the terminal to execute a `curl` command to call its official API directly.

- API Key environment variable: `$DEEPSEEK_API_KEY`
- API Endpoint: `https://api.deepseek.com/chat/completions`
- Available Models: Use `deepseek-chat` (for general coding) or `deepseek-reasoner` (for complex logic requiring deep thought).

## Execution Protocol

Construct and run a secure `curl` request in the background. Send the coding problem as `messages` to DeepSeek, read its JSON response, and synthesise the final answer for the user based on its output.
