import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "my-dashboard";
const base = process.env.BASE_PATH ?? (process.env.GITHUB_ACTIONS ? `/${repositoryName}/` : "/");
const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base,
  build: {
    rollupOptions: {
      input: {
        home: resolve(projectRoot, "index.html"),
        thoughts: resolve(projectRoot, "modules/thoughts/index.html"),
      },
    },
  },
});
