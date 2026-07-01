require('path'); require('./backend/node_modules/dotenv').config({path:'./backend/.env'});
const jwt = require('./backend/node_modules/jsonwebtoken');
const axios = require('./backend/node_modules/axios');

async function testApi() {
  try {
    const token = jwt.sign({ id: 1, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const res = await axios.get('http://localhost:8088/api/calls/leads', {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('API Response HTTP Status:', res.status);
    console.log('API returned leads length:', res.data.leads ? res.data.leads.length : 'undefined');
    if (res.data.leads && res.data.leads.length === 0) {
      console.log('Array is empty!');
    }
  } catch (err) {
    if (err.response) {
      console.error('API Error Status:', err.response.status);
      console.error('API Error Data:', err.response.data);
    } else {
      console.error('Network Error:', err.message);
    }
  }
}
testApi();
