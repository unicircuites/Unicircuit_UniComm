# 🔒 Git Push Hook - Automatic Time Check & Confirmation

## ✅ What Was Installed:

A Git pre-push hook that shows a **Windows popup dialog** before every push to GitHub.

**Files Created:**
- `.git/hooks/pre-push` (Git hook trigger)
- `.git/hooks/pre-push.ps1` (PowerShell GUI script)

---

## 🎯 How It Works:

### **When you run `git push`:**

1. **Popup appears** with 3 buttons:
   - ✓ **Yes, Push Now** (green) - Proceeds with push
   - ✗ **No, Cancel** (red) - Cancels push
   - ⏰ **Remind in 10 min** (yellow) - Cancels push, shows popup again in 10 minutes

2. **Time Check:**
   - **Before 18:00:00** - Shows warning: "Time until 18:00: X hours Y minutes"
   - **After 18:00:00** - Shows: "Time is after 18:00:00"

3. **Auto-close:**
   - If no button clicked within **30 seconds**, defaults to **No** (cancel push)

4. **Reminder System:**
   - Click "Remind in 10 min" → Popup shows again after 10 minutes
   - Reminder persists across terminal sessions
   - Stored in: `.git/hooks/push-reminder.txt`

---

## 🧪 How to Test:

### **Test 1: Try to push now**
```powershell
git push origin master
```

**Expected:**
- Popup appears
- Shows current time vs 18:00:00
- 3 buttons available

---

### **Test 2: Click "Yes, Push Now"**
- Push proceeds immediately
- Console shows: "✓ User confirmed push"

---

### **Test 3: Click "No, Cancel"**
- Push is cancelled
- Console shows: "✗ Push cancelled by user"
- Changes remain committed locally

---

### **Test 4: Click "Remind in 10 min"**
- Push is cancelled
- Console shows: "⏰ Reminder set for HH:MM:SS"
- After 10 minutes, next `git push` shows reminder popup

---

### **Test 5: Don't click anything (wait 30 seconds)**
- Popup auto-closes
- Defaults to "No" (cancel push)
- Console shows: "✗ Push cancelled by user"

---

## 📋 Popup Details:

**Title:** "Git Push - Time Check" or "Git Push Confirmation"

**Message Examples:**

**Before 18:00:**
```
⚠️ Current time is before 18:00:00

Time until 18:00: 2 hours 15 minutes

Do you want to push to GitHub now?
```

**After 18:00:**
```
✓ Time is after 18:00:00

Do you want to push to GitHub?
```

**Reminder:**
```
⏰ REMINDER: You asked to be reminded about pushing to GitHub.

Do you want to push now?
```

---

## 🔧 How to Disable (if needed):

### **Temporary (one push only):**
```powershell
git push --no-verify origin master
```

### **Permanent:**
```powershell
Remove-Item .git\hooks\pre-push
Remove-Item .git\hooks\pre-push.ps1
```

---

## 📝 Notes:

1. **Hook runs on every `git push`** - local commits are not affected
2. **Reminder file** stored at: `.git/hooks/push-reminder.txt`
3. **Works only on Windows** (uses PowerShell GUI)
4. **Target time:** 18:00:00 (6 PM) - hardcoded in script
5. **Auto-close timeout:** 30 seconds

---

## ✅ Benefits:

- ✅ Prevents accidental pushes before 18:00:00
- ✅ Always asks for confirmation
- ✅ Reminder system for delayed pushes
- ✅ Visual popup (not just console prompt)
- ✅ Safe default (No) if user walks away

---

## 🎯 Use Cases:

1. **Daily workflow:** Commit throughout the day, push at 18:00:00
2. **Review before push:** Always get a chance to reconsider
3. **Delayed push:** Set reminder if not ready yet
4. **Emergency push:** Can still push early by clicking "Yes"

---

**Hook is now active!** Try `git push origin master` to see it in action.
