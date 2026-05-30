/**
 * Outlook-safe message header banners (table-based HTML).
 */

const BANNER_PRESETS = {
  none: {
    id: 'none',
    label: 'No banner',
    enabled: false,
  },
  healthcare: {
    id: 'healthcare',
    label: 'Healthcare',
    enabled: true,
    headline: 'Smart Healthcare Infrastructure',
    subheadline: 'Patient Care · Safety · Operational Efficiency',
    footerLine: 'Unicircuit Engineering Services LLP · Healthcare ELV & Digital Solutions',
    accentColor: '#0d9488',
    accentColor2: '#0369a1',
    imageUrl: '',
  },
  brand: {
    id: 'brand',
    label: 'Unicircuit Brand',
    enabled: true,
    headline: 'Unicircuit Engineering Services LLP',
    subheadline: 'Switchgear · ELV · Smart Building · Industrial Automation',
    footerLine: 'Your partner for turnkey electrical & ELV projects across India',
    accentColor: '#e8820a',
    accentColor2: '#c96a00',
    imageUrl: '',
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    enabled: true,
    headline: 'Your headline',
    subheadline: 'Your subheadline',
    footerLine: '',
    accentColor: '#2563eb',
    accentColor2: '#1d4ed8',
    imageUrl: '',
  },
};

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildMessageBannerHtml(cfg) {
  if (!cfg || !cfg.enabled) return '';
  const headline = escapeHtml(cfg.headline || '');
  const sub = escapeHtml(cfg.subheadline || '');
  const footer = escapeHtml(cfg.footerLine || '');
  const accent = cfg.accentColor || '#0d9488';
  const imageUrl = String(cfg.imageUrl || '').trim();

  let imageRow = '';
  if (imageUrl) {
    imageRow = '<tr><td style="padding:0;line-height:0;font-size:0;">'
      + '<img src="' + escapeHtml(imageUrl) + '" alt="" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:8px 8px 0 0;" />'
      + '</td></tr>';
  }

  const headlineRadius = imageUrl ? '0' : '8px 8px 0 0';

  return '<div data-uc-banner="1" contenteditable="false" style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:600px;">'
    + imageRow
    + '<tr><td style="background:' + accent + ';padding:18px 22px;border-radius:' + headlineRadius + ';">'
    + '<div style="font-size:20px;font-weight:800;color:#ffffff;line-height:1.25;mso-line-height-rule:exactly;">' + headline + '</div>'
    + (sub ? '<div style="font-size:13px;color:#e0f2fe;margin-top:6px;line-height:1.45;mso-line-height-rule:exactly;">' + sub + '</div>' : '')
    + '</td></tr>'
    + (footer
      ? '<tr><td style="background:#f8fafc;padding:8px 22px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;font-size:11px;color:#475569;line-height:1.4;">' + footer + '</td></tr>'
      : '')
    + '</table></div>';
}

function buildWhatsAppBannerText(cfg) {
  if (!cfg || !cfg.enabled) return '';
  const lines = [];
  if (cfg.headline) lines.push('*' + String(cfg.headline).trim() + '*');
  if (cfg.subheadline) lines.push(String(cfg.subheadline).trim());
  if (cfg.footerLine) lines.push('_' + String(cfg.footerLine).trim() + '_');
  if (!lines.length) return '';
  return lines.join('\n') + '\n────────────────\n\n';
}

function getBannerPreset(presetId) {
  const base = BANNER_PRESETS[presetId] || BANNER_PRESETS.custom;
  return Object.assign({}, base);
}

module.exports = {
  BANNER_PRESETS,
  buildMessageBannerHtml,
  buildWhatsAppBannerText,
  getBannerPreset,
};
