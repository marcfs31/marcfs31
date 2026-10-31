#!/usr/bin/env node
// Updates the block between <!-- CONTRIBUTIONS:START --> and <!-- CONTRIBUTIONS:END -->
// in README.md with a compact summary of GitHub contributions for the token's owner
// (GraphQL `viewer`). Totals use contributionCalendar.totalContributions, the same
// figure as the profile graph (public + private, personal + organization work).
// No dependencies; needs Node 20+ (global fetch). No repository names are queried or written.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const README = path.resolve(__dirname, '..', 'README.md');
const START = '<!-- CONTRIBUTIONS:START -->';
const END = '<!-- CONTRIBUTIONS:END -->';
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

const DEFAULT_QUERY = `
  query {
    viewer {
      login
      contributionsCollection {
        contributionYears
        totalCommitContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        restrictedContributionsCount
        contributionCalendar { totalContributions }
      }
    }
  }
`;

const RANGE_QUERY = `
  query ($from: DateTime!, $to: DateTime!) {
    viewer {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar { totalContributions }
      }
    }
  }
`;

function num(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`Missing or invalid number for ${label}`);
  }
  return value;
}

const fmt = (n) => n.toLocaleString('en-US');

function today() {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
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
  const lastYear = {
    total: num(cc.contributionCalendar?.totalContributions, 'contributionCalendar.totalContributions'),
    commits: num(cc.totalCommitContributions, 'totalCommitContributions'),
    pullRequests: num(cc.totalPullRequestContributions, 'totalPullRequestContributions'),
    reviews: num(cc.totalPullRequestReviewContributions, 'totalPullRequestReviewContributions'),
    private: num(cc.restrictedContributionsCount, 'restrictedContributionsCount'),
  };

  // All time = sum of each calendar year's graph total (GraphQL ranges are capped at one year).
  const now = new Date();
  let allTime = 0;
  for (const year of [...cc.contributionYears].sort((a, b) => a - b)) {
    const from = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
    const to = yearEnd > now ? now : yearEnd;
    const data = await graphql(RANGE_QUERY, { from: from.toISOString(), to: to.toISOString() });
    allTime += num(
      data.viewer.contributionsCollection?.contributionCalendar?.totalContributions,
      `contributionCalendar.totalContributions for ${year}`,
    );
  }

  const block = [
    START,
    `**${fmt(lastYear.total)}** contributions in the last 12 months · **${fmt(allTime)}** all time`,
    '',
    `Commits ${fmt(lastYear.commits)} · Pull requests ${fmt(lastYear.pullRequests)} · Reviews ${fmt(lastYear.reviews)} · Private ${fmt(lastYear.private)} (last 12 months, public + private, personal + Fors Corp)`,
    '',
    `_Last updated: ${today()} (${TZ})_`,
    END,
  ].join('\n');

  // Compare without the date line so the README only changes when the numbers change.
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
