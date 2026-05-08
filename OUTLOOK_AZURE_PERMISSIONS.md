# Outlook Azure Permissions

Use this checklist when UniComm Pro is connected to Outlook/Microsoft 365, or when the mailbox is changed to a different account.

## Required Microsoft Graph Permissions

Add these under **Azure Portal > App registrations > UniComm app > API permissions > Microsoft Graph**.

### Delegated Permissions

These are used when a user signs in through the Outlook OAuth flow.

| Permission | Used for |
|---|---|
| `Mail.ReadWrite` | Read inbox/sent/drafts, open message body and attachments, mark read, move, delete, categorize |
| `Mail.Send` | Send new emails, replies, reply-all, forwards |
| `Contacts.ReadWrite` | Read, import, create, and update Outlook People contacts |
| `MailboxSettings.ReadWrite` | Automatic replies, mailbox settings, categories/settings |
| `offline_access` | Keep Outlook connected with refresh tokens |

`Mail.Read` is not required separately when `Mail.ReadWrite` is already granted.

### Application Permissions

These are used by the backend when it runs server-side/background Microsoft Graph calls.

| Permission | Used for |
|---|---|
| `Mail.ReadWrite` | Server/background mailbox read/write access |
| `Mail.Send` | Server/background send mail access |
| `Contacts.ReadWrite` | Server/background contacts access |
| `MailboxSettings.ReadWrite` | Server/background mailbox settings access |
| `Reports.Read.All` | Exact mailbox storage report: used GB, quota GB, deleted item size |

After adding permissions, click **Grant admin consent**.

## Changing To A Different Outlook Account

When signing in with a different mailbox/account:

1. Confirm the new account is in the same Microsoft Entra tenant as `MS_TENANT_ID`.
2. Update `backend/.env`:

```env
MS_USER_EMAIL=new-mailbox@example.com
```

3. Restart the backend server.
4. In the app, connect/re-authenticate Outlook again so delegated scopes are issued for the new account.
5. Confirm the Azure app still has all permissions listed above.
6. Confirm **admin consent** is granted after any permission change.

If the new mailbox is in a different tenant, create or configure an app registration in that tenant and update:

```env
MS_TENANT_ID=
MS_CLIENT_ID=
MS_CLIENT_SECRET=
MS_REDIRECT_URI=
MS_USER_EMAIL=
```

## Storage Tab Notes

The Outlook-style storage screen needs `Reports.Read.All` Application permission for exact quota data like:

```text
0.03 GB used of 49.50 GB
```

Without `Reports.Read.All`, the app can still show mailbox folder counts, but exact used/quota storage may not be available.

## Security Note

Application permissions can allow tenant-wide mailbox access. In production, restrict the app to only the required mailbox using an Exchange Application Access Policy.
