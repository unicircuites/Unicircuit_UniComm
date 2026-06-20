# ⚡ Quick Start: Automated Git Push Reminder

## 🎯 What You Get:

**Every day at 18:00:00 sharp, a popup appears automatically asking:**
> "You have X unpushed commits. Do you want to push to GitHub now?"

**3 buttons:**
- ✓ **Yes, Push Now** → Pushes immediately
- ✗ **Not Now** → Skip for today
- ⏰ **Remind in 10 min** → Ask again in 10 minutes

---

## 📥 Installation (One-Time Setup):

### **Step 1: Open PowerShell as Administrator**
- Right-click **PowerShell**
- Select **"Run as Administrator"**

### **Step 2: Run the installer**
```powershell
cd "C:\Users\unius\Documents\code workout\UNI_CRM"
.\install-daily-push-reminder.ps1
```

### **Step 3: Done!**
You'll see:
```
✅ Successfully installed!
Task will run every day at 18:00:00
```

---

## 🧪 Test It Now (Don't Wait Until 18:00):

```powershell
powershell -ExecutionPolicy Bypass -File "schedule-git-push.ps1"
```

This will show the popup immediately so you can see how it works.

---

## ✅ That's It!

From now on:
1. Work and commit throughout the day
2. At 18:00:00, popup appears automatically
3. Click "Yes, Push Now"
4. Done! ✅

---

## 🔧 Optional: Uninstall

If you want to remove it:

```powershell
# Run as Administrator
.\uninstall-daily-push-reminder.ps1
```

---

**Total setup time: 30 seconds** ⚡
