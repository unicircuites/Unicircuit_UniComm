'use strict';

const pool = require('../db/pool');
const wa = require('./whatsapp');
const {
  mergeWaDeliveries,
  tallyDeliveries,
  finalBroadcastStatus,
  acquireWaBroadcastJob,
  releaseWaBroadcastJob,
} = require('./broadcastHelpers');

async function fetchImageBuffer(imageUrl) {
  if (!imageUrl) return { imageBuf: null, imageMime: 'image/jpeg' };
  try {
    const https = require('https');
    const http = require('http');
    const proto = imageUrl.startsWith('https') ? https : http;
    return await new Promise((resolve, reject) => {
      proto.get(imageUrl, (res) => {
        const imageMime = res.headers['content-type'] || 'image/jpeg';
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ imageBuf: Buffer.concat(chunks), imageMime }));
        res.on('error', reject);
      }).on('error', reject);
    });
  } catch (e) {
    console.warn('[WA Broadcast] Could not fetch image URL:', e.message);
    return { imageBuf: null, imageMime: 'image/jpeg' };
  }
}

function prepareFileAttachments(files) {
  return (Array.isArray(files) ? files : []).slice(0, 10).map((att) => {
    const buffer = Buffer.from(String(att.contentBytes || att.data || '').replace(/^data:[^,]+,/, ''), 'base64');
    if (!buffer.length) return null;
    const mime = att.contentType || att.mimeType || 'application/octet-stream';
    const mediaType = String(att.mediaType || '').toLowerCase()
      || (String(mime).startsWith('image/') ? 'image'
        : String(mime).startsWith('video/') ? 'video'
          : 'document');
    return {
      buffer,
      filename: att.name || att.fileName || 'broadcast-attachment',
      mimetype: mime,
      mediaType,
    };
  }).filter(Boolean);
}

function applyVarFields(tmpl, recipientName, varFields) {
  let out = String(tmpl || '');
  for (const f of varFields || []) {
    const key = String(f.key || '').trim();
    if (!key) continue;
    const val = f.source === 'recipient'
      ? (recipientName || '')
      : String(f.value || '').trim();
    out = out.replace(new RegExp('\\{\\{' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\}\\}', 'g'), val);
  }
  return out;
}

async function runWaBroadcastJob({
  histId,
  targets,
  text,
  files,
  imageUrl,
  varFields,
  delay,
  baseDeliveries,
  total,
}) {
  if (!acquireWaBroadcastJob(histId)) {
    throw new Error('WhatsApp broadcast is already running');
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waSendTimeoutMs = Math.max(15000, parseInt(process.env.WA_BROADCAST_SEND_TIMEOUT_MS || '90000', 10) || 90000);
  const withWaSendTimeout = (promise, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`${label} timed out after ${waSendTimeoutMs}ms`)),
      waSendTimeoutMs
    )),
  ]);

  const { imageBuf, imageMime } = await fetchImageBuffer(imageUrl);
  const preparedFileAttachments = prepareFileAttachments(files);
  const batchDeliveries = [];
  let lastSnapshotAt = 0;
  const snapshotEvery = Math.max(1, parseInt(process.env.BROADCAST_DELIVERY_SNAPSHOT_EVERY || '10', 10) || 10);

  const persistProgress = async (forceStatus) => {
    const merged = mergeWaDeliveries(baseDeliveries, batchDeliveries);
    const stats = tallyDeliveries(merged);
    const status = forceStatus || finalBroadcastStatus(merged, total);
    await pool.query(
      `UPDATE wa_broadcast_history SET sent=$1, failed=$2, status=$3, deliveries=$4 WHERE id=$5`,
      [stats.sent, stats.failed, status, JSON.stringify(merged), histId]
    );
    return { merged, stats, status };
  };

  try {
    await pool.query(`UPDATE wa_broadcast_history SET status='sending' WHERE id=$1`, [histId]);

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const msg = applyVarFields(text, target.name, varFields);
      const sentAt = new Date().toISOString();
      try {
        if (imageBuf) {
          await withWaSendTimeout(wa.sendMediaMessage(target.jid, {
            buffer: imageBuf,
            filename: 'image.jpg',
            mimetype: imageMime,
            mediaType: 'image',
            caption: msg,
          }, null), `Media send to ${target.jid}`);
          if (preparedFileAttachments.length) await wait(800);
        }
        if (preparedFileAttachments.length) {
          for (let f = 0; f < preparedFileAttachments.length; f++) {
            const att = preparedFileAttachments[f];
            await withWaSendTimeout(wa.sendMediaMessage(target.jid, {
              buffer: att.buffer,
              filename: att.filename,
              mimetype: att.mimetype,
              mediaType: att.mediaType,
              caption: f === 0 && !imageBuf ? msg : '',
            }, null), `Attachment send to ${target.jid}`);
            if (f < preparedFileAttachments.length - 1) await wait(800);
          }
        } else if (!imageBuf) {
          await withWaSendTimeout(wa.sendMessage(target.jid, msg, null), `Message send to ${target.jid}`);
        }
        batchDeliveries.push({ jid: target.jid, name: target.name || '', status: 'sent', sent_at: sentAt });
      } catch (err) {
        batchDeliveries.push({
          jid: target.jid,
          name: target.name || '',
          status: 'failed',
          error: err.message,
          sent_at: sentAt,
        });
        console.error(`[WA Broadcast] Failed for ${target.jid}:`, err.message);
      }

      if (i < targets.length - 1) await wait(delay);

      const merged = mergeWaDeliveries(baseDeliveries, batchDeliveries);
      const done = tallyDeliveries(merged).sent + tallyDeliveries(merged).failed;
      if (done - lastSnapshotAt >= snapshotEvery || i === targets.length - 1) {
        lastSnapshotAt = done;
        pool.query(
          `UPDATE wa_broadcast_history SET sent=$1, failed=$2, deliveries=$3 WHERE id=$4`,
          [tallyDeliveries(merged).sent, tallyDeliveries(merged).failed, JSON.stringify(merged), histId]
        ).catch((e) => console.error('[WA Broadcast] progress update:', e.message));
      }
    }

    const final = await persistProgress(finalBroadcastStatus(mergeWaDeliveries(baseDeliveries, batchDeliveries), total));
    console.log(`[WA Broadcast #${histId}] Done - sent:${final.stats.sent} failed:${final.stats.failed}`);
    return final;
  } catch (err) {
    console.error('[WA Broadcast] Worker error:', err.message);
    await persistProgress('partial').catch(() => {});
    throw err;
  } finally {
    releaseWaBroadcastJob(histId);
  }
}

module.exports = {
  runWaBroadcastJob,
  fetchImageBuffer,
  prepareFileAttachments,
  applyVarFields,
};
