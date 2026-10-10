---
name: gemini-large-context
description: 用 Gemini CLI 作为子代理处理超出上下文限制的分析任务。当需要分析大型代码库、总结巨大的日志文件、或处理超出自身上下文容量的内容时使用。
---

# Using Gemini CLI for Large Codebase Analysis

When analysing large codebases, summarising massive log files, or dealing with context that exceeds your limits, you must act as the orchestrator and use the Gemini CLI as your subagent.

Execute the following command in the terminal to leverage Google Gemini's large context capacity:

```bash
gemini -p "<your prompt here>"
```

Wait for the CLI to return the output, read the results, and then synthesise the answer for the user based on Gemini's analysis.
