require('./backend/node_modules/dotenv').config({ path: './backend/.env' });
const pool = require('./backend/db/pool');
const msGraph = require('./backend/services/msGraph');

async function fixRetroactive() {
  console.log('Starting retroactive fix for old leads...');
  const msEmail = process.env.MS_USER_EMAIL;
  if (!msEmail) {
    console.error('No MS Auth email found in process.env.MS_USER_EMAIL!');
    process.exit(1);
  }

  const { rows: leads } = await pool.query("SELECT id, notes, contact_tags FROM leads WHERE platform = 'outlook'");
  console.log(`Found ${leads.length} outlook leads.`);

  let fixedCount = 0;

  for (const lead of leads) {
    if (!lead.notes || !lead.contact_tags) continue;
    
    // Check if it already has HTML (startsWith <html, etc.)
    const actualNotes = lead.notes.split('\n---\n')[0];
    const snippet = lead.notes.split('\n---\n').slice(1).join('\n---\n');
    
    const isHtml = (str) => {
      const s = str.trim().toLowerCase();
      return s.startsWith('<html') || s.startsWith('<!doctype html>') || s.startsWith('<div');
    };

    if (isHtml(snippet) || isHtml(actualNotes)) {
      continue; // Already has HTML, skip
    }

    // Find the msg id tag
    const msgTag = lead.contact_tags.find(t => t.startsWith('msg:'));
    if (!msgTag) continue;

    const msgId = msgTag.replace('msg:', '');
    
    console.log(`Fetching full HTML for lead ${lead.id} (msg: ${msgId})...`);
    try {
      const data = await msGraph.graphGet(
        `/me/messages/${encodeURIComponent(msgId)}?$select=body,subject,from,receivedDateTime`,
        msEmail
      );
      
      const fullBody = data.body && data.body.content ? data.body.content : '';
      
      if (fullBody && isHtml(fullBody)) {
        // Reconstruct notes
        const headerPart = actualNotes;
        const newNotes = `${headerPart}\n---\n${fullBody}`;
        
        await pool.query('UPDATE leads SET notes = $1 WHERE id = $2', [newNotes, lead.id]);
        console.log(`Fixed lead ${lead.id}!`);
        fixedCount++;
      } else {
        console.log(`Lead ${lead.id} fetched body is not HTML or empty, skipping.`);
      }
    } catch (e) {
      console.error(`Failed to fetch/update lead ${lead.id}: ${e.message}`);
    }
  }

  console.log(`Finished! Retroactively fixed ${fixedCount} leads.`);
  process.exit(0);
}

fixRetroactive();
