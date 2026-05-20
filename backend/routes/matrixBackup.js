const express = require('express');
const axios = require('axios');
const https = require('https');

const router = express.Router();

const MATRIX_BASE_URL = 'https://192.168.0.81:1026';

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

router.post('/create', async (req, res) => {

    try {

        console.log('[MATRIX] Starting native UCS backup...');

        // =========================
        // STEP 1: OPEN BACKUP PAGE
        // =========================

        const pageResponse = await axios.get(
            `${MATRIX_BASE_URL}/MailboxBackup.html?BackupType=Manual`,
            {
                httpsAgent,
                withCredentials: true
            }
        );

        const cookies = pageResponse.headers['set-cookie'];

        console.log('[MATRIX] Backup page opened');

        // =========================
        // STEP 2: CREATE FORM DATA
        // =========================

        const formData = new URLSearchParams();

        formData.append('SUBMIT_BUTTON1', 'BackupBtnPressed');
        formData.append('SUBMIT_BUTTON', 'Submit');
        formData.append('DfltButtonPressed', 'false');
        formData.append('ListBoxVal', '');

        // 1 = ALL MAILBOX BACKUP
        formData.append('BCKUP_MAILBOX_COMBO', '1');

        // delete after backup = OFF
        // checkbox intentionally omitted

        console.log('[MATRIX] Sending native backup trigger...');

        // =========================
        // STEP 3: TRIGGER BACKUP
        // =========================

        const backupResponse = await axios.post(
            `${MATRIX_BASE_URL}/MailboxBackup.html?BackupType=Manual`,
            formData,
            {
                httpsAgent,

                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': cookies ? cookies.join('; ') : ''
                },

                maxRedirects: 5
            }
        );

        console.log('[MATRIX] Native UCS backup triggered');

        // =========================
        // SUCCESS
        // =========================

        return res.json({
            success: true,
            message: 'Native Matrix UCS backup triggered successfully'
        });

    } catch (err) {

        console.error('[MATRIX BACKUP ERROR]', err.message);

        return res.status(500).json({
            success: false,
            error: err.message
        });

    }

});

module.exports = router;