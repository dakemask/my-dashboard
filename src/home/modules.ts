export interface DashboardModule {
  id: string;
  title: string;
  description: string;
  href: string;
}

export const dashboardModules: DashboardModule[] = [
  {
    id: "mind-map",
    title: "思维导图",
    description: "管理多级导图库，在自由画布中整理文字并建立连接。",
    href: "modules/mind-map/",
  },
  {
    id: "fragment-thoughts",
    title: "碎片想法",
    description: "随手记录零散想法，并通过搜索和版本历史回顾变化。",
    href: "modules/fragment-thoughts/",
  },
];
