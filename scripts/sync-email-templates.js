/**
 * Sync seed templates and report email_templates rows.
 */
const path = require('path');
process.chdir(path.join(__dirname, '../backend'));
require('dotenv').config();
const pool = require('./db/pool');
const { seedEmailTemplates } = require('../backend/data/emailTemplateStorage');

async function seedDefaultTemplates() {
  for (const tpl of seedEmailTemplates) {
    await pool.query(
      `INSERT INTO email_templates (slug, name, subject, html_body, category, variable_fields, banner_config)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
       ON CONFLICT (slug) WHERE slug IS NOT NULL DO UPDATE SET
         name = EXCLUDED.name,
         subject = EXCLUDED.subject,
         html_body = EXCLUDED.html_body,
         category = EXCLUDED.category,
         variable_fields = EXCLUDED.variable_fields,
         banner_config = EXCLUDED.banner_config,
         updated_at = NOW()`,
      [
        tpl.slug,
        tpl.name,
        tpl.subject || '',
        tpl.html_body,
        tpl.category || 'General',
        JSON.stringify(tpl.variable_fields || []),
        tpl.banner_config ? JSON.stringify(tpl.banner_config) : null
      ]
    );
  }
}

async function pruneOrphanDuplicates() {
  const seedSlugs = seedEmailTemplates.map((t) => t.slug);
  const seedSubjects = seedEmailTemplates.map((t) => (t.subject || '').trim().toLowerCase());

  const orphans = await pool.query(
    `SELECT id, name, subject FROM email_templates WHERE slug IS NULL ORDER BY id`
  );

  for (const row of orphans.rows) {
    const subj = (row.subject || '').trim().toLowerCase();
    const matchesSeedSubject = seedSubjects.includes(subj);
    const looksLikeSeedName = /introduction|protection template/i.test(row.name || '');
    if (matchesSeedSubject || looksLikeSeedName) {
      await pool.query(`DELETE FROM email_templates WHERE id = $1`, [row.id]);
      console.log('Removed orphan duplicate:', row.id, row.name);
    }
  }

  return seedSlugs;
}

async function main() {
  await seedDefaultTemplates();
  await pruneOrphanDuplicates();

  const r = await pool.query(
    `SELECT id, slug, name FROM email_templates ORDER BY slug NULLS LAST, id`
  );
  console.log('Total:', r.rows.length);
  r.rows.forEach((x) => console.log(x.id, x.slug || '(custom)', '|', x.name));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
