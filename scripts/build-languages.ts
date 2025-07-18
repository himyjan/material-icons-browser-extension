import 'dotenv/config';
import { Octokit } from '@octokit/core';
import * as fs from 'fs-extra';
import stringify from 'json-stable-stringify';
import { generateManifest, Manifest } from 'material-icon-theme';
import * as path from 'path';

interface LanguageContribution {
  id: string;
  extensions?: string[];
  filenames?: string[];
  filenamePatterns?: string[];
}

interface Language {
  id: string;
  extensions: string[];
  filenames: string[];
}

const vsDataPath: string = path.resolve(__dirname, '..', 'data');
const srcPath: string = path.resolve(__dirname, '..', 'src');

let index: number = 0;
let total: number;
let manifest: Manifest;
const items: Array<[string, string]> = [];
const contributions: LanguageContribution[] = [];
const languages: Language[] = [];

const resultsPerPage: number = 100; // max 100
const octokit: Octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});
// biome-ignore lint/style/useNamingConvention: per_page is a valid name
const query: { page: number; per_page: number; q: string } = {
  page: 0,
  // biome-ignore lint/style/useNamingConvention: per_page is a valid name
  per_page: resultsPerPage,
  q: 'contributes languages filename:package.json repo:microsoft/vscode',
};
const GITHUB_RATELIMIT: number = 6000;

async function main(): Promise<void> {
  await fs.remove(vsDataPath);
  await fs.ensureDir(vsDataPath);
  await fs.remove(path.resolve(srcPath, 'language-map.json'));

  console.log('[1/8] Generating icon configuration (manifest) file.');
  manifest = generateManifest();

  console.log(
    '[2/8] Querying Github API for official VSC language contributions.'
  );
  queryLanguageContributions();
}

main();

async function queryLanguageContributions(): Promise<void> {
  const res = await octokit.request('GET /search/code', query);
  if (!res.data) throw new Error();
  query.page = index;
  index += 1;
  if (!total) total = res.data.total_count;
  items.push(
    ...res.data.items.map(
      (item) => [item.html_url, item.path] as [string, string]
    )
  );
  if (resultsPerPage * index >= total) {
    console.log('[3/8] Fetching Microsoft language contributions from Github.');
    index = 0;
    total = items.length;
    items.forEach(([htmlUrl, path]) =>
      fetchLanguageContribution(htmlUrl, path)
    );
  } else {
    setTimeout(queryLanguageContributions, GITHUB_RATELIMIT);
  }
}

async function fetchLanguageContribution(
  htmlUrl: string,
  itemPath: string
): Promise<void> {
  const rawUrl: string = htmlUrl.replace('/blob/', '/raw/');
  const resPath: string = itemPath.replace(/[^/]+$/, 'extension.json');
  const extPath: string = path.join(vsDataPath, resPath);
  let extManifest: string;
  try {
    const response = await fetch(rawUrl, {});
    extManifest = await response.text();
  } catch (reason) {
    throw new Error(`${reason}`);
  }
  try {
    await fs.ensureDir(path.dirname(extPath));
    await fs.writeFile(extPath, extManifest, 'utf-8');
  } catch (reason) {
    throw new Error(`${reason} (${extPath})`);
  }
  items[index] = [extPath, extManifest];
  index += 1;
  if (index === total) {
    console.log('[4/8] Loading VSC language contributions into Node.');
    index = 0;
    items.forEach(([extPath, extManifest]) =>
      loadLanguageContribution(extPath, extManifest)
    );

    console.log(
      '[5/8] Processing language contributions for VSC File Icon API compatibility.'
    );
    index = 0;
    total = contributions.length;
    contributions.forEach(processLanguageContribution);
  }
}

function loadLanguageContribution(extPath: string, extManifest: string): void {
  let data: any;
  try {
    data = JSON.parse(extManifest.replace(/#\w+_\w+#/g, '0'));
  } catch (error) {
    throw new Error(`${error} (${extPath})`);
  }
  if (!data.contributes?.languages) {
    return;
  }
  contributions.push(...data.contributes.languages);
}

function processLanguageContribution(contribution: LanguageContribution): void {
  const { id, filenamePatterns } = contribution;
  let { extensions, filenames } = contribution;
  extensions = extensions || [];
  filenames = filenames || [];
  if (filenamePatterns) {
    filenamePatterns.forEach((ptn) => {
      if (/^\*\.[^*/?]+$/.test(ptn)) {
        extensions?.push(ptn.substring(1));
      }
      if (/^[^*/?]+$/.test(ptn)) {
        filenames?.push(ptn);
      }
    });
  }
  extensions = extensions
    .map((ext) => (ext.charAt(0) === '.' ? ext.substring(1) : ext))
    .filter((ext) => !/\*|\/|\?/.test(ext));
  filenames = filenames.filter((name) => !/\*|\/|\?/.test(name));
  if (!filenames.length && !extensions.length) {
    total -= 1;
    return;
  }
  const language: Language | undefined = languages.find(
    (lang) => lang.id === id
  );
  if (language) {
    language.filenames.push(...filenames);
    language.extensions.push(...extensions);
  } else {
    languages.push({ id, extensions, filenames });
  }
  index += 1;
  if (index === total) {
    console.log(
      '[6/8] Mapping language contributions into file icon configuration.'
    );
    index = 0;
    total = languages.length;
    languages.forEach(mapLanguageContribution);
  }
}

const languageMap: {
  fileExtensions: { [key: string]: string };
  fileNames: { [key: string]: string };
} = {
  fileExtensions: {},
  fileNames: {},
};

function mapLanguageContribution(lang: Language): void {
  const langIcon: string | undefined = manifest.languageIds?.[lang.id];
  lang.extensions.forEach((ext) => {
    const iconName: string | undefined =
      manifest.fileExtensions?.[ext] || langIcon;
    if (
      !manifest.fileExtensions?.[ext] &&
      iconName &&
      manifest.iconDefinitions?.[iconName]
    ) {
      languageMap.fileExtensions[ext] = iconName;
    }
  });
  lang.filenames.forEach((name) => {
    const iconName: string | undefined = manifest.fileNames?.[name] || langIcon;
    if (
      !manifest.fileNames?.[name] &&
      !(name.startsWith('.') && manifest.fileExtensions?.[name.substring(1)]) &&
      iconName &&
      manifest.iconDefinitions?.[iconName]
    ) {
      languageMap.fileNames[name] = iconName;
    }
  });
  index += 1;
  if (index === total) {
    generateLanguageMap();
  }
}

async function generateLanguageMap(): Promise<void> {
  console.log(
    '[7/8] Writing language contribution map to icon configuration file.'
  );
  await fs.writeFile(
    path.resolve(srcPath, 'language-map.json'),
    stringify(languageMap, { space: '  ' }) ?? ''
  );
  console.log('[8/8] Deleting language contribution cache.');
  await fs.remove(vsDataPath);
}
