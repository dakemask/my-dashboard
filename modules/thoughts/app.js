const els = {
  settingsBtn: document.querySelector("#settingsBtn"),
  settingsPanel: document.querySelector("#settingsPanel"),
  ownerInput: document.querySelector("#ownerInput"),
  repoInput: document.querySelector("#repoInput"),
  branchInput: document.querySelector("#branchInput"),
  pathInput: document.querySelector("#pathInput"),
  tokenInput: document.querySelector("#tokenInput"),
  saveSettingsBtn: document.querySelector("#saveSettingsBtn"),
  clearSettingsBtn: document.querySelector("#clearSettingsBtn"),
  thoughtInput: document.querySelector("#thoughtInput"),
  tagInput: document.querySelector("#tagInput"),
  addBtn: document.querySelector("#addBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  searchInput: document.querySelector("#searchInput"),
  status: document.querySelector("#status"),
  list: document.querySelector("#list"),
};

let state = {
  sha: null,
  data: {
    notes: [],
  },
};

function setStatus(message) {
  els.status.textContent = message || "";
}

function getSettings() {
  return {
    owner: localStorage.getItem("thought_owner") || "",
    repo: localStorage.getItem("thought_repo") || "my-dashboard-data",
    branch: localStorage.getItem("thought_branch") || "main",
    path: localStorage.getItem("thought_path") || "data/thoughts.json",
    token: localStorage.getItem("thought_token") || "",
  };
}

function saveSettings() {
  localStorage.setItem("thought_owner", els.ownerInput.value.trim());
  localStorage.setItem("thought_repo", els.repoInput.value.trim());
  localStorage.setItem("thought_branch", els.branchInput.value.trim());
  localStorage.setItem("thought_path", els.pathInput.value.trim());
  localStorage.setItem("thought_token", els.tokenInput.value.trim());
}

function fillSettingsForm() {
  const s = getSettings();
  els.ownerInput.value = s.owner;
  els.repoInput.value = s.repo;
  els.branchInput.value = s.branch;
  els.pathInput.value = s.path;
  els.tokenInput.value = s.token;
}

function assertSettings() {
  const s = getSettings();

  if (!s.owner || !s.repo || !s.branch || !s.path || !s.token) {
    els.settingsPanel.classList.remove("hidden");
    throw new Error("请先完成同步设置。");
  }

  return s;
}

function apiUrl(settings) {
  const path = encodeURIComponent(settings.path).replaceAll("%2F", "/");
  return `https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${path}`;
}

function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => binary += String.fromCharCode(b));
  return btoa(binary);
}

function base64ToText(base64) {
  const clean = base64.replace(/\n/g, "");
  const binary = atob(clean);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function githubFetch(url, options = {}) {
  const settings = getSettings();

  const res = await fetch(url, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${settings.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();

    if (res.status === 404) {
      const err = new Error("NOT_FOUND");
      err.status = 404;
      throw err;
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error("GitHub Token 无效，或权限不够。请检查 token 是否只授权给 thought-data，并开启 Contents Read and write。");
    }

    if (res.status === 409) {
      throw new Error("保存冲突：其他浏览器可能刚保存过。请先点刷新，再保存。");
    }

    throw new Error(`GitHub API 错误：${res.status} ${text}`);
  }

  return res.json();
}

async function loadData() {
  const settings = assertSettings();
  setStatus("正在从 GitHub 读取...");

  try {
    const json = await githubFetch(`${apiUrl(settings)}?ref=${settings.branch}`);
    state.sha = json.sha;
    state.data = JSON.parse(base64ToText(json.content));
    state.data.notes ||= [];
    setStatus(`已同步：${new Date().toLocaleString()}`);
  } catch (err) {
    if (err.status === 404 || err.message === "NOT_FOUND") {
      state.sha = null;
      state.data = { notes: [] };
      setStatus("数据文件还不存在。保存第一条想法时会自动创建。");
    } else {
      setStatus(err.message);
      throw err;
    }
  }

  render();
}

async function saveData(message = "update thoughts") {
  const settings = assertSettings();

  const body = {
    message,
    content: textToBase64(JSON.stringify(state.data, null, 2)),
    branch: settings.branch,
  };

  if (state.sha) {
    body.sha = state.sha;
  }

  setStatus("正在保存到 GitHub...");

  const json = await githubFetch(apiUrl(settings), {
    method: "PUT",
    body: JSON.stringify(body),
  });

  state.sha = json.content.sha;
  setStatus(`已保存：${new Date().toLocaleString()}`);
}

async function addNote() {
  const content = els.thoughtInput.value.trim();
  const tags = els.tagInput.value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  if (!content) {
    setStatus("先写点内容。");
    return;
  }

  const note = {
    id: crypto.randomUUID(),
    content,
    tags,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  state.data.notes.unshift(note);
  els.thoughtInput.value = "";
  els.tagInput.value = "";

  render();

  try {
    await saveData("add thought");
  } catch (err) {
    setStatus(err.message);
  }
}

async function deleteNote(id) {
  const ok = confirm("确定删除这条想法吗？");
  if (!ok) return;

  state.data.notes = state.data.notes.filter((note) => note.id !== id);
  render();

  try {
    await saveData("delete thought");
  } catch (err) {
    setStatus(err.message);
  }
}

function formatTime(iso) {
  return new Date(iso).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}

function render() {
  const q = els.searchInput.value.trim().toLowerCase();

  const notes = [...state.data.notes]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .filter((note) => {
      const text = `${note.content} ${(note.tags || []).join(" ")}`.toLowerCase();
      return text.includes(q);
    });

  if (notes.length === 0) {
    els.list.innerHTML = `<div class="empty">还没有匹配的想法。</div>`;
    return;
  }

  els.list.innerHTML = notes.map((note) => `
    <article class="note">
      <div class="note-content">${escapeHtml(note.content)}</div>

      <div class="note-meta">
        <div>
          ${(note.tags || []).length ? `
            <div class="tags">
              ${note.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
            </div>
          ` : ""}
        </div>

        <div>
          ${formatTime(note.createdAt)}
          <button class="ghost danger" data-delete="${note.id}">删除</button>
        </div>
      </div>
    </article>
  `).join("");

  document.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", () => deleteNote(btn.dataset.delete));
  });
}

els.settingsBtn.addEventListener("click", () => {
  els.settingsPanel.classList.toggle("hidden");
});

els.saveSettingsBtn.addEventListener("click", async () => {
  saveSettings();
  setStatus("设置已保存。");

  try {
    await loadData();
  } catch {}
});

els.clearSettingsBtn.addEventListener("click", () => {
  localStorage.removeItem("thought_owner");
  localStorage.removeItem("thought_repo");
  localStorage.removeItem("thought_branch");
  localStorage.removeItem("thought_path");
  localStorage.removeItem("thought_token");
  fillSettingsForm();
  setStatus("已清除当前浏览器里的设置。");
});

els.addBtn.addEventListener("click", addNote);

els.refreshBtn.addEventListener("click", async () => {
  try {
    await loadData();
  } catch (err) {
    setStatus(err.message);
  }
});

els.searchInput.addEventListener("input", render);

fillSettingsForm();

loadData().catch((err) => {
  setStatus(err.message);
});
