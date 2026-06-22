---
name: code-review
description: Review code changes for security, performance, and style issues.
allowed-tools: [bash]
model: deepseek-v4-pro
---
Perform a focused code review of: ${arguments}

Steps:
1. Read the target files (use bash: `cat`, `git diff`).
2. Check for: security vulnerabilities, performance pitfalls, error handling,
   and style consistency with the surrounding code.
3. Report findings as a prioritized list (P0 blocking → P3 nits). For each,
   cite the file and line and suggest a concrete fix.

Be direct. Skip praise. If nothing is wrong, say so in one line.
