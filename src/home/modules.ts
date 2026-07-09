export interface DashboardModule {
  id: string;
  title: string;
  description: string;
  href: string;
}

export const dashboardModules: DashboardModule[] = [
  {
    id: "fragment-thoughts",
    title: "碎片想法",
    description: "快速记录，随时搜索，数据同步到你的 GitHub 私有仓库。",
    href: "modules/fragment-thoughts/",
  },
  {
    id: "mind-map",
    title: "思维导图",
    description: "管理多个导图文件夹，绘制可编辑文本框和直线箭头，数据同步到你的 GitHub 私有仓库。",
    href: "modules/mind-map/",
  },
];
