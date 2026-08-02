import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "my-dashboard";
const base = process.env.BASE_PATH ?? (process.env.GITHUB_ACTIONS ? `/${repositoryName}/` : "/");
const projectRoot = fileURLToPath(new URL(".", import.meta.url));

function loadLocalHttpsOptions(): { key: Buffer; cert: Buffer } | undefined {
  const certPath = process.env.DASHBOARD_DEV_CERT
    ?? resolve(projectRoot, ".cert", "my-dashboard.pem");
  const keyPath = process.env.DASHBOARD_DEV_KEY
    ?? resolve(projectRoot, ".cert", "my-dashboard-key.pem");

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    console.warn("未找到本地 HTTPS 证书，开发服务器将使用 HTTP。需要局域网 HTTPS 时请先运行 npm run setup:https。");
    return undefined;
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
