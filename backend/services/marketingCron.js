/**
 * Marketing Cron Service
 * Fires daily at 6:00 PM IST → sends Socket.IO reminder to dashboard
 */
const cron = require('node-cron');

let io = null;

function start(socketIO) {
  io = socketIO;

  // Every day at 18:00 (6 PM) — cron: minute hour * * *
  cron.schedule('0 18 * * *', () => {
    console.log('[Marketing] 6 PM reminder — sending sync notification');
    if (io) {
      io.emit('marketing:sync_reminder', {
        time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        message: 'Time to update Marketing stats from EngageBay',
      });
    }
  }, {
    timezone: 'Asia/Kolkata',
  });

  console.log('[Marketing] Cron scheduled — daily 6 PM IST reminder');
}

module.exports = { start };
