import { CATEGORIES } from './categories.js';

// Which record is open in a KBMax tab, from its URL (the part after # is ignored):
// https://<host>/admin/configurators/118#887dsg6eh -> { category: products, id: 118 }.
export function detectCurrentRecord(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }

  for (const category of CATEGORIES) {
    if (!(category.getApi || category.recordApi) || !category.pagePath) continue;
    const match = new RegExp(`^/${category.pagePath}/(-?\\d+)(?:/.*)?$`).exec(pathname);
    if (match) return { category, id: Number(match[1]) };
  }
  return null;
}
