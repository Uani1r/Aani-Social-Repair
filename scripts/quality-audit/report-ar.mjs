#!/usr/bin/env node
/**
 * AANI Quality Audit — مولّد التقرير العربي.
 *
 * يقرأ نتائج Playwright بصيغة JSON (quality-audit-results/results.json) وينتج:
 *   - quality-audit-results/report-ar.html  : تقرير عربي كامل من اليمين إلى اليسار.
 *   - quality-audit-results/summary-ar.md    : ملخّص Markdown.
 *   - ملخّص إضافي في GitHub Actions Summary عند وجود GITHUB_STEP_SUMMARY.
 *
 * لا يتصل بأي خدمة خارجية ولا يعتمد على أي حزمة إضافية.
 * عند غياب ملف النتائج يُنشئ تقريراً يوضح ذلك وينتهي بنجاح، حتى لا يفشل
 * خطوة رفع التقرير (if: always()) بسبب غياب النتائج.
 */

import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RESULTS_DIR = path.resolve('quality-audit-results');
const RESULTS_FILE = path.join(RESULTS_DIR, 'results.json');
const REPORT_FILE = path.join(RESULTS_DIR, 'report-ar.html');
const SUMMARY_FILE = path.join(RESULTS_DIR, 'summary-ar.md');
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, 'screenshots');

const STATUS_LABELS = {
  passed: 'نجح',
  failed: 'فشل',
  timedOut: 'تجاوز المهلة',
  interrupted: 'توقف',
  skipped: 'تم تخطيه',
  unknown: 'غير معروف',
};

const STATUS_COLORS = {
  passed: '#16a34a',
  failed: '#dc2626',
  timedOut: '#d97706',
  interrupted: '#9333ea',
  skipped: '#6b7280',
  unknown: '#6b7280',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '0ms';
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function collectSpecs(suites, out = []) {
  for (const suite of Array.isArray(suites) ? suites : []) {
    if (Array.isArray(suite?.specs)) out.push(...suite.specs);
    collectSpecs(suite?.suites, out);
  }
  return out;
}

function buildRows(report) {
  const rows = [];

  for (const spec of collectSpecs(report?.suites)) {
    const file = spec.file ?? spec.title ?? '';
    for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
      const results = Array.isArray(test.results) ? test.results : [];
      const last = results[results.length - 1] ?? {};
      const duration = results.reduce((total, result) => total + (Number(result?.duration) || 0), 0);
      const status = last.status ?? (test.status === 'skipped' ? 'skipped' : 'unknown');
      const error = String(last.error?.message ?? '')
        .replace(/\u001b\[[0-9;]*m/g, '')
        .trim();

      rows.push({
        file,
        title: spec.title ?? '',
        project: test.projectName ?? '',
        status,
        duration,
        error,
      });
    }
  }

  return rows;
}

function buildTotals(rows) {
  const totals = { total: rows.length, passed: 0, failed: 0, skipped: 0, other: 0 };

  for (const row of rows) {
    if (row.status === 'passed') totals.passed += 1;
    else if (row.status === 'skipped') totals.skipped += 1;
    else if (row.status === 'failed' || row.status === 'timedOut' || row.status === 'interrupted') totals.failed += 1;
    else totals.other += 1;
  }

  return totals;
}

function buildProjectTotals(rows) {
  const byProject = new Map();

  for (const row of rows) {
    const key = row.project || '—';
    const entry = byProject.get(key) ?? { total: 0, passed: 0, failed: 0, skipped: 0 };
    entry.total += 1;
    if (row.status === 'passed') entry.passed += 1;
    else if (row.status === 'skipped') entry.skipped += 1;
    else entry.failed += 1;
    byProject.set(key, entry);
  }

  return [...byProject.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([project, counts]) => ({ project, ...counts }));
}

async function listScreenshots() {
  try {
    const entries = await readdir(SCREENSHOTS_DIR, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function buildEnvironment(report) {
  const projects = (report?.config?.projects ?? [])
    .map(project => project?.name)
    .filter(Boolean);

  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '';

  return {
    projects,
    commit: (process.env.GITHUB_SHA ?? '').slice(0, 12),
    ref: process.env.GITHUB_REF_NAME ?? '',
    runUrl,
    generatedAt: new Date().toISOString(),
  };
}

function statusBadge(status) {
  const key = STATUS_LABELS[status] ? status : 'unknown';
  return `<span class="badge" style="background:${STATUS_COLORS[key]}">${escapeHtml(STATUS_LABELS[key])}</span>`;
}

function renderHtml({ rows, totals, projectTotals, environment, screenshots, globalErrors, missingResults }) {
  const failures = rows.filter(row => row.error);

  const rowsHtml = rows.length
    ? rows
        .map(
          row => `<tr>
        <td dir="ltr" class="mono">${escapeHtml(row.file)}</td>
        <td>${escapeHtml(row.title)}</td>
        <td dir="ltr" class="mono">${escapeHtml(row.project)}</td>
        <td>${statusBadge(row.status)}</td>
        <td class="mono">${formatDuration(row.duration)}</td>
      </tr>`,
        )
        .join('\n')
    : '';

  const projectRowsHtml = projectTotals
    .map(
      item => `<tr>
        <td dir="ltr" class="mono">${escapeHtml(item.project)}</td>
        <td class="mono">${item.total}</td>
        <td class="mono ok">${item.passed}</td>
        <td class="mono bad">${item.failed}</td>
        <td class="mono muted">${item.skipped}</td>
      </tr>`,
    )
    .join('\n');

  const failuresHtml = failures.length
    ? failures
        .map(
          row => `<article class="failure">
        <h3>${escapeHtml(row.title)}</h3>
        <p class="meta" dir="ltr">${escapeHtml(row.project)} • ${escapeHtml(row.file)}</p>
        <pre dir="ltr">${escapeHtml(row.error)}</pre>
      </article>`,
        )
        .join('\n')
    : '<p class="empty">لا توجد أخطاء مسجّلة في هذا التشغيل.</p>';

  const globalErrorsHtml = globalErrors.length
    ? `<section>
      <h2>أخطاء عامة في التشغيل</h2>
      ${globalErrors
        .map(error => `<pre dir="ltr">${escapeHtml(error)}</pre>`)
        .join('\n')}
    </section>`
    : '';

  const screenshotsHtml = screenshots.length
    ? `<section>
      <h2>لقطات الشاشة</h2>
      <ul class="shots">
        ${screenshots
          .map(
            name =>
              `<li><a href="screenshots/${encodeURIComponent(name)}" target="_blank" rel="noreferrer">${escapeHtml(name)}</a></li>`,
          )
          .join('\n')}
      </ul>
    </section>`
    : '';

  const missingHtml = missingResults
    ? `<section class="notice">
      <h2>لم تُعثر على نتائج Playwright</h2>
      <p>لم يوجد الملف <span dir="ltr" class="mono">quality-audit-results/results.json</span>، لذلك لا يوجد ما يُعرض. تأكد من تشغيل <span dir="ltr" class="mono">pnpm run audit</span> قبل توليد التقرير.</p>
    </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>تقرير AANI Quality Audit</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 18px 48px;
    background: #0b0c10; color: #e8e8ea;
    font: 15px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "Cairo", "Tahoma", sans-serif;
  }
  main { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 6px; }
  h2 { font-size: 18px; margin: 32px 0 12px; }
  h3 { font-size: 15px; margin: 0 0 4px; }
  .sub { color: #9aa0aa; font-size: 13px; margin: 0 0 22px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .card { background: #14161c; border: 1px solid #242833; border-radius: 14px; padding: 14px 16px; }
  .card .label { color: #9aa0aa; font-size: 12px; }
  .card .value { font-size: 26px; font-weight: 700; line-height: 1.3; }
  .ok { color: #4ade80; } .bad { color: #f87171; } .muted { color: #8b90a0; }
  table { width: 100%; border-collapse: collapse; background: #14161c; border-radius: 14px; overflow: hidden; }
  th, td { padding: 10px 12px; text-align: right; border-bottom: 1px solid #22252f; font-size: 13px; }
  th { background: #191c24; color: #b9bfcc; font-weight: 600; }
  tr:last-child td { border-bottom: 0; }
  .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
  .badge { color: #fff; border-radius: 999px; padding: 2px 10px; font-size: 11px; white-space: nowrap; }
  .failure { background: #14161c; border: 1px solid #3b2327; border-radius: 14px; padding: 14px 16px; margin-bottom: 12px; }
  .failure .meta { color: #9aa0aa; font-size: 12px; margin: 0 0 8px; }
  pre { background: #0e1014; border: 1px solid #22252f; border-radius: 10px; padding: 12px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .empty { color: #8b90a0; }
  .notice { background: #1b1610; border: 1px solid #3d2f16; border-radius: 14px; padding: 16px; }
  .shots { background: #14161c; border: 1px solid #242833; border-radius: 14px; padding: 14px 16px 14px 32px; margin: 0; }
  .shots a { color: #93c5fd; }
  footer { margin-top: 36px; color: #7c828f; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>تقرير AANI Quality Audit</h1>
  <p class="sub">
    فحص آلي لواجهة تطبيق آني على Chromium و WebKit مع محاكاة iPhone — تقرير تشغيل فقط، ولا يتصل بـ Supabase أو بأي خدمة خارجية.
  </p>

  ${missingHtml}

  <div class="cards">
    <div class="card"><div class="label">إجمالي الاختبارات</div><div class="value">${totals.total}</div></div>
    <div class="card"><div class="label">نجح</div><div class="value ok">${totals.passed}</div></div>
    <div class="card"><div class="label">فشل</div><div class="value bad">${totals.failed}</div></div>
    <div class="card"><div class="label">تم تخطيه</div><div class="value muted">${totals.skipped}</div></div>
    <div class="card"><div class="label">غير محسوم</div><div class="value muted">${totals.other}</div></div>
  </div>

  <h2>ملخّص البيئات</h2>
  <table>
    <thead><tr><th>البيئة</th><th>الإجمالي</th><th>نجح</th><th>فشل</th><th>تم تخطيه</th></tr></thead>
    <tbody>${projectRowsHtml || '<tr><td colspan="5" class="empty">لا توجد نتائج.</td></tr>'}</tbody>
  </table>

  <h2>تفاصيل الاختبارات</h2>
  <table>
    <thead><tr><th>الملف</th><th>الاختبار</th><th>البيئة</th><th>الحالة</th><th>المدة</th></tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="5" class="empty">لا توجد نتائج.</td></tr>'}</tbody>
  </table>

  <h2>الأخطاء</h2>
  ${failuresHtml}

  ${globalErrorsHtml}
  ${screenshotsHtml}

  <footer>
    <p>بيئات الفحص: ${escapeHtml(environment.projects.join('، ') || '—')}</p>
    <p>الالتزام: <span dir="ltr">${escapeHtml(environment.commit || '—')}</span> — الفرع: <span dir="ltr">${escapeHtml(environment.ref || '—')}</span></p>
    ${environment.runUrl ? `<p><a href="${escapeHtml(environment.runUrl)}">رابط التشغيل على GitHub Actions</a></p>` : ''}
    <p>وُلّد هذا التقرير في <span dir="ltr">${escapeHtml(environment.generatedAt)}</span>.</p>
    <p>هذا التقرير يعكس نتيجة التشغيل الآلي فقط؛ لا يثبت عملاً صحيحاً لتجربة كاملة على iPhone حقيقي.</p>
  </footer>
</main>
</body>
</html>
`;
}

function renderMarkdown({ rows, totals, projectTotals, environment, globalErrors, missingResults }) {
  const lines = [];

  lines.push('### تقرير AANI Quality Audit');
  lines.push('');
  lines.push(
    `- الإجمالي: **${totals.total}** — نجح: **${totals.passed}** — فشل: **${totals.failed}** — تم تخطيه: **${totals.skipped}**`,
  );
  lines.push(`- البيئات: ${environment.projects.map(name => `\`${name}\``).join('، ') || '—'}`);
  if (environment.commit) lines.push(`- الالتزام: \`${environment.commit}\``);
  if (environment.runUrl) lines.push(`- التشغيل: ${environment.runUrl}`);
  lines.push('');

  if (missingResults) {
    lines.push('> لم تُعثر على ملف النتائج `quality-audit-results/results.json`، لذلك لا توجد تفاصيل.');
    lines.push('');
  }

  if (projectTotals.length) {
    lines.push('| البيئة | الإجمالي | نجح | فشل | تم تخطيه |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const item of projectTotals) {
      lines.push(`| ${item.project} | ${item.total} | ${item.passed} | ${item.failed} | ${item.skipped} |`);
    }
    lines.push('');
  }

  const failures = rows.filter(row => row.error);
  if (failures.length) {
    lines.push('#### أخطاء');
    lines.push('');
    for (const row of failures) {
      lines.push(`- **${row.title}** (\`${row.project}\` — \`${row.file}\`)`);
      lines.push('  ```');
      for (const line of row.error.split('\n').slice(0, 12)) lines.push(`  ${line}`);
      lines.push('  ```');
    }
    lines.push('');
  }

  if (globalErrors.length) {
    lines.push('#### أخطاء عامة');
    lines.push('');
    for (const error of globalErrors) {
      lines.push('```');
      lines.push(...error.split('\n').slice(0, 12));
      lines.push('```');
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  let report = null;
  try {
    report = JSON.parse(await readFile(RESULTS_FILE, 'utf8'));
  } catch {
    report = null;
  }

  const missingResults = report === null;
  const rows = missingResults ? [] : buildRows(report);
  const totals = buildTotals(rows);
  const projectTotals = buildProjectTotals(rows);
  const environment = buildEnvironment(report);
  const screenshots = await listScreenshots();
  const globalErrors = (Array.isArray(report?.errors) ? report.errors : [])
    .map(error => String(error?.message ?? error ?? '').trim())
    .filter(Boolean);

  const html = renderHtml({ rows, totals, projectTotals, environment, screenshots, globalErrors, missingResults });
  const markdown = renderMarkdown({ rows, totals, projectTotals, environment, globalErrors, missingResults });

  await writeFile(REPORT_FILE, html, 'utf8');
  await writeFile(SUMMARY_FILE, markdown, 'utf8');

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, 'utf8');
    } catch {
      // الملخّص الإضافي ليس حرجاً — التقرير نفسه كُتب بالفعل.
    }
  }

  console.log(`AANI Quality Audit: ${totals.total} اختبار — نجح ${totals.passed} — فشل ${totals.failed} — تخطّى ${totals.skipped}`);
  console.log(`التقرير العربي: ${path.relative(process.cwd(), REPORT_FILE)}`);
}

await main();
