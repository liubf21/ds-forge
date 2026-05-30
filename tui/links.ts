import { pathToFileURL } from "node:url";

const OSC = "\u001B]";
const ST = "\u0007";

export function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}

/** OSC 8 hyperlink — Cmd+click opens in VS Code / iTerm / most modern terminals. */
export function linkText(url: string, label: string): string {
  return `${OSC}8;;${url}${ST}${label}${OSC}8;;${ST}`;
}
