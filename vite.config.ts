import { defineConfig } from "vite";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "my-dashboard";
const base = process.env.BASE_PATH ?? (process.env.GITHUB_ACTIONS ? `/${repositoryName}/` : "/");
export default defineConfig({
  base,
});
