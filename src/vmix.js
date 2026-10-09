// vMix Web API client + XML parser.
//
// The hub connects OUT to each vMix machine's public IP and reads its Web API
// (http://host:port/api), which returns an XML snapshot of the whole switcher.
// We pull out one input (the active one, an input number, or an input title),
// work out how much time is left on it, and list its playlist items.
//
// Supports HTTP Basic auth because a vMix exposed on a public IP should have the
// Web Controller login enabled.

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
  textNodeName: '#text',
});

// Errors carry a short `.code` so the poller/test endpoint can classify them.
export class VmixError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/**
 * Fetch the raw vMix Web API XML.
 * @returns {Promise<string>} raw XML body
 * @throws {VmixError} code: TIMEOUT | AUTH | HTTP | NETWORK
 */
export async function fetchVmixApi(host, port, { username, password, timeoutMs = 2000 } = {}) {
  const url = `http://${host}:${port}/api`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {};
  if (username || password) {
    const token = Buffer.from(`${username ?? ''}:${password ?? ''}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (res.status === 401) throw new VmixError('AUTH', 'vMix Web Controller requires login');
    if (!res.ok) throw new VmixError('HTTP', `vMix returned HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err instanceof VmixError) throw err;
    if (err.name === 'AbortError') throw new VmixError('TIMEOUT', `No response within ${timeoutMs}ms`);
    throw new VmixError('NETWORK', err.message || 'Network error');
  } finally {
    clearTimeout(timer);
  }
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Parse a vMix Web API XML snapshot and extract a single input's countdown.
 *
 * @param {string} xml         raw XML from fetchVmixApi
 * @param {string} inputSelector  "active" | "<number>" | "<title>"
 * @returns {{
 *   state: string,            // Running | Paused | Completed | Unknown
 *   remainingMs: number|null, // time left on the selected input, or null
 *   list: Array<{index:number,title:string,selected:boolean}>,
 *   inputFound: boolean,
 *   title: string|null,
 *   number: number|null,
 *   position: number,
 *   duration: number
 * }}
 */
export function parseVmixXml(xml, inputSelector = 'active') {
  const doc = parser.parse(xml);
  const vmix = doc?.vmix ?? {};
  const inputs = asArray(vmix?.inputs?.input);
  const activeNumber = vmix?.active;

  const sel = inputSelector == null ? 'active' : String(inputSelector).trim();
  let target = null;

  if (sel === '' || sel.toLowerCase() === 'active') {
    target = inputs.find((i) => String(i['@_number']) === String(activeNumber));
  } else if (/^\d+$/.test(sel)) {
    target = inputs.find((i) => String(i['@_number']) === sel);
  } else {
    const lc = sel.toLowerCase();
    target = inputs.find((i) => String(i['@_title'] ?? '').toLowerCase() === lc);
  }

  if (!target) {
    return { state: 'Unknown', remainingMs: null, list: [], inputFound: false, title: null, number: null, position: 0, duration: 0 };
  }

  const state = String(target['@_state'] ?? 'Unknown');
  const position = Number(target['@_position'] ?? 0) || 0;
  const duration = Number(target['@_duration'] ?? 0) || 0;
  const remainingMs = duration > 0 ? Math.max(0, duration - position) : null;

  const list = asArray(target?.list?.item).map((it, index) => {
    if (it && typeof it === 'object') {
      return {
        index,
        title: String(it['#text'] ?? it['@_title'] ?? '').trim(),
        selected: it['@_selected'] === true || it['@_selected'] === 'true',
      };
    }
    return { index, title: String(it).trim(), selected: false };
  });

  return {
    state,
    remainingMs,
    list,
    inputFound: true,
    title: target['@_title'] != null ? String(target['@_title']) : null,
    number: target['@_number'] != null ? Number(target['@_number']) : null,
    position,
    duration,
  };
}

/** Convenience: fetch + parse in one call. Throws VmixError on failure. */
export async function pollVmix(host, port, opts = {}) {
  const { input = 'active', ...fetchOpts } = opts;
  const xml = await fetchVmixApi(host, port, fetchOpts);
  return parseVmixXml(xml, input);
}
