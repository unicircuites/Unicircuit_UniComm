# 🔒 Git Push Hook - Automatic Time Check & Confirmation

## ✅ What Was Installed:

### **1. Git Pre-Push Hook** (manual push protection)
A Git pre-push hook that shows a **Windows popup dialog** before every `git push` command.

**Files Created:**
- `.git/hooks/pre-push` (Git hook trigger)
- `.git/hooks/pre-push.ps1` (PowerShell GUI script)

### **2. Daily Scheduled Task** (automatic 18:00:00 reminder)
A Windows scheduled task that **automatically shows a popup at 18:00:00 every day**.

**Files Created:**
- `schedule-git-push.ps1` (Daily reminder script)
- `install-daily-push-reminder.ps1` (Installation script)
- `uninstall-daily-push-reminder.ps1` (Uninstall script)

---

## 🎯 How It Works:

### **Automatic Daily Reminder (18:00:00):**

**Every day at 18:00:00 sharp:**
1. **Popup appears automatically** (no need to run any command)
2. Shows unpushed commits count
3. Shows recent commit messages
4. **3 buttons:**
   - ✓ **Yes, Push Now** - Pushes to GitHub immediately
   - ✗ **Not Now** - Closes popup, you can push manually later
   - ⏰ **Remind in 10 min** - Shows popup again in 10 minutes

### **Manual Push Protection:**

**When you run `git push origin master`:**
1. Popup appears with time check
2. Shows current time vs 18:00:00
3. Same 3 buttons as above

---

## 📥 Installation:

### **Step 1: Install the Daily Reminder**

**Right-click PowerShell → Run as Administrator**, then:

```powershell
cd "C:\Users\unius\Documents\code workout\UNI_CRM"
.\install-daily-push-reminder.ps1
```

**Expected Output:**
```
✅ Successfully installed!

📋 Task Details:
  Name: GitPushDaily18
  Time: 18:00:00 (every day)

🎯 What happens:
  - Every day at 18:00:00, a popup will appear
  - Shows unpushed commits
  - 3 buttons: Yes / Not Now / Remind in 10 min
```

### **Step 2: Test It Now (Optional)**

Don't want to wait until 18:00? Test immediately:

```powershell
powershell -ExecutionPolicy Bypass -File "schedule-git-push.ps1"
```

---

## 🧪 Testing:

### **Test 1: Wait until 18:00:00**
- At exactly 18:00:00, popup appears automatically
- No need to run any command

### **Test 2: Click "Yes, Push Now"**
- Pushes all commits to GitHub
- Shows success message

### **Test 3: Click "Not Now"**
- Popup closes
- You can push manually later with `git push origin master`

### **Test 4: Click "Remind in 10 min"**
- Popup closes
- Another popup appears in exactly 10 minutes

---

## 📋 Popup Details:

**Title:** "⏰ Git Push - 18:00:00 Reminder"

**Message:**
```
🕐 It's 18:00:00 - Time to push to GitHub!

You have 4 unpushed commit(s) in:
C:\Users\unius\Documents\code workout\UNI_CRM

Do you want to push to GitHub now?

Recent commits:
55f8b00 Add Git pre-push hook with time check and GUI popup
49e2b3e Update work summary: 5 items completed
a40bb50 Audit partial tasks: mark Outlook Sync API complete
```

---

## 🔧 Management:

### **View the Scheduled Task:**
1. Press `Win + R`
2. Type: `taskschd.msc`
3. Find: **GitPushDaily18**

### **Disable Temporarily:**
In Task Scheduler, right-click **GitPushDaily18** → **Disable**

### **Uninstall Completely:**

**Right-click PowerShell → Run as Administrator**, then:

```powershell
cd "C:\Users\unius\Documents\code workout\UNI_CRM"
.\uninstall-daily-push-reminder.ps1
```

---

## 📝 Notes:

1. **Automatic popup at 18:00:00** - No manual command needed
2. **Works even if terminal is closed** - Windows Task Scheduler handles it
3. **Reminder system** - Can delay by 10 minutes multiple times
4. **Manual push still protected** - Git hook asks for confirmation
5. **No commits = no popup** - Only shows if there's something to push

---

## ✅ Benefits:

- ✅ **Automatic reminder** at 18:00:00 every day
- ✅ **No need to remember** to push
- ✅ **Visual popup** with commit preview
- ✅ **Flexible** - can push now, later, or set reminder
- ✅ **Safe** - always asks for confirmation

---

## 🎯 Workflow:

**Daily Routine:**
1. Work throughout the day, commit changes locally
2. At 18:00:00, popup appears automatically
3. Review commits in the popup
4. Click "Yes, Push Now" to push to GitHub
5. Done! ✅

**If not ready at 18:00:**
- Click "Remind in 10 min"
- Popup appears again at 18:10
- Can repeat multiple times

**If you want to push earlier:**
- Run: `git push origin master`
- Popup asks for confirmation
- Click "Yes, Push Now"

---

**Installation complete!** The popup will appear automatically at 18:00:00 every day.
