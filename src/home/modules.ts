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
];
