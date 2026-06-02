/**
 * Outlook-compatible email frames: banner + body + footer in one 600px bordered table.
 */

const EMAIL_FRAME_WIDTH = 600;

const BANNER_PRESETS = {
  none: { id: 'none', label: 'No banner', enabled: false, layout: 'simple' },
  healthcare: {
    id: 'healthcare',
    label: 'Healthcare Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'SMART HEALTHCARE · ELV SOLUTIONS',
    headline: 'Infrastructure Care You Can Trust',
    subheadline: 'Patient safety, uptime, and operational excellence for modern hospitals',
    footerLine: 'Unicircuit Engineering Services LLP · Healthcare ELV & Digital Solutions',
    accentColor: '#1d4ed8',
    overlayColor: '#1e3a8a',
    imageUrl: 'https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#2563eb',
  },
  forest: {
    id: 'forest',
    label: 'Forest & Wildlife Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'SMART SURVEILLANCE · ANTI-POACHING · IoT',
    headline: 'Protecting Forests. Empowering Rangers.',
    subheadline: 'Intelligent monitoring and protection infrastructure for forest departments, tiger reserves, and environmental agencies',
    footerLine: 'Unicircuit Engineering Services LLP · Forest & Wildlife Smart Surveillance Solutions',
    accentColor: '#166534',
    overlayColor: '#14532d',
    imageUrl: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#15803d',
  },
  defence: {
    id: 'defence',
    label: 'Defence & Manufacturing Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'ELV · PLANT SECURITY · DIGITAL INFRASTRUCTURE',
    headline: 'Securing India\'s Strategic Manufacturing.',
    subheadline: 'Turnkey ELV, physical security, and digital infrastructure for defence PSUs and strategic manufacturing facilities',
    footerLine: 'Unicircuit Engineering Services LLP · Defence & Industrial ELV Solutions · GeM Registered',
    accentColor: '#78350f',
    overlayColor: '#1c1917',
    imageUrl: 'https://images.unsplash.com/photo-1590959651373-a3db0f38a961?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#292524',
  },
  defencePsu: {
    id: 'defencePsu',
    label: 'Defence PSU Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'SECURE INFRASTRUCTURE · ELV · DEFENCE PSU',
    headline: 'Built for India\'s Most Demanding Facilities.',
    subheadline: 'Integrated plant security, OT infrastructure, and ELV solutions for Defence PSUs — GeM-empanelled, audit-ready',
    footerLine: 'Unicircuit Engineering Services LLP · Defence PSU ELV & Secure Infrastructure · GeM Empanelled',
    accentColor: '#1e3a5f',
    overlayColor: '#0f172a',
    imageUrl: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#1e3a5f',
  },
  banking: {
    id: 'banking',
    label: 'Banking & PSU Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'BRANCH SECURITY · ELV · CURRENCY CHEST SOLUTIONS',
    headline: 'Securing Every Branch. Every Chest. Every Day.',
    subheadline: 'RBI-compliant physical security, e-surveillance, and ELV infrastructure for PSU banking networks across India',
    footerLine: 'Unicircuit Engineering Services LLP · Banking & PSU ELV & Security Solutions',
    accentColor: '#1e40af',
    overlayColor: '#172554',
    imageUrl: 'https://images.unsplash.com/photo-1541354329998-f4d9a9f9297f?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#1e3a8a',
  },
  agriculture: {
    id: 'agriculture',
    label: 'Agriculture & Mandi Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'SMART MANDIS · IoT STORAGE · FIELD CONNECTIVITY',
    headline: 'Modernising India\'s Agricultural Infrastructure.',
    subheadline: 'Surveillance, IoT monitoring, and digital connectivity for mandis, procurement yards, warehouses, and field operations',
    footerLine: 'Unicircuit Engineering Services LLP · Agriculture & Government ELV Solutions',
    accentColor: '#365314',
    overlayColor: '#1a2e05',
    imageUrl: 'https://images.unsplash.com/photo-1500937386664-56d1dfef3854?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#3f6212',
  },
  foodProcessing: {
    id: 'foodProcessing',
    label: 'Food Processing Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'COLD CHAIN · SMART PLANT · FSSAI COMPLIANCE',
    headline: 'Precision Infrastructure for Food Processing.',
    subheadline: 'BMS, cold-chain IoT, surveillance, and ELV solutions for food processing, dairy, and agri-export operations',
    footerLine: 'Unicircuit Engineering Services LLP · Food Processing & Agri ELV Solutions',
    accentColor: '#0f766e',
    overlayColor: '#042f2e',
    imageUrl: 'https://images.unsplash.com/photo-1565043589221-1a6fd9ae45c7?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#0f766e',
  },
  coalMining: {
    id: 'coalMining',
    label: 'Coal Mining & PSU Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'MINE SAFETY · ASSET TRACKING · SURVEILLANCE',
    headline: 'Safety and Visibility Across Every Mine Site.',
    subheadline: 'Worker safety, HEMM tracking, perimeter security, and digital infrastructure for coal mining PSUs — GeM registered',
    footerLine: 'Unicircuit Engineering Services LLP · Mining & Heavy Industry ELV Solutions · GeM Registered',
    accentColor: '#44403c',
    overlayColor: '#1c1917',
    imageUrl: 'https://images.unsplash.com/photo-1611273426858-450d8e3c9fce?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#44403c',
  },
  powerGenerationPsu: {
    id: 'powerGenerationPsu',
    label: 'Power Generation PSU Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'PLANT SECURITY · ASSET HEALTH · ELV SOLUTIONS',
    headline: 'Powering Reliability. Securing Every Megawatt.',
    subheadline: 'Integrated plant security, asset monitoring, and ELV infrastructure for thermal, hydro, and renewable power PSUs',
    footerLine: 'Unicircuit Engineering Services LLP · Power Generation ELV & Security Solutions · GeM Empanelled',
    accentColor: '#b45309',
    overlayColor: '#1c1917',
    imageUrl: 'https://images.unsplash.com/photo-1513828583688-c52646db42da?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#92400e',
  },
  powerGenerationStatePsu: {
    id: 'powerGenerationStatePsu',
    label: 'Power Generation State PSU Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'STATE POWER · SMART GRID · ELV MODERNISATION',
    headline: 'Modernising State Power. Strengthening Energy Security.',
    subheadline: 'Asset monitoring, sub-station surveillance, and ELV infrastructure for state Gencos, Discoms, and Transcos',
    footerLine: 'Unicircuit Engineering Services LLP · State Power Utility ELV & Digital Solutions',
    accentColor: '#1d4ed8',
    overlayColor: '#1e3a8a',
    imageUrl: 'https://images.unsplash.com/photo-1473341304170-971dccb5ac1e?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#1e40af',
  },
  centralBank: {
    id: 'centralBank',
    label: 'Central Bank Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'HIGH-SECURITY · VAULT PROTECTION · MISSION-CRITICAL ELV',
    headline: 'Infrastructure Worthy of the Nation\'s Trust.',
    subheadline: 'Layered security, audit-grade documentation, and zero-downtime ELV for central banking vaults, data centres, and currency processing centres',
    footerLine: 'Unicircuit Engineering Services LLP · Central Banking & High-Security ELV Solutions',
    accentColor: '#92400e',
    overlayColor: '#1c1917',
    imageUrl: 'https://images.unsplash.com/photo-1501167786227-4cba60f6d58f?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#78350f',
  },
  healthcarePsu: {
    id: 'healthcarePsu',
    label: 'Healthcare PSU Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'SMART HOSPITAL · NABH · GeM REGISTERED',
    headline: 'Smart Infrastructure for Public Healthcare Excellence.',
    subheadline: 'BMS, CCTV, RFID asset tracking, and campus networking for AIIMS, ESIC, JIPMER, and central PSU hospitals',
    footerLine: 'Unicircuit Engineering Services LLP · Healthcare PSU ELV & Digital Infrastructure · GeM Registered',
    accentColor: '#0369a1',
    overlayColor: '#0c2340',
    imageUrl: 'https://images.unsplash.com/photo-1758691462878-6edc3d3da1be?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#075985',
  },
  educationPsu: {
    id: 'educationPsu',
    label: 'Education PSU Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'SMART CAMPUS · DIGITAL INFRASTRUCTURE · ELV',
    headline: 'Building the Campus of Tomorrow, Today.',
    subheadline: 'BMS, campus Wi-Fi, surveillance, and smart classroom AV for PSU training academies, technical institutes, and R&D centres',
    footerLine: 'Unicircuit Engineering Services LLP · Education & Campus ELV & Digital Solutions',
    accentColor: '#1d4ed8',
    overlayColor: '#1e1b4b',
    imageUrl: 'https://images.unsplash.com/photo-1562774053-701939374585?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#1e40af',
  },
  educationState: {
    id: 'educationState',
    label: 'Education State Govt Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'SMART CLASSROOMS · SURVEILLANCE · CAMPUS SAFETY',
    headline: 'Modernising State Education Infrastructure.',
    subheadline: 'Smart classroom AV, district-level CCTV, and ELV solutions for state schools, colleges, and examination infrastructure',
    footerLine: 'Unicircuit Engineering Services LLP · State Education ELV & Digital Solutions',
    accentColor: '#0f766e',
    overlayColor: '#134e4a',
    imageUrl: 'https://images.unsplash.com/photo-1580582932707-520aed937b7b?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#0f766e',
  },
  educationCentral: {
    id: 'educationCentral',
    label: 'Education Central Govt Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'KVS · NVS · IIT · NIT · CENTRAL UNIVERSITIES',
    headline: 'Smart Infrastructure for India\'s Premier Institutions.',
    subheadline: 'BMS, campus Wi-Fi, CCTV, and smart classroom AV for KVs, NVs, IITs, NITs, IIMs, and central universities',
    footerLine: 'Unicircuit Engineering Services LLP · Central Govt Education ELV & Digital Solutions · GeM Empanelled',
    accentColor: '#1d4ed8',
    overlayColor: '#172554',
    imageUrl: 'https://images.unsplash.com/photo-1607237138185-eedd9c632b0b?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#1e40af',
  },
  educationPrivate: {
    id: 'educationPrivate',
    label: 'Education Private Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'SMART CAMPUS · SAFETY · DIGITAL LEARNING',
    headline: 'The Campus Experience Students Choose.',
    subheadline: 'Smart classrooms, hostel safety, campus Wi-Fi, and ELV solutions for private universities, deemed institutions, and reputed schools',
    footerLine: 'Unicircuit Engineering Services LLP · Private Education ELV & Smart Campus Solutions',
    accentColor: '#7c3aed',
    overlayColor: '#2e1065',
    imageUrl: 'https://images.unsplash.com/photo-1498243691581-b145c3f54a5a?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#6d28d9',
  },
  industrialAssoc: {
    id: 'industrialAssoc',
    label: 'Industrial Association Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'INDUSTRY PARTNERSHIP · MEMBER SOLUTIONS · ENGAGEMENT',
    headline: 'Partnering with Industry. Enabling Members.',
    subheadline: 'Knowledge sessions, member benefit programmes, and Industry 4.0 solutions for industrial associations and chambers of commerce',
    footerLine: 'Unicircuit Engineering Services LLP · Industry Association & Member Engagement',
    accentColor: '#b45309',
    overlayColor: '#1c1917',
    imageUrl: 'https://images.unsplash.com/photo-1552664730-d307ca884978?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#92400e',
  },
  stateGovt: {
    id: 'stateGovt',
    label: 'State Government Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'SMART GOVERNANCE · SURVEILLANCE · ELV INFRASTRUCTURE',
    headline: 'Digital Infrastructure for Smarter Governance.',
    subheadline: 'City surveillance, secretariat networking, state data centres, and ELV solutions for state government departments — GeM empanelled',
    footerLine: 'Unicircuit Engineering Services LLP · State Government ELV & Digital Infrastructure Solutions',
    accentColor: '#0369a1',
    overlayColor: '#0c2340',
    imageUrl: 'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#075985',
  },
  correctional: {
    id: 'correctional',
    label: 'Correctional Facilities Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'SECURE SURVEILLANCE · ACCESS CONTROL · ELV',
    headline: 'Security and Transparency for Correctional Administration.',
    subheadline: 'AI-enabled CCTV, biometric inmate tracking, perimeter protection, and ELV solutions for correctional facilities — audit-grade, GeM compliant',
    footerLine: 'Unicircuit Engineering Services LLP · Correctional & High-Security ELV Solutions',
    accentColor: '#374151',
    overlayColor: '#111827',
    imageUrl: 'https://images.unsplash.com/photo-1557597774-9d273605dfa9?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#1f2937',
  },
  coldChainStorage: {
    id: 'coldChainStorage',
    label: 'Cold Chain & Storage Hero',
    enabled: true,
    layout: 'hero',
    eyebrow: 'IoT MONITORING · WAREHOUSE SECURITY · COLD CHAIN',
    headline: 'Protecting India\'s Food Security Infrastructure.',
    subheadline: 'IoT temperature monitoring, warehouse surveillance, and ELV solutions for FCI, NAFED, and agri storage PSUs — GeM empanelled',
    footerLine: 'Unicircuit Engineering Services LLP · Agri Storage & Cold Chain ELV Solutions · GeM Empanelled',
    accentColor: '#0e7490',
    overlayColor: '#0c2340',
    imageUrl: 'https://images.unsplash.com/photo-1561329913-721c104c3846?w=1200&q=80',
    heroHeight: 280,
    textAlign: 'left',
    showCta: false,
    showHeader: true,
    logoText: 'Unicircuit',
    logoSubtext: 'ENGINEERING SERVICES LLP',
    headerBg: '#0e7490',
  },
  brand: {
    id: 'brand',
    label: 'Unicircuit Brand',
    enabled: true,
    layout: 'simple',
    headline: 'Unicircuit Engineering Services LLP',
    subheadline: 'Switchgear · ELV · Smart Building · Industrial Automation',
    footerLine: 'Your partner for turnkey electrical & ELV projects across India',
    accentColor: '#1a6e99',
    imageUrl: '',
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    enabled: true,
    layout: 'hero',
    eyebrow: 'YOUR TAGLINE HERE',
    headline: 'Your Main Headline',
    subheadline: 'Supporting subheadline text',
    footerLine: '',
    accentColor: '#2563eb',
    overlayColor: '#1e3a8a',
    imageUrl: '',
    heroHeight: 260,
    textAlign: 'left',
    showCta: false,
    showHeader: false,
  },
};

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeBannerConfig(cfg) {
  const preset = BANNER_PRESETS[cfg && cfg.preset] || BANNER_PRESETS.custom;
  const c = cfg || {};
  const pick = (key, fallback) => (c[key] !== undefined && c[key] !== null ? c[key] : (preset[key] !== undefined ? preset[key] : fallback));

  return {
    enabled: c.enabled !== undefined ? !!c.enabled : !!preset.enabled,
    preset: c.preset || preset.id || 'custom',
    layout: pick('layout', 'hero'),
    eyebrow: String(pick('eyebrow', '')),
    headline: String(pick('headline', '')),
    subheadline: String(pick('subheadline', '')),
    footerLine: String(pick('footerLine', '')),
    accentColor: pick('accentColor', '#2563eb'),
    overlayColor: pick('overlayColor', '#1e3a8a'),
    imageUrl: String(pick('imageUrl', '')),
    imageDataUrl: String(pick('imageDataUrl', '')),
    heroHeight: Math.max(180, Math.min(480, parseInt(pick('heroHeight', 280), 10) || 280)),
    textAlign: ['left', 'center', 'right'].includes(c.textAlign) ? c.textAlign : (preset.textAlign || 'left'),
    showCta: !!pick('showCta', false),
    ctaText: String(pick('ctaText', 'Learn More')),
    ctaUrl: String(pick('ctaUrl', '#')),
    ctaColor: pick('ctaColor', '#ffffff'),
    ctaTextColor: pick('ctaTextColor', '#1d4ed8'),
    showHeader: !!pick('showHeader', false),
    showTopBar: !!pick('showTopBar', false),
    topBarText: String(pick('topBarText', 'View this email in your browser')),
    logoUrl: String(pick('logoUrl', '')),
    logoText: String(pick('logoText', 'Unicircuit')),
    logoSubtext: String(pick('logoSubtext', '')),
    headerBg: pick('headerBg', '#2563eb'),
    navLinks: String(pick('navLinks', 'Services, Contact')),
  };
}

function resolveImage(cfg) {
  const data = String(cfg.imageDataUrl || '').trim();
  if (data) return data;
  return String(cfg.imageUrl || '').trim();
}

function buildTopBarHtml(cfg) {
  if (!cfg.showTopBar) return '';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">'
    + '<tr><td style="background:#0f172a;padding:6px 16px;font-size:10px;color:#94a3b8;text-align:center;">'
    + escapeHtml(cfg.topBarText)
    + '</td></tr></table>';
}

function buildHeaderBarHtml(cfg) {
  if (!cfg.showHeader) return '';
  const bg = cfg.headerBg || cfg.accentColor || '#2563eb';
  const logoImg = cfg.logoUrl
    ? '<img src="' + escapeHtml(cfg.logoUrl) + '" alt="" width="36" height="36" style="display:block;border-radius:50%;border:2px solid rgba(255,255,255,0.35);" />'
    : '<div style="width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.2);text-align:center;line-height:36px;font-size:16px;color:#fff;font-weight:800;">U</div>';
  const nav = String(cfg.navLinks || '').split(',').map((s) => s.trim()).filter(Boolean);
  const navHtml = nav.length
    ? nav.map((link) => '<a href="#" style="color:#ffffff;font-size:12px;text-decoration:none;margin-left:14px;">' + escapeHtml(link) + '</a>').join('')
    : '';

  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">'
    + '<tr><td style="background:' + bg + ';padding:14px 20px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    + '<td valign="middle" style="white-space:nowrap;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
    + '<td valign="middle" style="padding-right:10px;">' + logoImg + '</td>'
    + '<td valign="middle"><div style="font-size:16px;font-weight:800;color:#ffffff;line-height:1.1;">' + escapeHtml(cfg.logoText) + '</div>'
    + (cfg.logoSubtext ? '<div style="font-size:9px;color:#bfdbfe;letter-spacing:1px;margin-top:2px;">' + escapeHtml(cfg.logoSubtext) + '</div>' : '')
    + '</td></tr></table></td>'
    + '<td valign="middle" align="right" style="text-align:right;">' + navHtml + '</td>'
    + '</tr></table></td></tr></table>';
}

function buildHeroBannerHtml(cfg) {
  const img = resolveImage(cfg);
  const h = cfg.heroHeight || 280;
  const overlay = cfg.overlayColor || '#1e3a8a';
  const align = cfg.textAlign || 'left';
  const eyebrow = escapeHtml(cfg.eyebrow || '');
  const headline = escapeHtml(cfg.headline || '');
  const sub = escapeHtml(cfg.subheadline || '');

  let ctaHtml = '';
  if (cfg.showCta && cfg.ctaText) {
    ctaHtml = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;"><tr><td style="background:'
      + escapeHtml(cfg.ctaColor || '#ffffff') + ';border-radius:6px;padding:11px 22px;">'
      + '<a href="' + escapeHtml(cfg.ctaUrl || '#') + '" style="color:'
      + escapeHtml(cfg.ctaTextColor || '#1d4ed8') + ';font-weight:700;font-size:13px;text-decoration:none;display:inline-block;">'
      + escapeHtml(cfg.ctaText) + ' &rsaquo;</a></td></tr></table>';
  }

  const bgAttr = img ? ' background="' + escapeHtml(img) + '"' : '';
  const bgStyle = img
    ? 'background-image:url(\'' + img.replace(/'/g, '%27') + '\');background-size:cover;background-position:center center;background-repeat:no-repeat;'
    : 'background-color:' + (cfg.accentColor || overlay) + ';';

  const vmlStart = img
    ? '<!--[if gte mso 9]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:' + EMAIL_FRAME_WIDTH + 'px;height:'
      + h + 'px;"><v:fill type="frame" src="' + escapeHtml(img) + '" color="' + overlay + '" /><v:textbox inset="0,0,0,0"><![endif]-->'
    : '';
  const vmlEnd = img ? '<!--[if gte mso 9]></v:textbox></v:rect><![endif]-->' : '';

  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">'
    + '<tr><td' + bgAttr + ' bgcolor="' + overlay + '" height="' + h + '" valign="middle" style="' + bgStyle + 'height:'
    + h + 'px;min-height:' + h + 'px;padding:0;mso-line-height-rule:exactly;">'
    + vmlStart
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">'
    + '<tr><td width="348" bgcolor="' + overlay + '" valign="middle" style="width:348px;background-color:' + overlay + ';padding:28px 24px;text-align:' + align + ';">'
    + (eyebrow ? '<div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#93c5fd;margin-bottom:10px;text-transform:uppercase;white-space:normal;word-break:break-word;overflow-wrap:break-word;line-height:1.5;mso-line-height-rule:exactly;">' + eyebrow + '</div>' : '')
    + '<div style="font-size:26px;font-weight:800;color:#ffffff;line-height:1.2;font-family:Georgia,\'Times New Roman\',serif;white-space:normal;word-break:break-word;overflow-wrap:break-word;mso-line-height-rule:exactly;">' + headline + '</div>'
    + (sub ? '<div style="font-size:14px;color:#dbeafe;margin-top:10px;line-height:1.45;white-space:normal;word-break:break-word;overflow-wrap:break-word;mso-line-height-rule:exactly;">' + sub + '</div>' : '')
    + ctaHtml
    + '</td><td style="font-size:0;line-height:0;">&nbsp;</td></tr></table>'
    + vmlEnd
    + '</td></tr></table>';
}

function buildSimpleBannerHtml(cfg) {
  const headline = escapeHtml(cfg.headline || '');
  const sub = escapeHtml(cfg.subheadline || '');
  const accent = cfg.accentColor || '#0d9488';
  const img = resolveImage(cfg);

  let imageRow = '';
  if (img) {
    imageRow = '<tr><td style="padding:0;line-height:0;font-size:0;">'
      + '<img src="' + escapeHtml(img) + '" alt="" width="' + EMAIL_FRAME_WIDTH + '" style="display:block;width:100%;height:auto;border:0;" />'
      + '</td></tr>';
  }

  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">'
    + imageRow
    + '<tr><td style="background:' + accent + ';padding:18px 22px;">'
    + '<div style="font-size:20px;font-weight:800;color:#ffffff;line-height:1.25;">' + headline + '</div>'
    + (sub ? '<div style="font-size:13px;color:#e0f2fe;margin-top:6px;line-height:1.45;">' + sub + '</div>' : '')
    + '</td></tr></table>';
}

function buildBannerStackHtml(cfg) {
  const c = normalizeBannerConfig(cfg);
  const parts = [];
  if (c.showTopBar) parts.push(buildTopBarHtml(c));
  if (c.showHeader) parts.push(buildHeaderBarHtml(c));
  if (c.layout === 'hero' || c.layout === 'full') {
    parts.push(buildHeroBannerHtml(c));
  } else {
    parts.push(buildSimpleBannerHtml(c));
  }
  if (!parts.length) return '';
  return '<div data-uc-banner="1" contenteditable="false" style="margin:0;padding:0;line-height:0;font-size:0;">'
    + parts.join('')
    + '</div>';
}

function buildTemplateFooterHtml(cfg) {
  const line = String(cfg.footerLine || '').trim();
  if (!line) return '';
  return '<div data-uc-template-footer="1" contenteditable="false" style="margin:0;padding:0;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">'
    + '<tr><td style="background:#ffffff;padding:10px 22px;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;text-align:center;line-height:1.4;mso-line-height-rule:exactly;">'
    + escapeHtml(line)
    + '</td></tr></table></div>';
}

function buildFramedEmailHtml(cfg, bodyHtml) {
  const c = normalizeBannerConfig(cfg);
  const body = String(bodyHtml || '').trim() || '<p style="margin:0;font-size:14px;line-height:1.6;color:#334155;">&nbsp;</p>';

  if (!c.enabled) {
    return body;
  }

  const banner = buildBannerStackHtml(c);
  const footer = buildTemplateFooterHtml(c);
  const w = EMAIL_FRAME_WIDTH;

  let rows = '';
  if (banner) {
    rows += '<tr><td style="padding:0;margin:0;line-height:0;font-size:0;vertical-align:top;" contenteditable="false">'
      + banner + '</td></tr>';
  }
  rows += '<tr><td data-uc-email-body="1" style="padding:20px 22px;background:#ffffff;color:#222222;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;vertical-align:top;">'
    + body + '</td></tr>';
  if (footer) {
    rows += '<tr><td style="padding:0;vertical-align:top;" contenteditable="false">' + footer + '</td></tr>';
  }

  return '<table data-uc-email-frame="1" role="presentation" width="' + w + '" cellpadding="0" cellspacing="0" border="0" '
    + 'style="border-collapse:collapse;width:' + w + 'px;max-width:' + w + 'px;margin:0 auto 16px auto;'
    + 'border:1px solid #cbd5e1;font-family:Arial,Helvetica,sans-serif;mso-table-lspace:0pt;mso-table-rspace:0pt;">'
    + rows
    + '</table>';
}

/** @deprecated Use buildFramedEmailHtml — kept for callers that only need banner block */
function buildMessageBannerHtml(cfg, bodyHtml) {
  return buildFramedEmailHtml(cfg, bodyHtml || '');
}

function buildWhatsAppBannerText(cfg) {
  const c = normalizeBannerConfig(cfg);
  if (!c.enabled) return '';
  const lines = [];
  if (c.eyebrow) lines.push('_' + String(c.eyebrow).trim() + '_');
  if (c.headline) lines.push('*' + String(c.headline).trim() + '*');
  if (c.subheadline) lines.push(String(c.subheadline).trim());
  if (c.footerLine) lines.push('_' + String(c.footerLine).trim() + '_');
  if (c.showCta && c.ctaText) lines.push('👉 ' + String(c.ctaText).trim());
  if (!lines.length) return '';
  return lines.join('\n') + '\n────────────────\n\n';
}

function getBannerPreset(presetId) {
  return normalizeBannerConfig({ preset: presetId, ...(BANNER_PRESETS[presetId] || {}) });
}

module.exports = {
  EMAIL_FRAME_WIDTH,
  BANNER_PRESETS,
  normalizeBannerConfig,
  buildBannerStackHtml,
  buildTemplateFooterHtml,
  buildFramedEmailHtml,
  buildMessageBannerHtml,
  buildWhatsAppBannerText,
  getBannerPreset,
};
