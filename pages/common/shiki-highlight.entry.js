import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import javascript from "@shikijs/langs/javascript";
import markdown from "@shikijs/langs/markdown";
import shellscript from "@shikijs/langs/shellscript";
import typescript from "@shikijs/langs/typescript";
import materialThemeDarker from "@shikijs/themes/material-theme-darker";

const theme = "material-theme-darker";
const highlighter = await createHighlighterCore({
  themes: [materialThemeDarker],
  langs: [javascript, typescript, shellscript, markdown],
  engine: createJavaScriptRegexEngine()
});

function detectLanguage(code) {
  const text = code.trim();
  if (/^(pnpm|npm|yarn|node|git|cargo|curl)\b/m.test(text)) return "shellscript";
  if (/^##\s|\n[-*]\s|^```/m.test(text)) return "markdown";
  if (/\b(?:interface|type)\s+\w+\b|:\s*(?:string|number|boolean)\b/.test(text)) return "typescript";
  return "javascript";
}

function highlightBlock(code) {
  const lang = code.dataset.lang || code.className.match(/language-([a-z0-9-]+)/i)?.[1] || detectLanguage(code.textContent || "");
  const html = highlighter.codeToHtml(code.textContent || "", {
    lang,
    theme
  });

  const template = document.createElement("template");
  template.innerHTML = html.trim();
  const highlightedPre = template.content.firstElementChild;
  if (!highlightedPre) return;

  const pre = code.closest("pre");
  if (pre) {
    pre.replaceWith(highlightedPre);
  }
}

document.querySelectorAll("pre > code").forEach(highlightBlock);
