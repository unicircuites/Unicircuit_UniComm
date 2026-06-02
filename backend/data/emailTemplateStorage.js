const { getBannerPreset, buildFramedEmailHtml } = require('./messageBanners');

// ── SERVICE LINK HELPER ───────────────────────────────────────────────────────
// Replaces bold service names with hyperlinks in rendered email HTML.
// ELV Turnkey Projects and any service not listed below stays as plain <strong>.
const SVC_URLS = {
  'Physical Security &amp; Surveillance': 'https://unicircuites.com/services/physical-security-surveillance/video-surveillance-solution/',
  'Industrial Asset Management':          'https://unicircuites.com/services/industrial-asset-management/',
  'Digital Infrastructure &amp; Connectivity': 'https://unicircuites.com/services/digital-infrastructure-connectivity/networking-solution/',
  'Smart Building Ecosystem':             'https://unicircuites.com/services/smart-building-ecosystem/',
  'Professional Services':                'https://unicircuites.com/services/professional-services/',
};

function applyServiceLinks(html) {
  let out = html;
  Object.entries(SVC_URLS).forEach(([name, url]) => {
    const re = new RegExp('<strong>' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '<\\/strong>', 'g');
    out = out.replace(re, '<a href="' + url + '" style="color:#1d4ed8;text-decoration:none;font-weight:700;" target="_blank">' + name + '</a>');
  });
  return out;
}

const healthcareBannerConfig    = getBannerPreset('healthcare');
const forestBannerConfig        = getBannerPreset('forest');
const defenceBannerConfig       = getBannerPreset('defence');
const defencePsuBannerConfig    = getBannerPreset('defencePsu');
const bankingBannerConfig       = getBannerPreset('banking');
const agricultureBannerConfig   = getBannerPreset('agriculture');
const foodProcessingBannerConfig = getBannerPreset('foodProcessing');
const coalMiningBannerConfig    = getBannerPreset('coalMining');
const powerGenerationPsuBannerConfig      = getBannerPreset('powerGenerationPsu');
const powerGenerationStatePsuBannerConfig = getBannerPreset('powerGenerationStatePsu');
const centralBankBannerConfig             = getBannerPreset('centralBank');
const healthcarePsuBannerConfig           = getBannerPreset('healthcarePsu');
const educationPsuBannerConfig            = getBannerPreset('educationPsu');
const educationStateBannerConfig          = getBannerPreset('educationState');
const educationCentralBannerConfig        = getBannerPreset('educationCentral');
const educationPrivateBannerConfig        = getBannerPreset('educationPrivate');
const industrialAssocBannerConfig         = getBannerPreset('industrialAssoc');
const stateGovtBannerConfig               = getBannerPreset('stateGovt');
const correctionalBannerConfig            = getBannerPreset('correctional');
const coldChainStorageBannerConfig        = getBannerPreset('coldChainStorage');

const agricultureBodyHtml = `
      <p>Dear {{recipient_name}},</p>

      <p>I am writing to introduce Unicircuit Engineering Services LLP, a digital transformation company supporting agriculture departments and allied agencies in modernising mandis, procurement infrastructure, storage networks, and field operations.</p>

      <p>Agriculture today is increasingly an information and infrastructure challenge — managing distributed mandis, ensuring transparent procurement, monitoring storage conditions, and connecting field offices to centralised e-platforms such as e-NAM. Unicircuit brings:</p>

      <ul>
        <li><strong>Physical Security &amp; Surveillance</strong> — CCTV for mandis, procurement yards, and warehouses with centralised viewing and incident analytics.</li>
        <li><strong>Industrial Asset Management</strong> — IoT-based monitoring of temperature, humidity, and inventory in warehouses, godowns, and silos.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Networking for e-NAM and mandi platforms, weighbridge integration, and district-office connectivity.</li>
        <li><strong>Smart Building Ecosystem</strong> — Office infrastructure, public address, fire safety, and energy management for departmental buildings.</li>
        <li><strong>ELV Turnkey Projects</strong> — Design-to-commissioning of integrated facilities under a single accountable partner.</li>
      </ul>

      <p>Our solutions are built for the realities of distributed, semi-rural deployment — robust hardware, simplified maintenance, and remote manageability.</p>

      <p>Could we request a brief introductory meeting {{meeting_window}} to understand your priorities and share relevant work?</p>

      <p>Warm regards,<br>
      {{sender_name}}<br>
      {{sender_designation}} | Unicircuit Engineering Services LLP<br>
      {{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim();

const foodProcessingBodyHtml = `
      <p>Dear {{recipient_name}},</p>

      <p>I am writing to introduce Unicircuit Engineering Services LLP — a digital transformation and ELV partner supporting food processing, dairy, beverage, and agri-export operations across India.</p>

      <p>Food processing operations demand precision: uninterrupted cold chain, hygiene compliance under FSSAI and HACCP, energy-efficient utilities, and complete batch traceability — alongside protection of inventory and personnel. Our capabilities map directly to these needs:</p>

      <ul>
        <li><strong>Smart Building Ecosystem</strong> — HVAC, BMS, energy management, and environmental controls for processing, cold-storage, and packaging areas.</li>
        <li><strong>Industrial Asset Management</strong> — IoT-based cold-chain temperature monitoring, machine condition monitoring, and OEE tracking.</li>
        <li><strong>Physical Security &amp; Surveillance</strong> — Food-grade IP65/66 surveillance, access control, visitor management, and dispatch monitoring.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Plant networking, OT/IT integration, and ERP/MES connectivity for end-to-end traceability.</li>
        <li><strong>ELV Turnkey Projects</strong> — Single-window execution for greenfield plants and brownfield expansions.</li>
      </ul>

      <p>May I request a brief introductory meeting {{meeting_window}} to share relevant work and explore alignment with your expansion or modernisation plans?</p>

      <p>Warm regards,<br>
      {{sender_name}}<br>
      {{sender_designation}} | Unicircuit Engineering Services LLP<br>
      {{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim();

const coalMiningBodyHtml = `
      <p>Dear {{recipient_name}},</p>

      <p>I am writing to introduce Unicircuit Engineering Services LLP — an Indian digital transformation company working with mining PSUs and heavy industry to strengthen worker safety, asset visibility, and operational efficiency.</p>

      <p>Coal mining operations — open-cast or underground — require continuous monitoring of people, equipment, and environmental parameters across challenging terrain. Unicircuit brings tightly integrated capabilities purpose-built for this domain:</p>

      <ul>
        <li><strong>Physical Security &amp; Surveillance</strong> — Perimeter intrusion systems, weighbridge monitoring, and anti-pilferage analytics across pit-to-dispatch.</li>
        <li><strong>Industrial Asset Management</strong> — HEMM tracking, RFID-based dispatch, and condition monitoring of conveyors, crushers, and substations.</li>
        <li><strong>Smart Building Ecosystem</strong> — BMS, fire detection, and gas detection for workshops, substations, and CHPs.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Underground and open-cast communications, mine-wide wireless, and surface command centres.</li>
        <li><strong>ELV Turnkey Projects</strong> — Design-to-commissioning with single-point accountability, even across remote sites.</li>
      </ul>

      <p>We are GeM-registered and structured to engage through standard PSU tender processes.</p>

      <p>Could we request a brief introductory meeting {{meeting_window}} to share our credentials and case examples relevant to your operations?</p>

      <p>Warm regards,<br>
      {{sender_name}}<br>
      {{sender_designation}} | Unicircuit Engineering Services LLP<br>
      {{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim();

const defencePsuBodyHtml = `
      <p>Dear {{recipient_name}},</p>

      <p>I am writing to introduce Unicircuit Engineering Services LLP — a homegrown digital transformation and ELV systems company working with Defence PSUs and strategic manufacturing facilities on plant security, operational technology, and integrated infrastructure.</p>

      <p>Defence PSUs operate in one of India's most demanding environments — balancing strict security mandates, indigenisation goals, audit readiness, and 24×7 production continuity. We help meet these objectives through:</p>

      <ul>
        <li><strong>Physical Security &amp; Surveillance</strong> — Perimeter intrusion detection, anti-drone systems, biometric access control, and integrated command-and-control centres.</li>
        <li><strong>Smart Building Ecosystem</strong> — BMS, fire and life safety, and energy management for plants, R&amp;D labs, and administrative blocks.</li>
        <li><strong>Industrial Asset Management</strong> — Predictive maintenance, machine condition monitoring, and end-to-end asset traceability.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Structured cabling, Tier-rated data centres, secure OT networking, and DR site infrastructure.</li>
        <li><strong>ELV Turnkey Projects</strong> — End-to-end execution under a single accountable partner — from concept to handover.</li>
      </ul>

      <p>We are GeM-empanelled and experienced with tender-driven procurement, security clearances, and PSU compliance documentation.</p>

      <p>May I request a 30-minute introductory meeting {{meeting_window}} to present our capabilities and discuss alignment with your upcoming projects?</p>

      <p>Warm regards,<br>
      {{sender_name}}<br>
      {{sender_designation}} | Unicircuit Engineering Services LLP<br>
      {{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim();

const bankingBodyHtml = `
      <p>Dear {{recipient_name}},</p>

      <p>I am writing to introduce Unicircuit Engineering Services LLP — a digital transformation and ELV systems integrator working with banking institutions across India to strengthen physical security, branch infrastructure, and centralised monitoring.</p>

      <p>Public sector banks operate one of the country's largest distributed networks — thousands of branches, currency chests, ATMs, regional offices, and training establishments. Each demands consistent security, uncompromising RBI compliance, uptime, and audit readiness. We deliver this through:</p>

      <ul>
        <li><strong>Physical Security &amp; Surveillance</strong> — IP-based CCTV, e-surveillance for currency chests with central NOC, AI-based analytics, and long-retention video archival.</li>
        <li><strong>Smart Building Ecosystem</strong> — Fire detection and suppression, BMS, public address, and access control across branches and back-offices.</li>
        <li><strong>ELV Turnkey Projects</strong> — Pan-India branch rollout, retrofitting, and standardisation programmes with uniform reporting.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Branch networking, data centre and DR infrastructure, and secure WAN connectivity.</li>
        <li><strong>Professional Services</strong> — Annual maintenance contracts, 24×7 NOC monitoring, and periodic compliance audits.</li>
      </ul>

      <p>We have the operational capability to execute multi-location, time-bound deployments while maintaining uniform quality and reporting.</p>

      <p>Could we connect briefly {{meeting_window}} to understand your roadmap and explore where we can add value?</p>

      <p>Warm regards,<br>
      {{sender_name}}<br>
      {{sender_designation}} | Unicircuit Engineering Services LLP<br>
      {{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim();

const defenceBodyHtml = `
      <p>Dear {{recipient_name}},</p>

      <p>I am writing to introduce Unicircuit Engineering Services LLP, an Indian digital transformation and ELV solutions company aligned with Defence Public Sector Undertakings and strategic manufacturing facilities in their modernisation programmes.</p>

      <p>As {{organisation_name}} advances its mandate of indigenous production across multiple legacy and greenfield facilities, the need for secure, efficient, and digitally enabled operations becomes mission-critical. Our capabilities are directly aligned to this:</p>

      <ul>
        <li><strong>Physical Security &amp; Surveillance</strong> — Multi-layered perimeter protection, explosion-proof CCTV, and access control for magazine and process zones.</li>
        <li><strong>Industrial Asset Management</strong> — Condition monitoring of plant machinery, RFID-based traceability of components and consumables, OEE dashboards.</li>
        <li><strong>Smart Building Ecosystem</strong> — BMS, fire detection, gas-leak detection, and environmental controls suited to hazardous and IS-classified areas.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Secure industrial networks with OT/IT segregation, secure data centre infrastructure, and disaster recovery.</li>
        <li><strong>ELV Turnkey Projects</strong> — Single-point accountability across design, supply, installation, and commissioning.</li>
      </ul>

      <p>We are GeM-registered and structured to engage through tender, OEM, or partner-led routes.</p>

      <p>Could we request a brief introductory meeting {{meeting_window}} to present our credentials and explore alignment with your upcoming modernisation programmes?</p>

      <p>Warm regards,<br>
      {{sender_name}}<br>
      {{sender_designation}} | Unicircuit Engineering Services LLP<br>
      {{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim();

const healthcareBodyHtml = `
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
    `.trim();

const forestBodyHtml = `
      <p>Dear {{recipient_name}},</p>

      <p>I am writing to introduce Unicircuit Engineering Services LLP, a technology and ELV systems integrator working with Forest Departments, Tiger Reserves, and environmental agencies on intelligent monitoring and protection infrastructure.</p>

      <p>Forest and environmental management today demands round-the-clock visibility across vast and often inaccessible terrain — for anti-poaching, fire early-warning, wildlife monitoring, and encroachment control. We help address these mandates through field-hardened solutions:</p>

      <ul>
        <li><strong>Physical Security &amp; Surveillance</strong> — Thermal and PTZ cameras, AI-based intrusion analytics, watch-tower integration, and drone-augmented patrolling.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Long-range wireless backhaul, solar-powered communication nodes, and satellite-linked command centres for low-bandwidth zones.</li>
        <li><strong>Industrial Asset Management</strong> — IoT sensors for soil, water, air-quality, smoke, and forest-fire early warning — integrated to a single dashboard.</li>
        <li><strong>ELV Turnkey Projects</strong> — Design, supply, installation, and commissioning of integrated control-and-command centres at division and circle levels.</li>
        <li><strong>Professional Services</strong> — Site surveys, system audits, training of forest staff, and multi-year AMC support.</li>
      </ul>

      <p>Our solutions are engineered for harsh outdoor environments and the operational realities of frontline staff.</p>

      <p>May I request a short introductory meeting {{meeting_window}} to share relevant case examples and explore how we could support your current initiatives?</p>

      <p>Warm regards,<br>
      {{sender_name}}<br>
      {{sender_designation}} | Unicircuit Engineering Services LLP<br>
      {{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim();

const powerGenerationPsuBodyHtml = `
      <p>Dear {{recipient_name}},</p>

      <p>I am writing to introduce Unicircuit Engineering Services LLP, a digital transformation and ELV systems partner working with power generation PSUs to enhance plant security, asset reliability, and operational visibility.</p>

      <p>Thermal, hydro, and renewable power plants operate under unique pressures — safeguarding critical national infrastructure, maximising plant availability, minimising forced outages, and meeting CEA / CERC compliance. We support these objectives through:</p>

      <ul>
        <li><strong>Physical Security &amp; Surveillance</strong> — Multi-tier perimeter protection, switchyard and coal-yard surveillance, and AI-based intrusion detection.</li>
        <li><strong>Industrial Asset Management</strong> — Condition monitoring of transformers, turbines, motors, and auxiliaries — with vibration and thermal analytics.</li>
        <li><strong>Smart Building Ecosystem</strong> — Control-room ergonomics, BMS, fire detection, and suppression for transformer and cable galleries.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Plant-wide networking, OT/IT segregation, and secure remote access.</li>
        <li><strong>ELV Turnkey Projects</strong> — Single-source design, supply, installation, testing, and commissioning.</li>
      </ul>

      <p>We are GeM-empanelled and accustomed to PSU procurement and compliance standards. May I request a brief introductory meeting {{meeting_window}} to share relevant credentials and case examples?</p>

      <p>Warm regards,<br>
      {{sender_name}}<br>
      {{sender_designation}} | Unicircuit Engineering Services LLP<br>
      {{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim();

const powerGenerationStatePsuBodyHtml = `
      <p>Dear {{recipient_name}},</p>

      <p>I am writing to introduce Unicircuit Engineering Services LLP, an Indian digital transformation and ELV partner working with State Power Generation companies, Discoms, and Transcos to modernise plant, sub-station, and field infrastructure.</p>

      <p>State power utilities sit at the heart of regional energy security — and face mounting pressure to improve reliability, reduce AT&amp;C losses, strengthen security, and enhance consumer service under RDSS and similar schemes. Our capabilities directly support these goals:</p>

      <ul>
        <li><strong>Industrial Asset Management</strong> — Transformer and feeder condition monitoring, IoT-based DT metering, and predictive maintenance analytics.</li>
        <li><strong>Physical Security &amp; Surveillance</strong> — Surveillance for power stations, sub-stations, and warehouses, plus anti-theft analytics on transmission corridors.</li>
        <li><strong>Smart Building Ecosystem</strong> — BMS, fire safety, and energy management for control rooms, sub-station buildings, and offices.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Fibre and wireless networking across plant and sub-stations; SCADA-ready ELV infrastructure.</li>
        <li><strong>ELV Turnkey Projects</strong> — Design-to-commissioning under a single accountable partner, with state-level deployment capability.</li>
      </ul>

      <p>We engage through standard tender, GeM, and EPC partner routes. Could we connect {{meeting_window}} for a brief introductory discussion at your convenience?</p>

      <p>Warm regards,<br>
      {{sender_name}}<br>
      {{sender_designation}} | Unicircuit Engineering Services LLP<br>
      {{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim();

const seedEmailTemplates = [
  {
    slug: 'healthcare-private-introduction',
    name: 'Healthcare Private - Introduction',
    category: 'Healthcare',
    subject: 'Smart Infrastructure to Enhance Patient Care, Safety, and Operational Efficiency',
    variable_fields: [
      {
        key: 'recipient_name',
        label: 'Recipient Name',
        required: true,
        source: 'recipient',
        value: '',
        example: 'Dr. Mehta',
        options: ['Dr. Mehta', 'Sir/Madam', 'Team', 'Dear Colleague']
      },
      {
        key: 'meeting_window',
        label: 'Meeting Window',
        required: true,
        source: 'static',
        value: 'next week',
        example: 'next week',
        options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month']
      },
      {
        key: 'sender_name',
        label: 'Sender Name',
        required: true,
        source: 'static',
        value: 'Nidhisha Badhel',
        example: 'Nidhisha Badhel',
        options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team']
      },
      {
        key: 'sender_designation',
        label: 'Sender Designation',
        required: true,
        source: 'static',
        value: 'Sales Executive',
        example: 'Sales Executive',
        options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager']
      },
      {
        key: 'sender_phone',
        label: 'Sender Phone',
        required: true,
        source: 'static',
        value: '+91 93594 75770',
        example: '+91 93594 75770',
        options: ['+91 93594 75770', '+91 712 2996167 Ext. 21', 'M 09359475770 | P +91 712 2996167 Ext. 21']
      },
      {
        key: 'sender_email',
        label: 'Sender Email',
        required: true,
        source: 'static',
        value: 'sales@unicircuites.com',
        example: 'sales@unicircuites.com',
        options: ['sales@unicircuites.com', 'noreply@unicircuites.live']
      },
      {
        key: 'company_website',
        label: 'Company Website',
        required: false,
        source: 'static',
        value: 'www.unicircuites.com',
        example: 'www.unicircuites.com',
        options: ['www.unicircuites.com', 'unicircuites.com', 'https://www.unicircuites.com']
      }
    ],
    banner_config: healthcareBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(healthcareBannerConfig, healthcareBodyHtml))
  },
  {
    slug: 'forest-wildlife-introduction',
    name: 'Forest & Wildlife - Introduction',
    category: 'Forest & Environment',
    subject: 'Smart Surveillance, Anti-Poaching, and IoT Solutions for Forest and Wildlife Protection',
    variable_fields: [
      {
        key: 'recipient_name',
        label: 'Recipient Name',
        required: true,
        source: 'recipient',
        value: '',
        example: 'Sir/Madam',
        options: ['Sir/Madam', 'Dear Colleague', 'Team', 'Dr. Sharma']
      },
      {
        key: 'meeting_window',
        label: 'Meeting Window',
        required: true,
        source: 'static',
        value: 'next week',
        example: 'next week',
        options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month']
      },
      {
        key: 'sender_name',
        label: 'Sender Name',
        required: true,
        source: 'static',
        value: 'Nidhisha Badhel',
        example: 'Nidhisha Badhel',
        options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team']
      },
      {
        key: 'sender_designation',
        label: 'Sender Designation',
        required: true,
        source: 'static',
        value: 'Sales Executive',
        example: 'Sales Executive',
        options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager']
      },
      {
        key: 'sender_phone',
        label: 'Sender Phone',
        required: true,
        source: 'static',
        value: '+91 93594 75770',
        example: '+91 93594 75770',
        options: ['+91 93594 75770', '+91 712 2996167 Ext. 21', 'M 09359475770 | P +91 712 2996167 Ext. 21']
      },
      {
        key: 'sender_email',
        label: 'Sender Email',
        required: true,
        source: 'static',
        value: 'sales@unicircuites.com',
        example: 'sales@unicircuites.com',
        options: ['sales@unicircuites.com', 'noreply@unicircuites.live']
      },
      {
        key: 'company_website',
        label: 'Company Website',
        required: false,
        source: 'static',
        value: 'www.unicircuites.com',
        example: 'www.unicircuites.com',
        options: ['www.unicircuites.com', 'unicircuites.com', 'https://www.unicircuites.com']
      }
    ],
    banner_config: forestBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(forestBannerConfig, forestBodyHtml))
  },
  {
    slug: 'defence-manufacturing-introduction',
    name: 'Defence & Manufacturing - Introduction',
    category: 'Defence',
    subject: 'ELV, Plant Security, and Digital Infrastructure for Strategic Manufacturing Facilities',
    variable_fields: [
      {
        key: 'recipient_name',
        label: 'Recipient Name',
        required: true,
        source: 'recipient',
        value: '',
        example: 'Sir/Madam',
        options: ['Sir/Madam', 'Dear Colleague', 'Team', 'Shri Kumar']
      },
      {
        key: 'organisation_name',
        label: 'Organisation Name',
        required: true,
        source: 'recipient',
        value: 'Yantra India Ltd.',
        example: 'Yantra India Ltd.',
        options: ['Yantra India Ltd.', 'your organisation', 'your facility']
      },
      {
        key: 'meeting_window',
        label: 'Meeting Window',
        required: true,
        source: 'static',
        value: 'at your convenience',
        example: 'at your convenience',
        options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month']
      },
      {
        key: 'sender_name',
        label: 'Sender Name',
        required: true,
        source: 'static',
        value: 'Nidhisha Badhel',
        example: 'Nidhisha Badhel',
        options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team']
      },
      {
        key: 'sender_designation',
        label: 'Sender Designation',
        required: true,
        source: 'static',
        value: 'Sales Executive',
        example: 'Sales Executive',
        options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager']
      },
      {
        key: 'sender_phone',
        label: 'Sender Phone',
        required: true,
        source: 'static',
        value: '+91 93594 75770',
        example: '+91 93594 75770',
        options: ['+91 93594 75770', '+91 712 2996167 Ext. 21', 'M 09359475770 | P +91 712 2996167 Ext. 21']
      },
      {
        key: 'sender_email',
        label: 'Sender Email',
        required: true,
        source: 'static',
        value: 'sales@unicircuites.com',
        example: 'sales@unicircuites.com',
        options: ['sales@unicircuites.com', 'noreply@unicircuites.live']
      },
      {
        key: 'company_website',
        label: 'Company Website',
        required: false,
        source: 'static',
        value: 'www.unicircuites.com',
        example: 'www.unicircuites.com',
        options: ['www.unicircuites.com', 'unicircuites.com', 'https://www.unicircuites.com']
      }
    ],
    banner_config: defenceBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(defenceBannerConfig, defenceBodyHtml))
  },
  {
    slug: 'defence-psu-introduction',
    name: 'Defence PSU - Introduction',
    category: 'Defence',
    subject: 'Secure Infrastructure and ELV Solutions for Defence PSU Facilities',
    variable_fields: [
      {
        key: 'recipient_name',
        label: 'Recipient Name',
        required: true,
        source: 'recipient',
        value: '',
        example: 'Sir/Madam',
        options: ['Sir/Madam', 'Dear Colleague', 'Team', 'Shri Kumar']
      },
      {
        key: 'meeting_window',
        label: 'Meeting Window',
        required: true,
        source: 'static',
        value: 'at your convenience',
        example: 'at your convenience',
        options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month']
      },
      {
        key: 'sender_name',
        label: 'Sender Name',
        required: true,
        source: 'static',
        value: 'Nidhisha Badhel',
        example: 'Nidhisha Badhel',
        options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team']
      },
      {
        key: 'sender_designation',
        label: 'Sender Designation',
        required: true,
        source: 'static',
        value: 'Sales Executive',
        example: 'Sales Executive',
        options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager']
      },
      {
        key: 'sender_phone',
        label: 'Sender Phone',
        required: true,
        source: 'static',
        value: '+91 93594 75770',
        example: '+91 93594 75770',
        options: ['+91 93594 75770', '+91 712 2996167 Ext. 21', 'M 09359475770 | P +91 712 2996167 Ext. 21']
      },
      {
        key: 'sender_email',
        label: 'Sender Email',
        required: true,
        source: 'static',
        value: 'sales@unicircuites.com',
        example: 'sales@unicircuites.com',
        options: ['sales@unicircuites.com', 'noreply@unicircuites.live']
      },
      {
        key: 'company_website',
        label: 'Company Website',
        required: false,
        source: 'static',
        value: 'www.unicircuites.com',
        example: 'www.unicircuites.com',
        options: ['www.unicircuites.com', 'unicircuites.com', 'https://www.unicircuites.com']
      }
    ],
    banner_config: defencePsuBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(defencePsuBannerConfig, defencePsuBodyHtml))
  },
  {
    slug: 'banking-psu-introduction',
    name: 'Banking PSU - Introduction',
    category: 'Banking',
    subject: 'ELV, Branch Security, and Currency Chest Solutions for PSU Banking Networks',
    variable_fields: [
      {
        key: 'recipient_name',
        label: 'Recipient Name',
        required: true,
        source: 'recipient',
        value: '',
        example: 'Sir/Madam',
        options: ['Sir/Madam', 'Dear Colleague', 'Team', 'Shri Verma']
      },
      {
        key: 'meeting_window',
        label: 'Meeting Window',
        required: true,
        source: 'static',
        value: 'at your convenience',
        example: 'at your convenience',
        options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month']
      },
      {
        key: 'sender_name',
        label: 'Sender Name',
        required: true,
        source: 'static',
        value: 'Nidhisha Badhel',
        example: 'Nidhisha Badhel',
        options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team']
      },
      {
        key: 'sender_designation',
        label: 'Sender Designation',
        required: true,
        source: 'static',
        value: 'Sales Executive',
        example: 'Sales Executive',
        options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager']
      },
      {
        key: 'sender_phone',
        label: 'Sender Phone',
        required: true,
        source: 'static',
        value: '+91 93594 75770',
        example: '+91 93594 75770',
        options: ['+91 93594 75770', '+91 712 2996167 Ext. 21', 'M 09359475770 | P +91 712 2996167 Ext. 21']
      },
      {
        key: 'sender_email',
        label: 'Sender Email',
        required: true,
        source: 'static',
        value: 'sales@unicircuites.com',
        example: 'sales@unicircuites.com',
        options: ['sales@unicircuites.com', 'noreply@unicircuites.live']
      },
      {
        key: 'company_website',
        label: 'Company Website',
        required: false,
        source: 'static',
        value: 'www.unicircuites.com',
        example: 'www.unicircuites.com',
        options: ['www.unicircuites.com', 'unicircuites.com', 'https://www.unicircuites.com']
      }
    ],
    banner_config: bankingBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(bankingBannerConfig, bankingBodyHtml))
  },
  {
    slug: 'agriculture-government-introduction',
    name: 'Agriculture Government - Introduction',
    category: 'Agriculture',
    subject: 'Smart Infrastructure for Mandis, Procurement Yards, Warehouses, and Field Operations',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, source: 'recipient', value: '', example: 'Sir/Madam', options: ['Sir/Madam', 'Dear Colleague', 'Team', 'Shri Patel'] },
      { key: 'meeting_window', label: 'Meeting Window', required: true, source: 'static', value: 'at your convenience', example: 'at your convenience', options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month'] },
      { key: 'sender_name', label: 'Sender Name', required: true, source: 'static', value: 'Nidhisha Badhel', example: 'Nidhisha Badhel', options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team'] },
      { key: 'sender_designation', label: 'Sender Designation', required: true, source: 'static', value: 'Sales Executive', example: 'Sales Executive', options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager'] },
      { key: 'sender_phone', label: 'Sender Phone', required: true, source: 'static', value: '+91 93594 75770', example: '+91 93594 75770', options: ['+91 93594 75770', '+91 712 2996167 Ext. 21', 'M 09359475770 | P +91 712 2996167 Ext. 21'] },
      { key: 'sender_email', label: 'Sender Email', required: true, source: 'static', value: 'sales@unicircuites.com', example: 'sales@unicircuites.com', options: ['sales@unicircuites.com', 'noreply@unicircuites.live'] },
      { key: 'company_website', label: 'Company Website', required: false, source: 'static', value: 'www.unicircuites.com', example: 'www.unicircuites.com', options: ['www.unicircuites.com', 'unicircuites.com', 'https://www.unicircuites.com'] }
    ],
    banner_config: agricultureBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(agricultureBannerConfig, agricultureBodyHtml))
  },
  {
    slug: 'food-processing-introduction',
    name: 'Food Processing & Agri - Introduction',
    category: 'Food Processing',
    subject: 'Smart Plant, Cold Chain, and Surveillance Solutions for Food Processing Operations',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, source: 'recipient', value: '', example: 'Sir/Madam', options: ['Sir/Madam', 'Dear Colleague', 'Team', 'Mr. Gupta'] },
      { key: 'meeting_window', label: 'Meeting Window', required: true, source: 'static', value: 'at your convenience', example: 'at your convenience', options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month'] },
      { key: 'sender_name', label: 'Sender Name', required: true, source: 'static', value: 'Nidhisha Badhel', example: 'Nidhisha Badhel', options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team'] },
      { key: 'sender_designation', label: 'Sender Designation', required: true, source: 'static', value: 'Sales Executive', example: 'Sales Executive', options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager'] },
      { key: 'sender_phone', label: 'Sender Phone', required: true, source: 'static', value: '+91 93594 75770', example: '+91 93594 75770', options: ['+91 93594 75770', '+91 712 2996167 Ext. 21', 'M 09359475770 | P +91 712 2996167 Ext. 21'] },
      { key: 'sender_email', label: 'Sender Email', required: true, source: 'static', value: 'sales@unicircuites.com', example: 'sales@unicircuites.com', options: ['sales@unicircuites.com', 'noreply@unicircuites.live'] },
      { key: 'company_website', label: 'Company Website', required: false, source: 'static', value: 'www.unicircuites.com', example: 'www.unicircuites.com', options: ['www.unicircuites.com', 'unicircuites.com', 'https://www.unicircuites.com'] }
    ],
    banner_config: foodProcessingBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(foodProcessingBannerConfig, foodProcessingBodyHtml))
  },
  {
    slug: 'coal-mining-psu-introduction',
    name: 'Coal Mining PSU - Introduction',
    category: 'Mining',
    subject: 'Mine Safety, Asset Tracking, and Surveillance Solutions for Coal Mining Operations',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, source: 'recipient', value: '', example: 'Sir/Madam', options: ['Sir/Madam', 'Dear Colleague', 'Team', 'Shri Singh'] },
      { key: 'meeting_window', label: 'Meeting Window', required: true, source: 'static', value: 'at your convenience', example: 'at your convenience', options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month'] },
      { key: 'sender_name', label: 'Sender Name', required: true, source: 'static', value: 'Nidhisha Badhel', example: 'Nidhisha Badhel', options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team'] },
      { key: 'sender_designation', label: 'Sender Designation', required: true, source: 'static', value: 'Sales Executive', example: 'Sales Executive', options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager'] },
      { key: 'sender_phone', label: 'Sender Phone', required: true, source: 'static', value: '+91 93594 75770', example: '+91 93594 75770', options: ['+91 93594 75770', '+91 712 2996167 Ext. 21', 'M 09359475770 | P +91 712 2996167 Ext. 21'] },
      { key: 'sender_email', label: 'Sender Email', required: true, source: 'static', value: 'sales@unicircuites.com', example: 'sales@unicircuites.com', options: ['sales@unicircuites.com', 'noreply@unicircuites.live'] },
      { key: 'company_website', label: 'Company Website', required: false, source: 'static', value: 'www.unicircuites.com', example: 'www.unicircuites.com', options: ['www.unicircuites.com', 'unicircuites.com', 'https://www.unicircuites.com'] }
    ],
    banner_config: coalMiningBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(coalMiningBannerConfig, coalMiningBodyHtml))
  },
  {
    slug: 'power-generation-psu-introduction',
    name: 'Power Generation PSU - Introduction',
    category: 'Power Generation',
    subject: 'Plant Security, Asset Health Monitoring, and ELV Solutions for Power Generation',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, source: 'recipient', value: '', example: 'Sir/Madam', options: ['Sir/Madam', 'Dear Colleague', 'Team', 'Shri Mishra'] },
      { key: 'meeting_window', label: 'Meeting Window', required: true, source: 'static', value: 'at your convenience', example: 'at your convenience', options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month'] },
      { key: 'sender_name', label: 'Sender Name', required: true, source: 'static', value: 'Nidhisha Badhel', example: 'Nidhisha Badhel', options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team'] },
      { key: 'sender_designation', label: 'Sender Designation', required: true, source: 'static', value: 'Sales Executive', example: 'Sales Executive', options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager'] },
      { key: 'sender_phone', label: 'Sender Phone', required: true, source: 'static', value: '+91 93594 75770', example: '+91 93594 75770', options: ['+91 93594 75770', '+91 712 2996167 Ext. 21', 'M 09359475770 | P +91 712 2996167 Ext. 21'] },
      { key: 'sender_email', label: 'Sender Email', required: true, source: 'static', value: 'sales@unicircuites.com', example: 'sales@unicircuites.com', options: ['sales@unicircuites.com', 'noreply@unicircuites.live'] },
      { key: 'company_website', label: 'Company Website', required: false, source: 'static', value: 'www.unicircuites.com', example: 'www.unicircuites.com', options: ['www.unicircuites.com', 'unicircuites.com', 'https://www.unicircuites.com'] }
    ],
    banner_config: powerGenerationPsuBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(powerGenerationPsuBannerConfig, powerGenerationPsuBodyHtml))
  },
  {
    slug: 'power-generation-state-psu-introduction',
    name: 'Power Generation State PSU - Introduction',
    category: 'Power Generation',
    subject: 'Modernisation Solutions for State Power Generation, Transmission, and Distribution Infrastructure',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, source: 'recipient', value: '', example: 'Sir/Madam', options: ['Sir/Madam', 'Dear Colleague', 'Team', 'Shri Pillai'] },
      { key: 'meeting_window', label: 'Meeting Window', required: true, source: 'static', value: 'at your convenience', example: 'at your convenience', options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month'] },
      { key: 'sender_name', label: 'Sender Name', required: true, source: 'static', value: 'Nidhisha Badhel', example: 'Nidhisha Badhel', options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team'] },
      { key: 'sender_designation', label: 'Sender Designation', required: true, source: 'static', value: 'Sales Executive', example: 'Sales Executive', options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager'] },
      { key: 'sender_phone', label: 'Sender Phone', required: true, source: 'static', value: '+91 93594 75770', example: '+91 93594 75770', options: ['+91 93594 75770', '+91 712 2996167 Ext. 21', 'M 09359475770 | P +91 712 2996167 Ext. 21'] },
      { key: 'sender_email', label: 'Sender Email', required: true, source: 'static', value: 'sales@unicircuites.com', example: 'sales@unicircuites.com', options: ['sales@unicircuites.com', 'noreply@unicircuites.live'] },
      { key: 'company_website', label: 'Company Website', required: false, source: 'static', value: 'www.unicircuites.com', example: 'www.unicircuites.com', options: ['www.unicircuites.com', 'unicircuites.com', 'https://www.unicircuites.com'] }
    ],
    banner_config: powerGenerationStatePsuBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(powerGenerationStatePsuBannerConfig, powerGenerationStatePsuBodyHtml))
  },
  {
    slug: 'central-bank-introduction',
    name: 'Central Bank - Introduction',
    category: 'Banking',
    subject: 'High-Security Infrastructure and ELV Solutions for Central Banking Operations',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, source: 'recipient', value: '', example: 'Sir/Madam', options: ['Sir/Madam', 'Dear Colleague', 'Team'] },
      { key: 'meeting_window', label: 'Meeting Window', required: true, source: 'static', value: 'at your convenience', example: 'at your convenience', options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month'] },
      { key: 'sender_name', label: 'Sender Name', required: true, source: 'static', value: 'Nidhisha Badhel', example: 'Nidhisha Badhel', options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team'] },
      { key: 'sender_designation', label: 'Sender Designation', required: true, source: 'static', value: 'Sales Executive', example: 'Sales Executive', options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager'] },
      { key: 'sender_phone', label: 'Sender Phone', required: true, source: 'static', value: '+91 93594 75770', example: '+91 93594 75770', options: ['+91 93594 75770', '+91 712 2996167 Ext. 21', 'M 09359475770 | P +91 712 2996167 Ext. 21'] },
      { key: 'sender_email', label: 'Sender Email', required: true, source: 'static', value: 'sales@unicircuites.com', example: 'sales@unicircuites.com', options: ['sales@unicircuites.com', 'noreply@unicircuites.live'] },
      { key: 'company_website', label: 'Company Website', required: false, source: 'static', value: 'www.unicircuites.com', example: 'www.unicircuites.com', options: ['www.unicircuites.com', 'unicircuites.com', 'https://www.unicircuites.com'] }
    ],
    banner_config: centralBankBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(centralBankBannerConfig, `
      <p>Dear {{recipient_name}},</p>
      <p>I am writing to introduce Unicircuit Engineering Services LLP — an Indian digital transformation and ELV systems integrator with deep capability in high-security, mission-critical environments such as those operated by central banking institutions.</p>
      <p>Central banks operate among the most security-sensitive facilities in the country — vaults, currency processing centres, regional offices, and data centres. The expectation is uncompromising: layered security, audit-grade documentation, zero downtime, and absolute confidentiality. We support these through:</p>
      <ul>
        <li><strong>Physical Security &amp; Surveillance</strong> — Multi-layer access control, biometric authentication, vault and strongroom protection, and integrated command centres.</li>
        <li><strong>Smart Building Ecosystem</strong> — Clean-agent fire suppression (FM200, Novec), BMS, and environmental controls for data centres and currency chests.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Tier-rated data centre infrastructure, secure structured cabling, and DR-site setup.</li>
        <li><strong>ELV Turnkey Projects</strong> — Single-window design-to-commissioning for sensitive facilities, under tight confidentiality protocols.</li>
        <li><strong>Professional Services</strong> — Clearance-aware execution, long-term AMC, and compliance support.</li>
      </ul>
      <p>May I request a brief introductory meeting {{meeting_window}} to share our credentials in confidence, and explore how we may be of service?</p>
      <p>Warm regards,<br>{{sender_name}}<br>{{sender_designation}} | Unicircuit Engineering Services LLP<br>{{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim())
  )},
  {
    slug: 'healthcare-psu-introduction',
    name: 'Healthcare PSU (Central) - Introduction',
    category: 'Healthcare',
    subject: 'Smart Hospital Infrastructure for Central PSU Healthcare Institutions',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, source: 'recipient', value: '', example: 'Sir/Madam', options: ['Sir/Madam', 'Dear Colleague', 'Team', 'Dr. Sharma'] },
      { key: 'meeting_window', label: 'Meeting Window', required: true, source: 'static', value: 'at your convenience', example: 'at your convenience', options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month'] },
      { key: 'sender_name', label: 'Sender Name', required: true, source: 'static', value: 'Nidhisha Badhel', example: 'Nidhisha Badhel', options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team'] },
      { key: 'sender_designation', label: 'Sender Designation', required: true, source: 'static', value: 'Sales Executive', example: 'Sales Executive', options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager'] },
      { key: 'sender_phone', label: 'Sender Phone', required: true, source: 'static', value: '+91 93594 75770', example: '+91 93594 75770', options: ['+91 93594 75770', '+91 712 2996167 Ext. 21', 'M 09359475770 | P +91 712 2996167 Ext. 21'] },
      { key: 'sender_email', label: 'Sender Email', required: true, source: 'static', value: 'sales@unicircuites.com', example: 'sales@unicircuites.com', options: ['sales@unicircuites.com', 'noreply@unicircuites.live'] },
      { key: 'company_website', label: 'Company Website', required: false, source: 'static', value: 'www.unicircuites.com', example: 'www.unicircuites.com', options: ['www.unicircuites.com', 'unicircuites.com', 'https://www.unicircuites.com'] }
    ],
    banner_config: healthcarePsuBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(healthcarePsuBannerConfig, `
      <p>Dear {{recipient_name}},</p>
      <p>I am writing to introduce Unicircuit Engineering Services LLP — a digital transformation and ELV partner working with public healthcare institutions to deliver smart hospital infrastructure that supports clinical excellence and operational efficiency.</p>
      <p>Central PSU healthcare institutions — AIIMS, JIPMER, PGIMER, ESIC hospitals, and others — manage large, complex campuses with intensive patient flow, critical care services, research wings, and academic facilities. We help address this complexity through:</p>
      <ul>
        <li><strong>Smart Building Ecosystem</strong> — Integrated BMS, HVAC, and energy management for OTs, ICUs, wards, and research labs with NABH-aligned logging.</li>
        <li><strong>Physical Security &amp; Surveillance</strong> — Campus-wide CCTV, access control, infant tracking, and queue/crowd analytics for OPD areas.</li>
        <li><strong>Industrial Asset Management</strong> — RFID-based tracking of medical equipment, linen, and consumables to drive utilisation and reduce loss.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Campus networking, structured cabling, data centre, and high-density Wi-Fi to support HIMS / EMR / PACS.</li>
        <li><strong>ELV Turnkey Projects</strong> — Design-to-commissioning for new blocks, super-specialty wings, and expansions.</li>
      </ul>
      <p>We are GeM-registered and conversant with CPWD, HSCC, and PSU tender frameworks.</p>
      <p>Could we request a brief introductory meeting {{meeting_window}} to share our credentials?</p>
      <p>Warm regards,<br>{{sender_name}}<br>{{sender_designation}} | Unicircuit Engineering Services LLP<br>{{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim())
  )},
  {
    slug: 'education-psu-introduction',
    name: 'Education PSU (Central) - Introduction',
    category: 'Education',
    subject: 'Smart Campus and Digital Infrastructure Solutions for Central PSU Educational Institutions',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, source: 'recipient', value: '', example: 'Sir/Madam', options: ['Sir/Madam', 'Dear Colleague', 'Team', 'Prof. Kumar'] },
      { key: 'meeting_window', label: 'Meeting Window', required: true, source: 'static', value: 'at your convenience', example: 'at your convenience', options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month'] },
      { key: 'sender_name', label: 'Sender Name', required: true, source: 'static', value: 'Nidhisha Badhel', example: 'Nidhisha Badhel', options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team'] },
      { key: 'sender_designation', label: 'Sender Designation', required: true, source: 'static', value: 'Sales Executive', example: 'Sales Executive', options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager'] },
      { key: 'sender_phone', label: 'Sender Phone', required: true, source: 'static', value: '+91 93594 75770', example: '+91 93594 75770', options: ['+91 93594 75770', '+91 712 2996167 Ext. 21', 'M 09359475770 | P +91 712 2996167 Ext. 21'] },
      { key: 'sender_email', label: 'Sender Email', required: true, source: 'static', value: 'sales@unicircuites.com', example: 'sales@unicircuites.com', options: ['sales@unicircuites.com', 'noreply@unicircuites.live'] },
      { key: 'company_website', label: 'Company Website', required: false, source: 'static', value: 'www.unicircuites.com', example: 'www.unicircuites.com', options: ['www.unicircuites.com', 'unicircuites.com', 'https://www.unicircuites.com'] }
    ],
    banner_config: educationPsuBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(educationPsuBannerConfig, `
      <p>Dear {{recipient_name}},</p>
      <p>I am writing to introduce Unicircuit Engineering Services LLP — a digital transformation and ELV partner working with educational institutions to build smart, secure, and digitally enabled campuses.</p>
      <p>PSU-managed institutions — training academies, technical institutes, and R&amp;D centres — demand infrastructure that supports modern pedagogy, examination integrity, residential life, and research activity on a single integrated campus. Unicircuit brings:</p>
      <ul>
        <li><strong>Smart Building Ecosystem</strong> — BMS, classroom automation, and energy management for academic and hostel blocks.</li>
        <li><strong>Physical Security &amp; Surveillance</strong> — Campus-wide CCTV with analytics, access control for hostels and labs, and examination-hall monitoring.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Campus-wide Wi-Fi, structured cabling, data centre, and smart classroom AV.</li>
        <li><strong>ELV Turnkey Projects</strong> — Single-window execution for greenfield campuses and major upgrades.</li>
        <li><strong>Professional Services</strong> — Design consultancy, AMC, training, and managed services.</li>
      </ul>
      <p>We engage through standard PSU procurement processes and have ready credentials for technical pre-qualification.</p>
      <p>May I request a brief introductory meeting {{meeting_window}} to share relevant work?</p>
      <p>Warm regards,<br>{{sender_name}}<br>{{sender_designation}} | Unicircuit Engineering Services LLP<br>{{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim())
  )},
  {
    slug: 'education-state-govt-introduction',
    name: 'Education State Govt - Introduction',
    category: 'Education',
    subject: 'Smart Classroom, Surveillance, and Campus Solutions for State Educational Institutions',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, source: 'recipient', value: '', example: 'Sir/Madam', options: ['Sir/Madam', 'Dear Colleague', 'Team'] },
      { key: 'meeting_window', label: 'Meeting Window', required: true, source: 'static', value: 'at your convenience', example: 'at your convenience', options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month'] },
      { key: 'sender_name', label: 'Sender Name', required: true, source: 'static', value: 'Nidhisha Badhel', example: 'Nidhisha Badhel', options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team'] },
      { key: 'sender_designation', label: 'Sender Designation', required: true, source: 'static', value: 'Sales Executive', example: 'Sales Executive', options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager'] },
      { key: 'sender_phone', label: 'Sender Phone', required: true, source: 'static', value: '+91 93594 75770', example: '+91 93594 75770', options: ['+91 93594 75770', '+91 712 2996167 Ext. 21'] },
      { key: 'sender_email', label: 'Sender Email', required: true, source: 'static', value: 'sales@unicircuites.com', example: 'sales@unicircuites.com', options: ['sales@unicircuites.com', 'noreply@unicircuites.live'] },
      { key: 'company_website', label: 'Company Website', required: false, source: 'static', value: 'www.unicircuites.com', example: 'www.unicircuites.com', options: ['www.unicircuites.com', 'unicircuites.com'] }
    ],
    banner_config: educationStateBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(educationStateBannerConfig, `
      <p>Dear {{recipient_name}},</p>
      <p>I am writing to introduce Unicircuit Engineering Services LLP — a digital transformation and ELV partner working with State Government education departments, universities, technical boards, and Samagra Shiksha programmes to digitally modernise schools, colleges, and examination infrastructure.</p>
      <p>State-managed education today balances scale (thousands of institutions) with the imperative for digital learning, examination integrity, campus safety, and central monitoring. Unicircuit supports these mandates through:</p>
      <ul>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Smart classroom AV, ICT labs, and school/college networking with central manageability.</li>
        <li><strong>Physical Security &amp; Surveillance</strong> — CCTV for institutions, central viewing at district / DEO level, and examination-hall recording.</li>
        <li><strong>Smart Building Ecosystem</strong> — Energy-efficient lighting, public address, and fire safety for schools and college blocks.</li>
        <li><strong>ELV Turnkey Projects</strong> — Large-scale rollouts and standardisation programmes across districts.</li>
        <li><strong>Professional Services</strong> — District-level AMC, training of teachers and support staff, and helpdesk models.</li>
      </ul>
      <p>We have the operational depth to execute multi-site, time-bound deployments with consistent quality and reporting.</p>
      <p>Could we connect for a brief introductory meeting {{meeting_window}}?</p>
      <p>Warm regards,<br>{{sender_name}}<br>{{sender_designation}} | Unicircuit Engineering Services LLP<br>{{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim())
  )},
  {
    slug: 'industrial-association-introduction',
    name: 'Industrial Association - Introduction',
    category: 'General',
    subject: 'Partnership Opportunity — Member Solutions and Industry Engagement with Unicircuit',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, source: 'recipient', value: '', example: 'Sir/Madam', options: ['Sir/Madam', 'Dear Colleague', 'Team'] },
      { key: 'meeting_window', label: 'Meeting Window', required: true, source: 'static', value: 'at your convenience', example: 'at your convenience', options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month'] },
      { key: 'sender_name', label: 'Sender Name', required: true, source: 'static', value: 'Nidhisha Badhel', example: 'Nidhisha Badhel', options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team'] },
      { key: 'sender_designation', label: 'Sender Designation', required: true, source: 'static', value: 'Sales Executive', example: 'Sales Executive', options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager'] },
      { key: 'sender_phone', label: 'Sender Phone', required: true, source: 'static', value: '+91 93594 75770', example: '+91 93594 75770', options: ['+91 93594 75770', '+91 712 2996167 Ext. 21'] },
      { key: 'sender_email', label: 'Sender Email', required: true, source: 'static', value: 'sales@unicircuites.com', example: 'sales@unicircuites.com', options: ['sales@unicircuites.com', 'noreply@unicircuites.live'] },
      { key: 'company_website', label: 'Company Website', required: false, source: 'static', value: 'www.unicircuites.com', example: 'www.unicircuites.com', options: ['www.unicircuites.com', 'unicircuites.com'] }
    ],
    banner_config: industrialAssocBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(industrialAssocBannerConfig, `
      <p>Dear {{recipient_name}},</p>
      <p>I am writing on behalf of Unicircuit Engineering Services LLP — a digital transformation and ELV solutions company serving Indian industry across Smart Building, Physical Security, Industrial Asset Management, Digital Infrastructure, and ELV Turnkey Projects.</p>
      <p>We see industry associations as critical multipliers — bringing together members on shared priorities such as plant modernisation, Industry 4.0 adoption, energy efficiency, and security. We would value the opportunity to engage with your association in the following ways:</p>
      <ul>
        <li><strong>Membership &amp; Participation</strong> — Active engagement in committees, working groups, and technology forums relevant to your members.</li>
        <li><strong>Knowledge Sessions</strong> — Curated sessions for member organisations on Smart Manufacturing, ELV best practices, and government digital initiatives.</li>
        <li><strong>Industry Showcasing</strong> — Showcasing relevant solutions at vendor meets, expos, and association conferences.</li>
        <li><strong>Policy &amp; Advocacy</strong> — Collaborating on industry inputs around digital transformation, ease of doing business, and Make-in-India.</li>
        <li><strong>Member Benefit Programmes</strong> — Co-creating preferential consultation, audits, or pilot programmes for member organisations.</li>
      </ul>
      <p>We would be honoured to formally introduce ourselves and discuss how Unicircuit can contribute to your association's agenda for the year.</p>
      <p>Could we request a short introductory meeting {{meeting_window}}?</p>
      <p>Warm regards,<br>{{sender_name}}<br>{{sender_designation}} | Unicircuit Engineering Services LLP<br>{{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim())
  )},
  {
    slug: 'state-government-introduction',
    name: 'State Government - Introduction',
    category: 'Government',
    subject: 'Smart Governance, Surveillance, and ELV Infrastructure for State Government Departments',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, source: 'recipient', value: '', example: 'Sir/Madam', options: ['Sir/Madam', 'Dear Colleague', 'Team'] },
      { key: 'meeting_window', label: 'Meeting Window', required: true, source: 'static', value: 'at your convenience', example: 'at your convenience', options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month'] },
      { key: 'sender_name', label: 'Sender Name', required: true, source: 'static', value: 'Nidhisha Badhel', example: 'Nidhisha Badhel', options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team'] },
      { key: 'sender_designation', label: 'Sender Designation', required: true, source: 'static', value: 'Sales Executive', example: 'Sales Executive', options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager'] },
      { key: 'sender_phone', label: 'Sender Phone', required: true, source: 'static', value: '+91 93594 75770', example: '+91 93594 75770', options: ['+91 93594 75770', '+91 712 2996167 Ext. 21'] },
      { key: 'sender_email', label: 'Sender Email', required: true, source: 'static', value: 'sales@unicircuites.com', example: 'sales@unicircuites.com', options: ['sales@unicircuites.com', 'noreply@unicircuites.live'] },
      { key: 'company_website', label: 'Company Website', required: false, source: 'static', value: 'www.unicircuites.com', example: 'www.unicircuites.com', options: ['www.unicircuites.com', 'unicircuites.com'] }
    ],
    banner_config: stateGovtBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(stateGovtBannerConfig, `
      <p>Dear {{recipient_name}},</p>
      <p>I am writing to introduce Unicircuit Engineering Services LLP — a digital transformation and ELV systems integrator working with State Government departments to modernise office, citizen-services, and field infrastructure.</p>
      <p>State governments today drive an ambitious agenda — Smart Cities, e-Governance, citizen services, surveillance command centres, and departmental digitisation. Each of these has real infrastructure demands that we are positioned to address:</p>
      <ul>
        <li><strong>Physical Security &amp; Surveillance</strong> — City surveillance, secretariat and office CCTV, and integrated command-and-control centres.</li>
        <li><strong>Smart Building Ecosystem</strong> — BMS, energy management, and fire and life safety for government buildings and citizen-service centres.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Secretariat networking, state data centres, district-office connectivity, and video conferencing.</li>
        <li><strong>ELV Turnkey Projects</strong> — Single-window design-to-commissioning for large, multi-discipline government projects.</li>
        <li><strong>Professional Services</strong> — Long-term AMC, 24×7 NOC monitoring, and managed services.</li>
      </ul>
      <p>We are GeM-empanelled and well-versed with state-level tendering, technical pre-qualification, and project execution norms.</p>
      <p>May I request a brief introductory meeting {{meeting_window}} to share our credentials?</p>
      <p>Warm regards,<br>{{sender_name}}<br>{{sender_designation}} | Unicircuit Engineering Services LLP<br>{{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim())
  )},
  {
    slug: 'correctional-facilities-introduction',
    name: 'Correctional Facilities - Introduction',
    category: 'Government',
    subject: 'Secure Surveillance, Access Control, and ELV Solutions for Correctional Facilities',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, source: 'recipient', value: '', example: 'Sir/Madam', options: ['Sir/Madam', 'Dear Colleague', 'Team'] },
      { key: 'meeting_window', label: 'Meeting Window', required: true, source: 'static', value: 'at your convenience', example: 'at your convenience', options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month'] },
      { key: 'sender_name', label: 'Sender Name', required: true, source: 'static', value: 'Nidhisha Badhel', example: 'Nidhisha Badhel', options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team'] },
      { key: 'sender_designation', label: 'Sender Designation', required: true, source: 'static', value: 'Sales Executive', example: 'Sales Executive', options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager'] },
      { key: 'sender_phone', label: 'Sender Phone', required: true, source: 'static', value: '+91 93594 75770', example: '+91 93594 75770', options: ['+91 93594 75770', '+91 712 2996167 Ext. 21'] },
      { key: 'sender_email', label: 'Sender Email', required: true, source: 'static', value: 'sales@unicircuites.com', example: 'sales@unicircuites.com', options: ['sales@unicircuites.com', 'noreply@unicircuites.live'] },
      { key: 'company_website', label: 'Company Website', required: false, source: 'static', value: 'www.unicircuites.com', example: 'www.unicircuites.com', options: ['www.unicircuites.com', 'unicircuites.com'] }
    ],
    banner_config: correctionalBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(correctionalBannerConfig, `
      <p>Dear {{recipient_name}},</p>
      <p>I am writing to introduce Unicircuit Engineering Services LLP — a digital transformation and ELV systems integrator with capability in high-security environments, including correctional facilities, defence sites, and central banking installations.</p>
      <p>Modern correctional administration demands a fine balance — enhanced inmate management and safety, perimeter integrity, contraband and communication control, staff safety, and full audit-grade transparency. Unicircuit's capabilities directly support these mandates:</p>
      <ul>
        <li><strong>Physical Security &amp; Surveillance</strong> — AI-enabled CCTV with behaviour analytics, perimeter intrusion detection, and integrated command-and-control rooms.</li>
        <li><strong>Industrial Asset Management</strong> — RFID and biometric inmate tracking, visitor management, and asset traceability.</li>
        <li><strong>Smart Building Ecosystem</strong> — Fire detection, public address, and energy management for barracks and administrative blocks.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Secure networking and video conferencing for e-Court and e-Mulaqaat initiatives.</li>
        <li><strong>ELV Turnkey Projects</strong> — Single-window design-to-commissioning under strict confidentiality and security protocols.</li>
      </ul>
      <p>We engage through standard government tender and GeM channels, and are accustomed to security clearance processes.</p>
      <p>May I request a brief introductory meeting {{meeting_window}} to present relevant credentials?</p>
      <p>Warm regards,<br>{{sender_name}}<br>{{sender_designation}} | Unicircuit Engineering Services LLP<br>{{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim())
  )},
  {
    slug: 'cold-chain-storage-psu-introduction',
    name: 'Cold Chain & Storage PSU - Introduction',
    category: 'Agriculture',
    subject: 'Warehouse Modernisation, Cold Chain Monitoring, and Surveillance for Storage Infrastructure',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, source: 'recipient', value: '', example: 'Sir/Madam', options: ['Sir/Madam', 'Dear Colleague', 'Team'] },
      { key: 'meeting_window', label: 'Meeting Window', required: true, source: 'static', value: 'at your convenience', example: 'at your convenience', options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month'] },
      { key: 'sender_name', label: 'Sender Name', required: true, source: 'static', value: 'Nidhisha Badhel', example: 'Nidhisha Badhel', options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team'] },
      { key: 'sender_designation', label: 'Sender Designation', required: true, source: 'static', value: 'Sales Executive', example: 'Sales Executive', options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager'] },
      { key: 'sender_phone', label: 'Sender Phone', required: true, source: 'static', value: '+91 93594 75770', example: '+91 93594 75770', options: ['+91 93594 75770', '+91 712 2996167 Ext. 21'] },
      { key: 'sender_email', label: 'Sender Email', required: true, source: 'static', value: 'sales@unicircuites.com', example: 'sales@unicircuites.com', options: ['sales@unicircuites.com', 'noreply@unicircuites.live'] },
      { key: 'company_website', label: 'Company Website', required: false, source: 'static', value: 'www.unicircuites.com', example: 'www.unicircuites.com', options: ['www.unicircuites.com', 'unicircuites.com'] }
    ],
    banner_config: coldChainStorageBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(coldChainStorageBannerConfig, `
      <p>Dear {{recipient_name}},</p>
      <p>I am writing to introduce Unicircuit Engineering Services LLP — a digital transformation and ELV partner supporting food and agri storage organisations in modernising warehouses, silos, and cold-chain infrastructure across India.</p>
      <p>National food security depends on the integrity of stored grain, perishables, and buffer stocks — across thousands of locations of varying age and capacity. Loss prevention, environmental control, and security are top priorities. Unicircuit brings:</p>
      <ul>
        <li><strong>Industrial Asset Management</strong> — IoT-based temperature and humidity monitoring, fumigation alerts, and silo-level inventory monitoring.</li>
        <li><strong>Physical Security &amp; Surveillance</strong> — Warehouse and silo perimeter surveillance, weighbridge integration, and dispatch monitoring.</li>
        <li><strong>Smart Building Ecosystem</strong> — Energy-efficient lighting, fire detection, and BMS for cold-storage and ambient warehouses.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Networking for distributed depots, regional offices, and central headquarters.</li>
        <li><strong>ELV Turnkey Projects</strong> — Multi-site rollout under a standardised design, with uniform reporting and AMC.</li>
      </ul>
      <p>Our solutions are engineered for the realities of large, distributed networks operated under PSU procurement norms. We are GeM-empanelled.</p>
      <p>Could we request a brief introductory meeting {{meeting_window}}?</p>
      <p>Warm regards,<br>{{sender_name}}<br>{{sender_designation}} | Unicircuit Engineering Services LLP<br>{{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim())
  )},
  {
    slug: 'education-central-govt-introduction',
    name: 'Education Central Govt - Introduction',
    category: 'Education',
    subject: 'Smart Campus, Surveillance, and Digital Infrastructure for Central Government Institutions',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, source: 'recipient', value: '', example: 'Sir/Madam', options: ['Sir/Madam', 'Dear Colleague', 'Team', 'Prof. Kumar'] },
      { key: 'meeting_window', label: 'Meeting Window', required: true, source: 'static', value: 'at your convenience', example: 'at your convenience', options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month'] },
      { key: 'sender_name', label: 'Sender Name', required: true, source: 'static', value: 'Nidhisha Badhel', example: 'Nidhisha Badhel', options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team'] },
      { key: 'sender_designation', label: 'Sender Designation', required: true, source: 'static', value: 'Sales Executive', example: 'Sales Executive', options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager'] },
      { key: 'sender_phone', label: 'Sender Phone', required: true, source: 'static', value: '+91 93594 75770', example: '+91 93594 75770', options: ['+91 93594 75770', '+91 712 2996167 Ext. 21'] },
      { key: 'sender_email', label: 'Sender Email', required: true, source: 'static', value: 'sales@unicircuites.com', example: 'sales@unicircuites.com', options: ['sales@unicircuites.com', 'noreply@unicircuites.live'] },
      { key: 'company_website', label: 'Company Website', required: false, source: 'static', value: 'www.unicircuites.com', example: 'www.unicircuites.com', options: ['www.unicircuites.com', 'unicircuites.com'] }
    ],
    banner_config: educationCentralBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(educationCentralBannerConfig, `
      <p>Dear {{recipient_name}},</p>
      <p>I am writing to introduce Unicircuit Engineering Services LLP — a digital transformation and ELV partner supporting central government educational institutions such as Kendriya Vidyalayas, Navodaya Vidyalayas, IITs, NITs, IIMs, AIIMS academic blocks, and central universities.</p>
      <p>Central government institutions operate at the leading edge of pedagogy, research, and student experience — and require infrastructure that matches. Unicircuit's portfolio supports the entire campus stack:</p>
      <ul>
        <li><strong>Smart Building Ecosystem</strong> — BMS, energy management, and smart lighting for academic blocks, hostels, and research labs.</li>
        <li><strong>Physical Security &amp; Surveillance</strong> — Campus CCTV with AI analytics, access control, and examination-hall monitoring.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Campus-wide Wi-Fi, structured cabling, data centre, and smart classroom AV.</li>
        <li><strong>ELV Turnkey Projects</strong> — Design-to-commissioning for new campuses, expansions, and modernisation.</li>
        <li><strong>Professional Services</strong> — AMC, managed services, and on-site support models.</li>
      </ul>
      <p>We are GeM-empanelled and conversant with CPWD and central institution procurement frameworks.</p>
      <p>May I request a brief introductory meeting {{meeting_window}} to share our credentials?</p>
      <p>Warm regards,<br>{{sender_name}}<br>{{sender_designation}} | Unicircuit Engineering Services LLP<br>{{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim())
  )},
  {
    slug: 'education-private-introduction',
    name: 'Education Private - Introduction',
    category: 'Education',
    subject: 'Smart Campus and Digital Infrastructure Solutions for Modern Educational Institutions',
    variable_fields: [
      { key: 'recipient_name', label: 'Recipient Name', required: true, source: 'recipient', value: '', example: 'Sir/Madam', options: ['Sir/Madam', 'Dear Colleague', 'Team', 'Prof. Sharma'] },
      { key: 'meeting_window', label: 'Meeting Window', required: true, source: 'static', value: 'at your convenience', example: 'at your convenience', options: ['this week', 'next week', 'in the coming days', 'at your convenience', 'early next month'] },
      { key: 'sender_name', label: 'Sender Name', required: true, source: 'static', value: 'Nidhisha Badhel', example: 'Nidhisha Badhel', options: ['Nidhisha Badhel', 'Rahul Sharma', 'Sales Team'] },
      { key: 'sender_designation', label: 'Sender Designation', required: true, source: 'static', value: 'Sales Executive', example: 'Sales Executive', options: ['Sales Executive', 'Business Development Manager', 'Regional Sales Manager', 'Key Account Manager'] },
      { key: 'sender_phone', label: 'Sender Phone', required: true, source: 'static', value: '+91 93594 75770', example: '+91 93594 75770', options: ['+91 93594 75770', '+91 712 2996167 Ext. 21'] },
      { key: 'sender_email', label: 'Sender Email', required: true, source: 'static', value: 'sales@unicircuites.com', example: 'sales@unicircuites.com', options: ['sales@unicircuites.com', 'noreply@unicircuites.live'] },
      { key: 'company_website', label: 'Company Website', required: false, source: 'static', value: 'www.unicircuites.com', example: 'www.unicircuites.com', options: ['www.unicircuites.com', 'unicircuites.com'] }
    ],
    banner_config: educationPrivateBannerConfig,
    html_body: applyServiceLinks(buildFramedEmailHtml(educationPrivateBannerConfig, `
      <p>Dear {{recipient_name}},</p>
      <p>I am writing to introduce Unicircuit Engineering Services LLP — a digital transformation and ELV partner working with private universities, deemed-to-be universities, and reputed schools across India to build smart, secure, and digitally enabled campuses.</p>
      <p>Today's parents and students choose institutions as much for the campus experience and safety as for academics. That places real demand on infrastructure — smart classrooms, hostel safety, energy efficiency, network availability, and visible security. Unicircuit's portfolio addresses each:</p>
      <ul>
        <li><strong>Smart Building Ecosystem</strong> — Classroom automation, BMS, energy management, and smart lighting across academic and residential blocks.</li>
        <li><strong>Physical Security &amp; Surveillance</strong> — Campus CCTV with analytics, access control for hostels and labs, and visitor management.</li>
        <li><strong>Digital Infrastructure &amp; Connectivity</strong> — Campus-wide high-density Wi-Fi, structured cabling, data centre, and AV for auditoriums and seminar halls.</li>
        <li><strong>ELV Turnkey Projects</strong> — Design-to-commissioning for greenfield campuses and major upgrades.</li>
        <li><strong>Professional Services</strong> — AMC, managed services, and on-site helpdesk support.</li>
      </ul>
      <p>We work flexibly through direct engagement, EPC partnerships, and OEM tie-ups.</p>
      <p>Could we connect for a brief introductory meeting {{meeting_window}} to share relevant work?</p>
      <p>Warm regards,<br>{{sender_name}}<br>{{sender_designation}} | Unicircuit Engineering Services LLP<br>{{sender_phone}} | {{sender_email}} | {{company_website}}</p>
    `.trim())
  )}
];

module.exports = {
  seedEmailTemplates
};
