/**
 * Outlook-compatible email banners — simple bar, hero image overlay, or full header stack.
 */

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
  brand: {
    id: 'brand',
    label: 'Unicircuit Brand',
    enabled: true,
    layout: 'simple',
    headline: 'Unicircuit Engineering Services LLP',
    subheadline: 'Switchgear · ELV · Smart Building · Industrial Automation',
    footerLine: 'Your partner for turnkey electrical & ELV projects across India',
    accentColor: '#e8820a',
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
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:600px;">'
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

  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:600px;">'
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
    ? '<!--[if gte mso 9]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:600px;height:'
      + h + 'px;"><v:fill type="frame" src="' + escapeHtml(img) + '" color="' + overlay + '" /><v:textbox inset="0,0,0,0"><![endif]-->'
    : '';
  const vmlEnd = img ? '<!--[if gte mso 9]></v:textbox></v:rect><![endif]-->' : '';

  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:600px;">'
    + '<tr><td' + bgAttr + ' bgcolor="' + overlay + '" height="' + h + '" valign="middle" style="' + bgStyle + 'height:'
    + h + 'px;min-height:' + h + 'px;padding:0;mso-line-height-rule:exactly;">'
    + vmlStart
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">'
    + '<tr><td width="58%" bgcolor="' + overlay + '" valign="middle" style="background-color:' + overlay + ';padding:28px 24px;text-align:' + align + ';">'
    + (eyebrow ? '<div style="font-size:10px;font-weight:700;letter-spacing:2px;color:#93c5fd;margin-bottom:10px;text-transform:uppercase;mso-line-height-rule:exactly;">' + eyebrow + '</div>' : '')
    + '<div style="font-size:26px;font-weight:800;color:#ffffff;line-height:1.2;font-family:Georgia,\'Times New Roman\',serif;mso-line-height-rule:exactly;">' + headline + '</div>'
    + (sub ? '<div style="font-size:14px;color:#dbeafe;margin-top:10px;line-height:1.45;mso-line-height-rule:exactly;">' + sub + '</div>' : '')
    + ctaHtml
    + '</td><td width="42%" style="font-size:0;line-height:0;">&nbsp;</td></tr></table>'
    + vmlEnd
    + '</td></tr>'
    + (cfg.footerLine
      ? '<tr><td style="background:#f8fafc;padding:10px 22px;border:1px solid #e2e8f0;font-size:11px;color:#64748b;text-align:center;">' + escapeHtml(cfg.footerLine) + '</td></tr>'
      : '')
    + '</table>';
}

function buildSimpleBannerHtml(cfg) {
  const headline = escapeHtml(cfg.headline || '');
  const sub = escapeHtml(cfg.subheadline || '');
  const footer = escapeHtml(cfg.footerLine || '');
  const accent = cfg.accentColor || '#0d9488';
  const img = resolveImage(cfg);

  let imageRow = '';
  if (img) {
    imageRow = '<tr><td style="padding:0;line-height:0;font-size:0;">'
      + '<img src="' + escapeHtml(img) + '" alt="" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:8px 8px 0 0;" />'
      + '</td></tr>';
  }
  const headlineRadius = img ? '0' : '8px 8px 0 0';

  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:600px;">'
    + imageRow
    + '<tr><td style="background:' + accent + ';padding:18px 22px;border-radius:' + headlineRadius + ';">'
    + '<div style="font-size:20px;font-weight:800;color:#ffffff;line-height:1.25;">' + headline + '</div>'
    + (sub ? '<div style="font-size:13px;color:#e0f2fe;margin-top:6px;line-height:1.45;">' + sub + '</div>' : '')
    + '</td></tr>'
    + (footer
      ? '<tr><td style="background:#f8fafc;padding:8px 22px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;font-size:11px;color:#475569;">' + footer + '</td></tr>'
      : '')
    + '</table>';
}

function buildMessageBannerHtml(cfg) {
  const c = normalizeBannerConfig(cfg);
  if (!c.enabled) return '';

  const parts = [];
  if (c.showTopBar) parts.push(buildTopBarHtml(c));
  if (c.showHeader) parts.push(buildHeaderBarHtml(c));

  if (c.layout === 'hero' || c.layout === 'full') {
    parts.push(buildHeroBannerHtml(c));
  } else {
    parts.push(buildSimpleBannerHtml(c));
  }

  return '<div data-uc-banner="1" contenteditable="false" style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;max-width:600px;">'
    + parts.join('')
    + '</div>';
}

function buildWhatsAppBannerText(cfg) {
  const c = normalizeBannerConfig(cfg);
  if (!c.enabled) return '';
  const lines = [];
  if (c.eyebrow) lines.push('_' + String(c.eyebrow).trim() + '_');
  if (c.headline) lines.push('*' + String(c.headline).trim() + '*');
  if (c.subheadline) lines.push(String(c.subheadline).trim());
  if (c.footerLine) lines.push('_' + String(c.footerLine).trim() + '_');
  if (c.showCta && c.ctaText) lines.push('👉 ' + String(c.ctaText).trim() + (c.ctaUrl && c.ctaUrl !== '#' ? ': ' + c.ctaUrl : ''));
  if (!lines.length) return '';
  return lines.join('\n') + '\n────────────────\n\n';
}

function getBannerPreset(presetId) {
  return normalizeBannerConfig({ preset: presetId, ...(BANNER_PRESETS[presetId] || {}) });
}

module.exports = {
  BANNER_PRESETS,
  normalizeBannerConfig,
  buildMessageBannerHtml,
  buildWhatsAppBannerText,
  getBannerPreset,
};
