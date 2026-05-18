# GitHub Push and Tower Pull Notes

Date: 2026-05-18

## What happened

- Work was committed on local branch `autosave` as commit `cec3f35`.
- Push command used was `git push origin main`, but local `main` was behind `origin/main`, so GitHub rejected it with a non-fast-forward error.
- Local `main` also had one unpushed commit, so it was backed up before syncing.

## Fix done

```powershell
git fetch origin
git branch backup-local-main-before-sync main
git checkout main
git rebase origin/main
git cherry-pick cec3f35
```

Cherry-pick had one conflict because `Matrix_Network_Drive_Connectivity.md` was deleted on remote `main` but modified in the local commit. The file was kept and staged.

```powershell
git add Matrix_Network_Drive_Connectivity.md
git cherry-pick --continue
```

## Push to GitHub

Run from the dev machine:

```powershell
cd "C:\Users\unius\Documents\code workout\UNI_CRM"
git status
git push origin main
```

## Pull on Tower server

Recommended if the update script exists:

```powershell
powershell -ExecutionPolicy Bypass -File C:\update-unicomm.ps1
```

Manual deployment commands:

```powershell
cd C:\UniComm\Unicircuit_UniComm-main
git stash
git pull origin main
cd backend
npm install
pm2 restart unicomm
pm2 status
```

## Backup branch

Old local `main` state was saved here:

```powershell
backup-local-main-before-sync
```
