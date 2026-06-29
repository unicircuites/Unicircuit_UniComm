const pool = require('./backend/db/pool');

const htmlContent = `<html><head><meta charset="UTF-8"><base target="_blank" rel="noopener noreferrer"><style>html,body{height:100%;margin:0;padding:12px;box-sizing:border-box;background:#ffffff!important;color:#1a1a1a;font-family:'Segoe UI',Outfit,sans-serif;font-size:13px;line-height:1.65;overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;word-wrap:break-word;overflow-wrap:break-word;word-break:break-word;}*{word-wrap:break-word!important;overflow-wrap:break-word!important;word-break:break-word!important;max-width:100vw!important;}pre{white-space:pre-wrap!important;}img{max-width:100%;height:auto;}a,a img,a picture{cursor:pointer;}a img{pointer-events:auto;}</style></head><body>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8"><style type="text/css">
<!--
body
	{background-color:#e4e4e4!important}
.aodemail
	{width:600px;
	margin-left:auto!important;
	margin-right:auto!important;
	margin-top:15px;
	text-align:center}
.aodemailheader
	{width:600px!important;
	margin-left:auto;
	margin-right:auto;
	text-align:center}
.aodemailcontent
	{width:570px;
	min-height:240px!important;
	background-color:#fff!important;
	padding:15px!important;
	margin-left:auto;
	margin-right:auto;
	text-align:left;
	font-size:11px!important;
	font-family:Verdana!important;
	font-weight:400;
	color:#333333!important}
.aodemailcontentinside
	{min-height:inherit;
	padding:15px!important}
.aodemailfooter
	{text-align:center;
	font:11px Verdana;
	font-weight:400;
	color:#888;
	margin-left:auto;
	margin-right:auto}
table
	{background-color:#fff;
	font-size:11px!important;
	font-family:Verdana!important;
	font-weight:400;
	color:#333333}
.aodfooterdefault
	{font-family:Verdana!important;
	font-size:11px}
.blueHeader
	{background-color:#4C5C89}
.SESI-tbl td, .SESI-tbl th
	{border:1px solid black}
.SESI-tbl
	{border-collapse:collapse}
.inlineText
	{font-weight:normal;
	font-size:12px;
	color:#767676;
	font-style:normal;
	text-align:left;
	font-family:"Arial Regular","Arial"}
-->
</style><div style="width:600px"><table class="aodemailheader" align="left" cellpadding="0" cellspacing="0"><tbody><tr><td><table border="0" cellpadding="0" cellspacing="0" style="width:100%"><tbody><tr><td class="blueHeader" style="width:100%"><img alt="ARIBA" height="25" width="200" src="https://service.ariba.com/an/p/Ariba/img_interactive_email_logo.png" border="0" style="padding:10px"> </td></tr></tbody></table><div class="aodemailcontent"><div class="aodemailcontentinside"><table align="center" cellpadding="0" cellspacing="0" width="100%"><tbody><tr><td class="aodemailcontentinside" width="100%"><table cellpadding="5" cellspacing="0" align="center"><tbody><tr><td style="margin-top:5px; font-family:Verdana!important; font-size:14px; color:#333333">Dear Sushil Malik, </td></tr><tr><td colspan="100%" style="margin-top:10px; font-family:Verdana!important; font-size:11px; color:#333333">Your password reset request to access the Ariba Commerce Cloud has been processed. To complete the password reset process, click the following link to confirm your email address and enter your new password: </td></tr><tr><td style="margin-top:10px; font-family:Verdana!important; font-size:11px; color:#336699"><a href="https://service.ariba.com/Authenticator.aw/ad/pswdReset?key=vBOwc0iK2SserR7l4Zl32bolwLZdbqLn&amp;anp=Ariba&amp;app=Supplier" target="_blank" rel="noopener noreferrer" style="cursor: pointer;">https://service.ariba.com/Authenticator.aw/ad/pswdReset?key=vBOwc0iK2SserR7l4Zl32bolwLZdbqLn&amp;anp=Ariba&amp;app=Supplier </a></td></tr><tr><td style="margin-top:10px; font-family:Verdana!important; font-size:11px; color:#333333"><b>Important: The link will expire in 24 hours. </b></td></tr><tr><td style="margin-top:10px; font-family:Verdana!important; font-size:11px; color:#333333">If this link doesn't work, please copy and paste it into your browser's address bar. </td></tr><tr><td style="margin-top:10px; font-family:Verdana!important; font-size:11px; color:#333333">You can also log in using a one-time password created in the Ariba Supplier mobile app, available now for iPhone® and iPad® on the App Store®. </td></tr><tr><td><a href="https://apps.apple.com/us/app/sap-business-network-supplier/id1604643590?ls=1&amp;mt=8" target="_blank" rel="noopener noreferrer" style="cursor: pointer;"><img border="0" width="100" height="30" alt="App Store®" src="https://service.ariba.com/an/p/Ariba/App-Store-100x30.png" style="pointer-events: auto; cursor: pointer;"></a> </td></tr></tbody></table></td></tr><tr><td class="aodemailcontentinside" width="100%"><table class="email-signature" align="center" width="100%" cellspacing="0" cellpadding="5"><tbody><tr><td class="aodfooterdefault"><div width="100%" style="margin-top:15px">Sincerely,</div><div><b>The SAP Ariba Team </b></div><div style="margin-bottom:20px"><a href="https://seller.ariba.com" style="color: rgb(136, 136, 136); cursor: pointer;" target="_blank" rel="noopener noreferrer">https://seller.ariba.com</a> </div></td></tr></tbody></table></td></tr></tbody></table></div></div><div class="aodSecondaryFooter"><table cellpadding="0" cellspacing="0" width="600" style="color:#777777; font-size:11px; font-family:Verdana; padding-left:15px; padding-right:15px; background-color:#f2f2f2"><tbody><tr><td style="margin-top:0px; font-family:Verdana!important; font-size:9px; color:#696969"><p class="trademark">Apple, the Apple logo, and iPhone are trademarks of Apple Inc., registered in the U.S. and other countries. App Store is a service mark of Apple Inc. </p></td></tr></tbody></table></div></td></tr><tr><td align="center" width="100%"><table width="100%" align="center" cellpadding="0" cellspacing="0" style="background-color:#e4e4e4; text-align:center"><tbody><tr style="background-color:#e4e4e4"><td width="100%" style="color:#888; padding-top:10px">Ariba, Inc., 3420 Hillview Ave, Bldg3, Palo Alto, CA 94304, USA </td></tr><tr style="background-color:#e4e4e4"><td width="100%" style="color:#888"><a target="_blank" href="https://www.sap.com/agreements-sap-business-network-privacy-statement" style="color: rgb(136, 136, 136); cursor: pointer;" rel="noopener noreferrer">Privacy Statement</a> | <a target="_blank" href="https://www.ariba.com/legal/ariba_data_policy.cfm" style="color: rgb(136, 136, 136); cursor: pointer;" rel="noopener noreferrer">Ariba Data Policy</a> | <a target="_blank" href="https://connect.ariba.com/help" style="color: rgb(136, 136, 136); cursor: pointer;" rel="noopener noreferrer">Ariba Help and Support</a> </td></tr><tr><td width="100%">If a customer-specific privacy statement applies to this processing of personal data, you can view it when logged into your account. </td></tr></tbody></table></td></tr></tbody></table></div><script>(function(){document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href],area[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";if(!h||/^javascript:/i.test(h)||/^#/i.test(h))return;e.preventDefault();try{window.parent.postMessage({type:"outlook-email-link",href:a.href},"*");}catch(_){}try{window.open(a.href,"_blank","noopener,noreferrer");}catch(_){}},true);})();</script></body></html>`;

async function insertTestLead() {
  const notesStr = `Source: outlook | Product: Ariba Test | Buyer: Sushil Malik | Confidence: high — manual test\n---\n${htmlContent}`;
  
  try {
    const res = await pool.query(
      `INSERT INTO leads (lead_name, subject, notes, platform, lead_date, lead_time, contact_phone, contact_tags, created_by)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, CURRENT_TIME, $5, $6, $7) RETURNING id`,
      [
        'Ariba Test Lead',
        'Password Reset - Ariba Commerce Cloud',
        notesStr,
        'outlook',
        null, // phone
        ['outlook', 'test'], // tags
        1 // created_by
      ]
    );
    console.log('Inserted test lead with ID:', res.rows[0].id);
  } catch (err) {
    console.error('Insert failed:', err);
  } finally {
    process.exit(0);
  }
}

insertTestLead();
