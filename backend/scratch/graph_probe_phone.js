require('dotenv').config();

const graph = require('../services/msGraph');
const fetch = require('node-fetch');

const mailbox = process.env.MS_USER_EMAIL;
const targetEmail = 'shaikkareem09368@gmail.com';
const targetName = 'Abdul Kareem';

function decodeJwtPayload(token) {
  try {
    const payload = String(token || '').split('.')[1];
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - payload.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return {};
  }
}

function summarizeToken(token) {
  const claims = decodeJwtPayload(token);
  return {
    tokenType: claims.scp ? 'delegated' : (claims.roles ? 'application' : 'unknown'),
    scp: claims.scp || '',
    roles: claims.roles || [],
    upn: claims.upn || claims.preferred_username || '',
    appid: claims.appid || claims.azp || '',
    tid: claims.tid || '',
    exp: claims.exp ? new Date(claims.exp * 1000).toISOString() : '',
  };
}

async function getJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { raw: text.slice(0, 500) };
  }
  return { status: res.status, ok: res.ok, data };
}

async function pageFind(label, firstUrl, token, predicate, maxPages = 20) {
  let url = firstUrl;
  let count = 0;
  let pages = 0;
  const matches = [];
  while (url && pages < maxPages) {
    const result = await getJson(url, token);
    if (!result.ok) {
      console.log(`\n${label} FAILED`);
      console.dir({ status: result.status, error: result.data }, { depth: 8 });
      return { count, pages, matches, failed: result };
    }
    const values = result.data.value || [];
    count += values.length;
    for (const item of values) {
      if (predicate(item)) matches.push(item);
    }
    url = result.data['@odata.nextLink'] || null;
    pages++;
  }
  console.log(`\n${label}`);
  console.dir({ count, pages, matches }, { depth: 10 });
  return { count, pages, matches };
}

function hasTarget(item) {
  const text = JSON.stringify(item || {}).toLowerCase();
  return text.includes(targetEmail.toLowerCase()) || text.includes(targetName.toLowerCase());
}

async function main() {
  const contactsToken = await graph.getAccessToken(mailbox);
  console.log('DEFAULT TOKEN SUMMARY');
  console.dir(summarizeToken(contactsToken), { depth: 5 });

  const graphRoot = 'https://graph.microsoft.com/v1.0';
  const base = `${graphRoot}/users/${encodeURIComponent(mailbox)}`;
  const contactSelect = 'id,displayName,givenName,surname,emailAddresses,businessPhones,mobilePhone,homePhones,companyName,jobTitle';

  await pageFind(
    'TEST 1: /users/{mailbox}/contacts',
    `${base}/contacts?$top=500&$select=${encodeURIComponent(contactSelect)}`,
    contactsToken,
    hasTarget,
    20
  );

  const folders = await getJson(`${base}/contactFolders?$top=100&$select=id,displayName`, contactsToken);
  console.log('\nTEST 2: contactFolders');
  console.dir({ status: folders.status, folders: (folders.data.value || []).map(f => f.displayName) }, { depth: 5 });
  if (folders.ok) {
    for (const folder of folders.data.value || []) {
      await pageFind(
        `TEST 2 folder: ${folder.displayName}`,
        `${base}/contactFolders/${encodeURIComponent(folder.id)}/contacts?$top=500&$select=${encodeURIComponent(contactSelect)}`,
        contactsToken,
        hasTarget,
        10
      );
    }
  }

  await pageFind(
    'TEST 3: tenant org contacts /contacts',
    `${graphRoot}/contacts?$top=999&$select=${encodeURIComponent('id,displayName,mail,proxyAddresses,phones,addresses,companyName')}`,
    contactsToken,
    hasTarget,
    5
  );

  const userDirectory = await getJson(
    `${graphRoot}/users?$top=25&$filter=${encodeURIComponent(`mail eq '${targetEmail}'`)}&$select=${encodeURIComponent('id,displayName,mail,userPrincipalName,mobilePhone,businessPhones')}`,
    contactsToken
  );
  console.log('\nTEST 4: users directory by mail');
  console.dir(userDirectory, { depth: 10 });

  const peopleScopes = [
    'https://graph.microsoft.com/People.Read',
    'https://graph.microsoft.com/People.Read.All',
    'offline_access',
  ];
  const peopleToken = await graph.getAccessTokenForScopes(mailbox, peopleScopes);
  console.log('\nPEOPLE TOKEN SUMMARY');
  console.dir(peopleToken ? summarizeToken(peopleToken) : null, { depth: 5 });

  if (peopleToken) {
    const peopleSelect = 'id,displayName,givenName,surname,scoredEmailAddresses,phones,companyName,jobTitle,userPrincipalName';
    await pageFind(
      'TEST 5: /me/people',
      `${graphRoot}/me/people?$top=1000&$select=${encodeURIComponent(peopleSelect)}`,
      peopleToken,
      hasTarget,
      20
    );

    const peopleSearch = await getJson(
      `${graphRoot}/me/people?$search=${encodeURIComponent(`"${targetEmail}"`)}&$select=${encodeURIComponent(peopleSelect)}`,
      peopleToken
    );
    console.log('\nTEST 6: /me/people search');
    console.dir(peopleSearch, { depth: 10 });
  }

  const appPeopleToken = await graph.getClientCredentialsToken(true);
  console.log('\nAPP PEOPLE TOKEN SUMMARY');
  console.dir(appPeopleToken ? summarizeToken(appPeopleToken) : null, { depth: 5 });
  if (appPeopleToken) {
    const peopleSelect = 'id,displayName,givenName,surname,scoredEmailAddresses,phones,companyName,jobTitle,userPrincipalName';
    await pageFind(
      'TEST 7: /users/{mailbox}/people with application token',
      `${graphRoot}/users/${encodeURIComponent(mailbox)}/people?$top=1000&$select=${encodeURIComponent(peopleSelect)}`,
      appPeopleToken,
      hasTarget,
      20
    );

    const searchBody = {
      requests: [
        {
          entityTypes: ['person'],
          query: { queryString: targetEmail },
          from: 0,
          size: 25,
          fields: ['displayName', 'emailAddresses', 'phones', 'givenName', 'surname', 'companyName', 'jobTitle'],
          contentSources: ['/Exchange'],
        },
      ],
    };
    const searchRes = await fetch(`${graphRoot.replace('/v1.0', '/beta')}/search/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appPeopleToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(searchBody),
    });
    const searchText = await searchRes.text();
    let searchData;
    try {
      searchData = JSON.parse(searchText);
    } catch (_) {
      searchData = { raw: searchText.slice(0, 1000) };
    }
    console.log('\nTEST 8: beta /search/query person');
    console.dir({ status: searchRes.status, ok: searchRes.ok, data: searchData }, { depth: 12 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
