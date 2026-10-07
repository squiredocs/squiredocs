/**
 * Tool Documentation Registry
 *
 * Full API references for the script-based MCP tools (modify,
 * compare_document_versions). MCP clients such as Claude Code truncate tool
 * descriptions at 2KB, so those tools ship a short description and agents
 * fetch the complete reference here via the get_tool_documentation tool.
 * The in-app chat agent still receives the full reference inline via each
 * tool's chatDescription.
 */

const { MODIFY_DOCUMENTATION } = require('./modify');
const { COMPARE_DOCUMENTATION } = require('./compare-document-versions');
const { EXPORT_API_DOCUMENTATION, buildExportApiDocumentation } = require('./export-api');

const SECTION_SEPARATOR = /═{20,}\n(.+)\n═{20,}\n/g;

/**
 * Slugify a section title, e.g.
 * "QUICK DECISION GUIDE: What kind of edit am I doing?" -> "quick-decision-guide"
 * (text after ":" and parentheticals are dropped to keep slugs short)
 */
function slugify(title) {
  return title
    .split(':')[0]
    .replace(/\(.*?\)/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Split a documentation string on its ═══-delimited section headers.
 * @returns {Array<{id: string, title: string, text: string}>}
 */
function parseSections(documentation) {
  const sections = [];
  const matches = [...documentation.matchAll(SECTION_SEPARATOR)];
  matches.forEach((match, i) => {
    const title = match[1].trim();
    const start = match.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : documentation.length;
    sections.push({
      id: slugify(title),
      title,
      text: documentation.slice(start, end).trimEnd(),
    });
  });
  return sections;
}

function buildEntry(documentation) {
  const sections = parseSections(documentation);
  return {
    full: documentation,
    sections,
    sectionIds: sections.map((s) => s.id),
  };
}

// rest_api is the canonical topic name (the reference covers import and sync,
// not just export); export_api remains an accepted alias because agents and
// older docs still ask for it.
const restApiEntry = buildEntry(EXPORT_API_DOCUMENTATION);
const REST_API_TOPICS = new Set(['rest_api', 'export_api']);

// Feature 058 (FR-031): the REST reference is built per base URL so every curl
// line names the instance the agent is connected to. Small cache: an instance
// sees a handful of origins (its APP_URL, localhost, an alias).
const restApiEntriesByBaseUrl = new Map();
const MAX_CACHED_BASE_URLS = 16;

function restApiEntryFor(baseUrl) {
  if (!baseUrl) return restApiEntry;
  let entry = restApiEntriesByBaseUrl.get(baseUrl);
  if (!entry) {
    if (restApiEntriesByBaseUrl.size >= MAX_CACHED_BASE_URLS) restApiEntriesByBaseUrl.clear();
    entry = buildEntry(buildExportApiDocumentation(baseUrl));
    restApiEntriesByBaseUrl.set(baseUrl, entry);
  }
  return entry;
}

const docs = {
  modify: buildEntry(MODIFY_DOCUMENTATION),
  compare_document_versions: buildEntry(COMPARE_DOCUMENTATION),
  rest_api: restApiEntry,
  export_api: restApiEntry,
};

const DOC_TOPICS = Object.keys(docs);

/**
 * Get the documentation entry for a tool.
 * @param {string} tool - Tool name (e.g. 'modify')
 * @param {{ baseUrl?: string }} [opts] - origin the REST reference's URLs use
 * @returns {{full: string, sections: Array, sectionIds: string[]}|null}
 */
function getDocs(tool, { baseUrl } = {}) {
  if (REST_API_TOPICS.has(tool)) return restApiEntryFor(baseUrl);
  return docs[tool] || null;
}

/**
 * Get a single documentation section for a tool.
 * @param {string} tool - Tool name
 * @param {string} sectionId - Section slug (see sectionIds)
 * @returns {{id: string, title: string, text: string}|null}
 */
function getSection(tool, sectionId, { baseUrl } = {}) {
  const entry = getDocs(tool, { baseUrl });
  if (!entry) return null;
  return entry.sections.find((s) => s.id === sectionId) || null;
}

module.exports = {
  DOC_TOPICS,
  getDocs,
  getSection,
  MODIFY_DOCUMENTATION,
  COMPARE_DOCUMENTATION,
  EXPORT_API_DOCUMENTATION,
  buildExportApiDocumentation,
};
