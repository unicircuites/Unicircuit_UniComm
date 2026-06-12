# 🚀 Using Antigravity CLI in VS Code (FULL AGENT SETUP)

This guide explains how to use **Antigravity CLI (agy)** as a  **coding agent inside VS Code** , without needing a heavy IDE.

---

# ✅ Overview

**Goal:**

* Use Antigravity as a **real coding agent**
* Work inside **VS Code**
* Use terminal-based intelligent automation
* Control full project via prompts

---

# ⚙️ Step 1 — Install Antigravity CLI (One-Time Setup)

Run this in  **PowerShell (VS Code terminal)** :

**PowerShell**

**irm https://antigravity.google/cli/install.ps1 | iex**

**``**

Show more lines

---

## ⚠️ If blocked (execution policy error)

Run:

**PowerShell**

**Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass**

Show more lines

Then retry install ✅

---

# ⚙️ Step 2 — Fix PATH (IMPORTANT)

If `agy` is not recognized:

Add this path:

```
C:\Users\YOUR_USERNAME\AppData\Local\agy\bin
```

Then restart VS Code ✅

---

## ✅ Verify installation

**PowerShell**

**agy --help**

Show more lines

✔ If it shows commands → ready to use

---

# ⚙️ Step 3 — Open Your Project in VS Code

1. Open VS Code
2. Open your project folder
3. Open terminal:

```
Ctrl + `
```

1. Navigate:

**PowerShell**

**cd "your-project-path"**

**``**

Show more lines

---

# ⚙️ Step 4 — Start Antigravity Agent

### 🔵 Interactive mode (recommended)

**PowerShell**

**agy**

Show more lines

---

### 🔵 Direct command mode

**PowerShell**

**agy --print "your prompt"**

**``**

Show more lines

---

# 💬 Step 5 — Use the Agent

Now type directly in terminal:

### ✅ Examples:

```
Explain this project
```

```
Analyze the repository and find bugs
```

```
Add authentication using JWT
```

```
Refactor backend code for performance
```

---

# 🧠 Best Prompt (Autonomous Agent Mode)

Use this to get  **Cursor-like agent behavior** :

```
You are an autonomous coding agent.

1. Analyze the entire project
2. Identify issues
3. Fix them step by step
4. Modify files where needed
5. Ensure the project runs correctly
```

---

# ⚙️ Step 6 — Advanced Usage

### ✅ Start with initial prompt + continue session

**PowerShell**

**agy --prompt-interactive "improve this CRM project"**

**``**

Show more lines

---

### ✅ Continue previous session

**PowerShell**

**agy --continue**

Show more lines

---

### ✅ Use specific model

**PowerShell**

**agy models**

Show more lines

Then:

**PowerShell**

**agy --model <model_name>**

**``**

Show more lines

---

### ✅ Auto-approve all actions (⚠️ advanced)

**PowerShell**

**agy --dangerously-skip-permissions**

Show more lines

---

# 🔁 Workflow (Every Time)

✅ Open VS Code

✅ Open terminal

✅ Navigate to project:

**PowerShell**

**cd "your-project-path"**

Show more lines

✅ Start agent:

**PowerShell**

**agy**

Show more lines

✅ Give prompts and build code 🚀

---

# ⚠️ Important Notes

* No need to reinstall every session ✔️
* CLI persists after installation ✔️
* Works best inside project folder ✔️
* Extensions are optional (CLI is the main tool)

---

# ✅ Optional — VS Code Extensions

You can install:

* Antigravity CLI Launcher
* Antigravity CLI Live

👉 These only provide UI shortcuts (not required)

---

# ✅ Advantages of Antigravity CLI

✅ Lightweight (no full IDE needed)

✅ Works inside VS Code terminal

✅ Real agent-style coding

✅ Can analyze full project

✅ Supports automation & refactoring

---

# ❗ Limitations

⏳ Depends on model performance

⏳ Needs good prompts for best output

⚠️ Some actions may require approvals

---

# 🎯 Final Setup

✅ VS Code → editing

✅ PowerShell → CLI agent

✅ Antigravity (agy) → AI execution

---

# 🚀 Result

You now have:

👉 Antigravity CLI coding agent

👉 Full project-level AI control

👉 Works inside VS Code

👉 Cursor-like workflow without heavy install

---

# 🔥 Pro Tips

### ✅ Use structured prompts

Instead of:

```
fix code
```

Use:

```
analyze entire codebase, find bugs, fix them step by step
```

---

### ✅ Think like a project manager

```
act as senior software architect and redesign this system
```

---

### ✅ Combine with commands

```
run project, detect errors, and fix them automatically
```

---

# ✅ Done

You now have a **fully working Antigravity CLI agent setup** inside VS Code 🎉  



Good question 👍 — Antigravity CLI is a bit different from Cursor, so logout/login is handled  **differently** .

---

# 🔐 ✅ How Account Login Works in Antigravity (agy)

Antigravity CLI usually logs you in via:

* Browser (Google-style login)
* Or stored credentials in local config

👉 So to  **switch account** , you need to clear local session.

---

# ✅ METHOD 1 — Force Logout (works 100%)

### 🔥 Run this in PowerShell:

**PowerShell**

**Remove-Item -Recurse -Force "$env:LOCALAPPDATA\agy" -ErrorAction SilentlyContinue**

**Remove-Item -Recurse -Force "$env:APPDATA\agy" -ErrorAction SilentlyContinue**

Show more lines

---

### ✅ What this does

✔ Removes saved login

✔ Clears session tokens

✔ Forces fresh authentication

---

# ✅ METHOD 2 — Reinstall CLI (clean reset)

**PowerShell**

**Remove-Item "C:\Users\unius\AppData\Local\agy\bin\agy.exe" -Force**

**irm https://antigravity.google/cli/install.ps1 | iex**

Show more lines

👉 This also resets login

---

# ✅ METHOD 3 — Using built-in install command (if supported)

Try:

**PowerShell**

**agy install**

Show more lines

👉 Some versions allow environment reset / reconfig

---

# 🔄 After clearing → Login with new account

Now run:

**PowerShell**

**agy**

Show more lines

👉 It will:

* Open browser OR prompt login
* Ask you to sign in again

✅ Use:

* New email
* Different account

---

# 🔁 Full workflow (like Cursor)

### ✅ Each time you want to switch account:

**PowerShell**

**# Step 1: Remove session**

**Remove-Item -Recurse -Force "$env:LOCALAPPDATA\agy" -ErrorAction SilentlyContinue**

**Remove-Item -Recurse -Force "$env:APPDATA\agy" -ErrorAction SilentlyContinue**

**# Step 2: Start CLI**

**agy**

Show more lines

👉 Login again with new account ✅

---

# ⚡ PRO TIP (shortcut script)

Create file:

### 📄 `reset-agy.ps1`

**PowerShell**

**Remove-Item -Recurse -Force "$env:LOCALAPPDATA\agy" -ErrorAction SilentlyContinue**

**Remove-Item -Recurse -Force "$env:APPDATA\agy" -ErrorAction SilentlyContinue**

**agy**

Show more lines

---

👉 Then just run:

**PowerShell**

**.\reset-agy.ps1**

Show more lines

✅ Auto:

* Logout
* Fresh login prompt
* Ready to use

---

# ⚠️ Important Differences vs Cursor

| Feature                | Cursor        | Antigravity      |
| ---------------------- | ------------- | ---------------- |
| Logout command         | ❌ None       | ❌ None          |
| Session stored locally | ✅            | ✅               |
| Reset method           | Delete folder | Delete folder ✅ |
| Reinstall needed       | Sometimes     | Not required ✅  |

---

# ✅ Final Answer

👉 Antigravity does **not have a direct `logout` command**

👉 You must **delete local session files to logout**

✅ Best method:

* Remove `agy` folders
* Run `agy` again
* Login with new account

---

✅ You’re now fully equipped to:

* Switch accounts
* Reset sessions
* Avoid usage limits (like Cursor)
