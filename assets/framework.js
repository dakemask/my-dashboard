const moduleList = document.querySelector("#moduleList");
const modules = window.dashboardModules || [];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}

function renderModules() {
  if (!modules.length) {
    moduleList.innerHTML = `<div class="empty">暂无可用模块。</div>`;
    return;
  }

  moduleList.innerHTML = modules.map((module) => `
    <a class="module-link" href="${escapeHtml(module.href)}">
      <span>
        <span class="module-title">${escapeHtml(module.title)}</span>
        <span class="module-description">${escapeHtml(module.description)}</span>
      </span>
      <span class="module-action">进入</span>
    </a>
  `).join("");
}

renderModules();
