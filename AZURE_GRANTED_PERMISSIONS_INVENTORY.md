# Azure Granted Permissions Inventory

Snapshot date: 2026-05-08  
Tenant/consent status shown by user: Granted for Unicircuit Engineering Services LLP  
API: Microsoft Graph

This file is the source-of-truth note for permissions already granted in Azure. The list intentionally includes both Delegated and Application permissions because UniComm uses both user-authenticated Graph flows and backend/client-credentials Graph calls.

## Contact Fetch Confidence

For Outlook contact/directory fetch, the relevant granted permissions are present:

| Permission | Type | Why it matters |
|---|---|---|
| `Contacts.Read` | Delegated | Read signed-in user's contacts |
| `Contacts.Read` | Application | Read contacts in all mailboxes |
| `Contacts.Read.Shared` | Delegated | Read shared contacts visible to the signed-in user |
| `Contacts.ReadWrite` | Delegated | Read/write signed-in user's contacts |
| `Contacts.ReadWrite` | Application | Read/write contacts in all mailboxes |
| `Contacts.ReadWrite.Shared` | Delegated | Read/write shared contacts |
| `OrgContact.Read.All` | Delegated | Read organizational contacts |
| `OrgContact.Read.All` | Application | Read organizational contacts without user login |
| `People.Read` | Delegated | Read signed-in user's relevant people list |
| `People.Read.All` | Delegated | Read all users' relevant people lists as signed-in user |
| `People.Read.All` | Application | Read all users' relevant people lists without user login |
| `offline_access` | Delegated | Keep delegated Graph token refreshable |

Conclusion: from the Azure permission inventory alone, contact fetch is not blocked by missing Graph permissions. If contacts still fail, check the runtime token (`scp`/`roles`), reconnect Outlook after consent changes, `MS_USER_EMAIL`, tenant/client IDs, Graph endpoint response, mailbox visibility, and any Exchange application access policy.

## Granted Permission List

| Permission | Type | Admin consent required | Status |
|---|---|---|---|
| `AccessReview.Read.All` | Delegated | Yes | Granted |
| `AccessReview.ReadWrite.All` | Delegated | Yes | Granted |
| `AccessReview.ReadWrite.Membership` | Delegated | Yes | Granted |
| `Acronym.Read.All` | Delegated | No | Granted |
| `AdministrativeUnit.Read.All` | Delegated | Yes | Granted |
| `AdministrativeUnit.ReadWrite.All` | Delegated | Yes | Granted |
| `AgentCardManifest.Read.All` | Delegated | Yes | Granted |
| `AgentCardManifest.ReadWrite.All` | Delegated | Yes | Granted |
| `AgentCollection.Read.All` | Delegated | Yes | Granted |
| `AgentCollection.Read.Global` | Delegated | Yes | Granted |
| `AgentCollection.Read.Quarantined` | Delegated | Yes | Granted |
| `AgentCollection.ReadWrite.All` | Delegated | Yes | Granted |
| `AgentCollection.ReadWrite.Global` | Delegated | Yes | Granted |
| `AgentCollection.ReadWrite.Quarantined` | Delegated | Yes | Granted |
| `AgentIdentity.DeleteRestore.All` | Delegated | Yes | Granted |
| `AgentIdentity.EnableDisable.All` | Delegated | Yes | Granted |
| `AgentIdentity.Read.All` | Delegated | Yes | Granted |
| `AgentIdentity.ReadWrite.All` | Delegated | Yes | Granted |
| `AgentIdentityBlueprint.AddRemoveCreds.All` | Delegated | Yes | Granted |
| `AgentIdentityBlueprint.Create` | Delegated | Yes | Granted |
| `AgentIdentityBlueprint.DeleteRestore.All` | Delegated | Yes | Granted |
| `AgentIdentityBlueprint.Read.All` | Delegated | Yes | Granted |
| `AgentIdentityBlueprint.ReadWrite.All` | Delegated | Yes | Granted |
| `AgentIdentityBlueprint.UpdateAuthProperties.All` | Delegated | Yes | Granted |
| `AgentIdentityBlueprint.UpdateBranding.All` | Delegated | Yes | Granted |
| `AgentIdentityBlueprintPrincipal.Create` | Delegated | Yes | Granted |
| `AgentIdentityBlueprintPrincipal.DeleteRestore.All` | Delegated | Yes | Granted |
| `AgentIdentityBlueprintPrincipal.EnableDisable.All` | Delegated | Yes | Granted |
| `AgentIdentityBlueprintPrincipal.Read.All` | Delegated | Yes | Granted |
| `AgentIdentityBlueprintPrincipal.ReadWrite.All` | Delegated | Yes | Granted |
| `AgentIdUser.ReadWrite.All` | Delegated | Yes | Granted |
| `AgentIdUser.ReadWrite.IdentityParentedBy` | Delegated | Yes | Granted |
| `Analytics.Read` | Delegated | No | Granted |
| `APIConnectors.Read.All` | Delegated | Yes | Granted |
| `APIConnectors.ReadWrite.All` | Delegated | Yes | Granted |
| `Application.Read.All` | Delegated | Yes | Granted |
| `Application.ReadUpdate.All` | Delegated | Yes | Granted |
| `Application.ReadWrite.All` | Delegated | Yes | Granted |
| `Contacts-OnPremisesSyncBehavior.ReadWrite.All` | Delegated | Yes | Granted |
| `Contacts.Read` | Delegated | No | Granted |
| `Contacts.Read` | Application | Yes | Granted |
| `Contacts.Read.Shared` | Delegated | No | Granted |
| `Contacts.ReadWrite` | Delegated | No | Granted |
| `Contacts.ReadWrite` | Application | Yes | Granted |
| `Contacts.ReadWrite.Shared` | Delegated | No | Granted |
| `email` | Delegated | No | Granted |
| `Mail.Read` | Delegated | No | Granted |
| `Mail.Read` | Application | Yes | Granted |
| `Mail.Read.Shared` | Delegated | No | Granted |
| `Mail.ReadBasic` | Delegated | No | Granted |
| `Mail.ReadBasic.Shared` | Delegated | No | Granted |
| `Mail.ReadWrite` | Delegated | No | Granted |
| `Mail.ReadWrite` | Application | Yes | Granted |
| `Mail.ReadWrite.Shared` | Delegated | No | Granted |
| `Mail.Send` | Delegated | No | Granted |
| `Mail.Send` | Application | Yes | Granted |
| `MailboxSettings.Read` | Application | Yes | Granted |
| `MailboxSettings.ReadWrite` | Delegated | No | Granted |
| `MailboxSettings.ReadWrite` | Application | Yes | Granted |
| `offline_access` | Delegated | No | Granted |
| `openid` | Delegated | No | Granted |
| `OrgContact.Read.All` | Delegated | Yes | Granted |
| `OrgContact.Read.All` | Application | Yes | Granted |
| `People.Read` | Delegated | No | Granted |
| `People.Read.All` | Delegated | Yes | Granted |
| `People.Read.All` | Application | Yes | Granted |
| `profile` | Delegated | No | Granted |
| `Reports.Read.All` | Application | Yes | Granted |
| `User-Mail.ReadWrite.All` | Delegated | Yes | Granted |
| `User.Read` | Delegated | No | Granted |
| `UserAuthMethod-Email.Read` | Delegated | Yes | Granted |
| `UserAuthMethod-Email.Read.All` | Delegated | Yes | Granted |
| `UserAuthMethod-Email.ReadWrite` | Delegated | Yes | Granted |
| `UserAuthMethod-Email.ReadWrite.All` | Delegated | Yes | Granted |

## Runtime Verification Rule

Do not infer runtime access only from the Azure portal list. For any Graph bug, verify the token used by the code:

- Delegated token must show needed permissions in the JWT `scp` claim.
- Application/client-credentials token must show needed permissions in the JWT `roles` claim.
- After adding or changing delegated permissions, reconnect Outlook so the stored refresh/access token can carry the new scopes.
- After adding or changing application permissions, restart/retry backend client-credentials flow so a fresh app token carries the new roles.
