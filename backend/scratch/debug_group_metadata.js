const wa = require('../services/whatsapp');

async function debugGroupMetadata() {
  try {
    // Wait for WhatsApp connection
    let attempts = 0;
    while (!wa.getStatus().connected && attempts < 30) {
      console.log('Waiting for WhatsApp connection...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }
    
    if (!wa.getStatus().connected) {
      console.log('WhatsApp not connected after 30 seconds');
      process.exit(1);
      return;
    }
    
    // Test with the group from your screenshot
    const testGroupJid = '919359475770-1636091956@g.us';
    
    console.log(`\nFetching metadata for: ${testGroupJid}`);
    const meta = await wa.getGroupMetadata(testGroupJid);
    
    console.log('\n=== GROUP METADATA ===');
    console.log('Group ID:', meta.id);
    console.log('Group Name:', meta.name);
    console.log('Participants:', meta.participants.length);
    
    console.log('\n=== FIRST 5 PARTICIPANTS (DETAILED) ===');
    meta.participants.slice(0, 5).forEach((p, i) => {
      console.log(`\nParticipant ${i + 1}:`);
      console.log('  Full object:', JSON.stringify(p, null, 2));
    });
    
    console.log('\n=== LID PARTICIPANTS WITH PHONE ===');
    const lidWithPhone = meta.participants.filter(p => p.jid && p.jid.endsWith('@lid') && p.phone);
    console.log(`Found ${lidWithPhone.length} LID participants with phone numbers`);
    
    lidWithPhone.slice(0, 5).forEach((p, i) => {
      console.log(`\n${i + 1}. ${p.jid}`);
      console.log('   Name:', p.name);
      console.log('   Phone:', p.phone);
      console.log('   Admin:', p.admin);
    });
    
    console.log('\n=== LID PARTICIPANTS WITHOUT PHONE ===');
    const lidWithoutPhone = meta.participants.filter(p => p.jid && p.jid.endsWith('@lid') && !p.phone);
    console.log(`Found ${lidWithoutPhone.length} LID participants WITHOUT phone numbers`);
    
    lidWithoutPhone.slice(0, 5).forEach((p, i) => {
      console.log(`\n${i + 1}. ${p.jid}`);
      console.log('   Name:', p.name);
      console.log('   Phone:', p.phone);
      console.log('   Full object:', JSON.stringify(p, null, 2));
    });
    
  } catch (err) {
    console.error('Error:', err.message);
    console.error('Stack:', err.stack);
  } finally {
    process.exit();
  }
}

debugGroupMetadata();
