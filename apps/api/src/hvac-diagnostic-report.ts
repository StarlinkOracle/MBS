type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function display(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  return escapeHtml(value);
}

function formatDate(value: unknown): string {
  if (!value) {
    return '—';
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return display(value);
  }
  return escapeHtml(
    new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date),
  );
}

function section(title: string, content: string): string {
  return `<section><h2>${escapeHtml(title)}</h2>${content}</section>`;
}

function definitionGrid(items: Array<[string, unknown]>): string {
  return `<dl class="definition-grid">${items
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${display(value)}</dd></div>`)
    .join('')}</dl>`;
}

function measurementRows(report: UnknownRecord): string {
  const raw = array(report.measurements).map(record);
  const derived = array(report.derivedMeasurements).map(record);

  const rawRows = raw.map((measurement) => {
    const value = measurement.canonicalValue ?? measurement.value ?? measurement.textValue;
    const unit = measurement.canonicalUnit ?? measurement.unit ?? '';
    return `<tr>
      <td>${display(measurement.label ?? measurement.measurementKey)}</td>
      <td>${display(value)} ${escapeHtml(unit)}</td>
      <td>${display(measurement.stage ?? 'INITIAL')}</td>
      <td>${measurement.verified ? 'Verified' : 'Recorded'}</td>
    </tr>`;
  });

  const derivedRows = derived.map((measurement) => `<tr class="derived">
    <td>${display(measurement.label ?? measurement.key ?? measurement.measurementKey)} <span>Calculated</span></td>
    <td>${display(measurement.value)} ${display(measurement.unit, '')}</td>
    <td>${display(measurement.stage ?? 'INITIAL')}</td>
    <td>${display(measurement.calculationVersion, 'Deterministic engine')}</td>
  </tr>`);

  if (rawRows.length + derivedRows.length === 0) {
    return '<p class="muted">No measurements were recorded.</p>';
  }

  return `<div class="table-wrap"><table>
    <thead><tr><th>Measurement</th><th>Value</th><th>Stage</th><th>Evidence</th></tr></thead>
    <tbody>${[...rawRows, ...derivedRows].join('')}</tbody>
  </table></div>`;
}

function findingCards(report: UnknownRecord): string {
  const findings = array(report.findings).map(record);
  if (findings.length === 0) {
    return '<p class="muted">No diagnostic findings were recorded.</p>';
  }

  return `<div class="finding-list">${findings
    .map((finding) => {
      const nextTest = record(finding.nextTest);
      const evidence = array(finding.evidence).map(String);
      const missing = array(finding.missingEvidence).map(String);
      return `<article class="finding ${escapeHtml(String(finding.severity ?? 'INFO').toLowerCase())}">
        <div class="finding-head">
          <h3>${display(finding.title)}</h3>
          <span>${display(finding.supportLevel)}</span>
        </div>
        <p>${display(finding.summary)}</p>
        ${
          evidence.length
            ? `<h4>Evidence</h4><ul>${evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
            : ''
        }
        ${
          missing.length
            ? `<h4>Missing or conflicting evidence</h4><ul>${missing.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
            : ''
        }
        ${
          Object.keys(nextTest).length
            ? `<div class="next-test"><strong>Next verification:</strong> ${display(nextTest.instructions ?? nextTest.title)}</div>`
            : ''
        }
      </article>`;
    })
    .join('')}</div>`;
}

function referenceRows(report: UnknownRecord): string {
  const references = array(report.references).map(record);
  if (references.length === 0) {
    return '<p class="muted">No model-matched manufacturer reference was available. Generic field interpretation must not be presented as an OEM requirement.</p>';
  }

  return `<div class="table-wrap"><table>
    <thead><tr><th>Metric</th><th>Target / Range</th><th>Match</th><th>Source</th></tr></thead>
    <tbody>${references
      .map((reference) => {
        const target =
          reference.targetValue !== null && reference.targetValue !== undefined
            ? `${reference.targetValue}${reference.tolerance !== null && reference.tolerance !== undefined ? ` ± ${reference.tolerance}` : ''}`
            : `${reference.minValue ?? '—'} to ${reference.maxValue ?? '—'}`;
        const source = [
          reference.documentTitle,
          reference.documentNumber,
          reference.revision ? `rev. ${reference.revision}` : null,
          reference.pageNumber ? `p. ${reference.pageNumber}` : null,
        ]
          .filter(Boolean)
          .join(' · ');
        return `<tr>
          <td>${display(reference.metricKey)}</td>
          <td>${display(target)} ${display(reference.unit, '')}</td>
          <td>${display(reference.matchLevel)}</td>
          <td>${display(source)}</td>
        </tr>`;
      })
      .join('')}</tbody>
  </table></div>`;
}

export function renderHvacDiagnosticReportHtml(
  reportValue: unknown,
  kind: 'TECHNICAL' | 'CUSTOMER',
): string {
  const report = record(reportValue);
  const session = record(report.session);
  const customer = record(report.customer);
  const job = record(report.job);
  const technician = record(report.technician);
  const equipment = array(report.equipment).map(record);

  const equipmentCards = equipment.length
    ? `<div class="equipment-grid">${equipment
        .map(
          (component) => `<article>
            <h3>${display(component.componentType, 'Equipment')}</h3>
            ${definitionGrid([
              ['Manufacturer', component.manufacturer],
              ['Model', component.model],
              ['Serial', component.serial],
              ['Refrigerant', component.refrigerant],
              ['Metering device', component.meteringDevice],
              ['Voltage / phase', [component.voltage, component.phase].filter(Boolean).join(' / ')],
            ])}
          </article>`,
        )
        .join('')}</div>`
    : '<p class="muted">No equipment components were recorded.</p>';

  const finalDiagnosis = session.finalDiagnosis ?? report.finalDiagnosis;
  const title = kind === 'CUSTOMER' ? 'Service Diagnostic Summary' : 'HVAC Technical Diagnostic Report';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #eef3f8; color: #142033; }
    .report { width: min(980px, calc(100% - 24px)); margin: 18px auto; background: white; border-radius: 16px; box-shadow: 0 12px 36px rgba(20,32,51,.12); overflow: hidden; }
    header { background: #10233e; color: white; padding: 28px 32px; }
    header h1 { margin: 0; font-size: 26px; }
    header p { margin: 8px 0 0; color: #c8d7e9; }
    main { padding: 24px 32px 36px; }
    section { margin: 0 0 28px; break-inside: avoid; }
    h2 { margin: 0 0 13px; font-size: 18px; color: #10233e; border-bottom: 2px solid #e8eef5; padding-bottom: 8px; }
    h3 { margin: 0 0 8px; font-size: 15px; }
    h4 { margin: 12px 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
    p, li, td, dd { font-size: 13px; line-height: 1.55; }
    .definition-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin: 0; }
    .definition-grid div { border: 1px solid #dce5ef; border-radius: 9px; padding: 10px; }
    dt { color: #61738a; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
    dd { margin: 3px 0 0; font-weight: 600; }
    .equipment-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .equipment-grid article { border: 1px solid #dce5ef; border-radius: 10px; padding: 14px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f0f5fa; color: #455a73; text-align: left; font-size: 11px; text-transform: uppercase; padding: 9px; }
    td { border-bottom: 1px solid #e4ebf2; padding: 9px; vertical-align: top; }
    tr.derived td:first-child span { display: inline-block; margin-left: 5px; padding: 2px 5px; border-radius: 999px; background: #e5f4f0; color: #087b65; font-size: 9px; }
    .finding-list { display: grid; gap: 12px; }
    .finding { border: 1px solid #dce5ef; border-left: 5px solid #5c789a; border-radius: 10px; padding: 14px; break-inside: avoid; }
    .finding.safety { border-left-color: #bf2d3c; }
    .finding.repair { border-left-color: #cf7b18; }
    .finding.attention { border-left-color: #dba90b; }
    .finding-head { display: flex; justify-content: space-between; gap: 12px; }
    .finding-head span { white-space: nowrap; color: #54677e; font-size: 10px; font-weight: 700; }
    .finding p { margin: 5px 0; }
    .finding ul { margin: 4px 0 0; padding-left: 20px; }
    .next-test { margin-top: 10px; padding: 9px 11px; border-radius: 8px; background: #eef6ff; color: #173b63; font-size: 12px; }
    .diagnosis { padding: 16px; border-radius: 10px; background: ${finalDiagnosis ? '#e9f8f3' : '#fff7df'}; border: 1px solid ${finalDiagnosis ? '#a7dece' : '#ead28f'}; }
    .muted { color: #697b90; font-style: italic; }
    .disclaimer { margin-top: 30px; padding: 12px; background: #f6f8fb; border-radius: 8px; color: #586b82; font-size: 11px; }
    .print-button { position: fixed; right: 18px; bottom: 18px; border: 0; border-radius: 999px; padding: 12px 18px; background: #137c6b; color: white; font-weight: 700; box-shadow: 0 6px 18px rgba(0,0,0,.2); cursor: pointer; }
    @media (max-width: 640px) { header, main { padding-left: 18px; padding-right: 18px; } .report { width: 100%; margin: 0; border-radius: 0; } .finding-head { display: block; } }
    @media print { body { background: white; } .report { width: 100%; margin: 0; box-shadow: none; border-radius: 0; } .print-button { display: none; } section { break-inside: auto; } .finding, .equipment-grid article { break-inside: avoid; } }
  </style>
</head>
<body>
  <article class="report">
    <header>
      <h1>${escapeHtml(title)}</h1>
      <p>Russell Comfort Solutions · Generated ${formatDate(report.generatedAt)}</p>
    </header>
    <main>
      ${section('Service call', definitionGrid([
        ['Customer', customer.fullName],
        ['Address', [customer.addressLine1, customer.city, customer.state, customer.postalCode].filter(Boolean).join(', ')],
        ['Job', job.title ?? job.id],
        ['Job status', job.status],
        ['Technician', technician.name ?? technician.email],
        ['Started', formatDate(session.startedAt)],
        ['Operating mode', session.operatingMode],
        ['Altitude', session.altitudeFt ? `${session.altitudeFt} ft` : null],
      ]))}
      ${section('Customer complaint', `<p>${display(session.complaintText, 'No complaint was recorded.')}</p>`)}
      ${section('Equipment', equipmentCards)}
      ${section('Measurements and calculated results', measurementRows(report))}
      ${section(kind === 'CUSTOMER' ? 'What we found' : 'Diagnostic findings and verification path', findingCards(report))}
      ${section('Manufacturer references', referenceRows(report))}
      ${section('Technician-confirmed outcome', `<div class="diagnosis"><strong>${finalDiagnosis ? 'Final diagnosis' : 'Status'}</strong><p>${display(finalDiagnosis, session.status === 'INCONCLUSIVE' ? 'The diagnostic was recorded as inconclusive.' : 'A final diagnosis has not yet been confirmed by the technician.')}</p></div>`)}
      <div class="disclaimer">${display(report.disclaimer, 'Diagnostic guidance supports evidence collection. The technician remains responsible for safety, verification, and the final diagnosis.')}</div>
    </main>
  </article>
  <button class="print-button" onclick="window.print()">Print / Save PDF</button>
</body>
</html>`;
}
