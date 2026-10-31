#!/usr/bin/env node
// Updates the block between <!-- CONTRIBUTIONS:START --> and <!-- CONTRIBUTIONS:END -->
// in README.md with GitHub contribution stats for the token's owner (GraphQL `viewer`).
// No dependencies; needs Node 20+ (global fetch).
// Private repository names are never written: private Fors-Corp repos are aggregated.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const README = path.resolve(__dirname, '..', 'README.md');
const START = '<!-- CONTRIBUTIONS:START -->';
const END = '<!-- CONTRIBUTIONS:END -->';
const ORG = 'Fors-Corp';
const TZ = 'Europe/Madrid';
const ENDPOINT = 'https://api.github.com/graphql';
const TOKEN = process.env.CONTRIBUTIONS_TOKEN;

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

async function graphql(query, variables = {}) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'marcfs31-readme-contributions',
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    fail(`GraphQL request failed: ${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) fail(`GraphQL HTTP ${res.status}: ${text.slice(0, 500)}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail(`GraphQL returned non-JSON: ${text.slice(0, 500)}`);
  }
  if (body.errors && body.errors.length) {
    fail(`GraphQL errors: ${JSON.stringify(body.errors).slice(0, 1000)}`);
  }
  if (!body.data || !body.data.viewer) fail('GraphQL response has no data.viewer');
  return body.data;
}

const COLLECTION_FIELDS = `
  totalCommitContributions
  totalPullRequestContributions
  totalIssueContributions
  totalPullRequestReviewContributions
  restrictedContributionsCount
  contributionCalendar { totalContributions }
  commitContributionsByRepository(maxRepositories: 100) {
    repository { name isPrivate owner { login } }
    contributions { totalCount }
  }
`;

const DEFAULT_QUERY = `
  query {
    viewer {
      login
      contributionsCollection {
        startedAt
        endedAt
        contributionYears
        ${COLLECTION_FIELDS}
      }
    }
  }
`;

const RANGE_QUERY = `
  query ($from: DateTime!, $to: DateTime!) {
    viewer {
      contributionsCollection(from: $from, to: $to) {
        ${COLLECTION_FIELDS}
      }
    }
  }
`;

const METRICS = [
  ['Commits', 'totalCommitContributions'],
  ['Pull requests', 'totalPullRequestContributions'],
  ['Issues', 'totalIssueContributions'],
  ['Pull request reviews', 'totalPullRequestReviewContributions'],
  ['Private contributions (restricted)', 'restrictedContributionsCount'],
];

function num(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`Missing or invalid number for ${label}`);
  }
  return value;
}

function summarize(collection) {
  const totals = {};
  for (const [, key] of METRICS) totals[key] = num(collection[key], key);
  totals.calendar = num(collection.contributionCalendar?.totalContributions, 'contributionCalendar.totalContributions');
  const org = { publicRepos: new Map(), privateRepos: new Set(), privateCommits: 0 };
  for (const entry of collection.commitContributionsByRepository || []) {
    const repo = entry.repository;
    if (!repo || !repo.owner || repo.owner.login !== ORG) continue;
    const count = num(entry.contributions?.totalCount, `commits in a ${ORG} repository`);
    if (repo.isPrivate) {
      org.privateRepos.add(repo.name); // kept in memory only, never written
      org.privateCommits += count;
    } else {
      org.publicRepos.set(repo.name, (org.publicRepos.get(repo.name) || 0) + count);
    }
  }
  return { totals, org };
}

function merge(a, b) {
  const totals = {};
  for (const key of Object.keys(a.totals)) totals[key] = a.totals[key] + b.totals[key];
  const publicRepos = new Map(a.org.publicRepos);
  for (const [name, count] of b.org.publicRepos) publicRepos.set(name, (publicRepos.get(name) || 0) + count);
  const privateRepos = new Set([...a.org.privateRepos, ...b.org.privateRepos]);
  return { totals, org: { publicRepos, privateRepos, privateCommits: a.org.privateCommits + b.org.privateCommits } };
}

const fmt = (n) => n.toLocaleString('en-US');

function today() {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function render(lastYear, allTime, range, firstYear) {
  const lines = [];
  lines.push(`| | Last 12 months | All time (since ${firstYear}) |`);
  lines.push('| --- | ---: | ---: |');
  for (const [label, key] of METRICS) {
    lines.push(`| ${label} | ${fmt(lastYear.totals[key])} | ${fmt(allTime.totals[key])} |`);
  }
  lines.push(`| **Total contributions** | **${fmt(lastYear.totals.calendar)}** | **${fmt(allTime.totals.calendar)}** |`);
  lines.push('');
  lines.push(`**Commits in [Fors Corp](https://github.com/${ORG}) repositories**`);
  lines.push('');
  lines.push('| Repository | Last 12 months | All time |');
  lines.push('| --- | ---: | ---: |');
  const names = [...allTime.org.publicRepos.keys()].sort(
    (x, y) => (allTime.org.publicRepos.get(y) - allTime.org.publicRepos.get(x)) || x.localeCompare(y),
  );
  for (const name of names) {
    const ly = lastYear.org.publicRepos.get(name) || 0;
    lines.push(`| [${name}](https://github.com/${ORG}/${name}) | ${fmt(ly)} | ${fmt(allTime.org.publicRepos.get(name))} |`);
  }
  if (allTime.org.privateRepos.size > 0) {
    lines.push(
      `| 🔒 Private repositories (${lastYear.org.privateRepos.size} / ${allTime.org.privateRepos.size}) | ${fmt(lastYear.org.privateCommits)} | ${fmt(allTime.org.privateCommits)} |`,
    );
  }
  if (names.length === 0 && allTime.org.privateRepos.size === 0) {
    lines.push('| _No commits found_ | 0 | 0 |');
  }
  lines.push('');
  lines.push(
    `Last 12 months: ${range.startedAt.slice(0, 10)} to ${range.endedAt.slice(0, 10)} (UTC). Totals include private work; private repository names are not shown.`,
  );
  return lines.join('\n');
}

async function main() {
  if (!TOKEN) fail('CONTRIBUTIONS_TOKEN is not set');

  const readme = fs.readFileSync(README, 'utf8');
  const startIdx = readme.indexOf(START);
  const endIdx = readme.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    fail(`README.md must contain ${START} followed by ${END}`);
  }

  const base = await graphql(DEFAULT_QUERY);
  const cc = base.viewer.contributionsCollection;
  if (!cc || !Array.isArray(cc.contributionYears) || cc.contributionYears.length === 0) {
    fail('contributionYears missing from GraphQL response');
  }
  const lastYear = summarize(cc);

  const now = new Date();
  const years = [...cc.contributionYears].sort((a, b) => a - b);
  let allTime = null;
  for (const year of years) {
    const from = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
    const to = yearEnd > now ? now : yearEnd;
    const data = await graphql(RANGE_QUERY, { from: from.toISOString(), to: to.toISOString() });
    const s = summarize(data.viewer.contributionsCollection || fail(`No contributionsCollection for ${year}`));
    allTime = allTime ? merge(allTime, s) : s;
  }

  const table = render(lastYear, allTime, cc, years[0]);
  const block = `${START}\n${table}\n\n_Last updated: ${today()} (${TZ})_\n${END}`;

  // Compare without the date line so the README only changes when the stats change.
  const stripDate = (s) => s.replace(/^_?Last updated: .*$/m, '');
  const current = readme.slice(startIdx, endIdx + END.length);
  if (stripDate(current) === stripDate(block)) {
    console.log('Contribution stats unchanged; README.md left as is.');
    return;
  }
  const updated = readme.slice(0, startIdx) + block + readme.slice(endIdx + END.length);
  fs.writeFileSync(README, updated);
  console.log(`README.md updated for ${base.viewer.login}.`);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
