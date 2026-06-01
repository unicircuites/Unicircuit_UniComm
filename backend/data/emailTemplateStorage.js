const { getBannerPreset, buildFramedEmailHtml } = require('./messageBanners');

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
    html_body: buildFramedEmailHtml(healthcareBannerConfig, healthcareBodyHtml)
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
    html_body: buildFramedEmailHtml(forestBannerConfig, forestBodyHtml)
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
    html_body: buildFramedEmailHtml(defenceBannerConfig, defenceBodyHtml)
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
    html_body: buildFramedEmailHtml(defencePsuBannerConfig, defencePsuBodyHtml)
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
    html_body: buildFramedEmailHtml(bankingBannerConfig, bankingBodyHtml)
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
    html_body: buildFramedEmailHtml(agricultureBannerConfig, agricultureBodyHtml)
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
    html_body: buildFramedEmailHtml(foodProcessingBannerConfig, foodProcessingBodyHtml)
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
    html_body: buildFramedEmailHtml(coalMiningBannerConfig, coalMiningBodyHtml)
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
    html_body: buildFramedEmailHtml(powerGenerationPsuBannerConfig, powerGenerationPsuBodyHtml)
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
    html_body: buildFramedEmailHtml(powerGenerationStatePsuBannerConfig, powerGenerationStatePsuBodyHtml)
  }
];

module.exports = {
  seedEmailTemplates
};
