import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import { dart } from "@codemirror/legacy-modes/mode/clike";
import { rust } from "@codemirror/lang-rust";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { go } from "@codemirror/lang-go";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";

export function getLanguage(filePath: string): LanguageSupport | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "rs":                          return rust();
    case "ts": case "mts":              return javascript({ typescript: true });
    case "tsx":                         return javascript({ typescript: true, jsx: true });
    case "js": case "mjs": case "cjs":  return javascript();
    case "jsx":                         return javascript({ jsx: true });
    case "py": case "pyi":              return python();
    case "c": case "h":
    case "cc": case "cpp": case "cxx":
    case "hpp": case "hxx":             return cpp();
    case "java":                        return java();
    case "go":                          return go();
    case "css": case "scss":            return css();
    case "html": case "htm":            return html();
    case "json": case "jsonc":          return json();
    case "md": case "mdx":              return markdown();
    case "yaml": case "yml":            return yaml();
    case "xml": case "svg":             return xml();
    case "sql":                         return sql();
    // No official @codemirror/lang-dart; the legacy (CodeMirror 5) mode is the standard route
    case "dart":                        return new LanguageSupport(StreamLanguage.define(dart));
    default:                            return null;
  }
}

/** highlight.js language string from file extension */
export function hlLang(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    rs: "rust", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    mjs: "javascript", cjs: "javascript", mts: "typescript", py: "python", pyi: "python",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
    java: "java", go: "go", css: "css", scss: "css", html: "html", htm: "html",
    json: "json", jsonc: "json", md: "markdown", mdx: "markdown", yaml: "yaml", yml: "yaml",
    xml: "xml", svg: "xml", sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
    toml: "ini", dockerfile: "dockerfile", dart: "dart",
  };
  return map[ext] ?? "plaintext";
}
