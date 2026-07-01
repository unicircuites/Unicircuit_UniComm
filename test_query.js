const pool = require('./backend/db/pool');
pool.query(`
  SELECT l.*, pc.name AS contact_name, pc.company AS contact_company 
  FROM leads l 
  LEFT JOIN pbx_contacts pc 
  ON pc.id = (
    SELECT id FROM pbx_contacts 
    WHERE phone_norm(phone) = phone_norm(l.contact_phone) 
    ORDER BY (name IS NULL), updated_at DESC NULLS LAST LIMIT 1
  ) 
  ORDER BY COALESCE(l.lead_date::timestamp + COALESCE(l.lead_time, TIME '00:00:00'), l.created_at) DESC, l.id DESC
`).then(console.log).catch(console.error).finally(()=>process.exit(0));
