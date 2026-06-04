const groups = [
  {
    title: "JSZipp users",
    links: [
      ["Overview", "index.html", "home"],
      ["Installation", "installation.html", "installation"],
      ["FAQ", "faq.html", "faq"],
      ["Changelog", "changelog.html", "changelog"],
      ["Upgrade guide", "upgrade-guide.html", "upgrade"],
      ["Bug tracker", "bug-tracker.html", "bugs"],
      ["Sponsorship", "sponsorship.html", "sponsorship"]
    ]
  },
  {
    title: "JSZipp developers",
    links: [
      ["How to contribute", "contribute.html", "contribute"],
      ["Contributors", "contributors.html", "contributors"]
    ]
  },
  {
    title: "Reference",
    links: [
      ["API", "api.html", "api"],
      ["How to / examples", "examples.html", "examples"],
      ["Performances / limitations", "performance.html", "performance"]
    ]
  }
];

const shikiHighlighterUrl = document.currentScript?.src
  ? new URL("shiki-highlight.js", document.currentScript.src).href
  : "common/shiki-highlight.js";

function basePath() {
  const path = window.location.pathname;
  return path.endsWith("/pages/") || path.endsWith("/pages/index.html") ? "." : ".";
}

function renderHeader() {
  const header = document.querySelector("[data-site-header]");
  if (!header) return;
  header.innerHTML = `
    <div class="topbar">
      <a class="brand" href="${basePath()}/index.html" aria-label="JSZipp documentation home">
        <span class="brand-mark"><img src="../assets/icon.png" alt="" /></span>
        <span>JS<b>Zipp</b></span>
      </a>
      <div class="topbar-spacer"></div>
      <nav class="topnav" aria-label="Primary">
        <a href="${basePath()}/index.html">Overview</a>
        <a href="${basePath()}/api.html">API</a>
        <a href="${basePath()}/examples.html">Examples</a>
        <a href="${basePath()}/performance.html">Limits</a>
        <a href="../demo/index.html">Demo</a>
      </nav>
    </div>`;
}

function renderSidebar() {
  const sidebar = document.querySelector("[data-site-sidebar]");
  if (!sidebar) return;
  const active = document.body.dataset.page;
  sidebar.innerHTML = groups.map((group) => `
    <section class="sidebar-section">
      <h2>${group.title}</h2>
      ${group.links.map(([label, href, key]) => `
        <a class="${key === active ? "active" : ""}" href="${basePath()}/${href}">
          <span>${label}</span>
        </a>`).join("")}
    </section>`).join("");
}

function renderFooter() {
  const footer = document.querySelector("[data-site-footer]");
  if (!footer) return;
  footer.innerHTML = `JSZipp documentation scaffold. MIT licensed. Public docs follow the JSZip information architecture with JSZipp-specific behavior.`;
}

renderHeader();
renderSidebar();
renderFooter();

void import(shikiHighlighterUrl).catch((error) => {
  console.warn("Shiki syntax highlighting failed to load.", error);
});
