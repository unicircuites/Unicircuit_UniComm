const seedEmailTemplates = [
  {
    slug: 'healthcare-private-introduction',
    name: 'Healthcare Private - Introduction',
    category: 'Healthcare',
    subject: 'Smart Infrastructure to Enhance Patient Care, Safety, and Operational Efficiency',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, example: 'Dr. Mehta' },
      { key: 'meeting_window', label: 'Meeting Window', required: true, example: 'next week' },
      { key: 'sender_name', label: 'Sender Name', required: true, example: 'Your Name' },
      { key: 'sender_designation', label: 'Sender Designation', required: true, example: 'Business Development Manager' },
      { key: 'sender_phone', label: 'Sender Phone', required: true, example: '+91 98765 43210' },
      { key: 'sender_email', label: 'Sender Email', required: true, example: 'name@unicircuit.in' },
      { key: 'company_website', label: 'Company Website', required: false, example: 'www.unicircuit.in' }
    ],
    html_body: `
      <p>Dear {{recipient_name}},</p>

      <p>I am writing to introduce Unicircuit Engineering Services LLP, a digital transformation and ELV solutions partner working with private hospitals, multi-specialty chains, and diagnostic networks across India.</p>

      <p>Modern healthcare institutions face a complex balancing act: ensuring patient safety, maintaining uptime of life-critical equipment, securing sensitive zones such as ICUs and pharmacies, and managing energy and operational costs, all while meeting NABH and JCI accreditation standards. Our integrated portfolio is designed to address exactly these challenges:</p>

      <ul>
        <li><strong>Smart Building Ecosystem</strong> - BMS, HVAC controls, and energy management for OTs, ICUs, and wards, with pressure-controlled environments and continuous compliance logging.</li>
        <li><strong>Physical Security &amp; Surveillance</strong> - AI-enabled CCTV, access control, infant tracking, queue analytics, and panic-response systems.</li>
        <li><strong>Industrial Asset Management</strong> - RFID-based tracking of medical equipment, beds, linen, and consumables to reduce loss and improve utilisation.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> - Structured cabling, high-density Wi-Fi, and data centre solutions to power HIMS / EMR / PACS reliably.</li>
        <li><strong>ELV Turnkey Projects</strong> - Single-window execution from design to commissioning, on time and on budget.</li>
      </ul>

      <p>I would value 20 minutes to understand your priorities for the coming year and explore where we can add measurable value, whether for a new facility, an expansion, or modernisation of an existing site. Could we connect for a brief introductory call {{meeting_window}}?</p>

      <p>Warm regards,<br>
      {{sender_name}}<br>
      {{sender_designation}} | Unicircuit Engineering Services LLP<br>
      {{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim()
  }
];

module.exports = {
  seedEmailTemplates
};
