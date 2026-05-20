const express = require('express');
const router = express.Router();

const fs = require('fs');
const path = require('path');

const BACKUP_DIR = path.join(__dirname, '../outlook_backups');

if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/*
==================================================
GET BACKUPS
==================================================
*/

router.get('/', async (req, res) => {

    try {

        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.endsWith('.json'))
            .map(file => {

                const full = path.join(BACKUP_DIR, file);
                const stat = fs.statSync(full);

                return {
                    name: file,
                    size: `${(stat.size / 1024).toFixed(1)} KB`,
                    created: stat.birthtime
                };

            })
            .sort((a, b) => new Date(b.created) - new Date(a.created));

        res.json({
            success: true,
            files
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: err.message
        });

    }

});

/*
==================================================
CREATE BACKUP
==================================================
*/

router.post('/create', async (req, res) => {

    try {

        const contacts = req.body.contacts || [];

        const filename =
            `outlook_backup_${new Date()
                .toISOString()
                .replace(/[:.]/g, '-')}.json`;

        const filepath = path.join(BACKUP_DIR, filename);

        fs.writeFileSync(
            filepath,
            JSON.stringify(contacts, null, 2)
        );

        const stat = fs.statSync(filepath);

        res.json({
            success: true,
            file: filename,
            size: stat.size
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: err.message
        });

    }

});

/*
==================================================
DELETE BACKUP
==================================================
*/

router.post('/delete', async (req, res) => {

    try {

        const file = req.body.file;

        if (!file) {
            return res.status(400).json({
                error: 'Missing file'
            });
        }

        const filepath = path.join(BACKUP_DIR, file);

        if (!fs.existsSync(filepath)) {
            return res.status(404).json({
                error: 'Backup not found'
            });
        }

        fs.unlinkSync(filepath);

        res.json({
            success: true
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: err.message
        });

    }

});

/*
==================================================
RESTORE BACKUP
==================================================
*/

router.post('/restore', async (req, res) => {

    try {

        const file = req.body.file;

        if (!file) {
            return res.status(400).json({
                error: 'Missing file'
            });
        }

        const filepath = path.join(BACKUP_DIR, file);

        if (!fs.existsSync(filepath)) {
            return res.status(404).json({
                error: 'Backup not found'
            });
        }

        const raw = fs.readFileSync(filepath, 'utf8');

        const contacts = JSON.parse(raw) || [];

        global.outlookContactsCache = contacts;

        if (req.session) {
            req.session.outlookContacts = contacts;
        }

        res.json({
            success: true,
            restored: contacts.length
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: err.message
        });

    }

});

/*
==================================================
DOWNLOAD BACKUP
==================================================
*/

router.get('/download/:file', (req, res) => {

    const file = req.params.file;
    const filepath = path.join(BACKUP_DIR, file);

    if (!fs.existsSync(filepath)) {
        return res.status(404).json({
            error: 'Backup not found'
        });
    }

    res.download(filepath);
});

router.get('/preview/:file', (req, res) => {

    try {

        const filePath = path.join(
            BACKUP_DIR,
            req.params.file
        );

        if (!fs.existsSync(filePath)) {

            return res.status(404).json({
                error: 'Backup not found'
            });
        }

        const raw = fs.readFileSync(filePath, 'utf8');

        const contacts = JSON.parse(raw) || [];

        res.json({
            success: true,
            contacts
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: err.message
        });
    }
});

module.exports = router;