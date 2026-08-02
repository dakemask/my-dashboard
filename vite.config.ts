import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "my-dashboard";
const base = process.env.BASE_PATH ?? (process.env.GITHUB_ACTIONS ? `/${repositoryName}/` : "/");
const projectRoot = fileURLToPath(new URL(".", import.meta.url));

function loadLocalHttpsOptions(): { key: Buffer; cert: Buffer } {
  const certPath = process.env.DASHBOARD_DEV_CERT
    ?? resolve(projectRoot, ".cert", "my-dashboard.pem");
  const keyPath = process.env.DASHBOARD_DEV_KEY
    ?? resolve(projectRoot, ".cert", "my-dashboard-key.pem");

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    throw new Error(
      "本地 HTTPS 证书未找到。请先按 README.md 的“局域网 HTTPS 开发”说明生成 .cert/my-dashboard.pem 和 .cert/my-dashboard-key.pem。",
    );
  }

  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}

export default defineConfig(({ command }) => {
  const localHttps = command === "serve" ? loadLocalHttpsOptions() : undefined;

  return {
    base,
    server: {
      host: "0.0.0.0",
      https: localHttps,
    },
    preview: {
      host: "0.0.0.0",
      https: localHttps,
    },
    build: {
      rollupOptions: {
        input: {
          home: resolve(projectRoot, "index.html"),
          mindMap: resolve(projectRoot, "modules/mind-map/index.html"),
          fragmentThoughts: resolve(projectRoot, "modules/fragment-thoughts/index.html"),
          todos: resolve(projectRoot, "modules/todos/index.html"),
        },
      },
    },
  };
});
