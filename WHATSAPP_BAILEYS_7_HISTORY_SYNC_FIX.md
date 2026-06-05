# WhatsApp Baileys 7 Sync Fixes

## Problem
In Baileys 7, `sock.chats` was removed, and setting `syncFullHistory: false` disabled the entire `messaging-history.set` event that usually populates initial chats and messages. As a result, after scanning the QR code, the WhatsApp account would connect but 0 chats would be loaded into the database, leaving the UI empty.

## Root Causes
1. **History Sync Disabled**: `syncFullHistory: false` combined with Baileys 7 defaults caused `shouldSyncHistoryMessage` to return `false`, skipping all initial history and app-state chat loading.
2. **Removed `sock.chats`**: The `resyncDirectoryFromSocket()` function attempted to read `sock.chats` which is undefined in Baileys 7, causing manual syncs to see 0 chats.
3. **No UI Refresh**: Because `messaging-history.set` was skipped, the `wa:sync_complete` event was never fired on first connect.

## The Fixes Applied
1. **Force History Sync**: Added `shouldSyncHistoryMessage: () => true` to the `makeWASocket` config to force Baileys to process history on QR connect, even if `syncFullHistory` is false.
2. **App-State Resync**: Added `sock.resyncAppState(ALL_WA_PATCH_NAMES, false)` to explicitly reload the chat/contact directory when the DB is empty.
3. **Event Updates**: Modified `chats.upsert` to always emit `wa:sync_complete` so the UI refreshes after app-state sync.
4. **Phone Resolution**: Ensured DB queries are scoped to the real linked phone (from `creds.me.id`) rather than LID user IDs.
5. **Memory Store**: Switched to using a `liveChatsStore` map populated by socket events instead of the removed `sock.chats` property.

> **CRITICAL REMINDER FOR FUTURE AGENTS**: Never rely on `sock.chats` in Baileys v7+. Always ensure `shouldSyncHistoryMessage` returns `true` if you need the initial chat list, otherwise Baileys will quietly drop all history sync data upon connection.
